import { assessDelegation, assessTask, type Assessment } from "./jev.js";
import { selectRoute, type Connection, type Policy } from "./router.js";
import type { RoutingEvidence } from "./learning.js";
import { availabilitySummary, catalogConnections, fetchModelCatalog, policyForCatalog } from "./catalog.js";
import { loadDefaultPolicy } from "./policy.js";

type JevOptions = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number };
export interface PlanInput extends JevOptions {
  task: string;
  delegation?: string;
  agent?: string;
  model?: string;
  effort?: string;
  /** A discovery snapshot. When omitted, configured harnesses and models are read from Conductor at runtime. */
  connections?: Connection[];
  policy?: Policy;
  evidence?: RoutingEvidence[];
  now?: number;
  /** Set false to disable runtime model discovery from Conductor. */
  discover?: boolean;
}
export type Availability = ReturnType<typeof availabilitySummary>;
type Route = ReturnType<typeof selectRoute>;

export function explicitDelegation() {
  return { useConductor: true, source: "explicit" as const, provider: null, reason: "Explicit user request for Conductor." };
}

export function explicitAssessment(): Assessment {
  return { level: 2, label: "explicit", source: "explicit", confidence: null, provider: null, reason: "Explicit model override." };
}

const message = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

/** Connections and policy to route with, or a precise reason there are none.
 * Never returns silently empty. */
export async function routingInputs(input: PlanInput): Promise<{ connections?: Connection[]; policy?: Policy; availability?: Availability; error?: string }> {
  let policy: Policy;
  try { policy = input.policy ?? await loadDefaultPolicy(); }
  catch (error) { return { error: `Routing policy could not be loaded: ${message(error, "unreadable policy")}` }; }
  if (input.connections) return { connections: input.connections, policy };
  if (input.discover === false) return { policy, error: "No connections snapshot was passed and runtime model discovery is disabled." };
  try {
    const catalog = await fetchModelCatalog({ env: input.env, fetch: input.fetch });
    const tuned = policyForCatalog(policy, catalog, { agent: input.agent, model: input.model });
    const availability = availabilitySummary(catalog, tuned);
    const connections = catalogConnections(catalog);
    if (!connections.length) {
      return { policy: tuned, availability, error: "Conductor reports no configured codex, claude or cursor harness. Connect one in the Conductor app, then retry." };
    }
    return { connections, policy: tuned, availability };
  } catch (error) {
    return { policy, error: message(error, "Could not read available models from Conductor") };
  }
}

function route(input: PlanInput, inputs: { connections: Connection[]; policy: Policy }, assessment: Assessment): Route {
  return selectRoute({ policy: inputs.policy, connections: inputs.connections, evidence: input.evidence, difficulty: assessment.level,
    agent: input.agent, model: input.model, effort: input.effort, now: input.now });
}

function tierHint(error: string, assessment: Assessment) {
  return /No connected model satisfies/.test(error)
    ? `${error} (tier ${assessment.label}, level ${assessment.level}). Check that Conductor lists a configured harness whose model the policy ranks at capability ${assessment.level} or higher.`
    : error;
}

export async function planLaunch(input: PlanInput) {
  if (!input.task.trim()) throw new Error("A task is required");
  const delegationMode = input.delegation ?? "auto";
  if (!["auto", "conductor"].includes(delegationMode)) throw new Error("delegation must be auto or conductor");
  const delegation = delegationMode === "conductor" ? explicitDelegation() : await assessDelegation(input.task, input);
  if (!delegation.useConductor) return { create: false as const, delegation, assessment: null, route: null, routeError: null, availability: undefined };
  const assessment = input.model ? explicitAssessment() : await assessTask(input.task, input);
  // A fully explicit harness and model needs no routing unless a snapshot was passed to check it.
  if (input.agent && input.model && !input.connections) {
    return { create: true as const, delegation, assessment, route: null, routeError: null, availability: undefined };
  }
  const inputs = await routingInputs(input);
  if (inputs.error || !inputs.connections || !inputs.policy) {
    const routeError = inputs.error ?? "No routing inputs";
    // An explicit harness can still launch; its choice is not substituted.
    if (input.agent) return { create: true as const, delegation, assessment, route: null, routeError, availability: inputs.availability };
    throw new Error(`No route: ${routeError}. Pass agent and model explicitly to launch anyway.`);
  }
  let selected: Route;
  try { selected = route(input, { connections: inputs.connections, policy: inputs.policy }, assessment); }
  catch (error) { throw new Error(tierHint(message(error, "No route"), assessment)); }
  return { create: true as const, delegation, assessment, route: selected, routeError: null, availability: inputs.availability };
}

export async function previewTask(input: PlanInput) {
  if (!input.task.trim()) throw new Error("A task is required");
  const delegationMode = input.delegation ?? "auto";
  if (!["auto", "conductor"].includes(delegationMode)) throw new Error("delegation must be auto or conductor");
  const delegation = delegationMode === "conductor" ? explicitDelegation() : await assessDelegation(input.task, input);
  const assessment = input.model ? explicitAssessment() : await assessTask(input.task, input);
  // The route is previewed even when the gate says direct, so callers can see
  // what would run. wouldLaunch is the gate decision.
  const inputs = await routingInputs(input);
  let route: Route | null = null;
  let routeError: string | null = inputs.error ?? null;
  if (!routeError && inputs.connections && inputs.policy) {
    try { route = selectRoute({ policy: inputs.policy, connections: inputs.connections, evidence: input.evidence, difficulty: assessment.level,
      agent: input.agent, model: input.model, effort: input.effort, now: input.now }); }
    catch (error) { routeError = tierHint(message(error, "No route"), assessment); }
  }
  if (!route && !routeError) routeError = "No route could be computed and no specific reason was reported.";
  return { launched: false as const, wouldLaunch: delegation.useConductor, delegation, assessment, route, routeError,
    ...(inputs.availability ? { availability: inputs.availability } : {}), fastMode: false as const };
}
