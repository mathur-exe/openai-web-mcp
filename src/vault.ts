// TokenVault: the only holder of the ChatGPT (Codex) OAuth tokens.
//
// - Its own device-code login (auth.openai.com/codex/device), so it owns a separate token
//   family. Never import ~/.codex/auth.json: refresh tokens are single-use and rotate, so a
//   shared copy would revoke the Codex CLI's login (hermes_cli/auth_codex.py:523-565).
// - One Durable Object instance ("owner") serializes storage; an in-memory promise makes
//   refresh single-flight across concurrent tool calls.
// - Login lifecycle (Kite-style): signed_out → pending → signed_in → (expired → pending → …).
//   `login()` is idempotent and is exposed both as the `chatgpt_login` MCP tool and on /admin.
// Endpoints and client id mirror Hermes (hermes_cli/auth_constants.py:90-92, auth_codex.py:1001-1100);
// refresh timing and failure classification mirror Codex (codex-rs/login/src/auth/manager.rs:232-233,1861).
import { DurableObject } from "cloudflare:workers";
import { ToolError, type Env } from "./types";
import type { Credential } from "./codex";
import { decodeClaims, isPermanentRefreshFailure, oauthErrorCode } from "./oauth";

export { decodeClaims };

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_ISSUER = "https://auth.openai.com";
/** Refresh when the access token has less than this left (Codex: 5 min; Hermes: 120 s). */
export const REFRESH_SKEW_S = 300;
/** Codex refreshes when the last refresh is older than 8 days (TOKEN_REFRESH_INTERVAL). */
export const REFRESH_INTERVAL_S = 8 * 86400;
/** Cron also refreshes early when the access token has under 2 days left. */
const KEEP_FRESH_MARGIN_S = 2 * 86400;
const LOGIN_WINDOW_S = 15 * 60;
const MAX_ERROR_CHARS = 300;

interface Tokens {
  access_token: string;
  refresh_token: string;
  obtained_at: number;
  last_refresh: number | null;
}

interface Pending {
  device_auth_id: string;
  user_code: string;
  interval_s: number;
  expires_at: number;
}

interface Expired {
  reason: string;
  at: number;
}

export type LoginState = "signed_out" | "pending" | "signed_in" | "expired";

export interface VaultStatus {
  state: LoginState;
  logged_in: boolean;
  plan: string | null;
  account_id_suffix: string | null;
  access_expires_at: string | null;
  last_refresh: string | null;
  signed_in_at: string | null;
  pending_login: { user_code: string; verification_url: string; expires_at: string } | null;
  expired: { reason: string; at: string } | null;
  last_error: string | null;
  /** One-line instruction for the model / owner. */
  next_step: string;
}

/** RPC drops custom Error classes, so the code travels in the message as "[CODE] text". */
export function vaultError(code: string, message: string) {
  return new ToolError(code, `[${code}] ${message}`);
}

const now = () => Math.floor(Date.now() / 1000);
const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);

export class TokenVault extends DurableObject<Env> {
  private refreshing: Promise<Tokens> | null = null;

  private get issuer() {
    return (this.env.OPENAI_AUTH_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, "");
  }

  async status(): Promise<VaultStatus> {
    const [tokens, pending, expired, lastError] = await Promise.all([
      this.ctx.storage.get<Tokens>("tokens"),
      this.ctx.storage.get<Pending>("pending"),
      this.ctx.storage.get<Expired>("expired"),
      this.ctx.storage.get<string>("last_error"),
    ]);
    const livePending = pending && pending.expires_at > now() ? pending : null;
    const claims = tokens ? decodeClaims(tokens.access_token) : {};
    const auth = claims["https://api.openai.com/auth"] ?? {};
    const state: LoginState = livePending ? "pending" : tokens ? "signed_in" : expired ? "expired" : "signed_out";
    const verification_url = `${this.issuer}/codex/device`;
    const next_step = {
      signed_in: "Ready.",
      pending: `Open ${verification_url}, sign in to ChatGPT and enter code ${livePending?.user_code}. Then call chatgpt_login again (or retry the search) to confirm.`,
      expired: `The ChatGPT login expired (${expired?.reason}). Call chatgpt_login and give the owner the link and code.`,
      signed_out: "Not signed in. Call chatgpt_login and give the owner the link and code.",
    }[state];
    return {
      state,
      logged_in: !!tokens,
      plan: auth.chatgpt_plan_type ?? null,
      account_id_suffix: auth.chatgpt_account_id ? auth.chatgpt_account_id.slice(-4) : null,
      access_expires_at: iso(claims.exp),
      last_refresh: iso(tokens?.last_refresh),
      signed_in_at: iso(tokens?.obtained_at),
      pending_login: livePending
        ? { user_code: livePending.user_code, verification_url, expires_at: iso(livePending.expires_at)! }
        : null,
      expired: expired ? { reason: expired.reason, at: iso(expired.at)! } : null,
      last_error: lastError ?? null,
      next_step,
    };
  }

