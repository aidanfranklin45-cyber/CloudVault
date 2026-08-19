// scratch/cleanup_employee_invoices.js
const https = require('https');

const SUPABASE_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ';

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
          resolve({ status: res.statusCode, data: JSON.parse(data || '[]') });
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

async function cleanupEmployeeInvoices() {
  const employeeEmails = [
    'aidan.exec@cloudvault.com',
    'manager.seattle@cloudvault.com',
    'worker.seattle@cloudvault.com',
    'ellie@test.com'
  ];

  console.log('Fetching invoices to clean up employee records...');
  const invRes = await supabaseRequest('invoices?select=*');
  const invoices = invRes.data || [];

  for (const inv of invoices) {
    const email = (inv.customer_email || '').toLowerCase();
    const isEmployee = employeeEmails.some(e => email === e.toLowerCase());

    if (isEmployee) {
      console.log(`Deleting employee invoice: ${inv.invoice_number} (${email})`);
      await supabaseRequest(`invoices?id=eq.${inv.id}`, 'DELETE');
    }
  }

  console.log('\n=== Employee Invoices Successfully Cleaned Up ===');
  const remaining = await supabaseRequest('invoices?select=invoice_number,customer_email,total_amount');
  console.log(`Remaining Customer Invoices (${remaining.data?.length || 0}):`);
  remaining.data?.forEach(i => console.log(` - ${i.invoice_number}: ${i.customer_email} ($${i.total_amount})`));
}

cleanupEmployeeInvoices().catch(console.error);
