import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 1. Signature Verification
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    console.error("Missing stripe-signature header");
    return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      webhookSecret,
      undefined,
      cryptoProvider
    );
  } catch (err: any) {
    console.error(`⚠️ Webhook signature verification failed: ${err.message}`);
    return new Response(
      JSON.stringify({ error: `Webhook signature verification failed: ${err.message}` }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  console.log(`[StripeWebhook] Processing Event ${event.id} [${event.type}]...`);

  // Initialize Supabase Client with service role for full admin access
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false },
  });

  // 2. Strict Idempotency Check
  const { data: existingEvent } = await supabase
    .from("stripe_webhook_events")
    .select("id, status")
    .eq("stripe_event_id", event.id)
    .maybeSingle();

  if (existingEvent && existingEvent.status === "processed") {
    console.log(`[StripeWebhook] Event ${event.id} already processed. Skipping for idempotency.`);
    return new Response(JSON.stringify({ received: true, idempotent_skip: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const dataObject = event.data.object as any;

    switch (event.type) {
      // -------------------------------------------------------------
      // Event: payment_intent.succeeded
      // -------------------------------------------------------------
      case "payment_intent.succeeded": {
        const paymentIntent = dataObject as Stripe.PaymentIntent;
        const customerId = typeof paymentIntent.customer === "string" ? paymentIntent.customer : null;
        const metadata = paymentIntent.metadata || {};
        const invoiceId = metadata.invoice_id || null;
        const reservationId = metadata.reservation_id || metadata.staging_reservation_id || null;
        const accessRequestId = metadata.access_request_id || null;
        const amountReceived = (paymentIntent.amount_received || paymentIntent.amount || 0) / 100;
        const nowIso = new Date().toISOString();

        console.log(`[StripeWebhook] payment_intent.succeeded: ${paymentIntent.id}, Amount=$${amountReceived}, Customer=${customerId}`);

        // Resolve user ID if possible
        let targetUid = metadata.supabase_uid || metadata.uid || null;
        if (!targetUid && customerId) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();
          if (u) targetUid = u.id;
        }

        // 1. Match and update public.invoices
        if (invoiceId) {
          await supabase
            .from("invoices")
            .update({
              payment_status: "paid",
              paid_at: nowIso,
              stripe_payment_intent_id: paymentIntent.id,
              amount_paid: amountReceived,
              amount_remaining: 0,
            })
            .eq("id", invoiceId);
        } else if (paymentIntent.invoice && typeof paymentIntent.invoice === "string") {
          await supabase
            .from("invoices")
            .update({
              payment_status: "paid",
              paid_at: nowIso,
              stripe_payment_intent_id: paymentIntent.id,
              amount_paid: amountReceived,
              amount_remaining: 0,
            })
            .eq("stripe_invoice_id", paymentIntent.invoice);
        } else {
          await supabase
            .from("invoices")
            .update({
              payment_status: "paid",
              paid_at: nowIso,
              amount_paid: amountReceived,
              amount_remaining: 0,
            })
            .eq("stripe_payment_intent_id", paymentIntent.id);
        }

        // 2. Match and update reservations / staging_reservations / access_requests
        if (reservationId) {
          await supabase
            .from("staging_reservations")
            .update({ status: "paid" })
            .eq("id", reservationId);
        }
        if (accessRequestId) {
          await supabase
            .from("access_requests")
            .update({ status: "paid" })
            .eq("id", accessRequestId);
        }

        // 3. Record successful charge in public.charges
        await supabase.from("charges").insert({
          uid: targetUid,
          charge_type: paymentIntent.description || "stripe_payment_intent",
          amount: amountReceived,
          status: "success",
          stripe_payment_intent_id: paymentIntent.id,
          charged_at: nowIso,
        });

        break;
      }

      // -------------------------------------------------------------
      // Event: invoice.paid & invoice.payment_succeeded
      // -------------------------------------------------------------
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const invoice = dataObject as Stripe.Invoice;
        const stripeInvoiceId = invoice.id;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
        const customerEmail = invoice.customer_email;
        const paymentIntentId = typeof invoice.payment_intent === "string" ? invoice.payment_intent : null;
        const hostedUrl = invoice.hosted_invoice_url || null;
        const pdfUrl = invoice.invoice_pdf || null;
        const subtotal = (invoice.subtotal || 0) / 100;
        const tax = (invoice.tax || 0) / 100;
        const total = (invoice.total || 0) / 100;
        const amountPaid = (invoice.amount_paid || 0) / 100;
        const amountDue = (invoice.amount_due || 0) / 100;
        const amountRemaining = (invoice.amount_remaining || 0) / 100;
        const paidAt = invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
          : new Date().toISOString();

        console.log(`[StripeWebhook] invoice.paid: ${stripeInvoiceId}, Total=$${total}, Customer=${customerId}`);

        // Resolve customer profile
        let uid: string | null = null;
        let userName: string | null = invoice.customer_name || null;
        if (customerId) {
          const { data: u } = await supabase
            .from("users")
            .select("id, name")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();
          if (u) {
            uid = u.id;
            userName = u.name || userName;
          }
        }
        if (!uid && customerEmail) {
          const { data: u } = await supabase
            .from("users")
            .select("id, name")
            .eq("email", customerEmail)
            .maybeSingle();
          if (u) {
            uid = u.id;
            userName = u.name || userName;
          }
        }

        const lines = (invoice.lines?.data || []).map((line) => ({
          id: line.id,
          description: line.description,
          amount: (line.amount || 0) / 100,
          quantity: line.quantity || 1,
          unit_amount: (line.price?.unit_amount || line.amount || 0) / 100,
        }));

        const invoiceRecord: any = {
          invoice_number: invoice.number || `INV-${stripeInvoiceId.substring(3, 13).toUpperCase()}`,
          stripe_invoice_id: stripeInvoiceId,
          stripe_customer_id: customerId,
          stripe_payment_intent_id: paymentIntentId,
          stripe_hosted_invoice_url: hostedUrl,
          stripe_invoice_pdf: pdfUrl,
          uid: uid,
          customer_name: userName || "CloudVault Customer",
          customer_email: customerEmail,
          invoice_type: invoice.subscription ? "subscription" : "one_time",
          payment_status: "paid",
          subtotal: subtotal,
          tax: tax,
          total_amount: total,
          amount_due: amountDue,
          amount_paid: amountPaid,
          amount_remaining: amountRemaining,
          payment_method: "stripe",
          transaction_reference: paymentIntentId || stripeInvoiceId,
          line_items: lines,
          paid_at: paidAt,
        };

        const { data: existingInv } = await supabase
          .from("invoices")
          .select("id")
          .eq("stripe_invoice_id", stripeInvoiceId)
          .maybeSingle();

        if (existingInv) {
          await supabase
            .from("invoices")
            .update(invoiceRecord)
            .eq("id", existingInv.id);
        } else {
          await supabase.from("invoices").insert(invoiceRecord);
        }

        // Restore active standing for user
        if (uid) {
          await supabase
            .from("users")
            .update({
              is_overdue: false,
              subscription_status: "active",
            })
            .eq("id", uid);
        }

        // Update recurring subscription status if attached
        if (invoice.subscription && typeof invoice.subscription === "string") {
          await supabase
            .from("subscriptions")
            .update({
              status: "active",
              last_billed_at: paidAt,
              last_updated: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", invoice.subscription);
        }

        break;
      }

      // -------------------------------------------------------------
      // Event: invoice.payment_failed
      // -------------------------------------------------------------
      case "invoice.payment_failed": {
        const invoice = dataObject as Stripe.Invoice;
        const stripeInvoiceId = invoice.id;
        const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
        const amountDue = (invoice.amount_due || 0) / 100;
        const nowIso = new Date().toISOString();

        console.warn(`🚨 [StripeWebhook] invoice.payment_failed: ${stripeInvoiceId}, Customer=${customerId}, Due=$${amountDue}`);

        // 1. Mark invoice status as past_due / payment_failed
        await supabase
          .from("invoices")
          .update({
            payment_status: "payment_failed",
            amount_due: amountDue,
          })
          .eq("stripe_invoice_id", stripeInvoiceId);

        // 2. Mark user as overdue & update subscription state
        if (customerId) {
          await supabase
            .from("users")
            .update({
              is_overdue: true,
              subscription_status: "past_due",
            })
            .eq("stripe_customer_id", customerId);
        }

        // 3. Mark subscription as past_due
        if (invoice.subscription && typeof invoice.subscription === "string") {
          await supabase
            .from("subscriptions")
            .update({
              status: "past_due",
              last_updated: nowIso,
            })
            .eq("stripe_subscription_id", invoice.subscription);
        }

        // 4. Log incident for Admin Alerts in privacy_audit_logs
        await supabase.from("privacy_audit_logs").insert({
          action: "stripe_invoice_payment_failed",
          details: {
            alert: "PAYMENT_FAILED_INCIDENT",
            stripe_invoice_id: stripeInvoiceId,
            stripe_customer_id: customerId,
            amount_due: amountDue,
            attempt_count: invoice.attempt_count,
            next_payment_attempt: invoice.next_payment_attempt,
            timestamp: nowIso,
          },
        });

        break;
      }

      // -------------------------------------------------------------
      // Event: customer.subscription.deleted
      // -------------------------------------------------------------
      case "customer.subscription.deleted": {
        const subscription = dataObject as Stripe.Subscription;
        const subId = subscription.id;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
        const nowIso = new Date().toISOString();

        console.log(`[StripeWebhook] customer.subscription.deleted: ${subId}, Customer=${customerId}`);

        // 1. Update customer profile state
        let targetUid: string | null = null;
        if (customerId) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();
          if (u) {
            targetUid = u.id;
            await supabase
              .from("users")
              .update({
                subscription_status: "canceled",
                onboarding_status: "canceled",
              })
              .eq("id", u.id);
          }
        }

        // 2. Mark subscription as canceled
        await supabase
          .from("subscriptions")
          .update({
            status: "canceled",
            canceled_at: nowIso,
            last_updated: nowIso,
          })
          .eq("stripe_subscription_id", subId);

        // 3. Record in cancellations ledger
        if (targetUid) {
          await supabase.from("cancellations").insert({
            uid: targetUid,
            account_status: "canceled",
            cancellation_date: nowIso,
            created_at: nowIso,
          });
        }

        break;
      }

      // -------------------------------------------------------------
      // Event: checkout.session.completed
      // -------------------------------------------------------------
      case "checkout.session.completed": {
        const session = dataObject as Stripe.Checkout.Session;
        const customerId = typeof session.customer === "string" ? session.customer : null;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
        const userUid = session.client_reference_id || session.metadata?.supabase_uid || session.metadata?.uid;
        const customerEmail = session.customer_details?.email || session.customer_email;

        console.log(`[StripeWebhook] checkout.session.completed: userUid=${userUid}, customerId=${customerId}, subId=${subscriptionId}`);

        let targetUserId = userUid;
        if (!targetUserId && customerId) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();
          if (u) targetUserId = u.id;
        }
        if (!targetUserId && customerEmail) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("email", customerEmail)
            .maybeSingle();
          if (u) targetUserId = u.id;
        }

        if (targetUserId) {
          await supabase
            .from("users")
            .update({
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              subscription_status: "active",
              is_overdue: false,
              onboarding_status: "active",
            })
            .eq("id", targetUserId);
        }

        break;
      }

      // -------------------------------------------------------------
      // Event: customer.subscription.created & updated
      // -------------------------------------------------------------
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = dataObject as Stripe.Subscription;
        const subId = subscription.id;
        const customerId = typeof subscription.customer === "string" ? subscription.customer : null;
        const status = subscription.status;
        const quantity = subscription.items?.data[0]?.quantity || 1;
        const priceId = subscription.items?.data[0]?.price?.id || null;
        const currentPeriodStart = subscription.current_period_start
          ? new Date(subscription.current_period_start * 1000).toISOString()
          : null;
        const currentPeriodEnd = subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null;
        const cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
        const nowIso = new Date().toISOString();

        let uid: string | null = null;
        if (customerId) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();
          if (u) {
            uid = u.id;
            await supabase
              .from("users")
              .update({
                stripe_subscription_id: subId,
                subscription_status: status,
                is_overdue: status === "past_due" || status === "unpaid",
              })
              .eq("id", u.id);
          }
        }

        const subData: any = {
          uid: uid,
          stripe_subscription_id: subId,
          stripe_customer_id: customerId,
          stripe_price_id: priceId,
          quantity: quantity,
          status: status,
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: cancelAtPeriodEnd,
          last_updated: nowIso,
        };

        const { data: existingSub } = await supabase
          .from("subscriptions")
          .select("id")
          .eq("stripe_subscription_id", subId)
          .maybeSingle();

        if (existingSub) {
          await supabase
            .from("subscriptions")
            .update(subData)
            .eq("id", existingSub.id);
        } else {
          await supabase.from("subscriptions").insert(subData);
        }

        break;
      }

      default:
        console.log(`[StripeWebhook] Unhandled event type: ${event.type}. Recorded for audit.`);
        break;
    }

    // 3. Log event into public.stripe_webhook_events as processed
    await supabase.from("stripe_webhook_events").upsert(
      {
        stripe_event_id: event.id,
        event_type: event.type,
        payload: event,
        status: "processed",
        created_at: new Date().toISOString(),
      },
      { onConflict: "stripe_event_id" }
    );

    console.log(`[StripeWebhook] Successfully processed & logged event ${event.id} [${event.type}]`);

    // 4. Return Confirmation HTTP 200 { received: true } to Stripe
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error(`[StripeWebhook] Error processing event ${event.id}:`, error.message);

    // Record failure in webhook log
    await supabase.from("stripe_webhook_events").upsert(
      {
        stripe_event_id: event.id,
        event_type: event.type,
        payload: { error: error.message, event },
        status: "failed",
        created_at: new Date().toISOString(),
      },
      { onConflict: "stripe_event_id" }
    );

    return new Response(
      JSON.stringify({ error: `Handler execution error: ${error.message}` }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
