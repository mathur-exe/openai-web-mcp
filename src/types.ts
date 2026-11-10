import type { TokenVault } from "./vault";

export interface Env {
  PUBLIC_ORIGIN: string;
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  VAULT: DurableObjectNamespace<TokenVault>;
  OWNER_PASSPHRASE: string;
  DAILY_LIMIT: string;
  CODEX_MODEL: string;
  /** Optional default search location (ISO 3166-1 alpha-2, e.g. "IN"); changes results a lot. */
  SEARCH_COUNTRY?: string;
  SEARCH_CITY?: string;
  /** IANA timezone, e.g. "Asia/Kolkata". */
  SEARCH_TIMEZONE?: string;
  /** Comma-separated hostnames always excluded from search (filters.blocked_domains). */
  BLOCKED_DOMAINS?: string;
  /**
   * Egress relay for the alpha/search POST (chatgpt.com blocks Cloudflare Workers' IPs).
   * Set both (RELAY_SECRET as a Worker secret). Unset = call chatgpt.com directly.
   */
  RELAY_URL?: string;
  RELAY_SECRET?: string;
  /** Test-only override for chatgpt.com/backend-api/codex. */
  CODEX_BASE_URL?: string;
  /** Test-only override for https://auth.openai.com. */
  OPENAI_AUTH_ISSUER?: string;
}

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public retry_after_seconds?: number,
  ) {
    super(message);
  }
}
