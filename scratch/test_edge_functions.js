const https = require('https');

const SUPABASE_URL = "https://xbxvebnrjryvksvtufqj.supabase.co";
const ANON_KEY = "sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ";

async function request(endpoint, method = 'POST', body = null, headers = {}) {
  const url = new URL(`${SUPABASE_URL}/functions/v1/${endpoint}`);
  return new Promise((resolve, reject) => {
    const reqHeaders = {
      'apikey': ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
      ...headers
    };

    const req = https.request(url, {
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, data: json });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("=== SUPABASE EDGE FUNCTIONS INTEGRATION TEST SUITE ===\n");
  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
    }
  }

  // -------------------------------------------------------------
  // Test 1: CORS Preflight (OPTIONS) on all functions
  // -------------------------------------------------------------
  console.log("--- 1. Testing CORS OPTIONS Preflight ---");
  for (const fn of ['stripe-checkout', 'stripe-billing-portal', 'stripe-subscription-update', 'stripe-webhook']) {
    const res = await request(fn, 'OPTIONS');
    assert(res.status === 200, `${fn} OPTIONS returns status 200`);
    assert(res.headers['access-control-allow-origin'] === '*', `${fn} has CORS Access-Control-Allow-Origin: *`);
  }

  // -------------------------------------------------------------
  // Test 2: stripe-checkout validation & dynamic calculations
  // -------------------------------------------------------------
  console.log("\n--- 2. Testing stripe-checkout ---");
  
  // 2a. Missing facilityId
  const resMissingFac = await request('stripe-checkout', 'POST', {
    toteCount: 5,
    successUrl: "https://cloudvault.app/success",
    cancelUrl: "https://cloudvault.app/cancel"
  });
  assert(resMissingFac.status === 400 && resMissingFac.data.error?.includes("facilityId"), "stripe-checkout rejects missing facilityId with 400");

  // 2b. Non-existent facilityId
  const resInvalidFac = await request('stripe-checkout', 'POST', {
    facilityId: "facility_non_existent_999",
    toteCount: 5,
    successUrl: "https://cloudvault.app/success",
    cancelUrl: "https://cloudvault.app/cancel"
  });
  assert(resInvalidFac.status === 404 && resInvalidFac.data.error?.includes("not found"), "stripe-checkout rejects invalid facility with 404");

  // 2c. Valid facility dynamic checkout (Seattle North, 12 totes -> Tier 2 rate = $3.50, unitAmountCents = 350)
  const resValidSea = await request('stripe-checkout', 'POST', {
    facilityId: "facility_seattle_north",
    toteCount: 12,
    logisticsType: "valet",
    promoCode: "ROSS20%",
    successUrl: "https://cloudvault.app/success",
    cancelUrl: "https://cloudvault.app/cancel"
  });
  console.log("Seattle Checkout Response:", JSON.stringify(resValidSea.data, null, 2));
  assert(resValidSea.status === 200, "stripe-checkout returns 200 for valid Seattle North request");
  assert(resValidSea.data.ratePerTote === 3.50, "stripe-checkout correctly resolved Seattle Tier 2 rate ($3.50)");
  assert(resValidSea.data.unitAmountCents === 350, "stripe-checkout calculated unitAmountCents as 350");
  assert(typeof resValidSea.data.url === 'string' && resValidSea.data.url.includes("stripe.com"), "stripe-checkout returns valid Stripe checkout session URL");

  // 2d. Valid facility dynamic checkout (Yakima, 30 totes -> Tier 3 rate = $2.50, unitAmountCents = 250)
  const resValidYak = await request('stripe-checkout', 'POST', {
    facilityId: "facility_yakima",
    toteCount: 30,
    logisticsType: "customer_dropoff",
    successUrl: "https://cloudvault.app/success",
    cancelUrl: "https://cloudvault.app/cancel"
  });
  console.log("Yakima Checkout Response:", JSON.stringify(resValidYak.data, null, 2));
  assert(resValidYak.status === 200, "stripe-checkout returns 200 for valid Yakima request");
  assert(resValidYak.data.ratePerTote === 2.50, "stripe-checkout correctly resolved Yakima Tier 3 rate ($2.50)");
  assert(resValidYak.data.unitAmountCents === 250, "stripe-checkout calculated unitAmountCents as 250");

  // -------------------------------------------------------------
  // Test 3: stripe-billing-portal
  // -------------------------------------------------------------
  console.log("\n--- 3. Testing stripe-billing-portal ---");

  // 3a. Missing user & customer
  const resMissingCust = await request('stripe-billing-portal', 'POST', {});
  assert(resMissingCust.status === 404, "stripe-billing-portal rejects missing customer with 404");

  // 3b. Non-existent user
  const resNoUser = await request('stripe-billing-portal', 'POST', {
    userId: "00000000-0000-0000-0000-000000000000"
  });
  assert(resNoUser.status === 404, "stripe-billing-portal returns 404 when user has no linked stripe_customer_id");

  // -------------------------------------------------------------
  // Test 4: stripe-subscription-update
  // -------------------------------------------------------------
  console.log("\n--- 4. Testing stripe-subscription-update ---");

  // 4a. Missing userId
  const resSubMissing = await request('stripe-subscription-update', 'POST', {
    targetToteCount: 15
  });
  assert(resSubMissing.status === 400 && resSubMissing.data.error?.includes("userId"), "stripe-subscription-update rejects missing userId with 400");

  // 4b. Dynamic rate update for existing customer (tea@test.com)
  const resSubValid = await request('stripe-subscription-update', 'POST', {
    userId: "71a548ef-310f-41b5-8332-4658224aeac5",
    targetToteCount: 28,
    facilityId: "facility_yakima"
  });
  console.log("Subscription Update Response:", JSON.stringify(resSubValid.data, null, 2));
  assert(resSubValid.status === 200, "stripe-subscription-update returns 200 for valid update");
  assert(resSubValid.data.newQuantity === 28, "stripe-subscription-update returned newQuantity 28");
  assert(resSubValid.data.newRate === 2.50, "stripe-subscription-update resolved Yakima Tier 3 rate ($2.50) for 28 totes");
  assert(resSubValid.data.monthlyTotal === 70.00, "stripe-subscription-update calculated monthlyTotal as $70.00 (28 * 2.50)");

  // -------------------------------------------------------------
  // Test 5: stripe-webhook
  // -------------------------------------------------------------
  console.log("\n--- 5. Testing stripe-webhook ---");

  // Missing stripe-signature header rejected with 400
  const resWebhookMissingSig = await request('stripe-webhook', 'POST', { test: true });
  assert(resWebhookMissingSig.status === 400, "stripe-webhook rejects request missing stripe-signature with 400");

  console.log(`\n========================================`);
  console.log(`RESULTS: ${passed} / ${total} assertions passed (${Math.round((passed / total) * 100)}%)`);
  console.log(`========================================\n`);

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
