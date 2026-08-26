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

    const body: TransferRequestBody = await req.json().catch(() => ({}));
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
