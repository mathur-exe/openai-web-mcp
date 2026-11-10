// Client for chatgpt.com/backend-api/codex/alpha/search — the standalone search endpoint behind
// the Codex CLI `web.run` tool (openai/codex codex-rs/codex-api/src/endpoint/search.rs).
// Undocumented and unversioned: parse defensively. Wire facts verified live 2026-11-10
// (see findings/05-openai-search-for-claude.md §10).
import { ToolError } from "./types";

export const DEFAULT_CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const CLIENT_NAME = "openai-web-mcp";
export const CLIENT_VERSION = "0.1.0";
/** output chars ≈ 4 × max_output_tokens (+3 for a trailing "..."). */
const CHARS_PER_TOKEN = 4;
/** Same as Hermes' openai-native provider (_TIMEOUT = 60). Live calls took 2.4–5.5 s. */
export const UPSTREAM_TIMEOUT_MS = 60_000;

export interface Credential {
  accessToken: string;
  accountId?: string;
  residency?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface Page {
  url: string;
  title: string;
  crawled: string | null;
  content_type: string | null;
  total_lines: number | null;
  first_line: number | null;
  last_line: number | null;
  /** Line to pass as `line` for the next page, or null at the end. */
  next_line: number | null;
  truncated: boolean;
  text: string;
}

export type Commands = Record<string, unknown[]>;

export interface RawResponse {
  output?: string;
  results?: Record<string, unknown>[] | null;
  encrypted_output?: string | null;
}

export function codexHeaders(cred: Credential): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    // Identify honestly as our own client; never impersonate codex_cli_rs / chatgpt_cca.
    originator: CLIENT_NAME,
    "User-Agent": `${CLIENT_NAME}/${CLIENT_VERSION}`,
  };
  if (cred.accountId) headers["ChatGPT-Account-ID"] = cred.accountId;
  if (cred.residency) headers["x-openai-internal-codex-residency"] = cred.residency;
  return headers;
}

