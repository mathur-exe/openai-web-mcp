import {
  alphaSearch,
  isNoToolResponse,
  parsePage,
  parseSearch,
  searchBudget,
  type Commands,
  type Credential,
  type Page,
  type RawResponse,
} from "./codex";
import { ToolError, type Env } from "./types";
import { assertPublicUrl } from "./url";

export { assertPublicUrl };
import { vault } from "./vault";

const DEFAULT_FETCH_TOKENS = 6000;
const FALLBACK_MAX_BYTES = 3_000_000;
const FALLBACK_TIMEOUT_MS = 20_000;

export interface SearchInput {
  query: string;
  limit: number;
  domains?: string[];
  exclude_domains?: string[];
  recency_days?: number;
  extra_queries?: string[];
  country?: string;
  city?: string;
}

const MAX_FILTER_DOMAINS = 100; // OpenAI web_search filter cap

export interface FetchInput {
  url: string;
  line?: number;
  find?: string;
  max_tokens?: number;
}

export class WebService {
  constructor(
    private env: Env,
    // Wrapped: storing the global `fetch` and calling it as a method throws "Illegal invocation".
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async search(input: SearchInput) {
    const first: Record<string, unknown> = { q: input.query };
    if (input.domains?.length) first.domains = input.domains;
    if (input.recency_days) first.recency = input.recency_days;
    const queries = [first, ...(input.extra_queries ?? []).slice(0, 3).map((q) => ({ q }))];
    const raw = await this.upstream("search", { search_query: queries }, searchBudget(input.limit), crypto.randomUUID(), this.searchSettings(input));
    const results = parseSearch(raw, input.limit);
    return { query: input.query, source: "openai-codex", count: results.length, results };
  }

  /** Location and domain exclusions: request-level `settings` (verified live 2026-11-10, findings §11). */
  private searchSettings(input: SearchInput): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    // A per-call country replaces the configured default entirely (its city/timezone don't carry over);
    // "global" opts out of any location.
    const country = (input.country ?? this.env.SEARCH_COUNTRY ?? "").trim().toUpperCase();
    if (country && country !== "GLOBAL") {
      const city = input.country && !input.city ? "" : (input.city ?? this.env.SEARCH_CITY ?? "").trim();
      settings.user_location = {
        type: "approximate",
        country,
        ...(city ? { city } : {}),
        ...(this.env.SEARCH_TIMEZONE && !input.country ? { timezone: this.env.SEARCH_TIMEZONE } : {}),
      };
    }
    const blocked = [
      ...(this.env.BLOCKED_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
      ...(input.exclude_domains ?? []),
    ];
    if (blocked.length) settings.filters = { blocked_domains: [...new Set(blocked)].slice(0, MAX_FILTER_DOMAINS) };
    return settings;
  }

  async fetchPage(input: FetchInput): Promise<Page & { source: string; note?: string }> {
    const url = assertPublicUrl(input.url);
    const budget = input.max_tokens ?? DEFAULT_FETCH_TOKENS;
    const commands: Commands = input.find
      ? { find: [{ ref_id: url.href, pattern: input.find }] }
      : { open: [{ ref_id: url.href, ...(input.line ? { lineno: input.line } : {}) }] };
    let upstreamError: string | null = null;
    try {
      // Stable per-URL session id keeps the upstream page cache warm for paging and find.
      const raw = await this.upstream("fetch", commands, budget, await urlSession(url.href));
      if (!isNoToolResponse(raw)) {
        const page = parsePage(raw.output ?? "", url.href, {
          startLine: input.find ? undefined : input.line,
          maxOutputTokens: budget,
        });
        if (page.text) return { ...page, source: "openai-codex" };
      }
      upstreamError = "alpha/search returned no page content";
    } catch (error) {
      // Only the daily cap is fatal; any upstream failure degrades to a direct fetch.
      if (!(error instanceof ToolError) || error.code === "DAILY_LIMIT") throw error;
      upstreamError = error.message;
    }
    const direct = await this.directFetch(url, input);
    return { ...direct, source: "direct", note: `Fetched directly because: ${upstreamError}` };
  }

  async usageToday() {
    const day = new Date().toISOString().slice(0, 10);
    const rows = await this.env.DB.prepare("SELECT kind, requests FROM usage_daily WHERE day = ?")
      .bind(day)
      .all<{ kind: string; requests: number }>();
    return {
      day,
      limit: Number(this.env.DAILY_LIMIT || 400),
      ...Object.fromEntries(rows.results.map((r) => [r.kind, r.requests])),
    };
  }

  private async upstream(
    kind: string,
    commands: Commands,
    budget: number,
    sessionId: string,
    settings?: Record<string, unknown>,
  ): Promise<RawResponse> {
    await this.count(kind);
    const box = vault(this.env);
    const call = (cred: Credential) =>
      alphaSearch(cred, {
        commands,
        maxOutputTokens: budget,
        sessionId,
        settings,
        model: this.env.CODEX_MODEL || "gpt-5.4-mini",
        base: this.env.CODEX_BASE_URL,
        fetcher: this.fetcher,
      });
    try {
      try {
        return await call(await box.credential());
      } catch (error) {
        // Mid-window revocation or rotation: force one refresh and retry once (same as Hermes' xAI path).
        if (error instanceof ToolError && error.code === "UPSTREAM_UNAUTHORIZED") return await call(await box.credential(true));
        throw error;
      }
    } catch (error) {
      throw rehydrate(error);
    }
  }

  private async count(kind: string) {
    const day = new Date().toISOString().slice(0, 10);
    const limit = Number(this.env.DAILY_LIMIT || 400);
    const row = await this.env.DB.prepare(
      `INSERT INTO usage_daily (kind, day, requests) VALUES (?, ?, 1)
      ON CONFLICT(kind, day) DO UPDATE SET requests = requests + 1 RETURNING
      (SELECT COALESCE(SUM(requests), 0) FROM usage_daily WHERE day = ?) AS total`,
    )
      .bind(kind, day, day)
      .first<{ total: number }>();
    if ((row?.total ?? 0) > limit)
      throw new ToolError("DAILY_LIMIT", `Daily limit of ${limit} upstream calls reached; resets at 00:00 UTC.`);
  }

  private async directFetch(url: URL, input: FetchInput): Promise<Page> {
    let current = url;
    let response: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      response = await this.fetcher(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
        headers: { "User-Agent": "openai-web-mcp/0.1 (+fallback fetch)", Accept: "text/html,text/plain,*/*;q=0.5" },
      });
      const location = response.headers.get("Location");
      if (response.status < 300 || response.status >= 400 || !location) break;
      await response.body?.cancel();
      current = assertPublicUrl(new URL(location, current).href);
    }
    if (!response || response.status >= 300)
      throw new ToolError("FETCH_FAILED", `Direct fetch returned HTTP ${response?.status ?? 0} for ${current.href}.`);
    const type = response.headers.get("Content-Type") ?? "";
    if (Number(response.headers.get("Content-Length") ?? 0) > FALLBACK_MAX_BYTES)
      throw new ToolError("FETCH_FAILED", "Page is too large for the direct fallback.");
    let title = "";
    let text: string;
    if (/html|xml/i.test(type)) ({ title, text } = await htmlToText(response));
    else if (/^text\/|json|javascript|markdown/i.test(type)) text = (await response.text()).slice(0, FALLBACK_MAX_BYTES);
    else {
      await response.body?.cancel();
      throw new ToolError("FETCH_FAILED", `Direct fallback cannot read content type "${type || "unknown"}".`);
    }
    // Same paging contract as the upstream path: lines, `line` selects the start.
    const lines = text.split("\n");
    const maxChars = (input.max_tokens ?? DEFAULT_FETCH_TOKENS) * 4;
    const start = Math.min(input.line ?? 0, lines.length);
    let end = start;
    let used = 0;
    while (end < lines.length && used + lines[end].length + 1 <= maxChars) used += lines[end++].length + 1;
    if (end === start && end < lines.length) end++;
    const atEnd = end >= lines.length;
    return {
      url: current.href,
      title,
      crawled: "now",
      content_type: type.split(";")[0] || null,
      total_lines: lines.length,
      first_line: start,
      last_line: end - 1,
      next_line: atEnd ? null : end,
      truncated: !atEnd,
      text: lines.slice(start, end).join("\n"),
    };
  }
}

