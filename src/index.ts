import { OAuthProvider, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { handleAdmin } from "./admin";
import { authorize, type AuthEnv } from "./auth";
import { createServer } from "./mcp";
import type { Env } from "./types";
import { vault } from "./vault";

export { TokenVault } from "./vault";

function createProvider(origin: string) {
  return new OAuthProvider<AuthEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      async fetch(request, env, ctx) {
        const { auth } = ctx as OAuthResourceContext<{ userId: string }>;
        if (!auth.scope.includes("mcp:read")) return new Response("Missing mcp:read scope", { status: 403 });
        return createMcpHandler(() => createServer(env))(request, env, ctx);
      },
    },
    defaultHandler: {
      async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === "/authorize") return authorize(request, env);
        if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(request, env);
        if (path === "/health") return Response.json({ status: "ok", version: "0.1.0" });
        return new Response("Not found", { status: 404 });
      },
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    scopesSupported: ["mcp:read"],
    requiredScopes: ["mcp:read"],
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
    refreshTokenIdleTTL: 2592000,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createProvider(env.PUBLIC_ORIGIN).fetch(request, env as AuthEnv, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM login_attempts WHERE expires_at <= ?").bind(now),
        env.DB.prepare("DELETE FROM usage_daily WHERE day < date('now', '-30 days')"),
      ]),
    );
    ctx.waitUntil(
      vault(env)
        .keepFresh()
        .then((outcome) => console.log("keep_fresh", outcome))
        .catch((e: unknown) => console.error("keep_fresh_failed", String(e))),
    );
  },
} satisfies ExportedHandler<Env>;
