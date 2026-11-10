import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";

const origin = "https://web.example";
const passphrase = "test-only-owner-passphrase-with-32-characters";
const admin = { Authorization: `Basic ${Buffer.from(`owner:${passphrase}`).toString("base64")}` };
let worker: Miniflare;

// ---- fake OpenAI ----------------------------------------------------------------------------
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (tag: string, expIn: number) =>
  `${b64({ alg: "none" })}.${b64({
    exp: Math.floor(Date.now() / 1000) + expIn,
    tag,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1234", chatgpt_plan_type: "plus", chatgpt_data_residency: "us" },
  })}.sig`;
const state = {
  // First access token is about to expire, forcing one refresh on first use.
  access: jwt("a1", 60),
  refresh: "r1",
  refreshCalls: 0,
  revokeNext: false,
  rejectRelay: false,
  directCalls: 0,
  approved: false,
  usercodeCalls: 0,
  refreshFail: null as null | { status: number; body: string },
  searchCalls: [] as { auth: string; account: string | null; originator: string | null; body: Record<string, unknown> }[],
};
const CITE = (ref: string) => `cite${ref}`;

async function fakeUpstream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === "auth.openai.com") {
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      state.usercodeCalls++;
      return Response.json({ device_auth_id: `dev-${state.usercodeCalls}`, user_code: `CODE-${state.usercodeCalls}`, interval: "3" });
    }
    if (url.pathname === "/api/accounts/deviceauth/token")
      return state.approved
        ? Response.json({ authorization_code: "code-1", code_verifier: "verifier-1" })
        : new Response("pending", { status: 403 });
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await request.text());
      if (form.get("grant_type") === "authorization_code") {
        expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
        expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
        return Response.json({ access_token: state.access, refresh_token: state.refresh });
      }
      state.refreshCalls++;
      await new Promise((r) => setTimeout(r, 200)); // widen the race window for the single-flight test
      if (state.refreshFail) return new Response(state.refreshFail.body, { status: state.refreshFail.status });
      if (form.get("refresh_token") !== state.refresh) return Response.json({ error: "refresh_token_reused" }, { status: 400 });
      state.access = jwt(`a${state.refreshCalls + 1}`, 3600);
      state.refresh = `r${state.refreshCalls + 1}`;
      return Response.json({ access_token: state.access, refresh_token: state.refresh });
    }
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({ issuer: "https://auth.openai.com" });
  }
  // chatgpt.com is blocked for Workers; search must go through the relay, which checks the shared secret.
  if (url.hostname === "chatgpt.com") {
    state.directCalls++;
    return new Response("<html>Unable to load site</html>", { status: 403, headers: { "content-type": "text/html" } });
  }
  if (url.hostname === "relay.example" && url.pathname === "/alpha/search") {
    if (state.rejectRelay || request.headers.get("X-Relay-Secret") !== "relay-secret-for-tests-0123456789abcdef")
      return Response.json({ error: "relay_forbidden" }, { status: 403 });
    const auth = request.headers.get("Authorization") ?? "";
    const body = (await request.json()) as Record<string, any>;
    if (!auth) return Response.json({ detail: "Unauthorized" }, { status: 401 });
    if (state.revokeNext) {
      state.revokeNext = false;
      return Response.json({ detail: "token revoked" }, { status: 401 });
    }
    if (auth !== `Bearer ${state.access}`) return Response.json({ detail: "stale token" }, { status: 401 });
    state.searchCalls.push({
      auth,
      account: request.headers.get("ChatGPT-Account-ID"),
      originator: request.headers.get("originator"),
      body,
    });
    const c = body.commands;
    if (c.search_query)
      return Response.json({
        output: "ignored",
        encrypted_output: "x",
        results: [1, 2, 3, 4].map((i) => ({
          type: "text_result",
          ref_id: `turn0search${i}`,
          title: `Result ${i}`,
          url: `https://r${i}.example/`,
          snippet: `snippet ${i} ${CITE(`turn0search${i}`)}`,
          domain: `r${i}.example`,
        })),
      });
    const target = (c.open ?? c.find)[0].ref_id as string;
    if (target === "https://broken.example/")
      return Response.json({ output: "Found no tool response. This likely means the arguments you provided were not valid.", results: [] });
    return Response.json({
      output: [
        "Doc (https://doc.example/)",
        `${CITE("turn0view0")} [wordlim: 200] Crawled: today; Content type: text/html; Source: open({}); Total lines: 3`,
        "L0: Hello 【0†world】",
        "L1: second",
        "L2: third",
      ].join("\n"),
      results: [],
    });
  }
  if (url.hostname === "broken.example")
    return new Response(
      "<html><head><title>Broken &amp; fixed</title><script>evil()</script></head><body><h1>Heading</h1><p>Para &lt;one&gt;</p><nav>x</nav></body></html>",
      { headers: { "Content-Type": "text/html" } },
    );
  return new Response("unexpected outbound request", { status: 599 });
}

