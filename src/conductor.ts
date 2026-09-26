const SECRET_KEY = /(api[_-]?key|token|secret|password|credential|authorization|private[_-]?key|cookie)/i;
const AGENTS = ["claude", "codex", "cursor", "acp"] as const;
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ConductorAgent = (typeof AGENTS)[number];
export type ConductorEffort = (typeof EFFORTS)[number];

export interface ConductorIdentity {
  userId?: string;
  organizationId?: string;
  name?: string;
  email?: string;
  authMethod?: string;
}

export interface WorkspaceDraft {
  projectId?: string;
  repositoryUrl?: string;
  branch?: string;
  name?: string;
  sessionName?: string;
  agent?: string;
  model?: string;
  effort?: string;
  message?: string;
  env?: Record<string, string>;
}

export interface SessionDraft {
  workspaceId: string;
  sessionId?: string;
  name?: string;
  agent: string;
  model?: string;
  effort?: string;
  message?: string;
  messageId?: string;
}

export interface ConductorOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function assertWorkspaceEnvSafe(env: Record<string, string> | undefined, processEnv: NodeJS.ProcessEnv) {
  if (!env) return;
  if (typeof env !== "object" || Array.isArray(env)) throw new Error("Workspace env must be a string map");
  const secretValues = new Set<string>();
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string" && value.length >= 8 && SECRET_KEY.test(key)) secretValues.add(value);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value) throw new Error("Workspace env values must be non-empty strings");
    if (SECRET_KEY.test(key) || secretValues.has(value)) {
      throw new Error(`Refusing to pass secret-like workspace env "${key}". Configure credentials on the Conductor cloud machine, not in workspace env.`);
    }
  }
}

export function workspacePayload(input: WorkspaceDraft, processEnv: NodeJS.ProcessEnv = {}) {
  if (!input.projectId && !input.repositoryUrl) throw new Error("projectId or repositoryUrl is required");
  if (input.projectId && input.repositoryUrl) throw new Error("Pass projectId or repositoryUrl, not both");
  if (input.agent && !(AGENTS as readonly string[]).includes(input.agent)) throw new Error("agent must be claude, codex, cursor, or acp");
  if (input.effort && !(EFFORTS as readonly string[]).includes(input.effort)) throw new Error("effort must be none, low, medium, high, xhigh, max, or ultra");
  assertWorkspaceEnvSafe(input.env, processEnv);
  const body: Record<string, unknown> = {};
  for (const key of ["projectId", "repositoryUrl", "branch", "name", "sessionName", "agent", "model", "effort", "message"] as const) {
    if (input[key]) body[key] = input[key];
  }
  if (input.env && Object.keys(input.env).length) body.env = input.env;
  body.fastMode = false;
  return body;
}

export function sessionPayload(input: SessionDraft) {
  if (!input.workspaceId) throw new Error("workspaceId is required");
  if (!(AGENTS as readonly string[]).includes(input.agent)) throw new Error("agent must be claude, codex, cursor, or acp");
  if (input.effort && !(EFFORTS as readonly string[]).includes(input.effort)) throw new Error("effort must be none, low, medium, high, xhigh, max, or ultra");
  const body: Record<string, unknown> = { workspaceId: input.workspaceId, agent: input.agent, fastMode: false };
  for (const key of ["sessionId", "name", "model", "effort", "message", "messageId"] as const) {
    if (input[key]) body[key] = input[key];
  }
  return body;
}

export function transcriptQuery(sessionId?: string, query?: string) {
  if (query) {
    const statement = query.trim();
    if (!statement) throw new Error("Transcript query is empty");
    if (statement.length > 10_000) throw new Error("Transcript query exceeds 10000 characters");
    if (statement.includes(";")) throw new Error("Transcript query must be a single statement");
    if (/set_config/i.test(statement)) throw new Error("Transcript query cannot contain set_config");
    if (!/^select\b/i.test(statement)) throw new Error("Transcript query must be a SELECT");
    if (!/\bsession_transcripts_view\b/i.test(statement)) throw new Error("Transcript query must read session_transcripts_view");
    return statement;
  }
  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error("sessionId must be 1-128 letters, numbers, underscores, or hyphens, or pass a read-only query");
  }
  return "SELECT session_id, workspace_id, session_title, agent_type, model, workspace_name, workspace_state, transcript_updated_at, transcript "
    + `FROM session_transcripts_view WHERE session_id = '${sessionId}' ORDER BY transcript_updated_at DESC LIMIT 20`;
}

