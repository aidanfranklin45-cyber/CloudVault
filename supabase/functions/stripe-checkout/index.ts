import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface CheckoutRequestBody {
  userId?: string;
  user_id?: string;
  facilityId?: string;
  facility_id?: string;
  toteCount?: number;
  tote_count?: number;
  logisticsType?: string;
  logistics_type?: string;
  promoCode?: string;
  promo_code?: string;
  successUrl?: string;
  success_url?: string;
  cancelUrl?: string;
  cancel_url?: string;
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
    const stripeSecretKey = Deno.env.get("Str1pe_Secret_Key") || Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("stripe_secret_key") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const body: CheckoutRequestBody = await req.json().catch(() => ({}));

    const userId = body.userId || body.user_id || null;
    const facilityId = body.facilityId || body.facility_id || null;
    const toteCountRaw = body.toteCount ?? body.tote_count ?? 1;
    const toteCount = Math.max(1, Number(toteCountRaw) || 1);
    const logisticsType = body.logisticsType || body.logistics_type || "standard";
    const promoCodeInput = (body.promoCode || body.promo_code || "").trim();
    const successUrl = body.successUrl || body.success_url;
    const cancelUrl = body.cancelUrl || body.cancel_url;

    if (!facilityId) {
      return new Response(
        JSON.stringify({
          error: "Missing required parameter 'facilityId'. A valid facility must be selected.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!successUrl || !cancelUrl) {
      return new Response(
        JSON.stringify({
          error: "Missing required parameters 'successUrl' and 'cancelUrl'.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 2. Fetch Dynamic Facility Rates
    const { data: facility, error: facError } = await supabase
      .from("facilities")
      .select("id, name, tier1_rate, tier2_rate, tier3_rate, tier4_rate, valet_base, valet_tote_adder")
      .eq("id", facilityId)
      .maybeSingle();

    if (facError) {
      throw new Error(`Database error querying facility '${facilityId}': ${facError.message}`);
    }

    if (!facility) {
      return new Response(
        JSON.stringify({
          error: `Facility with ID '${facilityId}' not found. Please provide a valid facility ID.`,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (
      facility.tier1_rate === null ||
      facility.tier2_rate === null ||
      facility.tier3_rate === null ||
      facility.tier4_rate === null
    ) {
      throw new Error(
        `Facility '${facility.name || facilityId}' is missing dynamic tier rate configurations in the database.`
      );
    }

    let tier1 = Number(facility.tier1_rate);
    let tier2 = Number(facility.tier2_rate);
    let tier3 = Number(facility.tier3_rate);
    let tier4 = Number(facility.tier4_rate);

    let customerEmail: string | null = null;
    let stripeCustomerId: string | null = null;

    // 3. Check for User Price Lock or Linked Customer ID
    if (userId) {
      const { data: user, error: userError } = await supabase
        .from("users")
        .select("id, email, stripe_customer_id, has_price_lock, price_lock_rates, price_lock_expires_at")
        .eq("id", userId)
        .maybeSingle();

      if (userError) {
        console.warn(`[StripeCheckout] Error checking user profile ${userId}: ${userError.message}`);
      }

      if (user) {
        customerEmail = user.email || null;
        stripeCustomerId = user.stripe_customer_id || null;

        const isPriceLockActive =
          user.has_price_lock &&
          (!user.price_lock_expires_at || new Date(user.price_lock_expires_at) > new Date()) &&
          user.price_lock_rates;

        if (isPriceLockActive) {
          const plr = user.price_lock_rates;
          if (plr.tier1_rate !== undefined) tier1 = Number(plr.tier1_rate);
          if (plr.tier2_rate !== undefined) tier2 = Number(plr.tier2_rate);
          if (plr.tier3_rate !== undefined) tier3 = Number(plr.tier3_rate);
          if (plr.tier4_rate !== undefined) tier4 = Number(plr.tier4_rate);
        }
      }
    }

    // 4. Calculate Dynamic Tier Unit Amount
    let ratePerTote: number;
    let tierName: string;

    if (toteCount >= 50) {
      ratePerTote = tier4;
      tierName = "Tier 4 Enterprise Storage";
    } else if (toteCount >= 25) {
      ratePerTote = tier3;
      tierName = "Tier 3 Commercial Storage";
    } else if (toteCount >= 10) {
      ratePerTote = tier2;
      tierName = "Tier 2 Preferred Storage";
    } else {
      ratePerTote = tier1;
      tierName = "Tier 1 Standard Storage";
    }

    const unitAmountCents = Math.round(ratePerTote * 100);

    // 5. Line items configuration
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `CloudVault Storage - ${tierName}`,
            description: `${toteCount} totes @ $${ratePerTote.toFixed(2)}/tote/month at ${facility.name || facilityId}`,
            metadata: {
              facility_id: facilityId,
              tier_name: tierName,
            },
          },
          unit_amount: unitAmountCents,
          recurring: {
            interval: "month",
          },
        },
        quantity: toteCount,
      },
    ];

    // Valet initial setup / delivery line item if applicable
    if (logisticsType.toLowerCase().includes("valet") && facility.valet_base !== null) {
      const valetBase = Number(facility.valet_base) || 0;
      const valetAdder = Number(facility.valet_tote_adder) || 0;
      const valetTotal = valetBase + toteCount * valetAdder;

      if (valetTotal > 0) {
        lineItems.push({
          price_data: {
            currency: "usd",
            product_data: {
              name: "CloudVault White-Glove Valet Initial Delivery",
              description: `Door-to-door bin drop-off & staging pickup (${toteCount} totes)`,
            },
            unit_amount: Math.round(valetTotal * 100),
          },
          quantity: 1,
        });
      }
    }

    // 6. Dynamic Promo Code Resolution
    let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined = undefined;
    let promoDetails: any = null;

    if (promoCodeInput) {
      const { data: promo, error: promoErr } = await supabase
        .from("promo_codes")
        .select("id, code, creator_id, stripe_coupon_id, stripe_promo_code_id, customer_discount_pct, is_active, expires_at, max_redemptions, current_redemptions")
        .ilike("code", promoCodeInput)
        .maybeSingle();

      if (promoErr) {
        console.warn(`[StripeCheckout] Error checking promo code '${promoCodeInput}': ${promoErr.message}`);
      }

      if (promo) {
        const isExpired = promo.expires_at && new Date(promo.expires_at) <= new Date();
        const isExhausted = promo.max_redemptions !== null && (promo.current_redemptions || 0) >= promo.max_redemptions;
        const isValid = promo.is_active !== false && !isExpired && !isExhausted;

        if (isValid) {
          promoDetails = promo;
          if (promo.stripe_promo_code_id) {
            discounts = [{ promotion_code: promo.stripe_promo_code_id }];
          } else if (promo.stripe_coupon_id) {
            discounts = [{ coupon: promo.stripe_coupon_id }];
          }
        }
      }
    }

    let sessionUrl: string;
    let sessionId: string;

    if (stripeSecretKey) {
      const stripe = new Stripe(stripeSecretKey, {
        apiVersion: "2023-10-16",
        httpClient: Stripe.createFetchHttpClient(),
      });

      // 7. Assemble Session Parameters
      const sessionParams: Stripe.Checkout.SessionCreateParams = {
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: lineItems,
        success_url: successUrl,
        cancel_url: cancelUrl,
        billing_address_collection: "auto",
        metadata: {
          userId: userId || "",
          facilityId: facilityId,
          toteCount: String(toteCount),
          logisticsType: logisticsType,
          ratePerTote: String(ratePerTote),
          promoCode: promoDetails ? promoDetails.code : promoCodeInput || "",
          promoCodeId: promoDetails ? promoDetails.id : "",
          creatorId: promoDetails?.creator_id || "",
        },
        subscription_data: {
          metadata: {
            userId: userId || "",
            facilityId: facilityId,
            toteCount: String(toteCount),
            logisticsType: logisticsType,
            ratePerTote: String(ratePerTote),
            promoCode: promoDetails ? promoDetails.code : "",
          },
        },
      };

      if (discounts && discounts.length > 0) {
        sessionParams.discounts = discounts;
      } else {
        sessionParams.allow_promotion_codes = true;
      }

      if (stripeCustomerId) {
        sessionParams.customer = stripeCustomerId;
        sessionParams.customer_update = {
          address: "auto",
          name: "auto",
        };
      } else if (customerEmail) {
        sessionParams.customer_email = customerEmail;
      }

      if (userId) {
        sessionParams.client_reference_id = userId;
      }

      // 8. Create Stripe Checkout Session
      const session = await stripe.checkout.sessions.create(sessionParams);
      sessionUrl = session.url || `https://checkout.stripe.com/pay/${session.id}`;
      sessionId = session.id;
    } else {
      // Sandbox fallback mode when STRIPE_SECRET_KEY is omitted in test environments
      sessionId = generateRandomId("cs_test_");
      sessionUrl = `https://checkout.stripe.com/pay/${sessionId}`;
    }

    return new Response(
      JSON.stringify({
        url: sessionUrl,
        sessionId: sessionId,
        facility: {
          id: facility.id,
          name: facility.name,
        },
        toteCount,
        ratePerTote,
        unitAmountCents,
        tierName,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("[StripeCheckout] Error creating checkout session:", error.message);
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to create checkout session",
      }),
      {
        status: error.status || 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
