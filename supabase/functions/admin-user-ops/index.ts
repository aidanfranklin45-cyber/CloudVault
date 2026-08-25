// supabase/functions/admin-user-ops/index.ts
// Privileged admin operations: fire_employee | admin_set_password | get_user_by_email

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Check caller authentication
    const authHeader = req.headers.get("Authorization");
    let callerUser = null;
    if (authHeader) {
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (token && token !== anonKey) {
        try {
          const { data: { user } } = await adminClient.auth.getUser(token);
          callerUser = user;
        } catch (e) {
          console.warn("Caller token verify warning:", e);
        }
      }
    }

    const body = await req.json();
    const { operation } = body;

    // ─── OPERATION: fire_employee ──────────────────────────────────────────────
    if (operation === "fire_employee") {
      const { target_user_id } = body;
      if (!target_user_id) {
        return new Response(JSON.stringify({ error: "target_user_id is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (callerUser && target_user_id === callerUser.id) {
        return new Response(JSON.stringify({ error: "Cannot terminate your own account" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 1: Revoke active sessions
      try {
        await adminClient.auth.admin.signOut(target_user_id, "others");
      } catch (e) {
        console.warn("SignOut warning (continuing):", e);
      }

      // Step 2: Mark user inactive
      await adminClient.from("users").update({ is_active: false, role: "terminated" }).eq("id", target_user_id);

      // Step 3: Delete auth credentials
      const { error: deleteErr } = await adminClient.auth.admin.deleteUser(target_user_id);
      if (deleteErr) {
        console.warn("deleteUser warning (continuing):", deleteErr);
      }

      return new Response(JSON.stringify({ success: true, message: "Employee terminated and credentials deleted." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── OPERATION: admin_set_password ────────────────────────────────────────
    if (operation === "admin_set_password") {
      const { target_user_id, email, new_password } = body;
      if (!new_password || new_password.length < 6) {
        return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let uid = target_user_id;

      // If only email was supplied, look up UID
      if (!uid && email) {
        const { data: { users }, error: listErr } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
        if (!listErr && users) {
          const match = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase().trim());
          if (match) uid = match.id;
        }
      }

      if (!uid) {
        return new Response(JSON.stringify({ error: "Could not find user to update password" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: updateData, error: pwErr } = await adminClient.auth.admin.updateUserById(uid, {
        password: new_password,
      });

      if (pwErr) {
        console.error("Admin updateUserById error:", pwErr);
        return new Response(JSON.stringify({ error: pwErr.message || "Failed to update password in Auth" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true, message: "Password updated successfully." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── OPERATION: get_user_by_email ─────────────────────────────────────────
    if (operation === "get_user_by_email") {
      const { email } = body;
      if (!email) {
        return new Response(JSON.stringify({ error: "email is required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: { users }, error: listErr } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
      if (listErr) throw listErr;

      const match = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase().trim());
      if (!match) {
        return new Response(JSON.stringify({ error: "No user found with that email address" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: profile } = await adminClient.from("users").select("name, role, assigned_facility_id").eq("id", match.id).maybeSingle();

      return new Response(JSON.stringify({
        success: true,
        user: {
          id: match.id,
          email: match.email,
          name: profile?.name || null,
          role: profile?.role || "unknown",
          assigned_facility_id: profile?.assigned_facility_id || null,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown operation: ${operation}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("admin-user-ops server error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
