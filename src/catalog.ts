import { createHash } from "node:crypto";
import type { Agent, Connection, Policy } from "./router.js";

/**
 * Runtime harness and model availability, read from Conductor itself.
 *
 * Primary source: the `list_models` tool on Conductor's hosted MCP server
 * (`https://api.conductor.build/mcp`), called with the same API key as the
 * REST API. It returns every agent with its accepted models, effort levels,
 * defaults and a `configured` flag. Conductor documents that only agents with
 * `configured: true` have credentials connected; the others fail at launch.
 *
 * Fallback: the public REST OpenAPI document, which enumerates accepted model
 * ids and efforts per agent but cannot say which agents are connected.
 */
export interface CatalogAgent {
  agent: string;
  configured: boolean | null;
  models: string[];
  efforts: string[];
  defaultModel?: string;
  defaultEffort?: string;
}
export interface ModelCatalog {
  source: "conductor_list_models" | "conductor_openapi";
  fetchedAt: string;
  agents: CatalogAgent[];
  warning?: string;
}
export interface CatalogOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Cache lifetime. Defaults to 5 minutes. Pass 0 to bypass the cache. */
  maxAgeMs?: number;
  now?: number;
}

const ROUTABLE: readonly Agent[] = ["codex", "claude", "cursor"];
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; catalog: ModelCatalog }>();

export function clearCatalogCache() { cache.clear(); }

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export function parseListModels(value: unknown): CatalogAgent[] {
  const agents = (value as { agents?: unknown })?.agents;
  if (!Array.isArray(agents) || !agents.length) throw new Error("Conductor list_models returned no agents");
  return agents.flatMap((row: any) => {
    if (!row || typeof row.agent !== "string") return [];
    return [{
      agent: row.agent, configured: typeof row.configured === "boolean" ? row.configured : null,
      models: strings(row.models), efforts: strings(row.efforts),
      ...(typeof row.defaultModel === "string" ? { defaultModel: row.defaultModel } : {}),
      ...(typeof row.defaultEffort === "string" ? { defaultEffort: row.defaultEffort } : {}),
    }];
  });
}

/** Parses "Accepted model ids by agent — claude: a, b; codex: c." style prose. */
function perAgentList(text: string, heading: string) {
  const start = text.indexOf(heading);
  if (start < 0) return new Map<string, string[]>();
  const rest = text.slice(start + heading.length).replace(/^[\s\u2014\u2013:-]+/, "");
  const body = rest.slice(0, rest.search(/\.(\s|$)/) >= 0 ? rest.search(/\.(\s|$)/) : rest.length);
  const result = new Map<string, string[]>();
  for (const part of body.split(";")) {
    const match = part.trim().match(/^([a-z]+):\s*(.+)$/);
    if (match) result.set(match[1], match[2].split(",").map((item) => item.trim()).filter(Boolean));
  }
  return result;
}

export function parseOpenApiCatalog(spec: any): CatalogAgent[] {
  const description: string = spec?.paths?.["/v0/workspaces"]?.post?.description ?? "";
  const models = perAgentList(description, "Accepted model ids by agent");
  const efforts = perAgentList(description, "Accepted effort levels by agent");
  if (!models.size) throw new Error("Conductor OpenAPI document does not list accepted models by agent");
  return [...models.entries()].map(([agent, list]) => ({ agent, configured: null, models: list, efforts: efforts.get(agent) ?? [] }));
}

async function readJsonRpc(response: Response) {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (type.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    for (const line of data.reverse()) {
      try { const message = JSON.parse(line); if (message && (message.result || message.error)) return message; } catch { /* keep looking */ }
    }
    throw new Error("Conductor MCP returned an unreadable event stream");
  }
  return JSON.parse(text);
}

async function fromListModels(key: string, options: CatalogOptions): Promise<ModelCatalog> {
  const base = (options.baseUrl ?? "https://api.conductor.build").replace(/\/$/, "");
  const response = await (options.fetch ?? fetch)(base + "/mcp", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_models", arguments: {} } }),
  });
  if (response.status === 401 || response.status === 403) throw new Error(`Conductor rejected CONDUCTOR_API_KEY (${response.status}) while listing models`);
  if (!response.ok) throw new Error(`Conductor list_models returned ${response.status}`);
  const message = await readJsonRpc(response);
  if (message?.error) throw new Error(`Conductor list_models failed: ${typeof message.error.message === "string" ? message.error.message : "error"}`);
  const result = message?.result;
  if (result?.isError) throw new Error("Conductor list_models returned an error result");
  let payload = result?.structuredContent;
  if (!payload) {
    const text = result?.content?.find?.((item: any) => item?.type === "text")?.text;
    payload = typeof text === "string" ? JSON.parse(text) : undefined;
  }
  return { source: "conductor_list_models", fetchedAt: new Date(options.now ?? Date.now()).toISOString(), agents: parseListModels(payload) };
}

