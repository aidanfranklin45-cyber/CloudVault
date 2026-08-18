// scratch/test_stripe_webhook.js
const { processStripeWebhookEvent } = require('../stripe-webhook-handler');

async function testWebhookFlow() {
  console.log('--- Starting Stripe Webhook Flow Tests ---');

  // Test 1: checkout.session.completed for bob3@test.com (cus_V692PDhKxU56DW)
  const checkoutEvent = {
    id: `evt_test_checkout_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_sample_session_123',
        customer: 'cus_V692PDhKxU56DW',
        subscription: 'sub_test_sample_sub_456',
        client_reference_id: '9ec3e1e8-06b2-4c1d-850a-ab399cfc127e', // Bob's ID
        customer_email: 'bob3@test.com',
        customer_details: { email: 'bob3@test.com' }
      }
    }
  };

  console.log('\nTesting checkout.session.completed...');
  const res1 = await processStripeWebhookEvent(checkoutEvent);
  console.log('Result 1:', res1);

  // Test 2: Idempotency check (sending same event again)
  console.log('\nTesting Idempotent Re-delivery of same event...');
  const resIdempotent = await processStripeWebhookEvent(checkoutEvent);
  console.log('Result Idempotency:', resIdempotent);

  // Test 3: invoice.paid with Stripe Tax and PDF/Hosted URLs
  const invoiceEvent = {
    id: `evt_test_inv_paid_${Date.now()}`,
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_test_${Date.now()}`,
        number: `INV-2026-${Math.floor(10000 + Math.random() * 90000)}`,
        customer: 'cus_V692PDhKxU56DW',
        customer_email: 'bob3@test.com',
        customer_name: 'Bob',
        payment_intent: 'pi_test_intent_789',
        hosted_invoice_url: 'https://invoice.stripe.com/i/acct_test/test_invoice_sample',
        invoice_pdf: 'https://pay.stripe.com/invoice/acct_test/inv_test_sample/pdf',
        subtotal: 2500, // $25.00
        tax: 215, // $2.15 (8.6% Washington State / Selah Local Tax via Stripe Tax)
        total: 2715, // $27.15
        amount_paid: 2715,
        amount_due: 2715,
        amount_remaining: 0,
        subscription: 'sub_test_sample_sub_456',
        status_transitions: {
          paid_at: Math.floor(Date.now() / 1000)
        },
        lines: {
          data: [
            {
              id: 'il_test_1',
              description: 'CloudVault 5-Tote Vault Storage Plan (Selah, WA)',
              amount: 2500,
              quantity: 5,
              unit_amount: 500,
              tax_amounts: [
                {
                  amount: 215,
                  tax_rate: {
                    id: 'txr_wa_selah',
                    jurisdiction: 'WA, US'
                  }
                }
              ]
            }
          ]
        }
      }
    }
  };

  console.log('\nTesting invoice.paid with Stripe Tax & Hosted URLs...');
  const res3 = await processStripeWebhookEvent(invoiceEvent);
  console.log('Result 3:', res3);

  // Test 4: customer.subscription.updated (tote quantity change)
  const subUpdateEvent = {
    id: `evt_test_sub_upd_${Date.now()}`,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_test_sample_sub_456',
        customer: 'cus_V692PDhKxU56DW',
        status: 'active',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        cancel_at_period_end: false,
        items: {
          data: [
            {
              id: 'si_test_1',
              quantity: 8,
              price: { id: 'price_test_tier1_storage' }
            }
          ]
        }
      }
    }
  };

  console.log('\nTesting customer.subscription.updated...');
  const res4 = await processStripeWebhookEvent(subUpdateEvent);
  console.log('Result 4:', res4);

  console.log('\n--- All Stripe Webhook Flow Tests Completed Successfully! ---');
}

testWebhookFlow().catch(console.error);
