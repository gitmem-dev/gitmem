/**
 * GitMem License Validation Edge Function
 *
 * Deployed on GitMem's Supabase project (gitmem-api.supabase.co).
 * Called by the MCP server on startup to validate Pro license keys.
 *
 * POST /functions/v1/gitmem-validate
 * Body: { api_key: string, install_id: string }
 * Response: { valid: boolean, tier: string | null, message: string }
 *
 * Validation logic:
 *   1. Check key exists and is active in gitmem_licenses
 *   2. Check key is not expired
 *   3. Check device count <= max_activations (or install_id already registered)
 *   4. Register/update activation record
 *   5. Return tier
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ valid: false, tier: null, message: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let body: { api_key?: string; install_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ valid: false, tier: null, message: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { api_key, install_id } = body;

  if (!api_key || !install_id) {
    return new Response(
      JSON.stringify({ valid: false, tier: null, message: "Missing api_key or install_id" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Basic format validation
  if (!api_key.startsWith("gitmem_pro_") && !api_key.startsWith("gitmem_dev_")) {
    return new Response(
      JSON.stringify({ valid: false, tier: null, message: "Invalid key format" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Connect to our Supabase (service role for admin access)
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Call the validation RPC
  const { data, error } = await supabase.rpc("gitmem_validate_license", {
    p_api_key: api_key,
    p_install_id: install_id,
  });

  if (error) {
    console.error("RPC error:", error);
    return new Response(
      JSON.stringify({ valid: false, tier: null, message: "Internal validation error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // RPC returns a single row: { tier, valid, message }
  const result = Array.isArray(data) ? data[0] : data;

  if (!result) {
    return new Response(
      JSON.stringify({ valid: false, tier: null, message: "No validation result" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      valid: result.valid,
      tier: result.valid ? result.tier : null,
      message: result.message,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
