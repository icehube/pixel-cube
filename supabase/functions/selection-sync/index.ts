import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://cube.kylehuberman.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const profile = new URL(req.url).searchParams.get("profile_id");
  if (!profile) {
    return new Response("Missing profile_id", { status: 400, headers: corsHeaders });
  }

  const restUrl = `${Deno.env.get("SUPABASE_URL")}/rest/v1/card_selections`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const headers = {
    apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates",
  };

  if (req.method === "GET") {
    const resp = await fetch(`${restUrl}?profile_id=eq.${profile}&select=card_name`, {
      headers,
    });
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (req.method === "POST") {
    await fetch(`${restUrl}?profile_id=eq.${profile}`, { method: "DELETE", headers });
    const payload = await req.text();
    const resp = await fetch(restUrl, { method: "POST", headers, body: payload });
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders });
});
