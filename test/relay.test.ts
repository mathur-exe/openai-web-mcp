import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

// relay.ts keeps isolate-local state, so every test gets a fresh module.
async function load() {
  vi.resetModules();
  return import("../src/relay");
}
const env = (extra: Partial<Env> = {}) =>
  ({ RELAY_URL: "https://relay.example", RELAY_SECRET: "s".repeat(40), RELAY_HEALTH_TIMEOUT_MS: "50", ...extra }) as Env;
const ok = () => Response.json({ status: "ok" });
// Behaves like a sleeping Render service: the request hangs until the caller's timeout aborts it.
const hangs: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
const fakeCtx = () => {
  const waits: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext, waits };
};

describe("relay warm check", () => {
  beforeEach(() => vi.useRealTimers());

  it("is a no-op when no relay is configured", async () => {
    const { relayState, ensureRelayAwake } = await load();
    const fetcher = vi.fn();
    expect(await relayState({} as Env, undefined, fetcher as never)).toBe("not_used");
    await ensureRelayAwake({} as Env, undefined, fetcher as never);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("trusts a successful check for the TTL (10 min), then re-checks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { relayState } = await load();
    const fetcher = vi.fn(async () => ok());
    expect(await relayState(env(), undefined, fetcher as never)).toBe("warm");
    expect(await relayState(env(), undefined, fetcher as never)).toBe("warm");
    expect(fetcher).toHaveBeenCalledTimes(1); // second answer came from the cache
    vi.setSystemTime(Date.now() + 9 * 60_000);
    await relayState(env(), undefined, fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(1); // still trusted after 9 min
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await relayState(env(), undefined, fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(2); // 11 min: Render may have slept, so check again
  });

  it("reports waking when /health hangs, and starts one background wake-up", async () => {
    const { relayState } = await load();
    const { ctx, waits } = fakeCtx();
    const started = Date.now();
    expect(await relayState(env(), ctx, hangs)).toBe("waking");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(waits).toHaveLength(1);
    expect(await relayState(env(), ctx, hangs)).toBe("waking");
    expect(waits).toHaveLength(1); // cooldown: no second wake-up request
  });

  it.each([
    ["HTML loading page with 200", () => new Response("<html>Loading…</html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["503 while spinning up", () => new Response("starting", { status: 503 })],
    ["wrong JSON", () => Response.json({ status: "starting" })],
  ])("treats %s as asleep", async (_name, make) => {
    const { relayState } = await load();
    expect(await relayState(env(), undefined, (async () => make()) as never)).toBe("waking");
  });

  it("treats a network error as asleep", async () => {
    const { relayState } = await load();
    expect(await relayState(env(), undefined, (async () => { throw new TypeError("fetch failed"); }) as never)).toBe("waking");
  });

  it("ensureRelayAwake throws a retryable RELAY_WARMING with agent instructions", async () => {
    const { ensureRelayAwake } = await load();
    const error = await ensureRelayAwake(env(), undefined, hangs).catch((e) => e);
    expect(error).toMatchObject({ code: "RELAY_WARMING", retry_after_seconds: 30 });
    expect(error.message).toMatch(/retry this same call once/);
    expect(error.message).toMatch(/Nothing was used from the daily limit/);
  });

  it("the background wake-up marks the relay warm once it answers", async () => {
    const { relayState } = await load();
    const { ctx, waits } = fakeCtx();
    let calls = 0;
    const fetcher = (async (_i: unknown, init?: RequestInit) => (++calls === 1 ? hangs(_i as never, init) : ok())) as typeof fetch;
    expect(await relayState(env(), ctx, fetcher)).toBe("waking");
    await Promise.all(waits); // the wake-up request is answered
    expect(await relayState(env(), undefined, (async () => { throw new Error("must not be called"); }) as never)).toBe("warm");
  });

  it("prewarm wakes a sleeping relay once and does nothing when it is known to be awake", async () => {
    const { prewarmRelay, markRelayWarm } = await load();
    const { ctx, waits } = fakeCtx();
    const fetcher = vi.fn(async () => ok());
    prewarmRelay(env(), ctx, fetcher as never);
    prewarmRelay(env(), ctx, fetcher as never); // inside the cooldown
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(fetcher).toHaveBeenCalledTimes(1);
    markRelayWarm(env());
    prewarmRelay(env(), ctx, fetcher as never);
    expect(waits).toHaveLength(1);
  });

  it("prewarm ignores a misconfigured relay instead of throwing", async () => {
    const { prewarmRelay } = await load();
    const { ctx, waits } = fakeCtx();
    expect(() => prewarmRelay(env({ RELAY_SECRET: "short" }), ctx, hangs)).not.toThrow();
    expect(waits).toHaveLength(0);
  });
});