export async function alphaSearch(
  cred: Credential,
  opts: {
    commands: Commands;
    maxOutputTokens: number;
    sessionId: string;
    model: string;
    /** Merged over the defaults below; see findings §10/§11 for which fields matter. */
    settings?: Record<string, unknown>;
    base?: string;
    /** Send the call through the egress relay instead of straight to chatgpt.com. */
    relay?: { url: string; secret: string };
    fetcher?: typeof fetch;
  },
): Promise<RawResponse> {
  const base = (opts.relay?.url || opts.base || DEFAULT_CODEX_BASE).replace(/\/+$/, "");
  const headers = codexHeaders(cred);
  if (opts.relay) headers["X-Relay-Secret"] = opts.relay.secret;
  let response: Response;
  try {
    response = await (opts.fetcher ?? fetch)(`${base}/alpha/search`, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers,
      body: JSON.stringify({
        id: opts.sessionId,
        model: opts.model,
        commands: opts.commands,
        settings: { external_web_access: true, allowed_callers: ["direct"], ...opts.settings },
        max_output_tokens: opts.maxOutputTokens,
      }),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ToolError(
      timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      timedOut ? `alpha/search did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} s.` : "Could not reach chatgpt.com.",
    );
  }
  const text = await response.text();
  if (opts.relay && response.status === 403 && /relay_forbidden/.test(text))
    throw new ToolError("RELAY_MISCONFIGURED", "The egress relay rejected RELAY_SECRET; the Worker and relay secrets differ.");
  if (response.status === 401) throw new ToolError("UPSTREAM_UNAUTHORIZED", "ChatGPT rejected the access token.");
  if (response.status === 429) {
    const retry = Number(response.headers.get("Retry-After")) || undefined;
    throw new ToolError("UPSTREAM_RATE_LIMITED", "ChatGPT usage limit reached for now.", retry);
  }
  if (response.status >= 300) {
    const challenge = isChallenge(response, text);
    throw new ToolError(
      challenge ? "UPSTREAM_CHALLENGED" : "UPSTREAM_ERROR",
      challenge
        ? `chatgpt.com answered with a bot challenge (HTTP ${response.status}); this egress is blocked.`
        : `alpha/search returned HTTP ${response.status}: ${errorSummary(text)}`,
    );
  }
  try {
    return JSON.parse(text) as RawResponse;
  } catch {
    throw new ToolError("UPSTREAM_ERROR", "alpha/search returned a non-JSON body.");
  }
}

/**
 * True when Cloudflare (not OpenAI's API) answered: a challenge, or an HTML block page where JSON is
 * expected. Observed 2026-11-10: Worker egress to chatgpt.com gets HTTP 403 HTML "Unable to load site".
 */
export function isChallenge(response: Response, body: string) {
  if (response.headers.get("cf-mitigated") === "challenge") return true;
  const html = /text\/html/i.test(response.headers.get("content-type") ?? "");
  return html && response.status >= 400 && /just a moment|challenge-platform|cf-chl|unable to load site|ray id/i.test(body);
}

function errorSummary(body: string) {
  try {
    const message = (JSON.parse(body) as { error?: { message?: string }; detail?: string })
      ?.error?.message ?? (JSON.parse(body) as { detail?: string }).detail;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  } catch {
    /* fall through */
  }
  return body.replace(/\s+/g, " ").slice(0, 300);
}

// ---- output cleanup -------------------------------------------------------------------------

/** Cite markers: U+E200 "cite" U+E202 "turn0search0" U+E201 (fields separated by U+E202). */
const CITE = /\uE200[^\uE201]*\uE201/g;
/** In-page links: 【12†link text】 or 【12†text†domain】 → link text. */
const LINK = /【\d+†([^†】]*)(?:†[^】]*)?】/g;
const LINE = /^L(\d+): ?(.*)$/;
const TITLE = /^(.*) \((https?:\/\/\S+)\)$/;

export function cleanInline(text: string) {
  return text.replace(CITE, "").replace(LINK, "$1").replace(/[\uE200-\uE2FF]/g, "").trim();
}

/** Token budget for a search that should return about `limit` results (live: 2500→10, 5000→25). */
export function searchBudget(limit: number) {
  return Math.min(8000, Math.max(1500, limit * 250));
}

export function parseSearch(raw: RawResponse, limit: number): SearchHit[] {
  const rows = Array.isArray(raw.results) ? raw.results : [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    hits.push({
      title: cleanInline(String(row.title ?? "")) || url,
      url,
      snippet: cleanInline(String(row.snippet ?? "")),
      domain: String(row.domain ?? safeHost(url)),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

function safeHost(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * `open`/`find` output → page. Format (live):
 *   Title (url)
 *   <cite> [wordlim: 200] Crawled: today; Content type: text/html; Source: open({...}); Total lines: 849
 *   L0: …\nL1: …
 * The upstream window starts on its own chunk boundary, so lines before `startLine` are dropped.
 * When the body hit the token budget the last line is partial: drop it and resume there.
 */
export function parsePage(
  output: string,
  requestedUrl: string,
  opts: { startLine?: number; maxOutputTokens: number },
): Page {
  const all = (output || "").split("\n");
  const titleMatch = TITLE.exec(all[0] ?? "");
  const header = all[1] ?? "";
  const field = (name: string) => new RegExp(`${name}: ([^;]+)`).exec(header)?.[1]?.trim() ?? null;
  const totalRaw = field("Total lines");
  const total = totalRaw && /^\d+$/.test(totalRaw) ? Number(totalRaw) : null;

  const lines: { n: number; text: string }[] = [];
  for (const raw of all.slice(2)) {
    const m = LINE.exec(raw);
    if (m) lines.push({ n: Number(m[1]), text: m[2] });
    else if (lines.length) lines[lines.length - 1].text += `\n${raw}`;
  }
  const truncated = output.length >= opts.maxOutputTokens * CHARS_PER_TOKEN;
  if (truncated && lines.length > 1) lines.pop();
  const start = opts.startLine ?? 0;
  const kept = lines.filter((l) => l.n >= start);
  const first = kept.length ? kept[0].n : null;
  const last = kept.length ? kept[kept.length - 1].n : null;
  const atEnd = last !== null && total !== null && last >= total - 1;
  return {
    url: titleMatch?.[2] ?? requestedUrl,
    title: cleanInline(titleMatch?.[1] ?? ""),
    crawled: field("Crawled"),
    content_type: field("Content type"),
    total_lines: total,
    first_line: first,
    last_line: last,
    next_line: last === null || atEnd ? null : last + 1,
    truncated: !atEnd && last !== null,
    text: kept
      .map((l) => cleanInline(l.text))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  };
}

export function isNoToolResponse(raw: RawResponse) {
  return /^Found no tool response/i.test((raw.output ?? "").trim());
}
