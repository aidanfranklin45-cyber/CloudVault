import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.42.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface FeedbackPayload {
  user_uid?: string;
  user_email?: string;
  user_name?: string;
  report_type: "bug" | "enhancement" | "contact_inquiry";
  flow_area: string;
  title: string;
  description: string;
  severity?: "low" | "medium" | "high" | "critical";
  honeypot?: string;
  diagnostics?: Record<string, unknown>;
}

Deno.serve(async (req: Request) => {
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const githubToken = Deno.env.get("GITHUB_TOKEN") || Deno.env.get("GITHUB_PAT") || Deno.env.get("GH_TOKEN") || "";

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    const payload: FeedbackPayload = await req.json().catch(() => null);
    if (!payload || !payload.title || !payload.description) {
      return new Response(JSON.stringify({ error: "Title and description are required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown_ip";

    // 1. Honeypot Bot Trap Check
    const honeypot = (payload.honeypot || (payload.diagnostics?.hp as string) || "").trim();
    if (honeypot) {
      console.warn(`[Bot Filter] Honeypot triggered from IP ${clientIp}: "${honeypot}"`);
      // Return 200 OK fake success so bots do not adapt or retry, while discarding payload
      return new Response(
        JSON.stringify({
          success: true,
          report_id: "shielded_bot",
          message: "Thank you! Your message has been sent directly to our dispatch team.",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 2. Bot Speed Trap (real humans take > 1500ms to open, read, fill, and submit)
    const formDurationMs = Number(payload.diagnostics?.duration_ms) || 0;
    if (formDurationMs > 0 && formDurationMs < 1500) {
      console.warn(`[Bot Filter] Speed trap triggered from IP ${clientIp}: completed in ${formDurationMs}ms`);
      return new Response(
        JSON.stringify({
          success: true,
          report_id: "shielded_speed",
          message: "Thank you! Your message has been sent directly to our dispatch team.",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 3. Multi-Tier Rate Limiting
    // A. Burst rate limit per IP: max 2 submissions per 60 seconds
    const { data: burstAllowed } = await supabase.rpc("check_rate_limit", {
      p_key: `feedback_burst:${clientIp}`,
      p_max_hits: 2,
      p_window_seconds: 60,
    });

    if (burstAllowed === false) {
      return new Response(
        JSON.stringify({
          error: "Rate limit exceeded. Please wait a moment before sending another message.",
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // B. Hourly rate limit per IP: max 5 submissions per 3600 seconds
    const { data: hourlyAllowed } = await supabase.rpc("check_rate_limit", {
      p_key: `feedback_hour:${clientIp}`,
      p_max_hits: 5,
      p_window_seconds: 3600,
    });

    if (hourlyAllowed === false) {
      return new Response(
        JSON.stringify({
          error: "Hourly limit reached (maximum 5 submissions per hour). Please try again later.",
        }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // C. Email-based rate limit: max 3 submissions per 3600 seconds per email
    const cleanEmail = (payload.user_email || "").toLowerCase().trim();
    if (cleanEmail) {
      const { data: emailAllowed } = await supabase.rpc("check_rate_limit", {
        p_key: `feedback_email:${cleanEmail}`,
        p_max_hits: 3,
        p_window_seconds: 3600,
      });

      if (emailAllowed === false) {
        return new Response(
          JSON.stringify({
            error: "Submission limit reached for this email address (maximum 3 per hour). Please try again later.",
          }),
          {
            status: 429,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    const reportType = payload.report_type === "contact_inquiry" ? "contact_inquiry" : (payload.report_type === "enhancement" ? "enhancement" : "bug");
    const flowArea = (payload.flow_area || "general").slice(0, 50);
    const severity = payload.severity || "medium";
    const title = payload.title.trim().slice(0, 200);
    const description = payload.description.trim().slice(0, 5000);
    const diagnostics = payload.diagnostics || {};

    // 1. Insert feedback report into database
    const { data: dbReport, error: dbError } = await supabase
      .from("feedback_reports")
      .insert({
        user_uid: payload.user_uid || null,
        user_email: payload.user_email || null,
        user_name: payload.user_name || null,
        report_type: reportType,
        flow_area: flowArea,
        title: title,
        description: description,
        severity: severity,
        diagnostics: diagnostics,
        status: "open",
      })
      .select("id, created_at")
      .single();

    if (dbError) {
      console.error("Database insert error:", dbError);
      throw new Error("Database error: " + dbError.message);
    }

    const reportId = dbReport.id;
    let githubIssueNumber: number | null = null;
    let githubIssueUrl: string | null = null;

    // 2. Automatically create GitHub Issue if token is present (Bypass for private contact inquiries)
    if (githubToken && reportType !== "contact_inquiry") {
      try {
        const ghRepoOwner = "aidanfranklin45-cyber";
        const ghRepoName = "CloudVault";
        const isBug = reportType === "bug";
        const prefixTag = isBug ? "🐛 [BUG]" : "💡 [ENHANCEMENT]";
        const ghIssueTitle = prefixTag + " [" + flowArea.toUpperCase() + "] " + title;

        const customerInfo = [
          payload.user_name ? ("**Name:** " + payload.user_name) : null,
          payload.user_email ? ("**Email:** `" + payload.user_email + "`") : null,
          payload.user_uid ? ("**User UID:** `" + payload.user_uid + "`") : null,
        ].filter(Boolean).join(" • ") || "Guest / Unauthenticated User";

        const ghBody = [
          "## " + (isBug ? "Bug Report" : "Feature Request / Enhancement") + " from Customer App",
          "",
          "### Summary",
          description,
          "",
          "---",
          "",
          "### Metadata",
          "- **Report ID:** `" + reportId + "`",
          "- **Customer:** " + customerInfo,
          "- **Category / Flow Area:** `" + flowArea + "`",
          "- **Severity Level:** `" + severity.toUpperCase() + "`",
          "- **Submitted At:** " + new Date().toUTCString(),
          "",
          "---",
          "",
          "<details>",
          "<summary><b>🔍 Automated Diagnostic Telemetry</b></summary>",
          "",
          "```json",
          JSON.stringify(diagnostics, null, 2),
          "```",
          "",
          "</details>",
          "",
          "*Reported via CloudVault In-App Feedback Hub.*"
        ].join("\n");

        const labels = [
          isBug ? "bug" : "enhancement",
          "customer-feedback",
          flowArea ? ("flow:" + flowArea.toLowerCase()) : "flow:general",
        ];

        const ghRes = await fetch("https://api.github.com/repos/" + ghRepoOwner + "/" + ghRepoName + "/issues", {
          method: "POST",
          headers: {
            "Authorization": "token " + githubToken,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "CloudVault-App-Feedback-Agent",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: ghIssueTitle,
            body: ghBody,
            labels: labels,
          }),
        });

        if (ghRes.ok) {
          const ghData = await ghRes.json();
          githubIssueNumber = ghData.number;
          githubIssueUrl = ghData.html_url;

          // Update database record with GitHub Issue metadata
          await supabase
            .from("feedback_reports")
            .update({
              github_issue_number: githubIssueNumber,
              github_issue_url: githubIssueUrl,
            })
            .eq("id", reportId);
        } else {
          const ghErrText = await ghRes.text();
          console.warn("GitHub issue creation failed:", ghRes.status, ghErrText);
        }
      } catch (ghErr) {
        console.warn("Error during GitHub issue dispatch:", ghErr);
      }
    }

    // 3. Automatically dispatch real-time alert to Discord Webhook
    const discordWebhookUrl = Deno.env.get("DISCORD_WEBHOOK_URL");
    if (discordWebhookUrl) {
      try {
        const isContact = reportType === "contact_inquiry";
        const isBug = reportType === "bug";
        let embedTitle = `💡 New Feature Idea / Enhancement`;
        let embedColor = 0x8b5cf6;

        if (isContact) {
          embedTitle = `📬 New Website Contact Inquiry`;
          embedColor = 0x2563eb; // Royal Blue
        } else if (isBug) {
          embedTitle = `🐛 New Bug Report [${severity.toUpperCase()}]`;
          embedColor = severity === "critical" ? 0x991b1b : severity === "high" ? 0xef4444 : 0xf59e0b;
        }

        const fields: any[] = isContact ? [
          {
            name: "👤 Submitter Name",
            value: payload.user_name || "Website Visitor",
            inline: true,
          },
          {
            name: "📧 Email",
            value: payload.user_email ? `\`${payload.user_email}\`` : "Not provided",
            inline: true,
          },
          {
            name: "📞 Phone",
            value: (payload.diagnostics?.phone as string) || "Not provided",
            inline: true,
          },
          {
            name: "🏷️ Topic / Subject",
            value: title,
            inline: false,
          },
          {
            name: "💬 Message",
            value: description.length > 1000 ? description.slice(0, 997) + "..." : description,
            inline: false,
          },
        ] : [
          {
            name: "📌 Title",
            value: title,
            inline: false,
          },
          {
            name: "👤 Submitter",
            value: payload.user_email 
              ? `${payload.user_name || "Customer"} (\`${payload.user_email}\`)` 
              : "Anonymous / Guest",
            inline: true,
          },
          {
            name: "🧭 Flow Area",
            value: `\`${flowArea}\``,
            inline: true,
          },
          {
            name: "⚡ Severity",
            value: `\`${severity.toUpperCase()}\``,
            inline: true,
          },
          {
            name: "📝 Description",
            value: description.length > 1000 ? description.slice(0, 997) + "..." : description,
            inline: false,
          },
        ];

        if (githubIssueUrl) {
          fields.push({
            name: "🐙 GitHub Issue",
            value: `[#${githubIssueNumber}](${githubIssueUrl})`,
            inline: true,
          });
        }

        if (!isContact && diagnostics && typeof diagnostics === "object" && Object.keys(diagnostics).length > 0) {
          const diagEntries = Object.entries(diagnostics)
            .filter(([_, v]) => v != null && typeof v !== "object")
            .slice(0, 4)
            .map(([k, v]) => `• **${k}**: \`${v}\``)
            .join("\n");
          if (diagEntries) {
            fields.push({
              name: "🔍 Diagnostic Telemetry",
              value: diagEntries,
              inline: false,
            });
          }
        }

        await fetch(discordWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: isContact ? "CloudVault Inquiries" : "CloudVault Feedback Bot",
            avatar_url: "https://cloudvault-35a9b-6b3db.web.app/logo.png",
            embeds: [
              {
                title: embedTitle,
                color: embedColor,
                fields: fields,
                timestamp: new Date().toISOString(),
                footer: { text: isContact ? `Inquiry ID: ${reportId} • CloudVault Dispatch` : `Report ID: ${reportId} • CloudVault Feedback Hub` },
              },
            ],
          }),
        });
      } catch (discordErr) {
        console.warn("[Feedback] Discord webhook dispatch warning:", discordErr);
      }
    }

    const successMsg = reportType === "contact_inquiry"
      ? "Thank you! Your message has been sent directly to our dispatch team. We will get back to you shortly."
      : "Feedback submitted successfully! Thank you for helping improve CloudVault.";

    return new Response(
      JSON.stringify({
        success: true,
        report_id: reportId,
        github_issue_number: githubIssueNumber,
        github_issue_url: githubIssueUrl,
        message: successMsg,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err: any) {
    console.error("submit-feedback error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error." }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