  /**
   * Kite-style login entry point. Idempotent:
   * - signed in and !force → status only;
   * - a login is pending → poll once now (so "done, check again" is instant) and return it;
   * - otherwise → start a device-code login and return the link + code.
   * While a forced re-login is pending, the existing tokens keep serving requests.
   */
  async login(force = false): Promise<VaultStatus> {
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (pending && pending.expires_at > now()) {
      await this.pollOnce();
      return this.status();
    }
    if (!force && (await this.ctx.storage.get<Tokens>("tokens"))) return this.status();
    return this.startLogin();
  }

  /** Step 1 of the device flow; polling continues in alarm(). */
  async startLogin(): Promise<VaultStatus> {
    const response = await fetch(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });
    const body = await response.text();
    if (response.status === 429)
      throw vaultError("UPSTREAM_RATE_LIMITED", "OpenAI is rate-limiting login requests; try again in a minute.");
    if (response.status !== 200)
      throw vaultError("LOGIN_FAILED", `Device code request returned HTTP ${response.status}: ${body.slice(0, MAX_ERROR_CHARS)}`);
    const data = JSON.parse(body) as { device_auth_id?: string; user_code?: string; interval?: string | number };
    if (!data.device_auth_id || !data.user_code)
      throw vaultError("LOGIN_FAILED", "Device code response missing device_auth_id or user_code.");
    const pending: Pending = {
      device_auth_id: data.device_auth_id,
      user_code: data.user_code,
      interval_s: Math.max(3, Number(data.interval ?? 5) || 5),
      expires_at: now() + LOGIN_WINDOW_S,
    };
    await this.ctx.storage.put("pending", pending);
    await this.ctx.storage.delete("last_error");
    await this.ctx.storage.setAlarm(Date.now() + pending.interval_s * 1000);
    return this.status();
  }

  async alarm() {
    const pending = await this.pollOnce();
    if (pending) await this.ctx.storage.setAlarm(Date.now() + pending.interval_s * 1000);
  }

  /** Steps 3–4: one poll; on approval, exchange the code. Returns the pending login if still waiting. */
  private async pollOnce(): Promise<Pending | null> {
    const pending = await this.ctx.storage.get<Pending>("pending");
    if (!pending) return null;
    if (pending.expires_at <= now()) {
      await this.fail("Login code expired after 15 minutes without approval.");
      return null;
    }
    const poll = await fetch(`${this.issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ device_auth_id: pending.device_auth_id, user_code: pending.user_code }),
    });
    if (poll.status === 403 || poll.status === 404) {
      await poll.body?.cancel();
      return pending; // owner has not approved yet
    }
    if (poll.status !== 200) {
      await this.fail(`Device auth polling returned HTTP ${poll.status}.`);
      return null;
    }
    const code = (await poll.json()) as { authorization_code?: string; code_verifier?: string };
    if (!code.authorization_code || !code.code_verifier) {
      await this.fail("Device auth response missing authorization_code or code_verifier.");
      return null;
    }
    const exchange = await this.tokenRequest({
      grant_type: "authorization_code",
      code: code.authorization_code,
      redirect_uri: `${this.issuer}/deviceauth/callback`,
      client_id: CODEX_CLIENT_ID,
      code_verifier: code.code_verifier,
    });
    if (exchange.status !== 200) {
      await this.fail(`Token exchange returned HTTP ${exchange.status}.`);
      return null;
    }
    const tokens = (await exchange.json()) as { access_token?: string; refresh_token?: string };
    if (!tokens.access_token || !tokens.refresh_token) {
      await this.fail("Token exchange did not return access and refresh tokens.");
      return null;
    }
    await this.ctx.storage.put("tokens", {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      obtained_at: now(),
      last_refresh: null,
    } satisfies Tokens);
    await this.ctx.storage.delete(["pending", "expired", "last_error"]);
    return null;
  }

  /** Bearer + account headers for alpha/search, refreshing first when close to expiry. */
  async credential(forceRefresh = false): Promise<Credential> {
    let tokens = await this.ctx.storage.get<Tokens>("tokens");
    if (!tokens) {
      const status = await this.status();
      throw vaultError(status.state === "pending" ? "LOGIN_PENDING" : "LOGIN_REQUIRED", status.next_step);
    }
    const exp = decodeClaims(tokens.access_token).exp ?? 0;
    if (forceRefresh || exp - now() < REFRESH_SKEW_S) tokens = await this.refresh(tokens.refresh_token);
    const auth = decodeClaims(tokens.access_token)["https://api.openai.com/auth"] ?? {};
    return {
      accessToken: tokens.access_token,
      accountId: auth.chatgpt_account_id,
      residency: auth.chatgpt_data_residency || auth.chatgpt_compute_residency,
    };
  }

  /** Daily cron: refresh when under 2 days remain or the last refresh is 8+ days old (Codex's rule). */
  async keepFresh(): Promise<"refreshed" | "fresh" | "signed_out"> {
    const tokens = await this.ctx.storage.get<Tokens>("tokens");
    if (!tokens) return "signed_out";
    const exp = decodeClaims(tokens.access_token).exp ?? 0;
    const lastRefresh = tokens.last_refresh ?? tokens.obtained_at;
    if (exp - now() < KEEP_FRESH_MARGIN_S || now() - lastRefresh > REFRESH_INTERVAL_S) {
      await this.refresh(tokens.refresh_token);
      return "refreshed";
    }
    return "fresh";
  }

  async logout(): Promise<VaultStatus> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return this.status();
  }

  private refresh(usedRefreshToken: string): Promise<Tokens> {
    this.refreshing ??= this.doRefresh(usedRefreshToken).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(usedRefreshToken: string): Promise<Tokens> {
    // A concurrent caller may have rotated already: adopt the stored pair instead of replaying.
    const stored = await this.ctx.storage.get<Tokens>("tokens");
    if (stored && stored.refresh_token !== usedRefreshToken) return stored;
    const response = await this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: usedRefreshToken,
      client_id: CODEX_CLIENT_ID,
    });
    const body = await response.text();
    if (response.status === 429)
      throw vaultError("UPSTREAM_RATE_LIMITED", "OpenAI is rate-limiting token refresh; try again later.");
    if (response.status !== 200) {
      const code = oauthErrorCode(body);
      if (isPermanentRefreshFailure(response.status, code)) {
        const reason = code ?? `http_${response.status}`;
        await this.ctx.storage.delete("tokens");
        await this.ctx.storage.put("expired", { reason, at: now() } satisfies Expired);
        throw vaultError("LOGIN_REQUIRED", (await this.status()).next_step);
      }
      // Transient (5xx, unknown 400): keep the grant; the next call retries.
      throw vaultError("UPSTREAM_ERROR", `Token refresh returned HTTP ${response.status}; the login is kept and will be retried.`);
    }
    const data = JSON.parse(body) as { access_token?: string; refresh_token?: string };
    if (!data.access_token) throw vaultError("UPSTREAM_ERROR", "Token refresh response had no access_token.");
    const next: Tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || usedRefreshToken,
      obtained_at: stored?.obtained_at ?? now(),
      last_refresh: now(),
    };
    await this.ctx.storage.put("tokens", next);
    return next;
  }

  private tokenRequest(form: Record<string, string>) {
    return fetch(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
  }

  private async fail(message: string) {
    await this.ctx.storage.delete("pending");
    await this.ctx.storage.put("last_error", message);
  }
}

export const vault = (env: Env) => env.VAULT.get(env.VAULT.idFromName("owner"));
