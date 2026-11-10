import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, secretOk } from "../server.mjs";

const SECRET = "x".repeat(40);
async function withRelay(fetchImpl, fn) {
  const server = createServer({ RELAY_SECRET: SECRET }, fetchImpl);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test("secretOk requires a long matching secret", () => {
  assert.equal(secretOk(SECRET, SECRET), true);
  assert.equal(secretOk("nope", SECRET), false);
  assert.equal(secretOk(undefined, SECRET), false);
  assert.equal(secretOk("short", "short"), false); // refuses weak configured secrets
});

test("forwards only the allowed headers and body, returns upstream status", async () => {
  let seen;
  await withRelay(async (url, init) => {
    seen = { url, init };
    return new Response('{"results":[]}', { status: 200, headers: { "content-type": "application/json" } });
  }, async (base) => {
    const r = await fetch(`${base}/alpha/search`, { method: "POST", headers: { "x-relay-secret": SECRET, authorization: "Bearer t", "chatgpt-account-id": "a1", cookie: "secret=1", "x-evil": "1", "content-type": "application/json" }, body: '{"q":1}' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { results: [] });
    assert.equal(seen.url, "https://chatgpt.com/backend-api/codex/alpha/search");
    assert.equal(seen.init.headers.authorization, "Bearer t");
    assert.equal(seen.init.headers["chatgpt-account-id"], "a1");
    assert.equal(seen.init.headers.cookie, undefined);
    assert.equal(seen.init.headers["x-evil"], undefined);
    assert.equal(seen.init.headers["x-relay-secret"], undefined);
    assert.equal(Buffer.from(seen.init.body).toString(), '{"q":1}');
  });
});

test("rejects missing/wrong secret, other paths, and oversized bodies without calling upstream", async () => {
  let calls = 0;
  await withRelay(async () => { calls++; return new Response("{}"); }, async (base) => {
    assert.equal((await fetch(`${base}/alpha/search`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/alpha/search`, { method: "POST", headers: { "x-relay-secret": "wrong" }, body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/anything-else`, { method: "POST", headers: { "x-relay-secret": SECRET } })).status, 404);
    assert.equal((await fetch(`${base}/alpha/search`, { method: "POST", headers: { "x-relay-secret": SECRET }, body: "x".repeat(70_000) })).status, 413);
    assert.equal(calls, 0);
  });
});

test("/probe says BLOCKED for an HTML block page and REACHABLE for a JSON 401", async () => {
  await withRelay(async () => new Response("<html>Unable to load site</html>", { status: 403, headers: { "content-type": "text/html" } }), async (base) => {
    const p = await (await fetch(`${base}/probe`)).json();
    assert.equal(p.verdict, "BLOCKED_OR_ERROR");
    assert.match(p.body_head, /Unable to load site/);
  });
  await withRelay(async () => new Response('{"detail":"Unauthorized"}', { status: 401, headers: { "content-type": "application/json" } }), async (base) => {
    assert.equal((await (await fetch(`${base}/probe`)).json()).verdict, "REACHABLE");
  });
});
