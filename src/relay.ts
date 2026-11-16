// The Render relay (findings §14) runs on the free plan: it spins down after 15 minutes without
// traffic and takes ~1 minute to come back (Render docs; measured 26 s). Instead of letting a tool
// call hang for that long, we check /health first. If the relay is asleep we start the wake-up in
// the background and fail fast with RELAY_WARMING so the agent can tell the user and retry once.
import { ToolError, type Env } from "./types";

/** Longest we wait for /health before declaring the relay asleep (ms). Env RELAY_HEALTH_TIMEOUT_MS overrides. */
const DEFAULT_HEALTH_TIMEOUT_MS = 8_000;
/** How long a successful check is trusted (s). Render sleeps after 15 min idle, so 10 min is safe. */
const DEFAULT_WARM_TTL_S = 600;
/** Upper bound for the background wake-up request (ms); Render takes ~60 s. */
const WAKE_TIMEOUT_MS = 70_000;
/** Don't start another background wake-up within this window (ms). */
const KICK_COOLDOWN_MS = 20_000;
export const RELAY_RETRY_AFTER_S = 30;

// Isolate-local on purpose: a stale or missing entry only costs one ~100 ms /health call.
let warmUntil = 0;
let lastKick = 0;

export function relayConfig(env: Env) {
  const url = (env.RELAY_URL ?? "").trim();
  if (!url) return undefined;
  if (!env.RELAY_SECRET || env.RELAY_SECRET.length < 32)
    throw new ToolError("RELAY_MISCONFIGURED", "RELAY_URL is set but RELAY_SECRET is missing or shorter than 32 characters.");
  return { url, secret: env.RELAY_SECRET };
}

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** True only for a real answer from our relay (guards against Render's HTML loading/error pages). */
async function ping(url: string, timeoutMs: number, fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${url.replace(/\/+$/, "")}/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json", "User-Agent": "openai-web-mcp/0.1.0 (relay health)" },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return false;
    }
    return ((await response.json().catch(() => null)) as { status?: string } | null)?.status === "ok";
  } catch {
    return false;
  }
}

export function markRelayWarm(env: Env) {
  warmUntil = Date.now() + num(env.RELAY_WARM_TTL_S, DEFAULT_WARM_TTL_S) * 1000;
}

/** Forget what we know, e.g. after a network failure talking to the relay. */
export function markRelayCold() {
  warmUntil = 0;
}

/** Start a wake-up that outlives the current request. Returns whether one was started. */
function kickWake(env: Env, url: string, ctx: ExecutionContext | undefined, fetcher: typeof fetch) {
  if (!ctx || Date.now() - lastKick < KICK_COOLDOWN_MS) return false;
  lastKick = Date.now();
  ctx.waitUntil(
    ping(url, WAKE_TIMEOUT_MS, fetcher).then((ok) => {
      if (ok) markRelayWarm(env);
    }),
  );
  return true;
}

export type RelayState = "warm" | "waking" | "not_used";

/** Check the relay; if it is asleep, start waking it. Never waits longer than the health timeout. */
export async function relayState(env: Env, ctx?: ExecutionContext, fetcher: typeof fetch = (i, init) => fetch(i, init)): Promise<RelayState> {
  const relay = relayConfig(env);
  if (!relay) return "not_used";
  if (Date.now() < warmUntil) return "warm";
  if (await ping(relay.url, num(env.RELAY_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS), fetcher)) {
    markRelayWarm(env);
    return "warm";
  }
  kickWake(env, relay.url, ctx, fetcher);
  return "waking";
}

/** Throws RELAY_WARMING (retryable, nothing counted against the daily limit) when the relay is asleep. */
export async function ensureRelayAwake(env: Env, ctx?: ExecutionContext, fetcher?: typeof fetch) {
  if ((await relayState(env, ctx, fetcher)) === "waking")
    throw new ToolError(
      "RELAY_WARMING",
      `The search relay is waking up from its free-tier sleep (takes 30–60 s). Nothing was used from the daily limit. Tell the user, wait about ${RELAY_RETRY_AFTER_S} seconds, then retry this same call once. Do not retry in parallel or loop.`,
      RELAY_RETRY_AFTER_S,
    );
}

/** Fire-and-forget: wake the relay when a client connects, before the first search is needed. */
export function prewarmRelay(env: Env, ctx: ExecutionContext, fetcher: typeof fetch = (i, init) => fetch(i, init)) {
  let relay;
  try {
    relay = relayConfig(env);
  } catch {
    return;
  }
  if (!relay || Date.now() < warmUntil) return;
  kickWake(env, relay.url, ctx, fetcher);
}
