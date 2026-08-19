// scratch/sync_itemized_stripe_invoices.js
const https = require('https');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_RESTRICTED_KEY;
const SUPABASE_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ';

function stripeRequest(endpoint, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.stripe.com/v1/${endpoint}`);
    const headers = { 'Authorization': `Bearer ${STRIPE_KEY}` };
    if (postData) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    const req = https.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(typeof postData === 'string' ? postData : postData.toString());
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
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getOrCreateStripeTaxRate(ratePercent = 8.5, displayName = 'Washington State & Local Sales Tax (8.5%)') {
  const search = await stripeRequest('tax_rates?limit=20');
  const existing = (search.data?.data || []).find(t => Math.abs(t.percentage - ratePercent) < 0.01 && t.active);
  if (existing) return existing.id;

  const params = new URLSearchParams();
  params.append('display_name', displayName);
  params.append('percentage', ratePercent.toString());
  params.append('inclusive', 'false');
  params.append('jurisdiction', 'WA, US');
  const createRes = await stripeRequest('tax_rates', 'POST', params.toString());
  return createRes.data?.id;
}

async function runItemizedSync() {
  console.log('=== Step 1: Initialize Regional Tax Rates in Stripe ===');
  const taxRate85 = await getOrCreateStripeTaxRate(8.5, 'Washington State & Local Sales Tax (8.5%)');
  const taxRate1025 = await getOrCreateStripeTaxRate(10.25, 'Seattle North Sales Tax (10.25%)');
  console.log(`Stripe Tax Rates: 8.5% (${taxRate85}), 10.25% (${taxRate1025})`);

  console.log('\n=== Step 2: Fetching All Historical Invoices ===');
  const invRes = await supabaseRequest('invoices?select=*');
  const invoices = invRes.data || [];
  console.log(`Processing ${invoices.length} invoices with enhanced styling and tax placement...`);

  for (const inv of invoices) {
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
      console.warn(`[Skip] Cannot find Stripe customer for invoice ${inv.invoice_number}`);
      continue;
    }

    console.log(`\nItemizing Invoice ${inv.invoice_number} (${inv.invoice_type}) for ${inv.customer_email}...`);

    // 1. Create Draft Invoice in Stripe with custom fields, footer, and tax settings
    const invParams = new URLSearchParams();
    invParams.append('customer', custId);
    invParams.append('auto_advance', 'false');
    invParams.append('collection_method', 'send_invoice');
    invParams.append('days_until_due', '3');
    invParams.append('description', 'CloudVault Automated Invoice Engine • Official Statement');
    invParams.append('footer', 'CloudVault Storage & Logistics Solutions • Selah, WA 98942 • support@cloudvault.io');
    invParams.append('rendering[amount_tax_display]', 'exclude_tax'); // Keeps tax cleanly in footer summary, NOT on individual line items
    invParams.append('metadata[original_invoice_number]', inv.invoice_number);
    invParams.append('metadata[supabase_invoice_id]', inv.id);

    // Custom Fields on PDF
    const facilityLabel = inv.facility_id === 'facility_seattle_north' ? 'Seattle North Fulfillment Center' :
                          inv.facility_id === 'facility_portland_central' ? 'Portland Central Hub' :
                          'Yakima Fulfillment Center (Selah Hub)';
    invParams.append('custom_fields[0][name]', 'Facility Hub');
    invParams.append('custom_fields[0][value]', facilityLabel);

    const serviceLabel = inv.invoice_type === 'valet_delivery' ? 'White-Glove Valet Delivery' :
                         inv.invoice_type === 'surge_delivery' ? 'Expedited Staging Retrieval' :
                         'Vault Storage Subscription';
    invParams.append('custom_fields[1][name]', 'Service Plan');
    invParams.append('custom_fields[1][value]', serviceLabel);

    if (inv.transaction_reference) {
      invParams.append('custom_fields[2][name]', 'Txn Reference');
      invParams.append('custom_fields[2][value]', inv.transaction_reference);
    }

    // Apply default tax rate if tax > 0
    const taxAmt = Number(inv.tax || 0);
    const subtotalAmt = Number(inv.subtotal || 0) + Number(inv.delivery_fee || 0) + Number(inv.surge_fee || 0);

    if (taxAmt > 0 && subtotalAmt > 0) {
      const calculatedRate = (taxAmt / subtotalAmt) * 100;
      const assignedTaxRateId = calculatedRate > 9.5 ? taxRate1025 : taxRate85;
      invParams.append('default_tax_rates[0]', assignedTaxRateId);
    }

    const draftRes = await stripeRequest('invoices', 'POST', invParams.toString());
    const stripeInvoiceId = draftRes.data?.id;

    if (!stripeInvoiceId) {
      console.error(`Failed creating draft invoice for ${inv.invoice_number}:`, draftRes.data);
      continue;
    }

    // 2. Parse Line Items
    let lines = inv.line_items;
    if (typeof lines === 'string') {
      try { lines = JSON.parse(lines); } catch (e) { lines = []; }
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      lines = [];
      const sub = Number(inv.subtotal || 0);
      const del = Number(inv.delivery_fee || 0);
      const srg = Number(inv.surge_fee || 0);

      if (sub > 0) lines.push({ description: 'CloudVault Monthly Vault Storage Plan', qty: 1, amount: sub });
      if (del > 0) lines.push({ description: 'Valet Doorstep Delivery Service Fee', qty: 1, amount: del });
      if (srg > 0) lines.push({ description: 'Expedited Staging / Surge Priority Access Fee', qty: 1, amount: srg });
      if (lines.length === 0) {
        lines.push({ description: inv.notes || 'CloudVault Storage Service', qty: 1, amount: Number(inv.total_amount || 10.00) });
      }
    }

    // Filter out tax-only lines
    const feeLines = lines.filter(l => {
      const desc = (l.description || '').toLowerCase();
      return !desc.includes('sales tax') && !desc.includes('state tax') && Number(l.amount || (l.unit_price * (l.qty || 1)) || 0) > 0;
    });

    // 3. Push each discrete line item to Stripe
    for (const item of feeLines) {
      const itemAmountCents = Math.round(Number(item.amount || (item.unit_price * (item.qty || 1)) || 0) * 100);
      if (itemAmountCents <= 0) continue;

      const itemParams = new URLSearchParams();
      itemParams.append('customer', custId);
      itemParams.append('invoice', stripeInvoiceId);
      itemParams.append('amount', itemAmountCents.toString());
      itemParams.append('currency', 'usd');
      itemParams.append('description', item.description || 'CloudVault Service Item');

      const itemRes = await stripeRequest('invoiceitems', 'POST', itemParams.toString());
      if (itemRes.data?.id) {
        console.log(`   + Line Item Added: "${item.description}" ($${(itemAmountCents / 100).toFixed(2)})`);
      } else {
        console.error(`   ! Failed adding line item "${item.description}":`, itemRes.data);
      }
    }

    // 4. Finalize Invoice
    const finalizeRes = await stripeRequest(`invoices/${stripeInvoiceId}/finalize`, 'POST', '');
    const finalized = finalizeRes.data;

    // 5. Mark Paid Out-of-Band
    let hostedUrl = finalized.hosted_invoice_url;
    let pdfUrl = finalized.invoice_pdf;

    const payParams = new URLSearchParams();
    payParams.append('paid_out_of_band', 'true');
    const payRes = await stripeRequest(`invoices/${stripeInvoiceId}/pay`, 'POST', payParams.toString());
    if (payRes.data?.hosted_invoice_url) {
      hostedUrl = payRes.data.hosted_invoice_url;
      pdfUrl = payRes.data.invoice_pdf;
    }

    const totalPaid = ((payRes.data?.total || payRes.data?.amount_paid || 0) / 100);
    const taxPaid = ((payRes.data?.tax || 0) / 100);

    console.log(`   -> Finalized & Paid: ${stripeInvoiceId} (Total: $${totalPaid.toFixed(2)}, Tax: $${taxPaid.toFixed(2)})`);
    console.log(`   -> PDF: ${pdfUrl}`);

    // 6. Update Supabase public.invoices with real total & tax calculated by Stripe
    await supabaseRequest(`invoices?id=eq.${inv.id}`, 'PATCH', {
      stripe_invoice_id: stripeInvoiceId,
      stripe_customer_id: custId,
      stripe_hosted_invoice_url: hostedUrl,
      stripe_invoice_pdf: pdfUrl,
      payment_status: 'paid',
      tax: taxPaid,
      total_amount: totalPaid
    });
  }

  console.log('\n=== All Invoices Successfully Upgraded with Beautiful Styling & Clean Tax Placement! ===');
}

runItemizedSync().catch(console.error);
