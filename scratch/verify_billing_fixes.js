const fs = require('fs');
const path = require('path');

global.window = global;

const mockFacilities = [
  { id: 'facility_seattle_north', name: 'Seattle North Hub', tier1_rate: 5.0, valet_base: 15.0, valet_tote_adder: 1.0 },
  { id: 'facility_portland_central', name: 'Portland Central Hub', tier1_rate: 5.0, valet_base: 15.0, valet_tote_adder: 1.0 }
];

const mockInvoices = [];
const mockSubscriptions = [
  { uid: 'user_123', total_totes: 5, status: 'pending' }
];
const mockCharges = [
  { id: 'chg_001', uid: 'user_123', amount: 45.00, charge_type: 'Late Fee', status: 'success', charged_at: '2026-08-01T10:00:00Z' }
];

function createQueryChain(table) {
  let filteredData = table === 'invoices' ? mockInvoices : (table === 'facilities' ? mockFacilities : (table === 'charges' ? mockCharges : []));
  const chain = {
    eq: (col, val) => {
      if (table === 'facilities') {
        const f = mockFacilities.find(x => x[col] === val);
        filteredData = f ? [f] : [];
      } else if (table === 'users') {
        filteredData = [{ id: 'user_123', name: 'Test User', email: 'test@example.com', assigned_facility_id: 'facility_seattle_north' }];
      } else {
        filteredData = filteredData.filter(x => x[col] === val);
      }
      return chain;
    },
    maybeSingle: async () => {
      return { data: filteredData[0] || null, error: null };
    },
    single: async () => {
      return { data: filteredData[0] || null, error: null };
    },
    limit: (n) => chain,
    order: (ordCol, opts) => chain,
    or: (orCond) => chain,
    then: (resolve, reject) => resolve({ data: filteredData, error: null })
  };
  return chain;
}

global.supabase = {
  from: (table) => ({
    select: (cols) => createQueryChain(table),
    insert: (arr) => ({
      select: () => ({
        single: async () => {
          const item = { id: 'inv_' + Date.now(), ...arr[0] };
          if (table === 'invoices') mockInvoices.push(item);
          return { data: item, error: null };
        }
      })
    }),
    update: (payload) => ({
      eq: (col, val) => {
        if (table === 'subscriptions') {
          const sub = mockSubscriptions.find(s => s[col] === val);
          if (sub) Object.assign(sub, payload);
        }
        return Promise.resolve({ data: payload, error: null });
      }
    })
  })
};

// Load billing-engine.js
const code = fs.readFileSync(path.join(__dirname, '..', 'billing-engine.js'), 'utf8');
eval(code);

async function runTests() {
  console.log('--- TEST 1: Facility ID Validation (Issue #44) ---');
  const valid1 = await window.CloudVaultBilling.validateFacilityId('facility_portland_central');
  console.log('Valid ID test:', valid1 === 'facility_portland_central' ? 'PASS' : 'FAIL (' + valid1 + ')');

  const invalid1 = await window.CloudVaultBilling.validateFacilityId('CV-SEA-01');
  console.log('Invalid ID test (fallback):', invalid1 === 'facility_seattle_north' ? 'PASS' : 'FAIL (' + invalid1 + ')');

  const null1 = await window.CloudVaultBilling.validateFacilityId(null);
  console.log('Null ID test (fallback):', null1 === 'facility_seattle_north' ? 'PASS' : 'FAIL (' + null1 + ')');

  const invRec = await window.CloudVaultBilling.createInvoiceRecord({
    uid: 'user_123',
    facility_id: 'CV-SEA-01',
    total_amount: 50.00
  });
  console.log('createInvoiceRecord facility_id resolved to:', invRec.data.facility_id, invRec.data.facility_id === 'facility_seattle_north' ? 'PASS' : 'FAIL');

  console.log('\n--- TEST 2: Signup Invoice Immediate Charge & Next Billing Date (Issue #31, #37) ---');
  const signupRes = await window.CloudVaultBilling.createSignupInvoice('user_123', {
    total_totes: 10,
    facility_id: 'facility_seattle_north',
    customer_name: 'Test Customer'
  });
  console.log('Signup Invoice payment_status:', signupRes.data.payment_status, signupRes.data.payment_status === 'paid' ? 'PASS' : 'FAIL');
  console.log('Signup Invoice paid_at:', signupRes.data.paid_at ? 'PASS' : 'FAIL');
  
  const sub = mockSubscriptions[0];
  console.log('Subscription next_billing_date updated:', sub.next_billing_date, sub.next_billing_date ? 'PASS' : 'FAIL');

  console.log('\n--- TEST 3: Access Request / Retrieval Flow Invoice (Issue #42) ---');
  const arRes = await window.CloudVaultBilling.createAccessRequestInvoice({
    id: 'req_99',
    uid: 'user_123',
    fulfillment_type: 'valet_delivery',
    requested_tote_codes: ['CV-SEA-10A', 'CV-SEA-10B'],
    valet_fee: 17.00,
    surge_fee: 5.00,
    subtotal: 0.00,
    status: 'scheduled'
  }, { name: 'Test User', assigned_facility_id: 'facility_seattle_north' });

  console.log('AR Invoice total_amount:', arRes.data.total_amount, arRes.data.total_amount === 22.00 ? 'PASS' : 'FAIL');
  console.log('AR Invoice delivery_fee:', arRes.data.delivery_fee, arRes.data.delivery_fee === 17.00 ? 'PASS' : 'FAIL');
  console.log('AR Invoice surge_fee:', arRes.data.surge_fee, arRes.data.surge_fee === 5.00 ? 'PASS' : 'FAIL');
  console.log('AR Invoice line items count:', arRes.data.line_items.length, arRes.data.line_items.length === 3 ? 'PASS' : 'FAIL');

  console.log('\n--- TEST 4: Synchronize Charges to Invoices (Issue #43) ---');
  const syncRes = await window.CloudVaultBilling.syncChargesToInvoices('user_123');
  console.log('Sync charges count:', syncRes.syncedCount, syncRes.syncedCount === 1 ? 'PASS' : 'FAIL');

  const userInvoices = await window.CloudVaultBilling.fetchInvoicesForUser('user_123', 'test@example.com');
  console.log('Fetch invoices count:', userInvoices.invoices.length, userInvoices.invoices.length === 4 ? 'PASS' : 'FAIL');
}

runTests().catch(err => console.error('Verification script error:', err));
