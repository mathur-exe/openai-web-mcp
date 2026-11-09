// Pure helpers for the ChatGPT OAuth tokens (no Workers runtime imports, so unit-testable).

/** Refresh error codes Codex treats as permanent (sign in again). */
const DEAD_GRANT_CODES = new Set(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

export interface AuthClaims {
  exp?: number;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
    chatgpt_data_residency?: string;
    chatgpt_compute_residency?: string;
  };
}

export function decodeClaims(jwt: string): AuthClaims {
  try {
    const part = jwt.split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(b64)) as AuthClaims;
  } catch {
    return {};
  }
}

/** OAuth error code from `{"error":"x"}`, `{"error":{"code":"x"}}` or `{"code":"x"}`. */
export function oauthErrorCode(body: string): string | null {
  try {
    const data = JSON.parse(body) as { error?: string | { code?: string }; code?: string };
    const code = typeof data.error === "string" ? data.error : (data.error?.code ?? data.code);
    return typeof code === "string" ? code.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Codex rule: 401, a known dead-grant code, or 400 invalid_grant is permanent; anything else is transient. */
export function isPermanentRefreshFailure(status: number, code: string | null) {
  return status === 401 || (code !== null && DEAD_GRANT_CODES.has(code)) || (status === 400 && code === "invalid_grant");
}
