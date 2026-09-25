import { DEFAULT_ROUTING_LEARNING, learnedRouteScore, type RoutingEvidence, type RoutingLearningPolicy } from "./learning.js";
export { assessTask } from "./jev.js";
export type Agent = "codex" | "claude" | "cursor";
export interface Connection {
  agent: Agent; accountFingerprint: string; authKind: "subscription" | "byok";
  enabled: boolean; models: string[]; observedAt: string | null;
  windows: { usedPercent: number; resetsAt: string | null }[]; quotaError: string | null;
}
export interface Policy {
  models: { agent: Agent; model: string; capability: number; efforts: string[] }[];
  quotaMaxAgeSeconds: number; reservePercent: number; learning: RoutingLearningPolicy;
}
export function validatePolicy(value: unknown): Policy {
  const p = value as Policy;
  if (!p || !Array.isArray(p.models) || !p.models.length || p.models.length > 100
    || !Number.isInteger(p.quotaMaxAgeSeconds) || p.quotaMaxAgeSeconds < 60 || p.quotaMaxAgeSeconds > 3600
    || !Number.isFinite(p.reservePercent) || p.reservePercent < 0 || p.reservePercent > 90) throw new Error("Invalid routing policy");
  const learning = p.learning ?? DEFAULT_ROUTING_LEARNING;
  if (typeof learning.enabled !== "boolean" || !Number.isFinite(learning.halfLifeDays) || learning.halfLifeDays < 1 || learning.halfLifeDays > 90
    || !Number.isInteger(learning.minSamples) || learning.minSamples < 5 || learning.minSamples > 100
    || !Number.isFinite(learning.maxAdjustment) || learning.maxAdjustment < 0 || learning.maxAdjustment > 12) throw new Error("Invalid learning policy");
  const seen = new Set<string>();
  for (const m of p.models) {
    if (!m || !["codex", "claude", "cursor"].includes(m.agent) || typeof m.model !== "string" || !m.model
      || !Number.isInteger(m.capability) || m.capability < 0 || m.capability > 3 || !Array.isArray(m.efforts) || !m.efforts.length
      || m.efforts.some((e) => !["none", "low", "medium", "high", "xhigh", "max", "ultra"].includes(e))
      || seen.has(m.agent + ":" + m.model)) throw new Error("Invalid or duplicate model");
    seen.add(m.agent + ":" + m.model);
  }
  return { ...p, learning };
}
export function validateConnections(value: unknown): Connection[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("Expected a discovered connection array");
  const seen = new Set<string>();
  for (const c of value) {
    if (!c || !["codex", "claude", "cursor"].includes(c.agent) || seen.has(c.agent) || !/^[a-f0-9]{64}$/.test(c.accountFingerprint)
      || !["byok", "subscription"].includes(c.authKind) || typeof c.enabled !== "boolean" || !Array.isArray(c.models)
      || c.models.some((m: unknown) => typeof m !== "string") || !Array.isArray(c.windows) || c.windows.length > 8
      || c.windows.some((w: any) => !w || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
        || (w.resetsAt !== null && (typeof w.resetsAt !== "string" || !Number.isFinite(Date.parse(w.resetsAt)))))) throw new Error("Invalid discovered account snapshot");
    seen.add(c.agent);
  }
  return value;
}
export function quotaState(c: Connection, p: Policy, now = Date.now()) {
  if (c.windows.some((w) => w.usedPercent === 100 && (!w.resetsAt || Date.parse(w.resetsAt) > now))) return { state: "exhausted", remainingPercent: 0 };
  const observed = Date.parse(c.observedAt ?? "");
  if (!Number.isFinite(observed) || now - observed > p.quotaMaxAgeSeconds * 1000 || observed > now + 60_000 || c.quotaError || !c.windows.length
    || c.windows.some((w) => w.resetsAt && Date.parse(w.resetsAt) <= now)) return { state: "unknown", remainingPercent: null };
  return { state: "fresh", remainingPercent: Math.min(...c.windows.map((w) => 100 - w.usedPercent)) };
}
export function selectRoute(input: { difficulty: number; connections: Connection[]; policy: Policy; evidence?: RoutingEvidence[];
  agent?: string; model?: string; effort?: string; now?: number }) {
  const policy = validatePolicy(input.policy);
  const connections = validateConnections(input.connections);
  if (!Number.isInteger(input.difficulty) || input.difficulty < 0 || input.difficulty > 3) throw new Error("Invalid task difficulty");
  const candidates = policy.models.flatMap((m) => {
    if ((input.agent && input.agent !== m.agent) || (input.model && input.model !== m.model) || (!input.model && m.capability < input.difficulty)) return [];
    const connection = connections.find((c) => c.agent === m.agent && c.enabled && c.models.includes(m.model));
    if (!connection) return [];
    const quota = quotaState(connection, policy, input.now);
    if (quota.state === "exhausted") return [];
    const wanted = input.effort ?? (m.agent === "cursor" ? ["low", "high", "xhigh", "xhigh"] : ["low", "high", "xhigh", "max"])[input.difficulty];
    if (input.effort && !m.efforts.includes(input.effort)) return [];
    const effort = m.efforts.includes(wanted) ? wanted : m.efforts[m.efforts.length - 1];
    const learning = learnedRouteScore({ ...m, effort, difficulty: input.difficulty, evidence: input.evidence ?? [], policy: policy.learning, now: input.now });
    const baseScore = (quota.remainingPercent === null ? -35 : quota.remainingPercent < policy.reservePercent ? -60 + quota.remainingPercent : quota.remainingPercent / 5)
      - (input.model ? 0 : m.capability - input.difficulty) * 15;
    return [{ agent: m.agent, model: m.model, capability: m.capability, effort, authKind: connection.authKind, ...quota, baseScore, learning, score: baseScore + learning.adjustment }];
  }).sort((a, b) => b.score - a.score || b.capability - a.capability);
  if (!candidates.length) throw new Error("No connected model satisfies the capability, explicit-choice and quota constraints");
  const best = candidates[0];
  return { agent: best.agent, model: best.model, effort: best.effort, fastMode: false as const, candidates };
}
