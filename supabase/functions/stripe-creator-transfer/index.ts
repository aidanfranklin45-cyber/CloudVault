import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface TransferRequestBody {
  creatorId?: string;
  creator_id?: string;
  amount?: number;
  currency?: string;
  payoutRef?: string;
  payout_ref?: string;
  idempotencyKey?: string;
  idempotency_key?: string;
}

Deno.serve(async (req: Request) => {
  // Handle CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const stripeSecretKey = Deno.env.get("Stripe_Secret_Key") || Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("Str1pe_Secret_Key") || Deno.env.get("stripe_secret_key") || Deno.env.get("STRIPE_API_KEY") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!stripeSecretKey) {
      throw new Error("Stripe secret key environment variable (Stripe_Secret_Key / STRIPE_SECRET_KEY) is missing in Supabase Edge Function secrets.");
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const body: any = await req.json().catch(() => ({}));
    const operation = body.operation || "transfer";

    // ────────────────────────────────────────────────────────────
    // OPERATION: create_promo_code (Server-side Stripe coupon & promo code sync)
    // ────────────────────────────────────────────────────────────
    if (operation === "create_promo_code") {
      const creatorData = body.creatorData || {};
      const promoData = body.promoData || {};
      const cleanCode = (promoData.code || "").trim().toUpperCase();

      if (!cleanCode) {
        return new Response(
          JSON.stringify({ error: "Promo code string is required (e.g. ALEX20 or CV50OFF)" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!creatorData.name || !creatorData.email) {
        return new Response(
          JSON.stringify({ error: "Partner/Creator name and contact email are required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const custDiscountPct = Number(promoData.customerDiscountPct) || 20.00;
      const custDiscountMonths = Number(promoData.customerDiscountMonths) || 2;
      
      const rawComm = promoData.commissionRatePct !== undefined && promoData.commissionRatePct !== null && promoData.commissionRatePct !== ""
        ? promoData.commissionRatePct
        : creatorData.defaultCommissionPct;
      const commRatePct = (rawComm !== undefined && rawComm !== null && rawComm !== "") ? Number(rawComm) : 0.00;

      const rawCommMonths = promoData.commissionMonths !== undefined && promoData.commissionMonths !== null && promoData.commissionMonths !== ""
        ? promoData.commissionMonths
        : creatorData.commissionMonths;
      const commMonths = (rawCommMonths !== undefined && rawCommMonths !== null && rawCommMonths !== "") ? Number(rawCommMonths) : 0;

      // 1. Create or retrieve Stripe Coupon
      let liveCouponId = cleanCode;
      try {
        const duration = custDiscountMonths > 0 ? "repeating" : "once";
        const couponParams: any = {
          id: cleanCode,
          name: `${cleanCode} (${custDiscountPct}% Off)`,
          percent_off: custDiscountPct,
          duration: duration,
        };
        if (duration === "repeating") {
          couponParams.duration_in_months = custDiscountMonths;
        }

        const cData = await stripe.coupons.create(couponParams);
        if (cData && cData.id) {
          liveCouponId = cData.id;
          console.log(`[StripeCreatorTransfer] Live Stripe Coupon Created: ${liveCouponId}`);
        }
      } catch (cErr: any) {
        if (cErr.message?.includes("already exists") || cErr.code === "resource_already_exists") {
          liveCouponId = cleanCode;
          console.log(`[StripeCreatorTransfer] Reusing existing Stripe Coupon: ${liveCouponId}`);
        } else {
          console.warn("[StripeCreatorTransfer] Stripe coupon creation warning:", cErr.message);
        }
      }

      // 2. Create Stripe Promotion Code
      let livePromoId = null;
      try {
        const cleanPromoCode = cleanCode.replace(/[^a-zA-Z0-9_-]/g, "");
        const pData = await stripe.promotionCodes.create({
          coupon: liveCouponId,
          code: cleanPromoCode,
        });
        if (pData && pData.id) {
          livePromoId = pData.id;
          console.log(`[StripeCreatorTransfer] Live Stripe Promotion Code Created: ${pData.code} (${livePromoId})`);
        }
      } catch (pErr: any) {
        console.warn("[StripeCreatorTransfer] Stripe promotion code creation notice:", pErr.message);
      }

      const stripeCouponId = liveCouponId || `co_${cleanCode}`;
      const stripePromoId = livePromoId || `promo_${cleanCode}`;

      // 3. Insert or update Creator Entity in Supabase
      const { data: creatorRec, error: creatorErr } = await supabase
        .from("creators")
        .insert({
          name: creatorData.name,
          handle: creatorData.handle || `@${creatorData.name.toLowerCase().replace(/\\s+/g, "")}`,
          email: creatorData.email,
          payout_email: creatorData.payoutEmail || creatorData.email,
          tier: creatorData.tier || (commRatePct === 0 ? "Internal Promo" : "Standard Influencer"),
          default_commission_pct: commRatePct,
          commission_duration_months: commMonths,
          status: "ACTIVE",
          notes: creatorData.notes || "Created via CloudVault Executive Promo Hub",
        })
        .select()
        .single();

      if (creatorErr) {
        console.error("[StripeCreatorTransfer] Error creating creator record in Supabase:", creatorErr.message);
        return new Response(
          JSON.stringify({ error: `Failed to save partner/creator in database: ${creatorErr.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 4. Insert Promo Code record
      const { data: promoRec, error: promoErr } = await supabase
        .from("promo_codes")
        .insert({
          creator_id: creatorRec.id,
          code: cleanCode,
          stripe_coupon_id: stripeCouponId,
          stripe_promo_code_id: stripePromoId,
          customer_discount_pct: custDiscountPct,
          customer_discount_duration_months: custDiscountMonths,
          commission_rate_pct: commRatePct,
          commission_duration_months: commMonths,
          max_redemptions: promoData.maxRedemptions ? Number(promoData.maxRedemptions) : null,
          allow_waitlist_deposits: promoData.allowWaitlistDeposits !== false,
          waitlist_deposit_discount_pct: Number(promoData.waitlistDepositDiscountPct) || custDiscountPct,
          is_active: true,
        })
        .select()
        .single();

      if (promoErr) {
        console.error("[StripeCreatorTransfer] Error creating promo code record in Supabase:", promoErr.message);
        return new Response(
          JSON.stringify({ error: `Failed to save promo code in database: ${promoErr.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          creatorId: creatorRec.id,
          promoId: promoRec.id,
          code: cleanCode,
          creatorName: creatorData.name,
          handle: creatorData.handle || `@${creatorData.name.toLowerCase().replace(/\\s+/g, "")}`,
          customerDiscount: `${custDiscountPct}% off for ${custDiscountMonths} months`,
          creatorCommission: `${commRatePct}% revenue share for ${commMonths} months`,
          stripeCouponId: stripeCouponId,
          stripePromoCodeId: stripePromoId,
          createdAt: new Date().toISOString(),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ────────────────────────────────────────────────────────────
    // OPERATION: update_promo_lifecycle (Synchronize promo status with Stripe)
    // ────────────────────────────────────────────────────────────
    if (operation === "update_promo_lifecycle") {
      const promoId = body.promoId || body.promo_id;
      const active = body.active !== undefined ? Boolean(body.active) : true;

      if (!promoId) {
        return new Response(
          JSON.stringify({ error: "Missing promoId parameter" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const { data: promoRec } = await supabase
        .from("promo_codes")
        .select("stripe_promo_code_id")
        .eq("id", promoId)
        .single();

      if (promoRec?.stripe_promo_code_id && !promoRec.stripe_promo_code_id.startsWith("promo_CV_") && !promoRec.stripe_promo_code_id.startsWith("promo_")) {
        try {
          await stripe.promotionCodes.update(promoRec.stripe_promo_code_id, { active });
          console.log(`[StripeCreatorTransfer] Updated Stripe promotion code ${promoRec.stripe_promo_code_id} active=${active}`);
        } catch (sErr: any) {
          console.warn("[StripeCreatorTransfer] Stripe promo code update notice:", sErr.message);
        }
      }

      return new Response(
        JSON.stringify({ success: true, promoId, active }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ────────────────────────────────────────────────────────────
    // OPERATION: transfer (Creator Commission Payout Transfer)
    // ────────────────────────────────────────────────────────────
    const creatorId = body.creatorId || body.creator_id;
    const amount = Number(body.amount);
    const currency = (body.currency || "usd").toLowerCase();
    const payoutRef = body.payoutRef || body.payout_ref || `ACH-${Date.now()}`;
    const idempotencyKey = body.idempotencyKey || body.idempotency_key || `cv_payout_${creatorId}_${Math.round(amount * 100)}_${Date.now()}`;

    if (!creatorId) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter: creatorId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return new Response(
        JSON.stringify({ error: "Invalid transfer amount. Must be greater than $0.00." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Fetch Creator Record & Verify Connect Account
    const { data: creator, error: creatorErr } = await supabase
      .from("creators")
      .select("*")
      .eq("id", creatorId)
      .single();

    if (creatorErr || !creator) {
      return new Response(
        JSON.stringify({ error: `Creator with ID ${creatorId} not found in database.` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!creator.stripe_connect_id) {
      return new Response(
        JSON.stringify({
          error: `Creator "${creator.name}" has not connected a Stripe Payout account yet. Please onboard them via Stripe Connect first.`,
          code: "STRIPE_CONNECT_ACCOUNT_MISSING",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Perform Real Stripe Transfer
    const amountInCents = Math.round(amount * 100);
    console.log(`[StripeTransfer] Initiating transfer of $${amount.toFixed(2)} (${amountInCents} cents) to ${creator.stripe_connect_id} for ${creator.name}...`);

    const transfer = await stripe.transfers.create(
      {
        amount: amountInCents,
        currency: currency,
        destination: creator.stripe_connect_id,
        description: `CloudVault Creator Commission Payout - ${creator.name}`,
        metadata: {
          creator_id: creator.id,
          creator_name: creator.name,
          payout_ref: payoutRef,
          platform: "CloudVault",
        },
      },
      {
        idempotencyKey: idempotencyKey,
      }
    );

    console.log(`[StripeTransfer] Transfer created successfully: ${transfer.id}`);

    // 3. Record Payout Row in public.creator_payouts
    const { data: payoutRecord, error: payoutDbErr } = await supabase
      .from("creator_payouts")
      .insert({
        creator_id: creator.id,
        amount: amount,
        currency: currency.toUpperCase(),
        status: "completed",
        payout_method: "stripe_connect",
        payout_reference: payoutRef,
        stripe_transfer_id: transfer.id,
        stripe_payout_id: (transfer as any).destination_payment || null,
        metadata: {
          stripe_transfer_id: transfer.id,
          destination: creator.stripe_connect_id,
          created: transfer.created,
        },
      })
      .select()
      .single();

    if (payoutDbErr) {
      console.warn("[StripeTransfer] Warning inserting creator_payouts record:", payoutDbErr);
    }

    // 4. Mark pending promo redemptions for this creator as PAID
    const { error: redemptionsErr } = await supabase
      .from("promo_redemptions")
      .update({
        payout_status: "PAID",
        payout_reference: transfer.id,
        paid_at: new Date().toISOString(),
      })
      .eq("creator_id", creator.id)
      .in("payout_status", ["PENDING", "APPROVED"]);

    if (redemptionsErr) {
      console.warn("[StripeTransfer] Warning updating promo_redemptions status:", redemptionsErr);
    }

    // 5. Update Creator Total Commission Paid
    await supabase
      .from("creators")
      .update({
        total_commission_paid: Number(creator.total_commission_paid || 0) + Number(amount),
        updated_at: new Date().toISOString(),
      })
      .eq("id", creator.id);

    return new Response(
      JSON.stringify({
        success: true,
        transfer_id: transfer.id,
        amount: amount,
        creator_id: creator.id,
        payout_id: payoutRecord?.id || null,
        reference: payoutRef,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[StripeTransfer] Transfer error:", err);
    return new Response(
      JSON.stringify({
        error: err.message || "Failed to process Stripe creator transfer",
        stripe_error_code: err.code || null,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
