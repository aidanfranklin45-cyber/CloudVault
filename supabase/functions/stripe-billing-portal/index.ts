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
    const stripeSecretKey = Deno.env.get("Stripe_Secret_Key") || Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("Str1pe_Secret_Key") || Deno.env.get("stripe_secret_key") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    const body: PortalRequestBody = await req.json().catch(() => ({}));
    let customerId = body.stripeCustomerId || body.stripe_customer_id || null;
    const userId = body.userId || body.user_id || null;
    const returnUrl = body.returnUrl || body.return_url || "https://cloudvault-35a9b-6b3db.web.app/dashboard.html";

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

    if (!stripeSecretKey) {
      return new Response(
        JSON.stringify({
          error: "STRIPE_SECRET_KEY is not configured in Supabase Edge Functions environment.",
          url: null,
          isSimulated: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // If customerId is missing or simulated, auto-create a real customer in Stripe
    if (!customerId || customerId.startsWith("cus_sim_")) {
      const email = userRecord?.email || `user_${userId || Date.now()}@cloudvault.app`;
      const name = userRecord?.name || email.split("@")[0];

      const existingCustomers = await stripe.customers.list({ email: email, limit: 1 });
      if (existingCustomers.data.length > 0) {
        customerId = existingCustomers.data[0].id;
      } else {
        const newCustomer = await stripe.customers.create({
          email: email,
          name: name,
          metadata: { supabase_uid: userId || "" },
        });
        customerId = newCustomer.id;
      }

      if (userId) {
        await supabase
          .from("users")
          .update({ stripe_customer_id: customerId })
          .eq("id", userId);
      }
    }

    const publishableKey = Deno.env.get("STRIPE_PUBLISHABLE_KEY") || Deno.env.get("Stripe_Publishable_Key") || Deno.env.get("STRIPE_PK") || "";

    // If client requested SetupIntent for Stripe Elements
    if (body.mode === "setup_intent") {
      try {
        const setupIntent = await stripe.setupIntents.create({
          customer: customerId,
          payment_method_types: ["card"],
          metadata: { supabase_uid: userId || "" },
        });

        return new Response(
          JSON.stringify({
            clientSecret: setupIntent.client_secret,
            publishableKey: publishableKey,
            customerId: customerId,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (setupErr: any) {
        console.error("[StripeBillingPortal] Error creating SetupIntent:", setupErr.message);
        return new Response(
          JSON.stringify({ error: setupErr.message || "Failed to create SetupIntent" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // If client requested attaching a newly tokenized payment method
    if (body.mode === "attach_payment_method" && body.paymentMethodId) {
      try {
        let pm: Stripe.PaymentMethod;
        try {
          pm = await stripe.paymentMethods.attach(body.paymentMethodId, {
            customer: customerId,
          });
        } catch (attachErr: any) {
          // If already attached to customer by SetupIntent or needs retrieval
          pm = await stripe.paymentMethods.retrieve(body.paymentMethodId);
        }

        try {
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: body.paymentMethodId },
          });
        } catch (custErr: any) {
          console.warn("[StripeBillingPortal] Customer default PM update notice:", custErr.message);
        }

        const brand = pm.card?.brand || "visa";
        const last4 = pm.card?.last4 || "4242";
        const expMonth = pm.card?.exp_month ? String(pm.card.exp_month).padStart(2, "0") : "12";
        const expYear = pm.card?.exp_year ? String(pm.card.exp_year).slice(-2) : "28";
        const expStr = `${expMonth}/${expYear}`;

        if (userId) {
          await supabase
            .from("users")
            .update({
              default_payment_method_id: body.paymentMethodId,
              card_brand: brand,
              card_last4: last4,
              card_exp: expStr,
            })
            .eq("id", userId);
        }

        return new Response(
          JSON.stringify({
            success: true,
            paymentMethodId: body.paymentMethodId,
            brand: brand,
            last4: last4,
            exp: expStr,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (attachErr: any) {
        console.error("[StripeBillingPortal] Error attaching payment method:", attachErr.message);
        return new Response(
          JSON.stringify({ error: attachErr.message || "Failed to attach payment method" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    let portalUrl: string | null = null;
    let lastErrorMsg: string | null = null;

    // Step 1: Attempt standard Billing Portal session creation
    try {
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      portalUrl = portalSession.url;
    } catch (portalErr: any) {
      console.warn("[StripeBillingPortal] Direct portal session attempt:", portalErr.message);
      lastErrorMsg = portalErr.message;

      // If no portal configuration exists, list or create one dynamically
      if (portalErr.message && (portalErr.message.includes("configuration") || portalErr.message.includes("portal"))) {
        try {
          const configs = await stripe.billingPortal.configurations.list({ limit: 1 });
          let configId = configs.data.length > 0 ? configs.data[0].id : null;

          if (!configId) {
            const newConfig = await stripe.billingPortal.configurations.create({
              business_profile: {
                headline: "CloudVault Account & Payment Management",
              },
              features: {
                payment_method_update: { enabled: true },
                customer_update: {
                  allowed_updates: ["email", "address", "phone"],
                  enabled: true,
                },
                invoice_history: { enabled: true },
              },
            });
            configId = newConfig.id;
          }

          if (configId) {
            const portalSession = await stripe.billingPortal.sessions.create({
              customer: customerId,
              return_url: returnUrl,
              configuration: configId,
            });
            portalUrl = portalSession.url;
          }
        } catch (configErr: any) {
          console.warn("[StripeBillingPortal] Config creation/retry attempt:", configErr.message);
          lastErrorMsg = configErr.message;
        }
      }
    }

    // Step 2: Fallback to Stripe Hosted Checkout Setup Mode (allowing instant card update directly on Stripe)
    if (!portalUrl) {
      try {
        const setupSession = await stripe.checkout.sessions.create({
          mode: "setup",
          customer: customerId,
          payment_method_types: ["card"],
          success_url: `${returnUrl}?setup_success=true&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: returnUrl,
          metadata: {
            supabase_uid: userId || "",
            purpose: "update_payment_method",
          },
        });
        portalUrl = setupSession.url;
      } catch (setupErr: any) {
        console.warn("[StripeBillingPortal] Checkout setup session fallback error:", setupErr.message);
        lastErrorMsg = setupErr.message;
      }
    }

    if (portalUrl) {
      return new Response(
        JSON.stringify({
          url: portalUrl,
          customerId: customerId,
          publishableKey: publishableKey,
          isSimulated: false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } else {
      return new Response(
        JSON.stringify({
          url: null,
          customerId: customerId,
          publishableKey: publishableKey,
          isSimulated: true,
          error: lastErrorMsg || "Failed to create portal or setup session",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (error: any) {
    console.error("[StripeBillingPortal] Critical Error:", error.message);
    return new Response(
      JSON.stringify({ error: error.message || "Failed to create customer portal session" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
