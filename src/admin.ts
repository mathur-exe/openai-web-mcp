// Owner-only pages: ChatGPT device login, status, and an egress reachability check.
// Auth: HTTP Basic, user "owner", password = OWNER_PASSPHRASE (rate-limited per IP per hour).
import { countAttempt, equalSecret, escape, ownerConfigured, peekAttempts } from "./auth";
import { DEFAULT_CODEX_BASE, isChallenge } from "./codex";
import { rehydrate, WebService } from "./service";
import { ToolError, type Env } from "./types";
import { vault, type VaultStatus } from "./vault";

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "same-origin",
};

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  if (!ownerConfigured(env)) return new Response("Set OWNER_PASSPHRASE (32+ characters) first.", { status: 503 });
  const denied = await checkOwner(request, env);
  if (denied) return denied;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  const box = vault(env);
  try {
    if (request.method === "POST") {
      if (request.headers.get("Origin") !== new URL(request.url).origin)
        return new Response("Invalid form origin", { status: 403 });
      if (path === "/admin/login") await box.login(true);
      else if (path === "/admin/logout") await box.logout();
      else return new Response("Not found", { status: 404 });
      return new Response(null, { status: 303, headers: { Location: "/admin" } });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (path === "/admin") return new Response(page(await box.status(), await new WebService(env).usageToday()), { headers: HTML_HEADERS });
    if (path === "/admin/status.json") return Response.json(await box.status(), { headers: { "Cache-Control": "no-store" } });
    if (path === "/admin/reachability")
      return Response.json(await reachability(request, env), { headers: { "Cache-Control": "no-store" } });
    return new Response("Not found", { status: 404 });
  } catch (error) {
    const e = rehydrate(error);
    if (e instanceof ToolError) return new Response(`${e.code}: ${e.message}`, { status: 502 });
    throw error;
  }
}

async function checkOwner(request: Request, env: Env): Promise<Response | null> {
  const header = request.headers.get("Authorization") ?? "";
  const challenge = new Response("Owner login required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="openai-web-mcp admin", charset="UTF-8"' },
  });
  if (!header.startsWith("Basic ")) return challenge;
  // Basic auth resends the password on every request (the page auto-refreshes during sign-in),
  // so only failures count toward the hourly limit; the limit is checked before verifying.
  const limited = new Response("Too many failed logins. Try again next hour.", { status: 429 });
  if ((await peekAttempts(request, env, "admin")) >= 20) return limited;
  let decoded = "";
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    /* treated as a failed attempt below */
  }
  const sep = decoded.indexOf(":");
  const ok = sep > 0 && decoded.slice(0, sep) === "owner" && (await equalSecret(decoded.slice(sep + 1), env.OWNER_PASSPHRASE));
  if (ok) return null;
  return (await countAttempt(request, env, "admin")) >= 20 ? limited : challenge;
}

/**
 * Can this Worker's egress reach OpenAI? Unauthenticated probes need no token: a JSON 401 from
 * alpha/search means we reached the origin; an HTML "Just a moment" / cf-mitigated means Cloudflare
 * bot management challenged the Worker. `?live=1` also runs one real search with the stored login.
 */
async function reachability(request: Request, env: Env) {
  const base = (env.CODEX_BASE_URL || DEFAULT_CODEX_BASE).replace(/\/+$/, "");
  const probe = async (name: string, url: string, init: RequestInit) => {
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
      };
    } catch (error) {
      return { name, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
    }
  };
  const checks = [
    await probe("alpha_search_unauthenticated", `${base}/alpha/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", originator: "openai-web-mcp", "User-Agent": "openai-web-mcp/0.1.0" },
      body: JSON.stringify({ id: crypto.randomUUID(), model: "gpt-5.4-mini", commands: { search_query: [{ q: "ping" }] } }),
    }),
    await probe("auth_openid_configuration", "https://auth.openai.com/.well-known/openid-configuration", { method: "GET" }),
  ];
  let live: unknown = "skipped (add ?live=1 after signing in)";
  if (new URL(request.url).searchParams.get("live") === "1") {
    try {
      const out = await new WebService(env).search({ query: "Cloudflare Workers", limit: 3 });
      live = { ok: true, count: out.count, first: out.results[0]?.url ?? null };
    } catch (error) {
      const e = rehydrate(error);
      live = { ok: false, error: e instanceof ToolError ? `${e.code}: ${e.message}` : String(e) };
    }
  }
  const cf = (request as Request & { cf?: { colo?: string; country?: string } }).cf;
  return { colo: cf?.colo ?? null, checked_at: new Date().toISOString(), checks, live };
}

function page(status: VaultStatus, usage: Record<string, unknown>) {
  const pending = status.pending_login;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
${pending ? '<meta http-equiv="refresh" content="5">' : ""}<title>OpenAI Web · Admin</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5"><main>
<h1>OpenAI Web admin</h1>
<p>ChatGPT login: <strong>${escape(status.state.replace("_", " "))}</strong>${status.plan ? ` (plan ${escape(status.plan)}, account …${escape(status.account_id_suffix ?? "")})` : ""}.</p>
${status.access_expires_at ? `<p>Access token expires ${escape(status.access_expires_at)}; last refresh ${escape(status.last_refresh ?? "never")}.</p>` : ""}
${status.expired ? `<p style="color:#a32d2d">Login expired ${escape(status.expired.at)} (${escape(status.expired.reason)}). Sign in again.</p>` : ""}
${status.last_error ? `<p style="color:#a32d2d">Last error: ${escape(status.last_error)}</p>` : ""}
${
  pending
    ? `<p>Open <a href="${escape(pending.verification_url)}" target="_blank" rel="noopener noreferrer">${escape(pending.verification_url)}</a> and enter <strong style="font-size:1.4em;letter-spacing:.1em">${escape(pending.user_code)}</strong>. This page refreshes until sign-in completes (code expires ${escape(pending.expires_at)}).</p>`
    : `<form method="post" action="/admin/login"><button>${status.logged_in ? "Sign in again" : "Sign in with ChatGPT"}</button></form>`
}
${status.logged_in ? '<form method="post" action="/admin/logout"><button>Sign out (forget tokens)</button></form>' : ""}
<p>Usage today: <code>${escape(JSON.stringify(usage))}</code></p>
<p><a href="/admin/reachability">Reachability check</a> · <a href="/admin/reachability?live=1">with a live search</a></p>
</main></body></html>`;
}
