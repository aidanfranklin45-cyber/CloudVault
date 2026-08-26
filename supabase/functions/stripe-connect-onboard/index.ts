import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface OnboardRequestBody {
  creatorId?: string;
  creator_id?: string;
  returnUrl?: string;
  return_url?: string;
  refreshUrl?: string;
  refresh_url?: string;
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

    const body: OnboardRequestBody = await req.json().catch(() => ({}));
    const creatorId = body.creatorId || body.creator_id;
    const returnUrl = body.returnUrl || body.return_url || "https://cloudvault-35a9b-6b3db.web.app/admin.html?connect=success";
    const refreshUrl = body.refreshUrl || body.refresh_url || "https://cloudvault-35a9b-6b3db.web.app/admin.html?connect=refresh";

    if (!creatorId) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter: creatorId" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Fetch Creator Record
    const { data: creator, error: creatorErr } = await supabase
      .from("creators")
      .select("*")
      .eq("id", creatorId)
      .single();

    if (creatorErr || !creator) {
      return new Response(
        JSON.stringify({ error: `Creator with ID ${creatorId} not found.` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let accountId = creator.stripe_connect_id;

    // 2. Create Stripe Express Account if not already created
    if (!accountId) {
      console.log(`[StripeConnect] Creating new Express account for creator ${creator.name} (${creator.email})...`);
      let account;
      try {
        // Modern Stripe Connect Controller configuration
        account = await stripe.accounts.create({
          controller: {
            stripe_dashboard: {
              type: "express",
            },
            fees: {
              payer: "application",
            },
            losses: {
              payments: "application",
            },
          },
          email: creator.payout_email || creator.email,
          business_type: "individual",
          capabilities: {
            transfers: { requested: true },
          },
          metadata: {
            creator_id: creator.id,
            creator_name: creator.name,
            platform: "CloudVault",
          },
        });
      } catch (modernErr: any) {
        console.warn("[StripeConnect] Controller creation notice, falling back to legacy express format:", modernErr.message);
        account = await stripe.accounts.create({
          type: "express",
          email: creator.payout_email || creator.email,
          capabilities: {
            transfers: { requested: true },
            card_payments: { requested: true },
          },
          business_type: "individual",
          metadata: {
            creator_id: creator.id,
            creator_name: creator.name,
            platform: "CloudVault",
          },
        });
      }

      accountId = account.id;

      // Update creators table with the new Connect ID
      await supabase
        .from("creators")
        .update({
          stripe_connect_id: accountId,
          stripe_connect_status: "pending",
          updated_at: new Date().toISOString(),
        })
        .eq("id", creator.id);

      console.log(`[StripeConnect] Created Express account ${accountId} for creator ${creator.id}`);
    }

    // 3. Generate Hosted Onboarding URL
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${refreshUrl}&creator_id=${creator.id}`,
      return_url: `${returnUrl}&creator_id=${creator.id}`,
      type: "account_onboarding",
    });

    return new Response(
      JSON.stringify({
        success: true,
        url: accountLink.url,
        account_id: accountId,
        creator_id: creator.id,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("[StripeConnect] Onboarding error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Failed to generate Stripe Connect onboarding link" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
