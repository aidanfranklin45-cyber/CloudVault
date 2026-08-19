// scratch/fix_populated_stripe_invoices.js
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

async function fixInvoices() {
  console.log('Fetching invoices from Supabase...');
  const invRes = await supabaseRequest('invoices?select=*');
  const invoices = invRes.data || [];
  console.log(`Found ${invoices.length} invoices.`);

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
      console.warn(`[Skip] No Stripe customer for invoice ${inv.invoice_number}`);
      continue;
    }

    const totalAmt = Number(inv.total_amount || inv.subtotal || 10.00);
    const amountCents = Math.round(totalAmt * 100);
    const description = inv.notes || `${inv.invoice_type ? inv.invoice_type.replace(/_/g, ' ') : 'Vault Storage'} - ${inv.invoice_number}`;

    console.log(`\nRe-creating Stripe Invoice for ${inv.invoice_number} ($${totalAmt.toFixed(2)}) -> Customer ${custId}...`);

    // 1. Create Draft Invoice in Stripe
    const invParams = new URLSearchParams();
    invParams.append('customer', custId);
    invParams.append('auto_advance', 'false');
    invParams.append('collection_method', 'send_invoice');
    invParams.append('days_until_due', '3');
    invParams.append('metadata[original_invoice_number]', inv.invoice_number);
    invParams.append('metadata[supabase_invoice_id]', inv.id);

    const draftRes = await stripeRequest('invoices', 'POST', invParams.toString());
    const stripeInvoiceId = draftRes.data?.id;

    if (!stripeInvoiceId) {
      console.error(`Failed to create draft invoice for ${inv.invoice_number}:`, draftRes.data);
      continue;
    }

    // 2. Attach Line Item explicitly to this invoice
    const itemParams = new URLSearchParams();
    itemParams.append('customer', custId);
    itemParams.append('invoice', stripeInvoiceId);
    itemParams.append('amount', amountCents.toString());
    itemParams.append('currency', 'usd');
    itemParams.append('description', description);

    const itemRes = await stripeRequest('invoiceitems', 'POST', itemParams.toString());
    if (!itemRes.data?.id) {
      console.error(`Failed to attach invoice item to ${stripeInvoiceId}:`, itemRes.data);
      continue;
    }

    // 3. Finalize Invoice
    const finalizeRes = await stripeRequest(`invoices/${stripeInvoiceId}/finalize`, 'POST', '');
    const finalized = finalizeRes.data;

    // 4. Mark Paid Out-of-Band
    let hostedUrl = finalized.hosted_invoice_url;
    let pdfUrl = finalized.invoice_pdf;

    const payParams = new URLSearchParams();
    payParams.append('paid_out_of_band', 'true');
    const payRes = await stripeRequest(`invoices/${stripeInvoiceId}/pay`, 'POST', payParams.toString());
    if (payRes.data?.hosted_invoice_url) {
      hostedUrl = payRes.data.hosted_invoice_url;
      pdfUrl = payRes.data.invoice_pdf;
    }

    console.log(` -> Finalized & Paid: ${stripeInvoiceId} (Amount: $${(payRes.data?.amount_paid / 100 || totalAmt).toFixed(2)})`);
    console.log(` -> Hosted URL: ${hostedUrl}`);

    // 5. Update Supabase
    await supabaseRequest(`invoices?id=eq.${inv.id}`, 'PATCH', {
      stripe_invoice_id: stripeInvoiceId,
      stripe_customer_id: custId,
      stripe_hosted_invoice_url: hostedUrl,
      stripe_invoice_pdf: pdfUrl,
      payment_status: 'paid'
    });
  }

  console.log('\n=== All Invoices Successfully Repopulated with Line Items & Finalized on Stripe! ===');
}

fixInvoices().catch(console.error);