beforeAll(async () => {
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: "dist/index.js",
      compatibilityDate: "2026-10-12",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      kvNamespaces: ["OAUTH_KV"],
      d1Databases: ["DB"],
      durableObjects: { VAULT: { className: "TokenVault", useSQLite: true } },
      outboundService: fakeUpstream,
      bindings: { PUBLIC_ORIGIN: origin, OWNER_PASSPHRASE: passphrase, DAILY_LIMIT: "30", BLOCKED_DOMAINS: "pinterest.com", RELAY_URL: "https://relay.example", RELAY_SECRET: "relay-secret-for-tests-0123456789abcdef", CODEX_MODEL: "gpt-5.4-mini" },
    }),
  );
  const db = await worker.getD1Database("DB");
  const sql = readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  for (const statement of sql.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
}, 60000);
afterAll(async () => {
  await worker?.dispose();
});

async function mcpToken() {
  const registration = await worker.dispatchFetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Integration test",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const client = (await registration.json()) as { client_id: string };
  const verifier = "a".repeat(64);
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
  const consentUrl = `${origin}/authorize?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    scope: "mcp:read",
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  })}`;
  const consent = await worker.dispatchFetch(consentUrl);
  const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1];
  const cookies = consent.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  const approved = await worker.dispatchFetch(consentUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, Cookie: cookies },
    body: new URLSearchParams({ handle, passphrase, decision: "approve" }).toString(),
  });
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get("Location")!).searchParams.get("code")!;
  const exchange = await worker.dispatchFetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }).toString(),
  });
  return ((await exchange.json()) as { access_token: string }).access_token;
}

let rpcId = 0;
async function rpc(token: string, method: string, params?: unknown) {
  const response = await worker.dispatchFetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const messages = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
    : [JSON.parse(text)];
  return messages.find((m) => "id" in m);
}
const call = async (token: string, name: string, args: Record<string, unknown>) => {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  return { isError: !!res.result.isError, data: JSON.parse(res.result.content[0].text) };
};

it("fails closed: /mcp needs a token, /admin needs the owner password", async () => {
  expect((await worker.dispatchFetch(`${origin}/mcp`, { method: "POST" })).status).toBe(401);
  const anon = await worker.dispatchFetch(`${origin}/admin`);
  expect(anon.status).toBe(401);
  expect(anon.headers.get("WWW-Authenticate")).toContain("Basic");
  const wrong = await worker.dispatchFetch(`${origin}/admin`, {
    headers: { Authorization: `Basic ${Buffer.from("owner:nope").toString("base64")}` },
  });
  expect(wrong.status).toBe(401);
  expect((await worker.dispatchFetch(`${origin}/admin`, { headers: admin })).status).toBe(200);
});

it("degrades web_fetch to a direct fetch before the ChatGPT login exists", async () => {
  const token = await mcpToken();
  const search = await call(token, "web_search", { query: "x" });
  expect(search).toMatchObject({ isError: true, data: { code: "LOGIN_REQUIRED" } });
  expect(search.data.message).toContain("chatgpt_login");
  const page = await call(token, "web_fetch", { url: "https://broken.example/" });
  expect(page.isError).toBe(false);
  expect(page.data.note).toContain("chatgpt_login");
  expect(page.data).toMatchObject({ source: "direct", title: "Broken & fixed" });
  expect(page.data.text).toContain("# Heading");
  expect(page.data.text).toContain("Para <one>");
  expect(page.data.text).not.toContain("evil");
  const blocked = await call(token, "web_fetch", { url: "http://169.254.169.254/latest/meta-data/" });
  expect(blocked).toMatchObject({ isError: true, data: { code: "INVALID_URL" } });
});

