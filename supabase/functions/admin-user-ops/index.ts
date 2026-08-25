// supabase/functions/admin-user-ops/index.ts
// Privileged admin user operations - requires executive JWT
// Operations: fire_employee | admin_set_password | get_user_by_email

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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: callerUser }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !callerUser) {
      return new Response(JSON.stringify({ error: "Unauthorized - invalid session" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: callerProfile } = await callerClient
      .from("users").select("role").eq("id", callerUser.id).single();

    if (!callerProfile || callerProfile.role !== "executive") {
      return new Response(JSON.stringify({ error: "Forbidden - executive clearance required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body = await req.json();
    const { operation } = body;

    if (operation === "fire_employee") {
      const { target_user_id } = body;
      if (!target_user_id) {
        return new Response(JSON.stringify({ error: "target_user_id required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (target_user_id === callerUser.id) {
        return new Response(JSON.stringify({ error: "Cannot terminate your own account" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Step 1: Revoke all active sessions immediately
      try {
        await adminClient.auth.admin.signOut(target_user_id, "others");
      } catch (e) {
        console.warn("SignOut error (ignoring):", e);
      }
      // Step 2: Mark user inactive
      await adminClient.from("users").update({ is_active: false, role: 'terminated' }).eq("id", target_user_id);
      // Step 3: Delete auth credentials permanently
      const { error: deleteErr } = await adminClient.auth.admin.deleteUser(target_user_id);
      if (deleteErr) throw deleteErr;

      return new Response(JSON.stringify({ success: true, message: "Employee terminated, sessions revoked, credentials deleted." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (operation === "admin_set_password") {
      const { target_user_id, new_password } = body;
      if (!target_user_id || !new_password) {
        return new Response(JSON.stringify({ error: "target_user_id and new_password required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (new_password.length < 6) {
        return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { error: pwErr } = await adminClient.auth.admin.updateUserById(target_user_id, { password: new_password });
      if (pwErr) throw pwErr;
      return new Response(JSON.stringify({ success: true, message: "Password updated successfully." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (operation === "get_user_by_email") {
      const { email } = body;
      if (!email) {
        return new Response(JSON.stringify({ error: "email required" }), {
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
      const { data: profile } = await adminClient.from("users").select("name, role, assigned_facility_id").eq("id", match.id).single();
      return new Response(JSON.stringify({
        success: true,
        user: { id: match.id, email: match.email, name: profile?.name || null, role: profile?.role || "unknown", assigned_facility_id: profile?.assigned_facility_id || null }
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Unknown operation: " + operation }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("admin-user-ops error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
