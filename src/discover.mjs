/**
 * OPT-IN account discovery. Not used by the router CLI or the MCP server.
 * Set CONDUCTOR_DISCOVERY_OPT_IN=1 to run it. It only works inside a Conductor
 * cloud workspace and calls undocumented workspace broker routes. The Cursor
 * path can send a session cookie to cursor.com. Those private interfaces can
 * change; a failed probe is not proof that a harness is disconnected.
 * Do not run this unless you intend that access. Quota snapshots contain
 * identity hashes and model ids, not provider keys or transcripts.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const env = process.env;
if (env.CONDUCTOR_DISCOVERY_OPT_IN !== '1') throw new Error('Discovery is opt-in. It calls undocumented Conductor broker routes and may send a session cookie. Set CONDUCTOR_DISCOVERY_OPT_IN=1 to run it.');
const workspaceId = env.CONDUCTOR_WORKSPACE_ID;
const workspaceAuth = env.CONDUCTOR_INTERNAL_WORKSPACE_AUTH;
if (env.CONDUCTOR_IS_LOCAL !== '0' || !workspaceId || !workspaceAuth) throw new Error('Discovery requires a Conductor cloud workspace');
const configured = (env.CONDUCTOR_INTERNAL_CONFIGURED_HARNESSES || '').split(',');
const fp = (provider, identity) => createHash('sha256').update(provider + ':' + identity.trim().toLowerCase()).digest('hex');
const jwt = (token) => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return {}; } };
const get = async (url, headers, body) => {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Provider returned ' + response.status);
  return response.json();
};
const broker = (route) => get('https://api.conductor.build/workspaces/' + encodeURIComponent(workspaceId) + '/' + route,
  { 'content-type': 'application/json' }, { workspaceId, workspaceAuth });
const catalog = JSON.parse((await run('conductor', ['model', '--json'], { timeout: 10000, maxBuffer: 100000 })).stdout).agents;
const modes = await broker('agent-auth-modes').catch(() => ({}));
const connections = [];
await Promise.all(configured.filter((a) => ['codex','claude','cursor'].includes(a)).map(async (agent) => {
  const models = catalog.find((c) => c.agent === agent)?.models || [];
  if (!models.length) return;
  const row = { agent, models, enabled: true, authKind: 'subscription', accountFingerprint: '', observedAt: new Date().toISOString(), windows: [], quotaError: 'quota_unknown' };
  try {
    if (agent === 'codex') {
      if (modes.codex === 'api-key' || (env.CODEX_API_KEY && !modes.codex)) {
        row.authKind = 'byok';
        row.accountFingerprint = fp(agent, env.CODEX_API_KEY || 'conductor-brokered-api-key:' + env.CONDUCTOR_USER_ID);
      } else {
        // This is the same broker the Conductor Codex runner calls at launch.
        // Never borrow a different local Codex profile just because it exists.
        const auth = await broker('codex-chatgpt-token');
        if (!auth.accessToken || !auth.chatgptAccountId) return;
        row.accountFingerprint = fp(agent, auth.chatgptAccountId);
        const q = await get('https://chatgpt.com/backend-api/wham/usage', { authorization: 'Bearer ' + auth.accessToken, 'ChatGPT-Account-Id': auth.chatgptAccountId });
        row.windows = [q.rate_limit?.primary_window, q.rate_limit?.secondary_window].filter(Boolean).map((w) => ({
          usedPercent: w.used_percent, resetsAt: typeof w.reset_at === 'number' ? new Date(w.reset_at * 1000).toISOString() : null,
        }));
        if (q.rate_limit?.limit_reached === true && !row.windows.some((w) => w.usedPercent >= 100)) row.windows.push({ usedPercent: 100, resetsAt: null });
      }
    } else if (agent === 'cursor') {
      if (!env.CURSOR_API_KEY) return;
      const identity = await get('https://api.cursor.com/v0/me', { authorization: 'Basic ' + Buffer.from(env.CURSOR_API_KEY + ':').toString('base64') });
      if (!identity.userEmail) return;
      row.accountFingerprint = fp(agent, identity.userEmail);
      row.authKind = 'byok';
      // Same account check before enriching the API-key harness with the
      // subscription dashboard. A different CLI login is never combined.
      const cli = JSON.parse(env.CURSOR_CLI_AUTH || '{}');
      const subject = jwt(cli.accessToken || '').sub?.split('|').pop();
      if (subject && /^[A-Za-z0-9._-]+$/.test(subject)) {
        const headers = { Cookie: 'WorkosCursorSessionToken=' + subject + '%3A%3A' + cli.accessToken };
        const profile = await get('https://cursor.com/api/auth/me', headers);
        if (typeof profile.email === 'string' && profile.email.toLowerCase() === identity.userEmail.toLowerCase()) {
          const q = await get('https://cursor.com/api/usage-summary', headers);
          const plan = q.individualUsage?.plan;
          // Percentage fields are already 0..100, even when below one.
          // Team-only or missing limits stay unknown; paid overage isn't quota.
          const used = plan?.totalPercentUsed ?? (plan?.limit > 0 && typeof plan.used === 'number' ? plan.used / plan.limit * 100 : null);
          if (typeof used === 'number' && Number.isFinite(used)) row.windows = [{ usedPercent: Math.min(100, Math.max(0, used)), resetsAt: q.billingCycleEnd || null }];
        }
      }
    } else {
      if (modes.claude === 'api-key' || env.ANTHROPIC_API_KEY) {
        row.authKind = 'byok'; row.accountFingerprint = fp(agent, env.ANTHROPIC_API_KEY || 'conductor-brokered-api-key:' + env.CONDUCTOR_USER_ID);
      } else {
        let token = env.CLAUDE_CODE_OAUTH_TOKEN;
        if (modes.claude === 'brokered-oauth') token = (await broker('claude-oauth-token')).accessToken;
        if (!token) return;
        // Inference-only setup tokens lack profile scope. Mark the configured
        // harness with unknown quota rather than claiming no Claude connection.
        row.accountFingerprint = fp(agent, token);
        const headers = { authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' };
        const profile = await get('https://api.anthropic.com/api/oauth/profile', headers).catch(() => null);
        if (profile?.account?.email) row.accountFingerprint = fp(agent, profile.account.email);
        const q = await get('https://api.anthropic.com/api/oauth/usage', headers);
        row.windows = [q.five_hour, q.seven_day, q.seven_day_sonnet, q.seven_day_opus].filter(Boolean).map((w) => ({ usedPercent: w.utilization, resetsAt: w.resets_at || null }));
      }
    }
    if (row.windows.length) row.quotaError = null;
  } catch { /* Credential remains local; never forward raw upstream errors. */ }
  if (row.accountFingerprint) connections.push(row);
}));
const identity = await get('https://api.conductor.build/me', {authorization: 'Bearer ' + (env.CONDUCTOR_API_TOKEN || env.CONDUCTOR_API_KEY)});
if (!identity.userId || !identity.organizationId) throw new Error('Conductor identity is incomplete');
console.log(JSON.stringify({ conductor: {userId: identity.userId, organizationId: identity.organizationId}, connections }, null, 2));
