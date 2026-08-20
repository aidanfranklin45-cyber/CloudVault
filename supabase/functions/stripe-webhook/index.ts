import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const connectWebhookSecret = Deno.env.get("STRIPE_CONNECT_WEBHOOK_SECRET") || "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2023-10-16",
  httpClient: Stripe.createFetchHttpClient(),
});

const cryptoProvider = Stripe.createSubtleCryptoProvider();

/**
 * Extract all possible promo code / coupon identifiers from a Stripe object
 */
function extractPromoCandidates(data: any): string[] {
  const candidates: string[] = [];

  const addCandidate = (val: any) => {
    if (!val) return;
    if (typeof val === "string" && val.trim().length > 0) {
      const trimmed = val.trim();
      if (!candidates.includes(trimmed)) {
        candidates.push(trimmed);
      }
    } else if (typeof val === "object") {
      if (val.id) addCandidate(val.id);
      if (val.code) addCandidate(val.code);
      if (val.coupon) addCandidate(val.coupon);
      if (val.promotion_code) addCandidate(val.promotion_code);
      if (val.name) addCandidate(val.name);
    }
  };

  if (!data) return candidates;

  // 1. Single discount object
  if (data.discount) {
    addCandidate(data.discount);
    if (typeof data.discount === "object") {
      addCandidate(data.discount.promotion_code);
      addCandidate(data.discount.coupon);
      addCandidate(data.discount.id);
    }
  }

  // 2. Discounts array
  if (Array.isArray(data.discounts)) {
    for (const d of data.discounts) {
      addCandidate(d);
      if (typeof d === "object") {
        addCandidate(d.promotion_code);
        addCandidate(d.coupon);
        addCandidate(d.id);
      }
    }
  }

  // 3. Total details breakdown discounts (Checkout session)
  if (Array.isArray(data.total_details?.breakdown?.discounts)) {
    for (const d of data.total_details.breakdown.discounts) {
      addCandidate(d.discount);
      if (typeof d.discount === "object") {
        addCandidate(d.discount.promotion_code);
        addCandidate(d.discount.coupon);
        addCandidate(d.discount.id);
      }
    }
  }

  // 4. Total discount amounts (Invoice)
  if (Array.isArray(data.total_discount_amounts)) {
    for (const tda of data.total_discount_amounts) {
      addCandidate(tda.discount);
      if (typeof tda === "object" && tda.discount) {
        addCandidate(tda.discount);
      }
    }
  }

  // 5. Line items discounts
  if (Array.isArray(data.lines?.data)) {
    for (const line of data.lines.data) {
      if (Array.isArray(line.discounts)) {
        for (const ld of line.discounts) {
          addCandidate(ld);
        }
      }
      if (Array.isArray(line.discount_amounts)) {
        for (const lda of line.discount_amounts) {
          addCandidate(lda.discount);
        }
      }
    }
  }

  // 6. Metadata keys
  const meta = data.metadata || {};
  addCandidate(meta.promoCode);
  addCandidate(meta.promo_code);
  addCandidate(meta.promoCodeId);
  addCandidate(meta.promo_code_id);
  addCandidate(meta.couponId);
  addCandidate(meta.coupon_id);
  addCandidate(meta.coupon);
  addCandidate(meta.discount_code);

  return candidates;
}

/**
 * Helper to record promo redemption and calculate commission dynamically from database promo_codes
 */
