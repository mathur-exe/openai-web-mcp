// Stateless egress relay for openai-web-mcp.
//
// chatgpt.com blocks Cloudflare Workers' egress IPs (findings §12), so the Worker sends its one
// upstream call (POST alpha/search) here and this process repeats it from a different network.
//
// - Holds no tokens and stores nothing. The caller's Authorization / ChatGPT-Account-ID headers are
//   forwarded for that single request and never logged.
// - Only one route is forwarded, to one hard-coded host: POST /alpha/search -> chatgpt.com.
// - Callers must send `X-Relay-Secret` equal to RELAY_SECRET (constant-time compare).
// - GET /probe needs no secret and reveals nothing but how chatgpt.com answers an unauthenticated
//   request from this network: use it once after deploying to learn whether this host is blocked.
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const UPSTREAM = (process.env.UPSTREAM_BASE || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 55_000;
const FORWARD_HEADERS = ["authorization", "chatgpt-account-id", "originator", "user-agent", "x-openai-internal-codex-residency", "content-type", "accept"];

const sha = (v) => createHash("sha256").update(v).digest();
export function secretOk(provided, expected) {
  return !!expected && expected.length >= 32 && typeof provided === "string" && timingSafeEqual(sha(provided), sha(expected));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

export function createServer(env = process.env, fetchImpl = fetch) {
  const secret = env.RELAY_SECRET || "";
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://relay");
    try {
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
      if (req.method === "GET" && url.pathname === "/probe") {
        const started = Date.now();
        const r = await fetchImpl(`${UPSTREAM}/alpha/search`, {
          method: "POST",
          headers: { "content-type": "application/json", originator: "openai-web-relay", "user-agent": "openai-web-relay/0.1.0" },
          body: JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", model: "gpt-5.4-mini", commands: { search_query: [{ q: "ping" }] } }),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await r.text();
        const type = r.headers.get("content-type") ?? "";
        const json = /json/i.test(type);
        return send(res, 200, {
          verdict: json && [200, 400, 401, 405, 422].includes(r.status) ? "REACHABLE" : "BLOCKED_OR_ERROR",
          status: r.status,
          content_type: type,
          ms: Date.now() - started,
          body_head: text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
        });
      }
      if (req.method === "POST" && url.pathname === "/alpha/search") {
        if (!secretOk(req.headers["x-relay-secret"], secret)) return send(res, 401, { error: "unauthorized" });
        const body = await readBody(req);
        const headers = {};
        for (const name of FORWARD_HEADERS) if (req.headers[name]) headers[name] = String(req.headers[name]);
        const r = await fetchImpl(`${UPSTREAM}/alpha/search`, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
        const out = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, {
          "content-type": r.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "no-store",
          ...(r.headers.get("retry-after") ? { "retry-after": r.headers.get("retry-after") } : {}),
        });
        return res.end(out);
      }
      return send(res, 404, { error: "not found" });
    } catch (error) {
      const status = error.status ?? (error.name === "TimeoutError" ? 504 : 502);
      return send(res, status, { error: status === 413 ? "request too large" : "relay error" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 10000);
  createServer().listen(port, "0.0.0.0", () => console.log(`openai-web-relay listening on :${port}; secret ${process.env.RELAY_SECRET ? "set" : "NOT SET (forwarding disabled)"}`));
}
