import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PortalRequestBody {
  userId?: string;
  user_id?: string;
  stripeCustomerId?: string;
  stripe_customer_id?: string;
  returnUrl?: string;
  return_url?: string;
}

Deno.serve(async (req: Request) => {
  // 1. Handle CORS Preflight
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
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    const body: PortalRequestBody = await req.json().catch(() => ({}));
    let customerId = body.stripeCustomerId || body.stripe_customer_id || null;
    const userId = body.userId || body.user_id || null;
    const returnUrl = body.returnUrl || body.return_url || "https://cloudvault-35a9b-6b3db.web.app/dashboard.html";

    // Fast-path: If real Stripe Customer ID is passed and Stripe Secret exists, generate portal session directly
    if (stripeSecretKey && customerId && customerId.startsWith("cus_") && !customerId.startsWith("cus_sim_")) {
      try {
        const stripe = new Stripe(stripeSecretKey, {
          apiVersion: "2023-10-16",
          httpClient: Stripe.createFetchHttpClient(),
        });

        const portalSession = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: returnUrl,
        });

        return new Response(
          JSON.stringify({
            url: portalSession.url,
            customerId: customerId,
            isSimulated: false,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (fastErr: any) {
        console.warn("[StripeBillingPortal] Fast path notice:", fastErr.message);
      }
    }

    // Fallback path: Lookup user in database or create customer
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    let userRecord: { id: string; email?: string; name?: string; stripe_customer_id?: string } | null = null;

    if (userId) {
      const { data: user } = await supabase
        .from("users")
        .select("id, stripe_customer_id, email, name")
        .eq("id", userId)
        .maybeSingle();

      if (user) {
        userRecord = user;
        if (!customerId && user.stripe_customer_id) {
          customerId = user.stripe_customer_id;
        }
      }
    }

    if (!customerId && stripeSecretKey && userRecord?.email) {
      try {
        const stripe = new Stripe(stripeSecretKey, {
          apiVersion: "2023-10-16",
          httpClient: Stripe.createFetchHttpClient(),
        });

        const newCustomer = await stripe.customers.create({
          email: userRecord.email,
          name: userRecord.name || userRecord.email.split("@")[0],
          metadata: { supabase_uid: userId || "" },
        });

        customerId = newCustomer.id;

        if (userId) {
          await supabase
            .from("users")
            .update({ stripe_customer_id: customerId })
            .eq("id", userId);
        }
      } catch (createErr: any) {
        console.warn("[StripeBillingPortal] Auto customer creation notice:", createErr.message);
      }
    }

    let portalUrl: string | null = null;
    let isSimulated = false;

    if (stripeSecretKey && customerId && !customerId.startsWith("cus_sim_")) {
      try {
        const stripe = new Stripe(stripeSecretKey, {
          apiVersion: "2023-10-16",
          httpClient: Stripe.createFetchHttpClient(),
        });

        const portalSession = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: returnUrl,
        });
        portalUrl = portalSession.url;
      } catch (err: any) {
        console.warn("[StripeBillingPortal] Portal API notice:", err.message);
        isSimulated = true;
      }
    } else {
      isSimulated = true;
    }

    return new Response(
      JSON.stringify({
        url: portalUrl,
        customerId: customerId,
        isSimulated: isSimulated,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("[StripeBillingPortal] Error:", error.message);
    return new Response(
      JSON.stringify({ error: error.message || "Failed to create customer portal session" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
