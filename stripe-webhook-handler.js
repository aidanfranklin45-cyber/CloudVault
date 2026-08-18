/**
 * CloudVault Stripe Webhook Handler & Event Reconciliation Service
 * Processes verified incoming Stripe webhooks and acts as the source of truth for all billing state.
 * Uses dependency-free native HTTPS requests for rock-solid portability across Node/Serverless runtimes.
 */

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xbxvebnrjryvksvtufqj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'sb_publishable_-cW5neaZRGmicOHaHw1n3g_laY5yFZQ';

function supabaseRequest(endpoint, method = 'GET', body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${endpoint}`);
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...extraHeaders
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
 * Main Webhook Processing Pipeline
 * @param {Object} event - Stripe Event Object
 * @returns {Promise<{success: boolean, eventId: string, eventType: string, message: string}>}
 */
async function processStripeWebhookEvent(event) {
  if (!event || !event.id || !event.type) {
    throw new Error('Invalid Stripe event payload: missing id or type.');
  }

  const eventId = event.id;
  const eventType = event.type;
  const dataObject = event.data ? event.data.object : null;

  console.log(`[StripeWebhook] Processing Event ${eventId} [${eventType}]...`);

  // 1. Strict Idempotency Check
  const checkRes = await supabaseRequest(`stripe_webhook_events?stripe_event_id=eq.${eventId}&select=id,status`);
  if (Array.isArray(checkRes.data) && checkRes.data.length > 0 && checkRes.data[0].status === 'processed') {
    console.log(`[StripeWebhook] Event ${eventId} already processed. Skipping for idempotency.`);
    return { success: true, eventId, eventType, message: 'Already processed (idempotent skip)' };
  }

  try {
    // 2. Dispatch event to handler
    switch (eventType) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(dataObject);
        break;

      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handleInvoicePaid(dataObject);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(dataObject);
        break;

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(dataObject);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(dataObject);
        break;

      case 'charge.succeeded':
      case 'payment_intent.succeeded':
        await handlePaymentSucceeded(dataObject);
        break;

      default:
        console.log(`[StripeWebhook] Unhandled event type: ${eventType}. Recorded for audit.`);
        break;
    }

    // 3. Log event into public.stripe_webhook_events as processed
    await supabaseRequest('stripe_webhook_events', 'POST', {
      stripe_event_id: eventId,
      event_type: eventType,
      payload: event,
      status: 'processed'
    }, { 'Prefer': 'resolution=merge-duplicates' });

    console.log(`[StripeWebhook] Successfully processed & logged event ${eventId} [${eventType}]`);
    return { success: true, eventId, eventType, message: 'Successfully processed' };

  } catch (error) {
    console.error(`[StripeWebhook] Error processing event ${eventId}:`, error.message);
    await supabaseRequest('stripe_webhook_events', 'POST', {
      stripe_event_id: eventId,
      event_type: eventType,
      payload: { error: error.message, event },
      status: 'failed'
    }, { 'Prefer': 'resolution=merge-duplicates' });

    throw error;
  }
}

/**
 * Handle checkout.session.completed
 */
async function handleCheckoutSessionCompleted(session) {
  if (!session) return;
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const userUid = session.client_reference_id || session.metadata?.supabase_uid;
  const customerEmail = session.customer_details?.email || session.customer_email;

  console.log(`[StripeWebhook] checkout.session.completed: userUid=${userUid}, customerId=${customerId}, subId=${subscriptionId}`);

  let targetUserId = userUid;
  if (!targetUserId && customerId) {
    const uRes = await supabaseRequest(`users?stripe_customer_id=eq.${customerId}&select=id`);
    if (Array.isArray(uRes.data) && uRes.data.length > 0) targetUserId = uRes.data[0].id;
  }
  if (!targetUserId && customerEmail) {
    const uRes = await supabaseRequest(`users?email=eq.${encodeURIComponent(customerEmail)}&select=id`);
    if (Array.isArray(uRes.data) && uRes.data.length > 0) targetUserId = uRes.data[0].id;
  }

  if (targetUserId) {
    await supabaseRequest(`users?id=eq.${targetUserId}`, 'PATCH', {
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId || null,
      subscription_status: 'active',
      is_overdue: false,
      onboarding_status: 'active'
    });
  }
}

/**
 * Handle invoice.paid & invoice.payment_succeeded
 */
async function handleInvoicePaid(invoice) {
  if (!invoice) return;
  const stripeInvoiceId = invoice.id;
  const customerId = invoice.customer;
  const customerEmail = invoice.customer_email;
  const paymentIntentId = invoice.payment_intent;
  const hostedUrl = invoice.hosted_invoice_url;
  const pdfUrl = invoice.invoice_pdf;

  const subtotal = (invoice.subtotal || 0) / 100;
  const tax = (invoice.tax || 0) / 100;
  const total = (invoice.total || 0) / 100;
  const amountPaid = (invoice.amount_paid || 0) / 100;
  const amountDue = (invoice.amount_due || 0) / 100;
  const amountRemaining = (invoice.amount_remaining || 0) / 100;

  console.log(`[StripeWebhook] invoice.paid: ${stripeInvoiceId} for customer ${customerId}, Total=$${total}, Tax=$${tax}`);

  let uid = null;
  let userName = null;
  if (customerId) {
    const uRes = await supabaseRequest(`users?stripe_customer_id=eq.${customerId}&select=id,name`);
    if (Array.isArray(uRes.data) && uRes.data.length > 0) {
      uid = uRes.data[0].id;
      userName = uRes.data[0].name;
    }
  }
  if (!uid && customerEmail) {
    const uRes = await supabaseRequest(`users?email=eq.${encodeURIComponent(customerEmail)}&select=id,name`);
    if (Array.isArray(uRes.data) && uRes.data.length > 0) {
      uid = uRes.data[0].id;
      userName = uRes.data[0].name;
    }
  }

  const lines = (invoice.lines?.data || []).map(line => ({
    id: line.id,
    description: line.description,
    amount: (line.amount || 0) / 100,
    quantity: line.quantity || 1,
    unit_amount: (line.price?.unit_amount || line.amount || 0) / 100,
    tax_amounts: (line.tax_amounts || []).map(t => ({
      amount: (t.amount || 0) / 100,
      tax_rate: t.tax_rate?.id,
      jurisdiction: t.tax_rate?.jurisdiction
    }))
  }));

  const existingRes = await supabaseRequest(`invoices?stripe_invoice_id=eq.${stripeInvoiceId}&select=id`);
  const invoiceRecord = {
    invoice_number: invoice.number || `INV-${stripeInvoiceId.substring(3, 13).toUpperCase()}`,
    stripe_invoice_id: stripeInvoiceId,
    stripe_customer_id: customerId,
    stripe_payment_intent_id: typeof paymentIntentId === 'string' ? paymentIntentId : null,
    stripe_hosted_invoice_url: hostedUrl,
    stripe_invoice_pdf: pdfUrl,
    uid: uid,
    customer_name: userName || invoice.customer_name || 'CloudVault Customer',
    customer_email: customerEmail,
    invoice_type: invoice.subscription ? 'subscription' : 'one_time',
    payment_status: 'paid',
    subtotal: subtotal,
    tax: tax,
    total_amount: total,
    amount_due: amountDue,
    amount_paid: amountPaid,
    amount_remaining: amountRemaining,
    payment_method: 'stripe',
    transaction_reference: typeof paymentIntentId === 'string' ? paymentIntentId : stripeInvoiceId,
    line_items: lines,
    paid_at: invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : new Date().toISOString()
  };

  if (Array.isArray(existingRes.data) && existingRes.data.length > 0) {
    await supabaseRequest(`invoices?id=eq.${existingRes.data[0].id}`, 'PATCH', invoiceRecord);
  } else {
    await supabaseRequest('invoices', 'POST', invoiceRecord);
  }

  if (uid) {
    await supabaseRequest(`users?id=eq.${uid}`, 'PATCH', {
      is_overdue: false,
      subscription_status: 'active'
    });
  }
}

/**
 * Handle invoice.payment_failed
 */
async function handleInvoicePaymentFailed(invoice) {
  if (!invoice) return;
  const stripeInvoiceId = invoice.id;
  const customerId = invoice.customer;
  console.warn(`[StripeWebhook] invoice.payment_failed: ${stripeInvoiceId} for customer ${customerId}`);

  const uRes = await supabaseRequest(`users?stripe_customer_id=eq.${customerId}&select=id`);
  if (Array.isArray(uRes.data) && uRes.data.length > 0) {
    await supabaseRequest(`users?id=eq.${uRes.data[0].id}`, 'PATCH', {
      is_overdue: true,
      subscription_status: 'past_due'
    });
  }

  await supabaseRequest(`invoices?stripe_invoice_id=eq.${stripeInvoiceId}`, 'PATCH', {
    payment_status: 'failed'
  });
}

/**
 * Handle customer.subscription.created & updated
 */
async function handleSubscriptionUpdated(subscription) {
  if (!subscription) return;
  const subId = subscription.id;
  const customerId = subscription.customer;
  const status = subscription.status;
  const quantity = subscription.items?.data[0]?.quantity || 1;
  const priceId = subscription.items?.data[0]?.price?.id || null;
  const currentPeriodStart = subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : null;
  const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
  const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;

  console.log(`[StripeWebhook] subscription.updated: ${subId}, status=${status}, quantity=${quantity}`);

  let uid = null;
  const uRes = await supabaseRequest(`users?stripe_customer_id=eq.${customerId}&select=id`);
  if (Array.isArray(uRes.data) && uRes.data.length > 0) {
    uid = uRes.data[0].id;
    await supabaseRequest(`users?id=eq.${uid}`, 'PATCH', {
      stripe_subscription_id: subId,
      subscription_status: status,
      is_overdue: (status === 'past_due' || status === 'unpaid')
    });
  }

  const existingSubRes = await supabaseRequest(`subscriptions?stripe_subscription_id=eq.${subId}&select=id`);
  const subData = {
    uid: uid,
    stripe_subscription_id: subId,
    stripe_customer_id: customerId,
    stripe_price_id: priceId,
    quantity: quantity,
    status: status,
    current_period_start: currentPeriodStart,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    last_updated: new Date().toISOString()
  };

  if (Array.isArray(existingSubRes.data) && existingSubRes.data.length > 0) {
    await supabaseRequest(`subscriptions?id=eq.${existingSubRes.data[0].id}`, 'PATCH', subData);
  } else {
    await supabaseRequest('subscriptions', 'POST', subData);
  }
}

/**
 * Handle customer.subscription.deleted
 */
async function handleSubscriptionDeleted(subscription) {
  if (!subscription) return;
  const subId = subscription.id;
  const customerId = subscription.customer;
  console.log(`[StripeWebhook] subscription.deleted: ${subId}`);

  const uRes = await supabaseRequest(`users?stripe_customer_id=eq.${customerId}&select=id`);
  if (Array.isArray(uRes.data) && uRes.data.length > 0) {
    await supabaseRequest(`users?id=eq.${uRes.data[0].id}`, 'PATCH', {
      subscription_status: 'canceled'
    });
  }

  await supabaseRequest(`subscriptions?stripe_subscription_id=eq.${subId}`, 'PATCH', {
    status: 'canceled',
    canceled_at: new Date().toISOString()
  });
}

/**
 * Handle charge.succeeded / payment_intent.succeeded
 */
async function handlePaymentSucceeded(charge) {
  if (!charge) return;
  const chargeId = charge.id;
  const customerId = charge.customer;
  const amount = (charge.amount || 0) / 100;
  const receiptUrl = charge.receipt_url || null;
  const brand = charge.payment_method_details?.card?.brand || 'card';
  const last4 = charge.payment_method_details?.card?.last4 || null;

  let uid = null;
  if (customerId) {
    const uRes = await supabaseRequest(`users?stripe_customer_id=eq.${customerId}&select=id`);
    if (Array.isArray(uRes.data) && uRes.data.length > 0) uid = uRes.data[0].id;
  }

  await supabaseRequest('charges', 'POST', {
    uid: uid,
    charge_type: charge.description || 'stripe_payment',
    amount: amount,
    status: 'success',
    stripe_charge_id: chargeId,
    stripe_payment_intent_id: charge.payment_intent || null,
    receipt_url: receiptUrl,
    payment_method_brand: brand,
    payment_method_last4: last4,
    charged_at: new Date().toISOString()
  });
}

module.exports = {
  processStripeWebhookEvent,
  handleCheckoutSessionCompleted,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted
};
