// scratch/backfill_stripe_customers.js
const https = require('https');

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_RESTRICTED_KEY;
const SUPABASE_URL = 'https://xbxvebnrjryvksvtufqj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ';

function makeRequest(url, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
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
      req.write(postData);
    }
    req.end();
  });
}

async function findOrCreateStripeCustomer(user) {
  const emailParam = encodeURIComponent(user.email);
  // 1. Search existing in Stripe
  const searchRes = await makeRequest(`https://api.stripe.com/v1/customers?email=${emailParam}&limit=1`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${STRIPE_KEY}` }
  });

  if (searchRes.data && searchRes.data.data && searchRes.data.data.length > 0) {
    const existing = searchRes.data.data[0];
    console.log(`[Stripe] Found existing customer for ${user.email}: ${existing.id}`);
    return existing.id;
  }

  // 2. Create customer if not found
  const params = new URLSearchParams();
  params.append('email', user.email);
  params.append('name', user.name || 'CloudVault User');
  if (user.phone) params.append('phone', user.phone);
  params.append('metadata[supabase_uid]', user.id);
  params.append('metadata[role]', user.role || 'customer');
  params.append('address[line1]', '100 Vault Way');
  params.append('address[city]', 'Selah');
  params.append('address[state]', 'WA');
  params.append('address[postal_code]', '98942');
  params.append('address[country]', 'US');

  const createRes = await makeRequest('https://api.stripe.com/v1/customers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${STRIPE_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  }, params.toString());

  if (createRes.data && createRes.data.id) {
    console.log(`[Stripe] Created new customer for ${user.email}: ${createRes.data.id}`);
    return createRes.data.id;
  } else {
    console.error(`[Stripe] Failed to create customer for ${user.email}:`, createRes);
    return null;
  }
}

async function run() {
  console.log('Fetching users from Supabase...');
  const usersRes = await makeRequest(`${SUPABASE_URL}/rest/v1/users?select=id,email,name,phone,role,stripe_customer_id`, {
    method: 'GET',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    }
  });

  if (!Array.isArray(usersRes.data)) {
    console.error('Failed to fetch users:', usersRes);
    return;
  }

  console.log(`Found ${usersRes.data.length} users.`);

  for (const user of usersRes.data) {
    try {
      let stripeCustId = user.stripe_customer_id;
      if (!stripeCustId) {
        stripeCustId = await findOrCreateStripeCustomer(user);
        if (stripeCustId) {
          // Update in Supabase
          const patchRes = await makeRequest(`${SUPABASE_URL}/rest/v1/users?id=eq.${user.id}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation'
            }
          }, JSON.stringify({ stripe_customer_id: stripeCustId }));

          console.log(`[Supabase] Updated ${user.email} -> ${stripeCustId} (Status: ${patchRes.status})`);
        }
      } else {
        console.log(`[Skip] User ${user.email} already has stripe_customer_id: ${stripeCustId}`);
      }
    } catch (err) {
      console.error(`Error processing user ${user.email}:`, err.message);
    }
  }

  console.log('Finished backfill!');
}

run();