function retryAfterMs(response: Response, attempt: number) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 20_000);
    const when = Date.parse(header);
    if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 20_000);
  }
  return Math.min(250 * 2 ** attempt, 4_000);
}

export class ConductorClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ConductorOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.conductor.build").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (options.apiKey) this.env = { ...this.env, CONDUCTOR_API_KEY: options.apiKey };
  }

  private key() {
    const key = this.env.CONDUCTOR_API_KEY || this.env.CONDUCTOR_API_TOKEN;
    if (!key) throw new Error("CONDUCTOR_API_KEY is required");
    return key;
  }

  async request(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | number | undefined>, idempotent = method === "GET") {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const key = this.key();
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
          headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        lastError = new Error(idempotent
          ? "Conductor request failed before a response."
          : "Conductor request failed before a response. This mutation was not retried.");
        if (idempotent && attempt < this.maxRetries) { await this.sleep(Math.min(250 * 2 ** attempt, 4_000)); continue; }
        throw lastError;
      }
      if (response.ok) return response.json() as Promise<any>;
      const retry = response.status === 429 || (idempotent && response.status >= 500);
      if (retry && attempt < this.maxRetries) { await this.sleep(retryAfterMs(response, attempt)); continue; }
      throw new Error(await this.failure(response, !idempotent));
    }
    throw lastError ?? new Error("Conductor request failed");
  }

  private async failure(response: Response, mutation: boolean) {
    let detail = "";
    try {
      const payload = await response.json() as { userMessage?: string; code?: string };
      if (typeof payload.userMessage === "string" && payload.userMessage) detail = `: ${payload.userMessage}`;
      else if (typeof payload.code === "string" && payload.code) detail = `: ${payload.code}`;
    } catch { /* Status is enough when the body is not the public error shape. */ }
    const hint = mutation ? " Check account, model, and repository access. This mutation was not retried." : "";
    return `Conductor returned ${response.status}${detail}.${hint}`;
  }

  me() { return this.request("GET", "/me") as Promise<ConductorIdentity>; }
  listProjects(query?: { limit?: number; offset?: number }) {
    if (query?.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error("limit must be an integer >= 1");
    if (query?.offset !== undefined && (!Number.isInteger(query.offset) || query.offset < 0)) throw new Error("offset must be an integer >= 0");
    return this.request("GET", "/v0/projects", undefined, query);
  }
  createWorkspace(body: Record<string, unknown>) {
    if (body.env) assertWorkspaceEnvSafe(body.env as Record<string, string>, this.env);
    if (body.fastMode !== false) throw new Error("Conductor launches must send fastMode false");
    return this.request("POST", "/v0/workspaces", body, undefined, false);
  }
  startSession(body: Record<string, unknown>) {
    if (body.fastMode !== false) throw new Error("Conductor sessions must send fastMode false");
    return this.request("POST", "/v0/sessions", body, undefined, false);
  }
  sendMessage(sessionId: string, message: string, messageId?: string) {
    if (!message.trim()) throw new Error("message is required");
    const body: Record<string, unknown> = { message };
    if (messageId) body.messageId = messageId;
    return this.request("POST", `/v0/sessions/${encodeURIComponent(sessionId)}/messages`, body, undefined, false);
  }
  sessionStatus(sessionId: string) { return this.request("GET", `/v0/sessions/${encodeURIComponent(sessionId)}/status`); }
  workspaceStatus(workspaceId: string) { return this.request("GET", `/v0/workspaces/${encodeURIComponent(workspaceId)}/status`); }
  cancelSession(sessionId: string) { return this.request("POST", `/v0/sessions/${encodeURIComponent(sessionId)}/cancel`, undefined, undefined, false); }
  async archiveSession(sessionId: string, confirmedByUser: boolean) {
    if (confirmedByUser !== true) throw new Error("Archiving a session requires confirmedByUser: true");
    return this.request("POST", `/v0/sessions/${encodeURIComponent(sessionId)}/archive`, undefined, undefined, false);
  }
  async archiveWorkspace(workspaceId: string, confirmedByUser: boolean) {
    if (confirmedByUser !== true) throw new Error("Archiving a workspace requires confirmedByUser: true");
    return this.request("POST", `/v0/workspaces/${encodeURIComponent(workspaceId)}/archive`, undefined, undefined, false);
  }
  sql(query: string) { return this.request("POST", "/v0/sql", { query }, undefined, true); }
}
