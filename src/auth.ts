import {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types";

// Adapted from the YouTube Research worker: owner-passphrase consent for MCP clients.
export type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
export const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function equalSecret(a: string, b: string): Promise<boolean> {
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  const x = new Uint8Array(left),
    y = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}

export function ownerConfigured(env: Env) {
  return !!env.OWNER_PASSPHRASE && env.OWNER_PASSPHRASE.length >= 32;
}

async function attemptBucket(request: Request, kind: string) {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const hex = Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
  return `${kind}:${hex}:${Math.floor(Date.now() / 1000 / 3600)}`;
}

/** Atomic hourly per-IP attempt counter (per `kind`); stores a digest, not the raw address. */
export async function countAttempt(request: Request, env: Env, kind: string) {
  const row = await env.DB.prepare(
    `INSERT INTO login_attempts VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,
  )
    .bind(await attemptBucket(request, kind), Math.floor(Date.now() / 1000) + 3600)
    .first<{ attempts: number }>();
  return row?.attempts ?? Infinity;
}

export async function peekAttempts(request: Request, env: Env, kind: string) {
  const row = await env.DB.prepare("SELECT attempts FROM login_attempts WHERE bucket = ?")
    .bind(await attemptBucket(request, kind))
    .first<{ attempts: number }>();
  return row?.attempts ?? 0;
}

function page(details: ConsentDescription, handle: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenAI Web · Connect</title>
  <body><main><h1>Connect OpenAI Web</h1>
  <p>Client: <strong>${escape(details.clientName)}</strong>.</p>
  <p>${details.clientDomain ? `Client domain: ${escape(details.clientDomain)}` : "Client name is self-reported, not verified."}</p>
  <p>Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? "<p>This sends access to an app on your computer. Continue only if you started this connection.</p>" : ""}
  <p>Permissions: ${details.scope.map(escape).join(", ") || "(none requested)"}. Searches run on the owner’s ChatGPT plan.</p>
  <form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
  <p><label>Owner passphrase <input type="password" name="passphrase" autocomplete="current-password" maxlength="1024" required></label></p>
  <button name="decision" value="approve">Connect</button> <button name="decision" value="deny" formnovalidate>Cancel</button>
  </form></main></body></html>`;
}

export async function authorize(request: Request, env: AuthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!ownerConfigured(env))
    return new Response(
      "Owner login is not configured. Set a random passphrase of at least 32 characters.",
      { status: 503 },
    );
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Cache-Control", "no-store");
      consent.headers.set(
        "Content-Security-Policy",
        `default-src 'none'; form-action 'self' ${new URL(authRequest.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      );
      // no-referrer would make browser form POSTs send Origin: null (see YouTube Research DEPLOYMENT.md).
      consent.headers.set("Referrer-Policy", "same-origin");
      return new Response(page(details, consent.handle), { headers: consent.headers });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (request.headers.get("Origin") !== new URL(request.url).origin)
      return new Response("Invalid form origin", { status: 403 });
    if (Number(request.headers.get("Content-Length") ?? 0) > 8192)
      return new Response("Form too large", { status: 413 });
    const body = await request.text();
    if (body.length > 8192) return new Response("Form too large", { status: 413 });
    const form = new URLSearchParams(body);
    const handle = form.get("handle") ?? "";
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if ((await countAttempt(request, env, "consent")) > 10)
      return new Response("Too many login attempts. Try again next hour.", { status: 429 });
    if (!(await equalSecret(form.get("passphrase") ?? "", env.OWNER_PASSPHRASE)))
      return new Response("Invalid passphrase. Return to the connection page to try again.", {
        status: 401,
      });
    const approved = await oauth.approveConsent(request, handle, { scope: ["mcp:read"] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: { label: "OpenAI Web owner" },
      scope: approved.request.scope,
      props: { userId: "owner" },
    });
    approved.headers.set("Location", redirectTo);
    approved.headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof CimdFetchError)
      return new Response(
        "Invalid or expired authorization request. Restart the connection from your MCP client.",
        { status: 400 },
      );
    throw error;
  }
}