async function processPromoRedemption(
  supabase: any,
  params: {
    promoCandidates: string[];
    targetUserId: string | null;
    customerEmail: string | null;
    invoiceId: string;
    chargeId: string | null;
    grossAmount: number;
    discountAmount: number;
    netPaidAmount: number;
    nowIso: string;
  }
) {
  const {
    promoCandidates,
    targetUserId,
    customerEmail,
    invoiceId,
    chargeId,
    grossAmount,
    discountAmount,
    netPaidAmount,
    nowIso,
  } = params;

  // 1. Prevent duplicate redemption record for the exact invoice
  const { data: existingRedemption } = await supabase
    .from("promo_redemptions")
    .select("id")
    .eq("stripe_invoice_id", invoiceId)
    .maybeSingle();

  if (existingRedemption) {
    console.log(`[StripeWebhook] Redemption already recorded for invoice ${invoiceId}. Skipping.`);
    return existingRedemption;
  }

  // 2. Find matching promo code record from candidates
  let promo: any = null;

  for (const candidate of promoCandidates) {
    if (!candidate) continue;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate);
    let filterString = `code.ilike.${candidate},stripe_promo_code_id.eq.${candidate},stripe_coupon_id.eq.${candidate}`;
    if (isUuid) {
      filterString += `,id.eq.${candidate}`;
    }

    const { data: p } = await supabase
      .from("promo_codes")
      .select("*")
      .or(filterString)
      .maybeSingle();

    if (p) {
      promo = p;
      break;
    }
  }

  // Fallback: check if the user was referred by a promo code in users table
  if (!promo && targetUserId) {
    const { data: u } = await supabase
      .from("users")
      .select("referred_by_promo_code, referred_by_creator_id")
      .eq("id", targetUserId)
      .maybeSingle();

    if (u && u.referred_by_promo_code) {
      const { data: p } = await supabase
        .from("promo_codes")
        .select("*")
        .ilike("code", u.referred_by_promo_code)
        .maybeSingle();
      if (p) promo = p;
    }
  }

  if (!promo) {
    if (promoCandidates.length > 0) {
      console.log(`[StripeWebhook] No matching promo code in database for candidates: ${JSON.stringify(promoCandidates)}`);
    }
    return null;
  }

  // Dynamic commission calculation using promo_codes.commission_rate_pct from DB
  const commissionRate = Number(promo.commission_rate_pct) || 0;
  const creatorCommissionAmount = Number((grossAmount * (commissionRate / 100)).toFixed(2));
  const isCommissionEligible = Boolean(promo.creator_id && commissionRate > 0);

  // Count prior redemptions by this customer for this promo to determine month_index
  let monthIndex = 1;
  if (targetUserId) {
    const { count } = await supabase
      .from("promo_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("promo_code_id", promo.id)
      .or(`customer_id.eq.${targetUserId},customer_uid.eq.${targetUserId}`);
    if (count !== null && count !== undefined) {
      monthIndex = count + 1;
    }
  }

  // 3. Insert redemption record into public.promo_redemptions
  const redemptionInsert: any = {
    promo_code_id: promo.id,
    promo_code: promo.code,
    creator_id: promo.creator_id,
    customer_id: targetUserId,
    customer_uid: targetUserId,
    customer_email: customerEmail,
    stripe_invoice_id: invoiceId,
    stripe_charge_id: chargeId,
    gross_amount: grossAmount,
    invoice_gross_amount: grossAmount,
    discount_amount: discountAmount,
    net_paid_amount: netPaidAmount,
    commission_rate_applied: commissionRate,
    commission_amount: creatorCommissionAmount,
    creator_commission_amount: creatorCommissionAmount,
    month_index: monthIndex,
    is_commission_eligible: isCommissionEligible,
    payout_status: "PENDING",
    paid_at: nowIso,
    created_at: nowIso,
  };

  const { data: insertedRedemption, error: insertError } = await supabase
    .from("promo_redemptions")
    .insert(redemptionInsert)
    .select()
    .maybeSingle();

  if (insertError) {
    console.error(`[StripeWebhook] Failed to insert promo redemption:`, insertError.message);
  }

  // 4. Atomically increment promo_codes.current_redemptions and add to promo_codes.total_revenue_generated
  const { error: rpcError } = await supabase.rpc("increment_promo_code_stats", {
    p_promo_id: promo.id,
    p_revenue_amount: grossAmount,
  });

  if (rpcError) {
    console.warn(`[StripeWebhook] increment_promo_code_stats RPC returned error, applying atomic fallback update:`, rpcError.message);
    await supabase
      .from("promo_codes")
      .update({
        current_redemptions: (promo.current_redemptions || 0) + 1,
        total_revenue_generated: Number(((Number(promo.total_revenue_generated) || 0) + grossAmount).toFixed(2)),
        updated_at: nowIso,
      })
      .eq("id", promo.id);
  }

  // 5. Update creator lifetime stats
  if (promo.creator_id) {
    const { data: creator } = await supabase
      .from("creators")
      .select("total_attributed_revenue, total_commission_earned")
      .eq("id", promo.creator_id)
      .maybeSingle();

    if (creator) {
      await supabase
        .from("creators")
        .update({
          total_attributed_revenue: Number(((Number(creator.total_attributed_revenue) || 0) + grossAmount).toFixed(2)),
          total_commission_earned: Number(((Number(creator.total_commission_earned) || 0) + creatorCommissionAmount).toFixed(2)),
          updated_at: nowIso,
        })
        .eq("id", promo.creator_id);
    }
  }

  // 6. Update user referral attribution
  if (targetUserId) {
    await supabase
      .from("users")
      .update({
        referred_by_promo_code: promo.code,
        referred_by_creator_id: promo.creator_id,
        referred_at: nowIso,
      })
      .eq("id", targetUserId);
  }

  console.log(`[StripeWebhook] Recorded promo redemption for code "${promo.code}" on invoice ${invoiceId}: Gross=$${grossAmount}, Discount=$${discountAmount}, CreatorCommission=$${creatorCommissionAmount}`);

  return insertedRedemption || redemptionInsert;
}

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
    if (connectWebhookSecret) {
      try {
        event = await stripe.webhooks.constructEventAsync(
          rawBody,
          signature,
          connectWebhookSecret,
          undefined,
          cryptoProvider
        );
      } catch (err2: any) {
        console.error(`⚠️ Webhook signature verification failed for both secrets: ${err.message} | ${err2.message}`);
        return new Response(
          JSON.stringify({ error: `Webhook signature verification failed: ${err.message}` }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    } else {
      console.error(`⚠️ Webhook signature verification failed: ${err.message}`);
      return new Response(
        JSON.stringify({ error: `Webhook signature verification failed: ${err.message}` }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
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

  let eventDiagnostics: Record<string, any> | null = null;

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
      // Event: payment_intent.payment_failed
      // -------------------------------------------------------------
      case "payment_intent.payment_failed": {
        const paymentIntent = dataObject as Stripe.PaymentIntent;
        const paymentIntentId = paymentIntent.id;
        const customerId = typeof paymentIntent.customer === "string" ? paymentIntent.customer : null;
        const metadata = paymentIntent.metadata || {};
        const invoiceId = metadata.invoice_id || (typeof paymentIntent.invoice === "string" ? paymentIntent.invoice : null);
        const lastError = paymentIntent.last_payment_error;
        const nowIso = new Date().toISOString();
        const amountFailed = (paymentIntent.amount || 0) / 100;

        console.warn(`🚨 [StripeWebhook] payment_intent.payment_failed: ${paymentIntentId}, Customer=${customerId}, Error=${lastError?.message || "Unknown"}`);

        // Extract Failure Diagnostics
        const failureDiagnostics = {
          code: lastError?.code || "payment_intent_failed",
          decline_code: lastError?.decline_code || null,
          message: lastError?.message || "Payment intent execution failed",
          type: lastError?.type || null,
          param: lastError?.param || null,
          doc_url: lastError?.doc_url || null,
          stripe_payment_intent_id: paymentIntentId,
          stripe_invoice_id: invoiceId,
          stripe_customer_id: customerId,
          amount_failed: amountFailed,
          occurred_at: nowIso,
        };

        eventDiagnostics = { failure_diagnostics: failureDiagnostics };

        // 1. Update matching invoice payment_status: 'failed'
        const failureNote = `Payment intent failed: ${failureDiagnostics.message}${failureDiagnostics.decline_code ? ` [Decline: ${failureDiagnostics.decline_code}]` : ""}`;
        if (invoiceId) {
          await supabase
            .from("invoices")
            .update({
              payment_status: "failed",
              notes: failureNote,
            })
            .or(`id.eq.${invoiceId},stripe_invoice_id.eq.${invoiceId}`);
        } else {
          await supabase
            .from("invoices")
            .update({
              payment_status: "failed",
              notes: failureNote,
            })
            .eq("stripe_payment_intent_id", paymentIntentId);
        }

        // 2. Resolve user ID if possible
        let targetUid = metadata.supabase_uid || metadata.uid || null;
        if (!targetUid && customerId) {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();
          if (u) targetUid = u.id;
        }

        // 3. Record failed charge in public.charges
        await supabase.from("charges").insert({
          uid: targetUid,
          charge_type: paymentIntent.description || "stripe_payment_intent_failed",
          amount: amountFailed,
          status: "failed",
          stripe_payment_intent_id: paymentIntentId,
          charged_at: nowIso,
        });

        // 4. Log failure in privacy_audit_logs
        await supabase.from("privacy_audit_logs").insert({
          action: "stripe_payment_intent_failed",
          details: failureDiagnostics,
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
        const paymentIntentId = typeof invoice.payment_intent === "string" 
          ? invoice.payment_intent 
          : (invoice.payment_intent as any)?.id || null;
        const chargeId = typeof invoice.charge === "string" 
          ? invoice.charge 
          : (invoice.charge as any)?.id || paymentIntentId || null;
        const hostedUrl = invoice.hosted_invoice_url || null;
        const pdfUrl = invoice.invoice_pdf || null;
        const subtotal = (invoice.subtotal || 0) / 100;
        const tax = (invoice.tax || 0) / 100;
        const total = (invoice.total || 0) / 100;
        const amountPaid = (invoice.amount_paid || 0) / 100;
        const amountDue = (invoice.amount_due || 0) / 100;
        const amountRemaining = (invoice.amount_remaining || 0) / 100;

        // Dynamic calculation of discount amount
        const totalDiscount = Array.isArray(invoice.total_discount_amounts)
          ? invoice.total_discount_amounts.reduce((sum, d) => sum + (d.amount || 0), 0) / 100
          : Math.max(0, subtotal - (total - tax));
        const grossAmount = subtotal > 0 ? subtotal : Number((total - tax + totalDiscount).toFixed(2));

        const paidAt = invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
          : new Date().toISOString();

        console.log(`[StripeWebhook] ${event.type}: ${stripeInvoiceId}, Gross=$${grossAmount}, Discount=$${totalDiscount}, Total=$${total}, Customer=${customerId}`);

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
          discount: totalDiscount,
          total_amount: total,
          amount_due: amountDue,
          amount_paid: amountPaid,
          amount_remaining: amountRemaining,
          payment_method: "stripe",
          transaction_reference: chargeId || paymentIntentId || stripeInvoiceId,
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

        // Webhook Attribution for Promo Codes
        const promoCandidates = extractPromoCandidates(invoice);
        const redemption = await processPromoRedemption(supabase, {
          promoCandidates,
          targetUserId: uid,
          customerEmail: customerEmail || null,
          invoiceId: stripeInvoiceId,
          chargeId: chargeId,
          grossAmount: grossAmount,
          discountAmount: totalDiscount,
          netPaidAmount: amountPaid,
          nowIso: paidAt,
        });

        if (redemption) {
          eventDiagnostics = { promo_attribution: redemption };
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
        const paymentIntentId = typeof invoice.payment_intent === "string" 
          ? invoice.payment_intent 
          : (invoice.payment_intent as any)?.id || null;
        const amountDue = (invoice.amount_due || 0) / 100;
        const nowIso = new Date().toISOString();

        // Extract Failure Diagnostics
        const lastError = (invoice as any).last_payment_error || (invoice as any).payment_intent?.last_payment_error || null;
        const failureDiagnostics = {
          code: lastError?.code || (invoice as any).charge?.failure_code || "invoice_payment_failed",
          decline_code: lastError?.decline_code || (invoice as any).charge?.failure_message || null,
          message: lastError?.message || (invoice as any).charge?.failure_message || "Invoice payment attempt failed",
          type: lastError?.type || null,
          param: lastError?.param || null,
          stripe_invoice_id: stripeInvoiceId,
          stripe_payment_intent_id: paymentIntentId,
          stripe_customer_id: customerId,
          amount_due: amountDue,
          attempt_count: invoice.attempt_count,
          next_payment_attempt: invoice.next_payment_attempt
            ? new Date(invoice.next_payment_attempt * 1000).toISOString()
            : null,
          occurred_at: nowIso,
        };

        eventDiagnostics = { failure_diagnostics: failureDiagnostics };

        console.warn(`🚨 [StripeWebhook] invoice.payment_failed: ${stripeInvoiceId}, Customer=${customerId}, Due=$${amountDue}, Reason=${failureDiagnostics.message}`);

        // 1. Determine if invoice is overdue or failed
        const isOverdue = invoice.due_date ? (invoice.due_date * 1000 < Date.now()) : false;
        const paymentStatus = isOverdue ? "overdue" : "failed";

        // Update matching invoice in public.invoices
        await supabase
          .from("invoices")
          .update({
            payment_status: paymentStatus,
            amount_due: amountDue,
            notes: `Payment failed: ${failureDiagnostics.message}${failureDiagnostics.decline_code ? ` (Decline code: ${failureDiagnostics.decline_code})` : ""}`,
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
          details: failureDiagnostics,
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
        const userUid = session.client_reference_id || session.metadata?.userId || session.metadata?.supabase_uid || session.metadata?.uid;
        const customerEmail = session.customer_details?.email || session.customer_email;
        const chargeId = typeof session.payment_intent === "string" ? session.payment_intent : null;
        const nowIso = new Date().toISOString();

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

        // Webhook Attribution for Promo Codes
        const promoCandidates = extractPromoCandidates(session);
        const discountAmount = (session.total_details?.amount_discount || 0) / 100;
        const subtotal = (session.amount_subtotal || 0) / 100;
        const total = (session.amount_total || 0) / 100;
        const grossAmount = subtotal > 0 ? subtotal : Number((total + discountAmount).toFixed(2));
        const netPaidAmount = total;
        const invoiceId = (typeof session.invoice === "string" ? session.invoice : null) || `CHK-${session.id.substring(3, 13).toUpperCase()}`;

        const redemption = await processPromoRedemption(supabase, {
          promoCandidates,
          targetUserId: targetUserId || null,
          customerEmail: customerEmail || null,
          invoiceId: invoiceId,
          chargeId: chargeId,
          grossAmount: grossAmount,
          discountAmount: discountAmount,
          netPaidAmount: netPaidAmount,
          nowIso: nowIso,
        });

        if (redemption) {
          eventDiagnostics = { promo_attribution: redemption };
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

      // -------------------------------------------------------------
      // Event: promotion_code.created
      // -------------------------------------------------------------
      case "promotion_code.created": {
        const promoCodeObj = dataObject as Stripe.PromotionCode;
        const couponId = typeof promoCodeObj.coupon === "string" ? promoCodeObj.coupon : promoCodeObj.coupon?.id;
        const code = promoCodeObj.code;
        const maxRedemptions = promoCodeObj.max_redemptions || null;
        const expiresAt = promoCodeObj.expires_at ? new Date(promoCodeObj.expires_at * 1000).toISOString() : null;
        const isActive = promoCodeObj.active;
        const nowIso = new Date().toISOString();

        console.log(`[StripeWebhook] promotion_code.created: ${promoCodeObj.id} (${code})`);

        const { data: existingPromo } = await supabase
          .from("promo_codes")
          .select("id")
          .ilike("code", code)
          .maybeSingle();

        if (existingPromo) {
          await supabase
            .from("promo_codes")
            .update({
              stripe_promo_code_id: promoCodeObj.id,
              stripe_coupon_id: couponId,
              max_redemptions: maxRedemptions,
              expires_at: expiresAt,
              is_active: isActive,
              updated_at: nowIso,
            })
            .eq("id", existingPromo.id);
        }
        break;
      }

      // -------------------------------------------------------------
      // Event: promotion_code.updated
      // -------------------------------------------------------------
      case "promotion_code.updated": {
        const promoCodeObj = dataObject as Stripe.PromotionCode;
        const maxRedemptions = promoCodeObj.max_redemptions || null;
        const expiresAt = promoCodeObj.expires_at ? new Date(promoCodeObj.expires_at * 1000).toISOString() : null;
        const isActive = promoCodeObj.active;
        const nowIso = new Date().toISOString();

        console.log(`[StripeWebhook] promotion_code.updated: ${promoCodeObj.id}`);

        await supabase
          .from("promo_codes")
          .update({
            max_redemptions: maxRedemptions,
            expires_at: expiresAt,
            is_active: isActive,
            updated_at: nowIso,
          })
          .eq("stripe_promo_code_id", promoCodeObj.id);
        break;
      }

      // -------------------------------------------------------------
      // Event: coupon.created
      // -------------------------------------------------------------
      case "coupon.created": {
        const couponObj = dataObject as Stripe.Coupon;
        const couponId = couponObj.id;
        const percentOff = couponObj.percent_off ? Number(couponObj.percent_off) : null;
        const durationMonths = couponObj.duration_in_months || null;
        const nowIso = new Date().toISOString();

        console.log(`[StripeWebhook] coupon.created: ${couponId} (${percentOff}% off)`);

        const { data: existingPromo } = await supabase
          .from("promo_codes")
          .select("id")
          .eq("stripe_coupon_id", couponId)
          .maybeSingle();

        if (existingPromo && percentOff !== null) {
          await supabase
            .from("promo_codes")
            .update({
              customer_discount_pct: percentOff,
              customer_discount_duration_months: durationMonths,
              is_active: couponObj.valid,
              updated_at: nowIso,
            })
            .eq("id", existingPromo.id);
        }
        break;
      }

      // -------------------------------------------------------------
      // Event: coupon.deleted
      // -------------------------------------------------------------
      case "coupon.deleted": {
        const couponObj = dataObject as Stripe.Coupon;
        const couponId = couponObj.id;
        const nowIso = new Date().toISOString();

        console.log(`[StripeWebhook] coupon.deleted: ${couponId}`);

        await supabase
          .from("promo_codes")
          .update({
            is_active: false,
            updated_at: nowIso,
          })
          .eq("stripe_coupon_id", couponId);
        break;
      }

      // -------------------------------------------------------------
      // Event: charge.refunded & charge.refund.updated
      // -------------------------------------------------------------
      case "charge.refunded":
      case "charge.refund.updated": {
        const charge = dataObject as Stripe.Charge;
        const chargeId = charge.id;
        const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
        const invoiceId = typeof charge.invoice === "string" ? charge.invoice : null;
        const customerId = typeof charge.customer === "string" ? charge.customer : null;
        const amountRefunded = (charge.amount_refunded || 0) / 100;
        const latestRefund = charge.refunds?.data?.[0];
        const refundReason = latestRefund?.reason || (latestRefund as any)?.description || (charge as any)?.refund_reason || "requested_by_customer";
        const refundId = latestRefund?.id || null;
        const nowIso = new Date().toISOString();

        console.log(`[StripeWebhook] charge.refunded: ${chargeId}, PI=${paymentIntentId}, Amount=$${amountRefunded}, Reason=${refundReason}`);

        const refundDetails = {
          charge_id: chargeId,
          stripe_payment_intent_id: paymentIntentId,
          stripe_invoice_id: invoiceId,
          stripe_customer_id: customerId,
          refund_id: refundId,
          amount_refunded: amountRefunded,
          reason: refundReason,
          status: latestRefund?.status || "succeeded",
          refunded_at: nowIso,
        };

        eventDiagnostics = { refund_details: refundDetails };

        // 1. Update invoice payment_status: 'refunded'
        if (invoiceId) {
          await supabase
            .from("invoices")
            .update({
              payment_status: "refunded",
              refunded_at: nowIso,
              notes: `Refunded $${amountRefunded}. Reason: ${refundReason}`,
            })
            .eq("stripe_invoice_id", invoiceId);
        } else if (paymentIntentId) {
          await supabase
            .from("invoices")
            .update({
              payment_status: "refunded",
              refunded_at: nowIso,
              notes: `Refunded $${amountRefunded}. Reason: ${refundReason}`,
            })
            .eq("stripe_payment_intent_id", paymentIntentId);
        }

        // 2. Update charges table
        if (paymentIntentId) {
          await supabase
            .from("charges")
            .update({
              status: "refunded",
            })
            .eq("stripe_payment_intent_id", paymentIntentId);
        }

        // 3. Log refund in privacy_audit_logs
        await supabase.from("privacy_audit_logs").insert({
          action: "stripe_charge_refunded",
          details: refundDetails,
        });

        break;
      }

      // -------------------------------------------------------------
      // Event: account.updated (Stripe Connect Express Onboarding / Verification)
      // -------------------------------------------------------------
      case "account.updated": {
        const account = dataObject as Stripe.Account;
        console.log(`[StripeWebhook] account.updated for Connect account ${account.id}, details_submitted=${account.details_submitted}, payouts_enabled=${account.payouts_enabled}`);

        const creatorIdFromMeta = account.metadata?.creator_id;
        const payoutsEnabled = Boolean(account.payouts_enabled);
        const detailsSubmitted = Boolean(account.details_submitted);

        let status = "not_connected";
        if (payoutsEnabled && detailsSubmitted) {
          status = "verified";
        } else if (detailsSubmitted && !payoutsEnabled) {
          status = "pending_verification";
        } else if (account.requirements?.disabled_reason || (account.requirements?.currently_due && account.requirements.currently_due.length > 0)) {
          status = "restricted";
        } else {
          status = "pending";
        }

        let query = supabase.from("creators").update({
          stripe_connect_id: account.id,
          stripe_connect_status: status,
          updated_at: new Date().toISOString(),
        });

        if (creatorIdFromMeta) {
          query = query.eq("id", creatorIdFromMeta);
        } else {
          query = query.eq("stripe_connect_id", account.id);
        }

        const { error: updateErr } = await query;
        if (updateErr) {
          console.warn("[StripeWebhook] Error updating creator Connect status:", updateErr);
        } else {
          console.log(`[StripeWebhook] Successfully updated creator Connect status to '${status}' for ${account.id}`);
        }

        eventDiagnostics = {
          account_id: account.id,
          status,
          payouts_enabled: payoutsEnabled,
          details_submitted: detailsSubmitted,
        };
        break;
      }

      // -------------------------------------------------------------
      // Event: account.application.deauthorized (Stripe Connect Disconnect)
      // -------------------------------------------------------------
      case "account.application.deauthorized": {
        const account = dataObject as any;
        const accountId = account.id || (event as any).account;
        console.log(`[StripeWebhook] account.application.deauthorized for Connect account ${accountId}`);

        if (accountId) {
          await supabase
            .from("creators")
            .update({
              stripe_connect_status: "deauthorized",
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_connect_id", accountId);
        }

        eventDiagnostics = {
          account_id: accountId,
          action: "deauthorized",
        };
        break;
      }

      // -------------------------------------------------------------
      // Event: transfer.created (Stripe Connect Creator Commission Transfer)
      // -------------------------------------------------------------
      case "transfer.created": {
        const transfer = dataObject as Stripe.Transfer;
        console.log(`[StripeWebhook] transfer.created: ${transfer.id}, Amount=$${(transfer.amount / 100).toFixed(2)} to ${transfer.destination}`);

        const creatorId = transfer.metadata?.creator_id;
        const payoutRef = transfer.metadata?.payout_ref;

        if (transfer.id) {
          await supabase
            .from("creator_payouts")
            .update({
              status: "completed",
              stripe_transfer_id: transfer.id,
              stripe_payout_id: (transfer as any).destination_payment || null,
              updated_at: new Date().toISOString(),
            })
            .or(`stripe_transfer_id.eq.${transfer.id},payout_reference.eq.${payoutRef}`);
        }

        eventDiagnostics = {
          transfer_id: transfer.id,
          amount: transfer.amount / 100,
          destination: transfer.destination,
          creator_id: creatorId,
        };
        break;
      }

      // -------------------------------------------------------------
      // Event: transfer.failed (Stripe Connect Creator Transfer Failed)
      // -------------------------------------------------------------
      case "transfer.failed": {
        const transfer = dataObject as any;
        console.error(`[StripeWebhook] 🚨 transfer.failed: ${transfer.id} to ${transfer.destination}`);

        if (transfer.id) {
          await supabase
            .from("creator_payouts")
            .update({
              status: "failed",
              metadata: {
                failed_at: new Date().toISOString(),
                failure_reason: transfer.failure_message || "Transfer failed in Stripe",
              },
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_transfer_id", transfer.id);
        }

        eventDiagnostics = {
          transfer_id: transfer.id,
          status: "failed",
          failure_message: transfer.failure_message,
        };
        break;
      }

      default:
        console.log(`[StripeWebhook] Unhandled event type: ${event.type}. Recorded for audit.`);
        break;
    }

    // 3. Log event into public.stripe_webhook_events as processed with diagnostics
    const finalPayload = eventDiagnostics ? { ...event, ...eventDiagnostics } : event;

    await supabase.from("stripe_webhook_events").upsert(
      {
        stripe_event_id: event.id,
        event_type: event.type,
        payload: finalPayload,
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
        payload: { error: error.message, event, diagnostics: eventDiagnostics || null },
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
