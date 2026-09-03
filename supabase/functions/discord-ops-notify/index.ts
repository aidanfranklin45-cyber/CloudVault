import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface DiscordNotifyBody {
  event: "tote_retrieval" | "totes_rented" | "waitlist_joined" | "retrieval_completed";
  customerName?: string;
  customerEmail?: string;
  userId?: string;
  facilityId?: string;
  facilityName?: string;
  fulfillmentType?: string;
  toteCount?: number;
  toteCodes?: string[];
  targetDate?: string;
  timeSlot?: string;
  deliveryAddress?: string;
  deliveryNotes?: string;
  planName?: string;
  monthlyAmount?: number;
  totalCharged?: number;
  surgeFee?: number;
  surgeTier?: string;
  promoCode?: string;
  discountAmount?: number;
  city?: string;
  zipCode?: string;
  depositStatus?: string;
  depositAmount?: number;
}

Deno.serve(async (req: Request) => {
  // 1. Handle CORS
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
    const webhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL") || "";

    const body: DiscordNotifyBody = await req.json().catch(() => ({}));
    const event = body.event || "tote_retrieval";

    if (!webhookUrl) {
      console.warn("[DiscordWebhook] DISCORD_WEBHOOK_URL is not configured in Supabase secrets.");
      return new Response(
        JSON.stringify({
          success: false,
          warning: "DISCORD_WEBHOOK_URL secret is not set in Supabase. Skipping webhook dispatch.",
          receivedData: body,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let embed: any = null;
    const timestamp = new Date().toISOString();

    if (event === "tote_retrieval") {
      const isValet = (body.fulfillmentType === "valet_delivery");
      const title = isValet ? "🚚 New Doorstep Valet Delivery Request" : "🏢 New Self-Service Staging Room Pickup";
      const color = isValet ? 0x2563eb : 0x10b981; // Blue for Valet, Emerald for Pickup
      const toteCodesStr = Array.isArray(body.toteCodes) && body.toteCodes.length > 0 
        ? body.toteCodes.join(", ") 
        : `${body.toteCount || 1} Tote(s)`;

      const fields = [
        {
          name: "👤 Customer",
          value: `${body.customerName || "Customer"} (${body.customerEmail || "No Email"})`,
          inline: true,
        },
        {
          name: "📍 Fulfillment Hub",
          value: body.facilityName || "Yakima Fulfillment Center (Selah, WA)",
          inline: true,
        },
        {
          name: "📦 Requested Totes",
          value: `**${body.toteCount || 1} Total**\n\`${toteCodesStr}\``,
          inline: true,
        },
        {
          name: "🗓️ Target Schedule",
          value: `${body.targetDate || "Next Available"} • ${body.timeSlot || "Standard Window"}`,
          inline: true,
        },
      ];

      if (isValet && body.deliveryAddress) {
        fields.push({
          name: "🏠 Delivery Address",
          value: body.deliveryAddress,
          inline: false,
        });
      }

      if (body.deliveryNotes) {
        fields.push({
          name: "📝 Customer Instructions",
          value: body.deliveryNotes,
          inline: false,
        });
      }

      let financialSummary = `$${Number(body.totalCharged || 0).toFixed(2)}`;
      if (body.promoCode) {
        financialSummary += ` (Coupon: **${body.promoCode}** -$${Number(body.discountAmount || 0).toFixed(2)})`;
      }
      if (body.surgeFee && body.surgeFee > 0) {
        financialSummary += ` • Surge: +$${Number(body.surgeFee).toFixed(2)} (${body.surgeTier || "Expedited"})`;
      }

      fields.push({
        name: "💳 Total Due / Charged",
        value: financialSummary,
        inline: true,
      });

      embed = {
        title,
        color,
        description: `A customer has scheduled a tote retrieval on the CloudVault portal.`,
        fields,
        footer: { text: "CloudVault Logistics & Warehouse System" },
        timestamp,
      };

    } else if (event === "totes_rented") {
      // New Customer Subscription / Checkout
      const fields = [
        {
          name: "👤 Customer",
          value: `${body.customerName || "Customer"} (${body.customerEmail || "No Email"})`,
          inline: true,
        },
        {
          name: "📦 Plan & Totes Rented",
          value: `**${body.toteCount || 5} Totes** (${body.planName || "Standard Storage Plan"})`,
          inline: true,
        },
        {
          name: "📍 Facility Hub",
          value: body.facilityName || "Yakima Fulfillment Center (Selah, WA)",
          inline: true,
        },
        {
          name: "💰 Monthly Subscription",
          value: `$${Number(body.monthlyAmount || 25).toFixed(2)}/mo${body.promoCode ? ` (Promo: **${body.promoCode}**)` : ""}`,
          inline: true,
        },
      ];

      if (body.deliveryAddress) {
        fields.push({
          name: "🏠 Drop-off Address / Target",
          value: `${body.deliveryAddress}${body.targetDate ? ` • ${body.targetDate}` : ""}`,
          inline: false,
        });
      }

      embed = {
        title: "🎉 New Customer Totes Rented / Subscription Activated!",
        color: 0x059669, // Rich Emerald
        description: `A new customer completed checkout and reserved totes!`,
        fields,
        footer: { text: "CloudVault Billing & Customer Activation" },
        timestamp,
      };

    } else if (event === "waitlist_joined") {
      // Expansion Market Waitlist
      const hasDeposit = (body.depositStatus === "paid" || (body.depositAmount && body.depositAmount > 0));
      const fields = [
        {
          name: "👤 Lead",
          value: `${body.customerName || "Expansion Lead"} (${body.customerEmail || "No Email"})`,
          inline: true,
        },
        {
          name: "📍 Expansion City & ZIP",
          value: `**${body.city || "Pending Market"}** (${body.zipCode || "N/A"})`,
          inline: true,
        },
        {
          name: "📦 Reserved Capacity",
          value: `**${body.toteCount || 5} Totes**`,
          inline: true,
        },
        {
          name: "🔒 3-Year Rate Lock Status",
          value: hasDeposit ? "✅ **Priority Deposit Paid ($10.00)**" : "Standard Waitlist (No Deposit)",
          inline: true,
        },
      ];

      embed = {
        title: "📋 New Expansion Market Waitlist Lead",
        color: hasDeposit ? 0xd97706 : 0x6366f1, // Amber if deposit paid, Indigo if standard
        description: `A visitor joined the expansion queue for an upcoming unlaunched market.`,
        fields,
        footer: { text: "CloudVault Market Expansion Router" },
        timestamp,
      };

    } else if (event === "retrieval_completed") {
      embed = {
        title: "✅ Tote Retrieval Completed",
        color: 0x10b981,
        description: `Totes for **${body.customerName || "Customer"}** have been fulfilled/handed off.`,
        fields: [
          { name: "📦 Totes", value: (body.toteCodes || []).join(", ") || `${body.toteCount || 1} Totes`, inline: true },
          { name: "📍 Hub", value: body.facilityName || "Yakima Fulfillment Center", inline: true },
        ],
        footer: { text: "CloudVault Warehouse Operations" },
        timestamp,
      };
    }

    // Send payload to Discord
    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "CloudVault Ops",
        avatar_url: "https://cloudvault-35a9b-6b3db.web.app/logo.png",
        embeds: [embed],
      }),
    });

    if (!discordRes.ok) {
      const errText = await discordRes.text();
      console.error("[DiscordWebhook] Discord API error:", discordRes.status, errText);
      return new Response(
        JSON.stringify({ success: false, error: `Discord API responded with ${discordRes.status}: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, event, deliveredAt: timestamp }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("[DiscordWebhook] Exception:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