async function fromOpenApi(options: CatalogOptions): Promise<ModelCatalog> {
  const base = (options.baseUrl ?? "https://api.conductor.build").replace(/\/$/, "");
  const response = await (options.fetch ?? fetch)(base + "/v0/openapi.json", {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new Error(`Conductor OpenAPI document returned ${response.status}`);
  return {
    source: "conductor_openapi", fetchedAt: new Date(options.now ?? Date.now()).toISOString(), agents: parseOpenApiCatalog(await response.json()),
    warning: "Conductor list_models was unavailable. Models come from the public OpenAPI document, which cannot say which agents have credentials connected.",
  };
}

export async function fetchModelCatalog(options: CatalogOptions = {}): Promise<ModelCatalog> {
  const env = options.env ?? process.env;
  const key = env.CONDUCTOR_API_KEY || env.CONDUCTOR_API_TOKEN;
  if (!key) throw new Error("CONDUCTOR_API_KEY is required to detect available harnesses and models from Conductor");
  const cacheKey = createHash("sha256").update((options.baseUrl ?? "") + ":" + key).digest("hex");
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const hit = cache.get(cacheKey);
  if (maxAge > 0 && hit && now - hit.at < maxAge) return hit.catalog;
  let catalog: ModelCatalog;
  try {
    catalog = await fromListModels(key, options);
  } catch (primary) {
    // An auth failure is not something the public spec can fix; surface it.
    if (primary instanceof Error && /rejected CONDUCTOR_API_KEY/.test(primary.message)) throw primary;
    try { catalog = await fromOpenApi(options); }
    catch {
      throw new Error(`Could not read available models from Conductor: ${primary instanceof Error ? primary.message : "request failed"}`);
    }
  }
  if (maxAge > 0) cache.set(cacheKey, { at: now, catalog });
  return catalog;
}

/** One connection per routable agent Conductor reports as configured. Quota is
 * not exposed by Conductor's API, so windows stay empty and quota is "unknown"
 * for every harness alike: ranking then follows capability fit and policy order. */
export function catalogConnections(catalog: ModelCatalog): Connection[] {
  return catalog.agents.flatMap((row) => {
    if (!(ROUTABLE as readonly string[]).includes(row.agent) || row.configured === false || !row.models.length) return [];
    return [{
      agent: row.agent as Agent, authKind: "conductor" as const, enabled: true, models: row.models,
      accountFingerprint: createHash("sha256").update("conductor-catalog:" + row.agent).digest("hex"),
      observedAt: catalog.fetchedAt, windows: [], quotaError: "quota_not_exposed_by_conductor",
    }];
  });
}

/** Restricts each policy model's efforts to what Conductor accepts for its agent
 * right now, and admits an explicitly requested model Conductor accepts even if
 * the policy has not ranked it yet. */
export function policyForCatalog(policy: Policy, catalog: ModelCatalog, explicit?: { agent?: string; model?: string }): Policy {
  const byAgent = new Map(catalog.agents.map((row) => [row.agent, row]));
  const models = policy.models.map((m) => {
    const accepted = byAgent.get(m.agent)?.efforts;
    return accepted && accepted.length ? { ...m, efforts: m.efforts.filter((effort) => accepted.includes(effort)) } : m;
  });
  if (explicit?.model && !models.some((m) => m.model === explicit.model)) {
    const owner = catalog.agents.find((row) => (!explicit.agent || row.agent === explicit.agent)
      && (ROUTABLE as readonly string[]).includes(row.agent) && row.models.includes(explicit.model!));
    if (owner) models.push({ agent: owner.agent as Agent, model: explicit.model, capability: 0,
      efforts: owner.efforts.filter((e) => ["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(e)) });
  }
  return { ...policy, models };
}

export function availabilitySummary(catalog: ModelCatalog, policy: Policy) {
  const ranked = new Set(policy.models.map((m) => m.agent + ":" + m.model));
  return {
    source: catalog.source, fetchedAt: catalog.fetchedAt, ...(catalog.warning ? { warning: catalog.warning } : {}),
    agents: catalog.agents.map((row) => ({
      agent: row.agent, configured: row.configured,
      routableModels: row.models.filter((model) => ranked.has(row.agent + ":" + model)),
      unrankedModels: row.models.filter((model) => !ranked.has(row.agent + ":" + model)),
    })),
  };
}
