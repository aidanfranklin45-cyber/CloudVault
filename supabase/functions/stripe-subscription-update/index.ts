import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@^14.25.0";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface UpdateSubscriptionRequestBody {
  userId?: string;
  user_id?: string;
  targetToteCount?: number;
  target_tote_count?: number;
  targetTotes?: number;
  facilityId?: string;
  facility_id?: string;
  prorationBehavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
  proration_behavior?: Stripe.SubscriptionUpdateParams.ProrationBehavior;
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
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!stripeSecretKey) {
      throw new Error("Missing STRIPE_SECRET_KEY environment variable.");
    }
    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error("Missing Supabase configuration environment variables.");
    }

    const stripe = new Stripe(stripeSecretKey, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const body: UpdateSubscriptionRequestBody = await req.json().catch(() => ({}));

    const userId = body.userId || body.user_id;
    const targetToteCountRaw = body.targetToteCount ?? body.target_tote_count ?? body.targetTotes;
    let facilityId = body.facilityId || body.facility_id || null;
    const prorationBehavior = body.prorationBehavior || body.proration_behavior || "always_invoice";

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Missing required parameter 'userId'." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (targetToteCountRaw === undefined || targetToteCountRaw === null || isNaN(Number(targetToteCountRaw))) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid parameter 'targetToteCount'." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const targetToteCount = Math.max(1, Number(targetToteCountRaw));

    // 2. Fetch User & Subscription Details
    const { data: user, error: userErr } = await supabase
      .from("users")
      .select("id, email, stripe_customer_id, stripe_subscription_id, assigned_facility_id, has_price_lock, price_lock_rates, price_lock_expires_at")
      .eq("id", userId)
      .maybeSingle();

    if (userErr) {
      throw new Error(`Database error querying user profile: ${userErr.message}`);
    }
    if (!user) {
      return new Response(
        JSON.stringify({ error: `User with ID '${userId}' not found.` }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve active facility
    if (!facilityId) {
      facilityId = user.assigned_facility_id;
    }

    // Query active subscription from database
    const { data: subRecord, error: subDbErr } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("uid", userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subDbErr) {
      console.warn(`[StripeSubscriptionUpdate] Error querying subscription: ${subDbErr.message}`);
    }

    if (!facilityId && subRecord && subRecord.facility_id) {
      facilityId = subRecord.facility_id;
    }

    if (!facilityId) {
      return new Response(
        JSON.stringify({
          error: "Could not resolve an assigned facility for this account. Please specify 'facilityId'.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Fetch Dynamic Facility Rates
    const { data: facility, error: facError } = await supabase
      .from("facilities")
      .select("id, name, tier1_rate, tier2_rate, tier3_rate, tier4_rate")
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
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (
      facility.tier1_rate === null ||
      facility.tier2_rate === null ||
      facility.tier3_rate === null ||
      facility.tier4_rate === null
    ) {
      throw new Error(
        `Facility '${facility.name || facilityId}' is missing dynamic tier rates in the database.`
      );
    }

    let tier1 = Number(facility.tier1_rate);
    let tier2 = Number(facility.tier2_rate);
    let tier3 = Number(facility.tier3_rate);
    let tier4 = Number(facility.tier4_rate);

    // Check user price lock
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

    // 4. Calculate Dynamic Rate Tier for New Tote Count
    let newRate: number;
    let tierName: string;

    if (targetToteCount >= 50) {
      newRate = tier4;
      tierName = "Tier 4 Enterprise Volume";
    } else if (targetToteCount >= 25) {
      newRate = tier3;
      tierName = "Tier 3 Commercial Volume";
    } else if (targetToteCount >= 10) {
      newRate = tier2;
      tierName = "Tier 2 Preferred Volume";
    } else {
      newRate = tier1;
      tierName = "Tier 1 Standard Volume";
    }

    const stripeSubId = user.stripe_subscription_id || subRecord?.stripe_subscription_id;
    let prorationAmount = 0;
    let updatedStripeSub: any = null;

    // 5. Update Stripe Subscription if linked
    if (stripeSubId) {
      const existingStripeSub = await stripe.subscriptions.retrieve(stripeSubId);

      if (existingStripeSub && existingStripeSub.items?.data?.length > 0) {
        const primaryItem = existingStripeSub.items.data[0];
        const existingProduct =
          typeof primaryItem.price.product === "string"
            ? primaryItem.price.product
            : (primaryItem.price.product as Stripe.Product)?.id;

        const updatePayload: Stripe.SubscriptionUpdateParams = {
          proration_behavior: prorationBehavior,
          items: [
            {
              id: primaryItem.id,
              quantity: targetToteCount,
              price_data: {
                currency: "usd",
                product: existingProduct,
                unit_amount: Math.round(newRate * 100),
                recurring: {
                  interval: "month",
                },
              },
            },
          ],
          metadata: {
            userId: userId,
            facilityId: facilityId,
            toteCount: String(targetToteCount),
            ratePerTote: String(newRate),
            planTier: tierName,
            last_updated: new Date().toISOString(),
          },
        };

        updatedStripeSub = await stripe.subscriptions.update(stripeSubId, updatePayload);

        // Retrieve upcoming invoice or latest invoice to calculate proration amount if applicable
        if (existingStripeSub.customer) {
          try {
            const customerId =
              typeof existingStripeSub.customer === "string"
                ? existingStripeSub.customer
                : existingStripeSub.customer.id;

            const upcoming = await stripe.invoices.retrieveUpcoming({
              customer: customerId,
              subscription: stripeSubId,
            });

            if (upcoming && upcoming.amount_due !== undefined) {
              prorationAmount = (upcoming.amount_due || 0) / 100;
            }
          } catch (e: any) {
            console.warn(`[StripeSubscriptionUpdate] Non-blocking notice fetching upcoming invoice: ${e.message}`);
          }
        }
      }
    }

    const nowIso = new Date().toISOString();
    const monthlyTotal = targetToteCount * newRate;

    // 6. Update local Database Records
    if (subRecord?.id) {
      await supabase
        .from("subscriptions")
        .update({
          total_totes: targetToteCount,
          tote_count: targetToteCount,
          quantity: targetToteCount,
          tote_rate: newRate,
          recurring_storage: monthlyTotal,
          monthly_total: monthlyTotal,
          plan_tier: tierName,
          facility_id: facilityId,
          last_updated: nowIso,
          updated_at: nowIso,
        })
        .eq("id", subRecord.id);
    } else {
      await supabase.from("subscriptions").insert({
        uid: userId,
        stripe_subscription_id: stripeSubId || null,
        stripe_customer_id: user.stripe_customer_id || null,
        total_totes: targetToteCount,
        tote_count: targetToteCount,
        quantity: targetToteCount,
        tote_rate: newRate,
        recurring_storage: monthlyTotal,
        monthly_total: monthlyTotal,
        plan_tier: tierName,
        facility_id: facilityId,
        status: "active",
        created_at: nowIso,
        last_updated: nowIso,
      });
    }

    await supabase
      .from("users")
      .update({
        active_totes_held: targetToteCount,
        assigned_facility_id: facilityId,
      })
      .eq("id", userId);

    return new Response(
      JSON.stringify({
        success: true,
        newQuantity: targetToteCount,
        newRate: newRate,
        tierName: tierName,
        monthlyTotal: monthlyTotal,
        prorationAmount: prorationAmount,
        facility: {
          id: facility.id,
          name: facility.name,
        },
        stripeSubscriptionId: stripeSubId || null,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("[StripeSubscriptionUpdate] Error updating subscription:", error.message);
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to update subscription",
      }),
      {
        status: error.status || 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