export function rehydrate(error: unknown) {
  // Errors from the Durable Object arrive over RPC as plain Errors; the vault puts the code in the message.
  if (error instanceof ToolError) return error;
  const match = /^\[([A-Z_]+)\] ([\s\S]*)$/.exec(error instanceof Error ? error.message : "");
  return match ? new ToolError(match[1], match[2]) : error;
}

async function urlSession(url: string) {
  const hex = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const BLOCK = "p,div,br,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,section,article,header,footer,main,pre,blockquote,table,hr,dt,dd,figcaption";
const SKIP = "script,style,noscript,svg,template,iframe,head";

export async function htmlToText(response: Response): Promise<{ title: string; text: string }> {
  let title = "";
  let inTitle = false;
  let skip = 0;
  const parts: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el) {
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
    })
    .on(SKIP, {
      element(el) {
        skip++;
        el.onEndTag(() => {
          skip--;
        });
      },
    })
    .on(BLOCK, {
      element(el) {
        parts.push(el.tagName.startsWith("h") && el.tagName.length === 2 ? `\n${"#".repeat(Number(el.tagName[1]))} ` : "\n");
      },
    })
    .onDocument({
      text(chunk) {
        if (inTitle) title += chunk.text;
        else if (!skip) parts.push(chunk.text);
      },
    });
  await rewriter.transform(response).arrayBuffer();
  const text = decodeEntities(parts.join(""))
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title: decodeEntities(title).trim(), text };
}

function decodeEntities(s: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}