it("logs in Kite-style through the chatgpt_login tool", async () => {
  const token = await mcpToken();
  const first = await call(token, "chatgpt_login", {});
  expect(first.data).toMatchObject({ state: "pending", code: "CODE-1", login_url: "https://auth.openai.com/codex/device" });
  expect(first.data.next_step).toContain("CODE-1");
  const blocked = await call(token, "web_search", { query: "x" });
  expect(blocked).toMatchObject({ isError: true, data: { code: "LOGIN_PENDING" } });
  // Idempotent: calling again while pending polls and returns the same code, no new device code.
  const again = await call(token, "chatgpt_login", {});
  expect(again.data).toMatchObject({ state: "pending", code: "CODE-1" });
  expect(state.usercodeCalls).toBe(1);
  state.approved = true;
  const done = await call(token, "chatgpt_login", {});
  expect(done.data).toMatchObject({ state: "signed_in", plan: "plus" });
  expect((await call(token, "chatgpt_login", {})).data.state).toBe("signed_in"); // no-op when signed in
  expect(state.usercodeCalls).toBe(1);
});

it("refreshes single-flight, retries a 401 once, and serves search and fetch", async () => {
  const token = await mcpToken();
  // Two concurrent calls with an expiring token must spend the refresh token exactly once.
  const [a, b] = await Promise.all([
    call(token, "web_search", { query: "workers", limit: 3 }),
    call(token, "web_search", { query: "durable objects", domains: ["developers.cloudflare.com"], recency_days: 30 }),
  ]);
  expect(state.refreshCalls).toBe(1);
  expect(a.isError).toBe(false);
  expect(a.data.results).toHaveLength(3);
  expect(a.data.results[0]).toEqual({ title: "Result 1", url: "https://r1.example/", snippet: "snippet 1", domain: "r1.example" });
  expect(b.data.count).toBe(4);
  const sent = state.searchCalls.at(-1)!;
  expect(sent.account).toBe("acct-1234");
  expect(sent.originator).toBe("openai-web-mcp");
  expect(state.searchCalls.map((c) => JSON.stringify(c.body.commands))).toContain(
    JSON.stringify({ search_query: [{ q: "durable objects", domains: ["developers.cloudflare.com"], recency: 30 }] }),
  );

  const page = await call(token, "web_fetch", { url: "https://doc.example/", line: 1 });
  expect(page.data).toMatchObject({ source: "openai-codex", title: "Doc", first_line: 1, last_line: 2, next_line: null, text: "second\nthird" });

  // 401 mid-window → one forced refresh → retried call succeeds.
  state.revokeNext = true;
  const retried = await call(token, "web_search", { query: "again" });
  expect(retried.isError).toBe(false);
  expect(state.refreshCalls).toBe(2);
});

it("sends location and domain filters as request settings", async () => {
  const token = await mcpToken();
  await call(token, "web_search", { query: "filter coffee", country: "in", city: "Bengaluru", exclude_domains: ["quora.com"] });
  expect(state.searchCalls.at(-1)!.body.settings).toEqual({
    external_web_access: true,
    allowed_callers: ["direct"],
    user_location: { type: "approximate", country: "IN", city: "Bengaluru" },
    filters: { blocked_domains: ["pinterest.com", "quora.com"] },
  });
  await call(token, "web_search", { query: "filter coffee", country: "global" });
  expect(state.searchCalls.at(-1)!.body.settings).not.toHaveProperty("user_location");
});

