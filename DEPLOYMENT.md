# Deployment status

Updated 2026-11-10. Owner requires no paid services.

## Live resources

- Cloudflare account: `57f62b1e73f8766f847b79ead891b2eb` (Workers Free; same account as YouTube Research).
- Worker: `openai-web-mcp`, origin `https://openai-web-mcp.gmathur1993.workers.dev`, MCP at `/mcp`, owner pages at `/admin`.
- Durable Object: `TokenVault` (SQLite-backed, free plan), holds the ChatGPT tokens.
- D1: `openai-web-mcp`, ID `85eb6e11-cd13-433a-842a-250a44141f57`, binding `DB`.
- KV: `OAUTH_KV`, ID `1151c4ea20754c1da077c35671597bfb`.
- Cron: `17 3 * * *` (token keep-fresh and table cleanup). Preview URLs are disabled.
- Render relay: service `openai-web-relay` (`srv-dbpdgvlbedkc738es16g`), free plan, Oregon, `https://openai-web-relay.onrender.com`, auto-deploys `main` and starts with `node relay/server.mjs`. Same workspace as ValuePickr.
- GitHub: `mathur-exe/openai-web-mcp` (public, so Render can read it; no secrets are committed).

No paid plan was enabled on Cloudflare or Render.

## Why a relay

`chatgpt.com/backend-api/*` returns an HTML 403 ("Unable to load site") to Cloudflare Workers' egress IPs, while `auth.openai.com` is reachable. Render's network gets the normal JSON 401. So the Worker does everything except the single `alpha/search` POST, which it sends to the relay with `X-Relay-Secret`. The relay holds no tokens and forwards only that route to `chatgpt.com`. Evidence: findings §12 and §14.

## Secrets

- Worker secrets: `OWNER_PASSPHRASE` (owner login for MCP consent and `/admin`) and `RELAY_SECRET`.
- Render env var: `RELAY_SECRET` (same value as the Worker's).
- Private local copies, git-ignored: `.wrangler/owner-passphrase.txt`, `.wrangler/relay-secret.txt`.
- ChatGPT tokens live only inside the `TokenVault` Durable Object, from the Worker's own device login. Never copy `~/.codex/auth.json`.

## Verification

- 39 Worker tests and 4 relay tests pass; dry-run build 278 KB gzipped.
- `node scripts/smoke.mjs`: OAuth discovery, DCR, owner consent, PKCE, protected MCP, four-tool discovery, `web_status`, live OAuth refresh. All pass.
- Render `/probe`: REACHABLE (JSON 401 from chatgpt.com).
- `node scripts/smoke.mjs --live` (needs the ChatGPT sign-in below): one search and one page fetch through the relay. **Not yet run.**

## Owner steps remaining

1. Open `/admin`, log in as user `owner` with the passphrase, and click **Sign in with ChatGPT**; enter the code at `auth.openai.com/codex/device`. (Or ask Claude to call `chatgpt_login` once connected.)
2. Run `node scripts/smoke.mjs --live`.
3. Connect Claude: `claude mcp add --transport http openai-web https://openai-web-mcp.gmathur1993.workers.dev/mcp`, then deny the built-in `WebSearch` / `WebFetch` in `~/.claude/settings.json`.

## Notes

- Render free instances sleep when idle; the first search after a quiet period can take 30–60 s. The Worker's upstream timeout is 60 s.
- If the relay secret differs between Worker and Render, tools return `RELAY_MISCONFIGURED`.
- Rotate the relay secret by writing a new value to `.wrangler/relay-secret.txt`, then `wrangler secret put RELAY_SECRET < .wrangler/relay-secret.txt` and update the Render env var.
