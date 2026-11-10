// Can a Cloudflare Worker reach OpenAI? No credentials involved: a JSON 401 from alpha/search
// means the request reached OpenAI's origin; an HTML "Just a moment" page or a `cf-mitigated:
// challenge` header means Cloudflare bot management blocked this egress.
import { isChallenge } from "../src/codex";

async function probe(name: string, url: string, init: RequestInit) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: "manual", ...init });
    const body = await response.text();
    return {
      name,
      status: response.status,
      ms: Date.now() - started,
      content_type: response.headers.get("content-type"),
      cf_mitigated: response.headers.get("cf-mitigated"),
      challenged: isChallenge(response, body),
      body_head: body.replace(/\s+/g, " ").slice(0, 160),
      body_text: body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
      server: response.headers.get("server"),
      cf_ray: response.headers.get("cf-ray"),
    };
  } catch (error) {
    return { name, error: String(error), ms: Date.now() - started };
  }
}

export default {
  async fetch(request: Request) {
    const checks = [
      await probe("alpha_search_unauthenticated", "https://chatgpt.com/backend-api/codex/alpha/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", originator: "openai-web-mcp", "User-Agent": "openai-web-mcp/0.1.0" },
        body: JSON.stringify({ id: crypto.randomUUID(), model: "gpt-5.4-mini", commands: { search_query: [{ q: "ping" }] } }),
      }),
      await probe("device_usercode_endpoint_get", "https://auth.openai.com/api/accounts/deviceauth/usercode", { method: "GET" }),
      await probe("api_openai_com_responses_unauthenticated", "https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5-mini", input: "ping" }),
      }),
      await probe("auth_openid_configuration", "https://auth.openai.com/.well-known/openid-configuration", { method: "GET" }),
    ];
    // Reaching OpenAI's API means a JSON answer (401 without a token); an HTML page is Cloudflare, not OpenAI.
    const api = checks[0];
    const reachable =
      checks.every((c) => "status" in c && !c.challenged) &&
      "content_type" in api && /json/i.test(api.content_type ?? "") && [200, 400, 401, 405, 422].includes(api.status as number);
    const cf = (request as Request & { cf?: { colo?: string } }).cf;
    return Response.json({ verdict: reachable ? "REACHABLE" : "BLOCKED_OR_ERROR", colo: cf?.colo ?? null, checks });
  },
};
