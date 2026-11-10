// Run only against the owner's deployed Worker. With --live, uses one live search and one page fetch on the owner's ChatGPT plan.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';

const origin = 'https://openai-web-mcp.gmathur1993.workers.dev';
const owner = (await readFile(new URL('../.wrangler/owner-passphrase.txt', import.meta.url), 'utf8')).trim();
async function json(response) {
  assert.ok(response.ok, `Unexpected HTTP ${response.status}`);
  return response.json();
}
const challengeResponse = await fetch(`${origin}/mcp`, { method: 'POST' });
assert.equal(challengeResponse.status, 401);
const challenge = challengeResponse.headers.get('WWW-Authenticate');
const resourceUrl = challenge?.match(/resource_metadata="([^"]+)"/)?.[1];
assert.ok(resourceUrl, 'MCP challenge must point to resource discovery');
const resource = await json(await fetch(resourceUrl));
assert.equal(resource.resource, `${origin}/mcp`);
const metadata = await json(await fetch(`${origin}/.well-known/oauth-authorization-server`));
const client = await json(await fetch(metadata.registration_endpoint, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'OpenAI Web deployment check',
    redirect_uris: ['http://localhost:8977/callback'], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
}));
const verifier = randomBytes(48).toString('base64url');
const params = new URLSearchParams({ client_id: client.client_id, redirect_uri: 'http://localhost:8977/callback',
  response_type: 'code', scope: 'mcp:read', state: randomBytes(16).toString('hex'),
  code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${origin}/mcp` });
const consent = await fetch(`${metadata.authorization_endpoint}?${params}`);
assert.equal(consent.status, 200);
assert.equal(consent.headers.get('Referrer-Policy'), 'same-origin', 'Browser consent must preserve its form origin');
const html = await consent.text();
const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
assert.ok(handle, 'Consent page must provide a browser-bound handle');
const cookies = consent.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const approved = await fetch(metadata.authorization_endpoint, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: cookies },
  body: new URLSearchParams({ handle, passphrase: owner, decision: 'approve' }),
});
assert.equal(approved.status, 302, 'Owner login must succeed');
const callback = new URL(approved.headers.get('Location'));
assert.equal(callback.searchParams.get('state'), params.get('state'));
const tokens = await json(await fetch(metadata.token_endpoint, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
    grant_type: 'authorization_code', code: callback.searchParams.get('code'), client_id: client.client_id,
    redirect_uri: 'http://localhost:8977/callback', code_verifier: verifier, resource: `${origin}/mcp`,
  }),
}));
async function rpc(method, params) {
  const response = await fetch(`${origin}/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  assert.equal(response.status, 200, `${method}: HTTP ${response.status}`);
  const text = await response.text();
  const data = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text.split('\n').find(line => line.startsWith('data: '))?.slice(6) : text;
  const result = JSON.parse(data);
  assert.ok(!result.error, `${method}: protocol error`);
  return result.result;
}
try {
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'deployment-check', version: '1' } });
  const { tools } = await rpc('tools/list');
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['chatgpt_login', 'web_fetch', 'web_search', 'web_status']);
  console.log('PASS: OAuth, PKCE, protected MCP, four-tool discovery');
  const status = await rpc('tools/call', { name: 'web_status', arguments: {} });
  const statusData = JSON.parse(status.content[0].text);
  assert.ok(!status.isError);
  console.log(`PASS: web_status; ChatGPT login state = ${statusData.login.state}; usage today = ${JSON.stringify(statusData.usage)}`);
  if (process.argv.includes('--live')) {
    assert.equal(statusData.login.state, 'signed_in', 'Sign in to ChatGPT first (chatgpt_login or /admin)');
    const search = await rpc('tools/call', { name: 'web_search', arguments: { query: 'Cloudflare Workers free plan limits', limit: 3 } });
    const searchData = JSON.parse(search.content[0].text);
    assert.ok(!search.isError, `Search failed: ${searchData.code ?? 'unknown'} ${searchData.message ?? ''}`);
    assert.ok(searchData.results.length > 0, 'Search must return results');
    console.log(`PASS: live web_search, ${searchData.results.length} results, first ${searchData.results[0].url}`);
    const page = await rpc('tools/call', { name: 'web_fetch', arguments: { url: searchData.results[0].url, max_tokens: 1000 } });
    const pageData = JSON.parse(page.content[0].text);
    assert.ok(!page.isError && pageData.text.length > 0, `Fetch failed: ${pageData.code ?? 'unknown'}`);
    console.log(`PASS: live web_fetch via ${pageData.source}, ${pageData.text.length} chars, lines ${pageData.first_line}-${pageData.last_line} of ${pageData.total_lines}`);
  }
  const refreshed = await json(await fetch(metadata.token_endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id,
    }),
  }));
  tokens.access_token = refreshed.access_token;
  tokens.refresh_token = refreshed.refresh_token;
  console.log('PASS: live OAuth refresh');
} finally {
  // End the temporary test grant rather than leave an authorized client session.
  if (metadata.revocation_endpoint) {
    await fetch(metadata.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refresh_token, token_type_hint: 'refresh_token', client_id: client.client_id }) });
  }
}
