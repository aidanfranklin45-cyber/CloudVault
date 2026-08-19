// scratch/sync_dynamic_stripe_billing.js
const https = require('https');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_RESTRICTED_KEY;
const SUPABASE_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ';

function stripeRequest(endpoint, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.stripe.com/v1/${endpoint}`);
    const headers = {
      'Authorization': `Bearer ${STRIPE_KEY}`
    };
    if (postData) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const req = https.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : postData.toString());
    }
    req.end();
  });
}

function supabaseRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${endpoint}`);
    const headers = {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    const req = https.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Resolves dynamic volume rate schedule:
 * 1. Checks Price Lock first
 * 2. Otherwise resolves regional facility tier pricing
 */
function resolveUserDynamicPricing(user, facility, toteCount = 1) {
  let rates = { tier1: 5.00, tier2: 3.50, tier3: 2.00, tier4: 1.00 };
  let isPriceLock = false;

  if (user.has_price_lock && user.price_lock_rates) {
    const plr = user.price_lock_rates;
    rates.tier1 = Number(plr.tier1_rate || plr.tier1 || rates.tier1);
    rates.tier2 = Number(plr.tier2_rate || plr.tier2 || rates.tier2);
    rates.tier3 = Number(plr.tier3_rate || plr.tier3 || rates.tier3);
    rates.tier4 = Number(plr.tier4_rate || plr.tier4 || rates.tier4);
    isPriceLock = true;
  } else if (facility) {
    rates.tier1 = Number(facility.tier1_rate) || 5.00;
    rates.tier2 = Number(facility.tier2_rate) || 3.50;
    rates.tier3 = Number(facility.tier3_rate) || 2.00;
    rates.tier4 = Number(facility.tier4_rate) || 1.00;
  }

  const count = Math.max(1, Number(toteCount) || 1);
  let toteRate = rates.tier1;
  let tierNumber = 1;
  let tierName = 'Tier 1 Standard Volume';

  if (count >= 50) {
    toteRate = rates.tier4;
    tierNumber = 4;
    tierName = 'Tier 4 Enterprise Volume';
  } else if (count >= 25) {
    toteRate = rates.tier3;
    tierNumber = 3;
    tierName = 'Tier 3 Commercial Volume';
  } else if (count >= 10) {
    toteRate = rates.tier2;
    tierNumber = 2;
    tierName = 'Tier 2 Preferred Volume';
  }

  return {
    toteRate,
    tierNumber,
    tierName,
    recurringStorage: count * toteRate,
    isPriceLock,
    ratesUsed: rates
  };
}

async function main() {
  console.log('=== Step 1: Initialize Base Product in Stripe ===');
  let productId = null;
  const prodSearch = await stripeRequest('products?limit=10');
  if (prodSearch.data?.data?.length > 0) {
    const existing = prodSearch.data.data.find(p => p.name === 'CloudVault Storage Service' || p.name === 'CloudVault Dynamic Vault Storage');
    if (existing) productId = existing.id;
  }

  if (!productId) {
    const prodParams = new URLSearchParams();
    prodParams.append('name', 'CloudVault Dynamic Vault Storage');
    prodParams.append('tax_code', 'txcd_20030000'); // General Physical Storage Services
    prodParams.append('description', 'Regional tiered vault storage with dynamic volume pricing');
    const createProdRes = await stripeRequest('products', 'POST', prodParams.toString());
    productId = createProdRes.data.id;
    console.log(`Created Stripe Product: ${productId}`);
  } else {
    console.log(`Using existing Stripe Product: ${productId}`);
  }

  console.log('\n=== Step 2: Fetching Facilities & Users from Supabase ===');
  const [facRes, usersRes, inventoryRes] = await Promise.all([
    supabaseRequest('facilities?select=*'),
    supabaseRequest('users?select=*'),
    supabaseRequest('inventory?select=id,uid,status')
  ]);

  const facilitiesMap = {};
  (facRes.data || []).forEach(f => facilitiesMap[f.id] = f);

  const inventoryByUid = {};
  (inventoryRes.data || []).forEach(t => {
    if (!inventoryByUid[t.uid]) inventoryByUid[t.uid] = 0;
    if (['stored', 'staged', 'with-customer', 'pending-stage'].includes(t.status)) {
      inventoryByUid[t.uid]++;
    }
  });

  console.log(`Loaded ${Object.keys(facilitiesMap).length} facilities, ${usersRes.data?.length || 0} users.`);

  console.log('\n=== Step 3: Dynamic Price Resolution & Subscription Activation on Stripe ===');
  for (const user of (usersRes.data || [])) {
    if (user.role !== 'customer') {
      console.log(`[Skip] Staff account: ${user.email} (${user.role})`);
      continue;
    }

    const customerId = user.stripe_customer_id;
    if (!customerId) {
      console.warn(`[Skip] User ${user.email} missing stripe_customer_id`);
      continue;
    }

    const facilityId = user.assigned_facility_id || 'facility_seattle_north';
    const facility = facilitiesMap[facilityId];
    const toteCount = inventoryByUid[user.id] || user.active_totes_held || 5;

    const pricing = resolveUserDynamicPricing(user, facility, toteCount);
    console.log(`\nCustomer: ${user.email} (${user.name})`);
    console.log(` - Facility: ${facility?.name || facilityId}`);
    console.log(` - Totes: ${toteCount}`);
    console.log(` - Pricing: $${pricing.toteRate.toFixed(2)}/tote/mo (${pricing.tierName}) [Price Lock: ${pricing.isPriceLock}]`);

    // Attach test card tok_visa if customer has no default source
    try {
      const sourceParams = new URLSearchParams();
      sourceParams.append('source', 'tok_visa');
      await stripeRequest(`customers/${customerId}/sources`, 'POST', sourceParams.toString());
    } catch (e) {
      // Ignore if source already attached
    }

    // Check if customer already has an active subscription on Stripe
    const subSearch = await stripeRequest(`subscriptions?customer=${customerId}&status=active&limit=1`);
    let stripeSubId = null;

    if (subSearch.data?.data?.length > 0) {
      stripeSubId = subSearch.data.data[0].id;
      console.log(` - Existing active Stripe subscription: ${stripeSubId}`);
    } else {
      // Create new dynamic subscription on Stripe with exact regional price_data
      const unitCents = Math.round(pricing.toteRate * 100);
      const subParams = new URLSearchParams();
      subParams.append('customer', customerId);
      subParams.append('items[0][price_data][currency]', 'usd');
      subParams.append('items[0][price_data][product]', productId);
      subParams.append('items[0][price_data][unit_amount]', unitCents.toString());
      subParams.append('items[0][price_data][recurring][interval]', 'month');
      subParams.append('items[0][quantity]', toteCount.toString());
      subParams.append('metadata[supabase_uid]', user.id);
      subParams.append('metadata[facility_id]', facilityId);
      subParams.append('metadata[tier_name]', pricing.tierName);
      subParams.append('metadata[is_price_lock]', String(pricing.isPriceLock));
      subParams.append('metadata[origin_address]', 'Selah, WA 98942');

      const createSubRes = await stripeRequest('subscriptions', 'POST', subParams.toString());
      if (createSubRes.data?.id) {
        stripeSubId = createSubRes.data.id;
        console.log(` - Created new dynamic Stripe subscription: ${stripeSubId}`);
      } else {
        console.error(` - Error creating subscription for ${user.email}:`, createSubRes.data);
      }
    }

    if (stripeSubId) {
      // Update Supabase users & subscriptions
      await supabaseRequest(`users?id=eq.${user.id}`, 'PATCH', {
        stripe_subscription_id: stripeSubId,
        subscription_status: 'active',
        active_totes_held: toteCount
      });

      // Upsert subscriptions mirror
      const subMirrorData = {
        uid: user.id,
        stripe_subscription_id: stripeSubId,
        stripe_customer_id: customerId,
        total_totes: toteCount,
        tote_count: toteCount,
        tote_rate: pricing.toteRate,
        recurring_storage: pricing.recurringStorage,
        status: 'active',
        facility_id: facilityId,
        has_price_lock: pricing.isPriceLock,
        last_updated: new Date().toISOString()
      };

      const existingSubRes = await supabaseRequest(`subscriptions?uid=eq.${user.id}&select=id`);
      if (existingSubRes.data?.length > 0) {
        await supabaseRequest(`subscriptions?id=eq.${existingSubRes.data[0].id}`, 'PATCH', subMirrorData);
      } else {
        await supabaseRequest('subscriptions', 'POST', subMirrorData);
      }
    }
  }

  console.log('\n=== Step 4: Retroactively Migrating Historical Invoices to Stripe ===');
  const invRes = await supabaseRequest('invoices?select=*');
  const invoices = invRes.data || [];
  console.log(`Found ${invoices.length} historical invoices in Supabase.`);

  for (const inv of invoices) {
    if (inv.stripe_invoice_id && inv.stripe_hosted_invoice_url) {
      console.log(`[Skip] Invoice ${inv.invoice_number} already synced to Stripe (${inv.stripe_invoice_id})`);
      continue;
    }

    // Find customer's stripe_customer_id
    let custId = inv.stripe_customer_id;
    if (!custId && inv.uid) {
      const uRes = await supabaseRequest(`users?id=eq.${inv.uid}&select=stripe_customer_id`);
      if (uRes.data?.length > 0) custId = uRes.data[0].stripe_customer_id;
    }
    if (!custId && inv.customer_email) {
      const uRes = await supabaseRequest(`users?email=eq.${encodeURIComponent(inv.customer_email)}&select=stripe_customer_id`);
      if (uRes.data?.length > 0) custId = uRes.data[0].stripe_customer_id;
    }

    if (!custId) {
      console.warn(`[Skip] Cannot find Stripe Customer for invoice ${inv.invoice_number} (${inv.customer_email})`);
      continue;
    }

    const totalAmt = Number(inv.total_amount || inv.subtotal || 10.00);
    const amountCents = Math.round(totalAmt * 100);
    const invDesc = inv.notes || `${inv.invoice_type || 'Vault Storage'} - ${inv.invoice_number}`;

    console.log(`Migrating Invoice ${inv.invoice_number} ($${totalAmt.toFixed(2)}) for ${inv.customer_email} (${custId})...`);

    // 1. Create Invoice Item in Stripe
    const itemParams = new URLSearchParams();
    itemParams.append('customer', custId);
    itemParams.append('amount', amountCents.toString());
    itemParams.append('currency', 'usd');
    itemParams.append('description', invDesc);
    const itemRes = await stripeRequest('invoiceitems', 'POST', itemParams.toString());

    if (!itemRes.data?.id) {
      console.error(` - Failed creating invoiceitem for ${inv.invoice_number}:`, itemRes.data);
      continue;
    }

    // 2. Create Invoice in Stripe
    const invParams = new URLSearchParams();
    invParams.append('customer', custId);
    invParams.append('auto_advance', 'false');
    invParams.append('collection_method', 'send_invoice');
    invParams.append('days_until_due', '3');
    invParams.append('metadata[original_invoice_number]', inv.invoice_number);
    invParams.append('metadata[supabase_invoice_id]', inv.id);

    const stripeInvRes = await stripeRequest('invoices', 'POST', invParams.toString());
    const stripeInvoiceId = stripeInvRes.data?.id;

    if (!stripeInvoiceId) {
      console.error(` - Failed creating invoice for ${inv.invoice_number}:`, stripeInvRes.data);
      continue;
    }

    // 3. Finalize Stripe Invoice
    const finalizeRes = await stripeRequest(`invoices/${stripeInvoiceId}/finalize`, 'POST', '');
    const finalizedInvoice = finalizeRes.data;

    // 4. Mark Paid Out of Band (since original was already paid)
    let hostedUrl = finalizedInvoice.hosted_invoice_url;
    let pdfUrl = finalizedInvoice.invoice_pdf;

    if (inv.payment_status === 'paid' || inv.payment_status === 'deposit_received') {
      const payParams = new URLSearchParams();
      payParams.append('paid_out_of_band', 'true');
      const paidRes = await stripeRequest(`invoices/${stripeInvoiceId}/pay`, 'POST', payParams.toString());
      if (paidRes.data?.hosted_invoice_url) {
        hostedUrl = paidRes.data.hosted_invoice_url;
        pdfUrl = paidRes.data.invoice_pdf;
      }
    }

    console.log(` - Stripe Invoice Created: ${stripeInvoiceId}`);
    console.log(` - Hosted URL: ${hostedUrl}`);

    // 5. Update Supabase public.invoices
    await supabaseRequest(`invoices?id=eq.${inv.id}`, 'PATCH', {
      stripe_invoice_id: stripeInvoiceId,
      stripe_customer_id: custId,
      stripe_hosted_invoice_url: hostedUrl,
      stripe_invoice_pdf: pdfUrl,
      payment_status: 'paid'
    });
  }

  console.log('\n=== Dynamic Stripe Sync & Historical Invoices Migration Complete! ===');
}

main().catch(console.error);
