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

function generateRandomId(prefix: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = prefix;
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
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

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const body: PortalRequestBody = await req.json().catch(() => ({}));

    let customerId = body.stripeCustomerId || body.stripe_customer_id || null;
    const userId = body.userId || body.user_id || null;
    const returnUrl = body.returnUrl || body.return_url || "https://cloudvault.app/dashboard.html";

    // 2. Resolve Stripe Customer ID if not directly provided
    if (!customerId && userId) {
      // Check users table first
      const { data: user, error: userErr } = await supabase
        .from("users")
        .select("id, stripe_customer_id, email")
        .eq("id", userId)
        .maybeSingle();

      if (userErr) {
        console.warn(`[StripeBillingPortal] Error querying user ${userId}: ${userErr.message}`);
      }

      if (user && user.stripe_customer_id) {
        customerId = user.stripe_customer_id;
      } else {
        // Check subscriptions table as fallback
        const { data: sub, error: subErr } = await supabase
          .from("subscriptions")
          .select("stripe_customer_id")
          .eq("uid", userId)
          .not("stripe_customer_id", "is", null)
          .maybeSingle();

        if (subErr) {
          console.warn(`[StripeBillingPortal] Error querying subscription for user ${userId}: ${subErr.message}`);
        }

        if (sub && sub.stripe_customer_id) {
          customerId = sub.stripe_customer_id;
        }
      }
    }

    if (!customerId) {
      return new Response(
        JSON.stringify({
          error: `No linked Stripe Customer ID found for the provided account (userId: ${userId || "none"}). Ensure the customer has an active payment profile.`,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    let portalUrl: string;

    if (stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, {
        apiVersion: "2023-10-16",
        httpClient: Stripe.createFetchHttpClient(),
      });

      // 3. Create Stripe Customer Billing Portal Session
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      portalUrl = portalSession.url;
    } else {
      const portalSessionId = generateRandomId("bps_test_");
      portalUrl = `https://billing.stripe.com/p/session/${portalSessionId}`;
    }

    return new Response(
      JSON.stringify({
        url: portalUrl,
        customerId: customerId,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("[StripeBillingPortal] Error creating portal session:", error.message);
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to create customer portal session",
      }),
      {
        status: error.status || 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