it("keeps the login on transient refresh errors, marks it expired on dead grants, and recovers", async () => {
  const token = await mcpToken();
  state.refreshFail = { status: 503, body: '{"error":"temporarily_unavailable"}' };
  state.revokeNext = true;
  const transient = await call(token, "web_search", { query: "x" });
  expect(transient).toMatchObject({ isError: true, data: { code: "UPSTREAM_ERROR" } });
  expect((await call(token, "web_status", {})).data.login.state).toBe("signed_in");

  state.refreshFail = { status: 400, body: '{"error":{"code":"refresh_token_expired"}}' };
  state.revokeNext = true;
  const dead = await call(token, "web_search", { query: "x" });
  expect(dead).toMatchObject({ isError: true, data: { code: "LOGIN_REQUIRED" } });
  expect(dead.data.message).toContain("refresh_token_expired");
  const status = (await call(token, "web_status", {})).data.login;
  expect(status).toMatchObject({ state: "expired", expired: { reason: "refresh_token_expired" } });

  state.refreshFail = null;
  state.approved = false;
  const relogin = await call(token, "chatgpt_login", {});
  expect(relogin.data).toMatchObject({ state: "pending", code: "CODE-2" });
  state.approved = true;
  expect((await call(token, "chatgpt_login", {})).data.state).toBe("signed_in");
  expect((await call(token, "web_status", {})).data.login.expired).toBeNull();
  expect((await call(token, "web_search", { query: "back" })).isError).toBe(false);
});

it("admin forced re-login keeps the old tokens serving until the new login completes", async () => {
  const token = await mcpToken();
  state.approved = false;
  const start = await worker.dispatchFetch(`${origin}/admin/login`, { method: "POST", redirect: "manual", headers: { ...admin, Origin: origin } });
  expect(start.status).toBe(303);
  const forged = await worker.dispatchFetch(`${origin}/admin/logout`, { method: "POST", headers: { ...admin, Origin: "https://evil.example" } });
  expect(forged.status).toBe(403);
  const pending = (await (await worker.dispatchFetch(`${origin}/admin/status.json`, { headers: admin })).json()) as Record<string, any>;
  expect(pending).toMatchObject({ state: "pending", logged_in: true, pending_login: { user_code: "CODE-3" } });
  expect((await call(token, "web_search", { query: "still works" })).isError).toBe(false);
  state.approved = true;
  let status: Record<string, any> = pending;
  for (let i = 0; i < 40 && status.state !== "signed_in"; i++) {
    await new Promise((r) => setTimeout(r, 250));
    status = await (await worker.dispatchFetch(`${origin}/admin/status.json`, { headers: admin })).json();
  }
  expect(status).toMatchObject({ state: "signed_in", pending_login: null }); // completed by the DO alarm
});

it("sends alpha/search only through the relay, and reports a wrong relay secret clearly", async () => {
  const token = await mcpToken();
  const before = state.directCalls;
  expect((await call(token, "web_search", { query: "via relay" })).isError).toBe(false);
  expect(state.directCalls).toBe(before); // never contacted chatgpt.com directly
  const refreshesBefore = state.refreshCalls;
  state.rejectRelay = true;
  const bad = await call(token, "web_search", { query: "bad secret" });
  state.rejectRelay = false;
  expect(bad).toMatchObject({ isError: true, data: { code: "RELAY_MISCONFIGURED" } });
  // A relay auth failure must not be mistaken for ChatGPT rejecting the token (no forced refresh).
  expect(state.refreshCalls).toBe(refreshesBefore);
});

it("enforces the daily limit and reports usage", async () => {
  const token = await mcpToken();
  let last: { isError: boolean; data: any } = { isError: false, data: {} };
  for (let i = 0; i < 30 && !last.isError; i++) last = await call(token, "web_search", { query: `q${i}` });
  expect(last).toMatchObject({ isError: true, data: { code: "DAILY_LIMIT" } });
  const status = await call(token, "web_status", {});
  expect(status.data.login.state).toBe("signed_in");
  expect(status.data.usage.limit).toBe(30);
});

it("reachability reports JSON 401 from the origin as reachable", async () => {
  const res = await worker.dispatchFetch(`${origin}/admin/reachability`, { headers: admin });
  const body = (await res.json()) as { checks: { name: string; status: number; challenged: boolean }[] };
  expect(body.checks[0]).toMatchObject({ name: "alpha_search_via_relay_unauthenticated", status: 401, challenged: false });
  expect(body.checks[1]).toMatchObject({ name: "auth_openid_configuration", status: 200 });
});
