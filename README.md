# Conductor Jev Router

[![npm](https://img.shields.io/npm/v/jev-conductor-router)](https://www.npmjs.com/package/jev-conductor-router)

Decide with [Jev](https://docs.typesafe.ai/api) whether a coding task needs a [Conductor](https://conductor.build) cloud workspace, how hard it is, and which harness and model should run it. Then call Conductor's public API.

The same package is a stdio MCP server and a small CLI. Any agent client that can start a local process can install it. You bring your own keys. Nothing in this repository calls home, and no key is bundled.

```sh
npx -y jev-conductor-router mcp
```

Node.js 20 or newer. MIT licensed. To run the git tree instead of the published package, use `npx -y github:JussCubs/jev-conductor-router mcp`. That git install runs `prepare`, which compiles `dist/` so the `jev-conductor-router` bin exists.

## 60-second quickstart

Set `CONDUCTOR_API_KEY` and at least one Jev key (`ORBIO_API_KEY`, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY`) in the environment that starts the process. The default provider chain is Orbio, then OpenRouter, then TypeSafe, using only the keys that are set.

### Generic MCP JSON

```sh
npx -y jev-conductor-router mcp
```

```json
{
  "mcpServers": {
    "jev-conductor-router": {
      "command": "npx",
      "args": ["-y", "jev-conductor-router", "mcp"],
      "env": {
        "CONDUCTOR_API_KEY": "paste-your-key",
        "ORBIO_API_KEY": "paste-your-key"
      }
    }
  }
}
```

Omit any Jev key you do not have. Restart the client after saving.

### Grok Bot

```sh
npx -y jev-conductor-router mcp
```

This repo is a Grok plugin. `.grok-plugin/plugin.json` points at the skill and `.mcp.json`, and that MCP file uses the npm package command above. Grok also reads the Claude Code layout.

```sh
grok --plugin-dir /path/to/jev-conductor-router
```

Or add the directory under `[plugins] paths` in `~/.grok/config.toml`, then enable it from `/plugins`. Put the API keys in the environment Grok uses to start MCP servers.

### Claude Code

```sh
npx -y jev-conductor-router mcp
```

The repo is its own marketplace. Root `.mcp.json` starts the server with that npm package.

```sh
claude plugin marketplace add /path/to/jev-conductor-router
claude plugin install jev-conductor-router@jev-conductor-router
```

Claude also reads `skills/conductor-jev-router/SKILL.md`.

### Cursor

```sh
npx -y jev-conductor-router mcp
```

Add the generic MCP block in Cursor Settings → MCP, or open this repo as a plugin (`.cursor-plugin/plugin.json` points at `.mcp.json` and the skill).

### Codex

```sh
npx -y jev-conductor-router mcp
```

Open the repo in Codex. The marketplace catalog is `.agents/plugins/marketplace.json` and the portable manifest is root `plugin.json` (`extensions.com.openai` plus `mcp.json`). Both MCP configs use the npm package. Restart the ChatGPT desktop app, then install **Conductor Jev Router** from that local marketplace. From the CLI:

```sh
codex plugin marketplace add /path/to/jev-conductor-router
```

Install the plugin from the Plugins Directory. The public Codex directory expects a remote HTTPS MCP server; this package is local stdio. See [docs/publishing.md](docs/publishing.md).

### OpenClaw

```sh
npx -y jev-conductor-router mcp
```

The skill at `skills/conductor-jev-router/SKILL.md` includes `metadata.openclaw`. Point OpenClaw at that directory, or publish it later with ClawHub (commands are in the publishing doc; this repo does not publish).

### Muse Code

```sh
npx -y jev-conductor-router mcp
```

Muse reads `.agents/skills/conductor-jev-router` (a link to the same skill). Trust the workspace, then ask Muse to route a task. Muse uses the skill instructions. It does not start the MCP server by itself; add the generic MCP block if your Muse build accepts MCP config.

### Gemini CLI

```sh
npx -y jev-conductor-router mcp
```

`gemini-extension.json` is at the repo root and starts the server with that npm package.

```sh
gemini extensions install /path/to/jev-conductor-router --consent
```

Restart Gemini CLI. `GEMINI.md` tells the model to preview a route before creating a workspace.

### Cline

```sh
npx -y jev-conductor-router mcp
```

Follow [llms-install.md](llms-install.md) and paste the `mcpServers` block into `cline_mcp_settings.json`.

### CLI

```sh
npx -y jev-conductor-router mcp
```

From a clone, `npm ci` runs `prepare` and writes `dist/`:

```sh
git clone https://github.com/JussCubs/jev-conductor-router.git
cd jev-conductor-router
npm ci
cp .env.example .env
printf 'Fix the misspelled heading on the homepage. Run its existing checks.\n' > task.txt
node dist/cli.js route --task-file task.txt --snapshot connections.json
node dist/cli.js launch --task-file task.txt --snapshot connections.json --project YOUR_PROJECT_ID
```

`route` prints the decision. `launch` creates a real cloud workspace. `mcp` starts the stdio server and does not read the snapshot. The snapshot is optional: without `connections.json`, the CLI and the MCP server read configured harnesses and accepted models from Conductor at runtime.

## Environment

| Variable | Required | Role |
| --- | --- | --- |
| `CONDUCTOR_API_KEY` | For every Conductor call | Bearer token for `https://api.conductor.build`. `CONDUCTOR_API_TOKEN` is accepted as an alias. |
| `ORBIO_API_KEY` | One Jev key | Orbio decisions. First in the default chain when set. |
| `ORBIO_BASE_URL` | No | Orbio origin. Defaults to `https://api.orbio.so`. `http` and `https` only. |
| `OPENROUTER_API_KEY` | One Jev key | OpenRouter Decisions API. |
| `TYPESAFE_API_KEY` | One Jev key | TypeSafe System One. |
| `JEV_PROVIDER` | No | `orbio`, `openrouter`, or `typesafe`. When unset, the chain is every configured key in that order. |
| `JEV_FALLBACK_PROVIDER` | No | One fallback provider. When unset, the remaining configured providers stay in the default order. |
| `JEV_MODEL` | No | Defaults to `typesafe/jev-1.13`. |
| `OPENROUTER_JEV_MODEL` | No | Optional model override for OpenRouter only. |
| `TYPESAFE_JEV_MODEL` | No | Optional model override for TypeSafe only. |
| `CONDUCTOR_DISCOVERY_OPT_IN` | No | Set to `1` to run the opt-in quota helper. Routing and MCP do not need it. |

The CLI loads a local `.env` when one exists. MCP hosts should pass keys in their own server `env` block. Leave `JEV_PROVIDER` unset to use the default chain.

Fallback happens only after a network error, a timeout, or HTTP 402, 408, 429, or 5xx. HTTP 400, 401, and 403 stop the chain and name the provider that rejected the key or the request.

TypeSafe's native API receives `jev-1.13.0` when `JEV_MODEL` is the default `typesafe/jev-1.13`. Orbio and OpenRouter receive the prefixed id.

## Tools

| Tool | What it does |
| --- | --- |
| `jev_decide` | Ask Jev a choice, score, or noul question. Defaults to the delegation and difficulty questions. |
| `conductor_route` | Preview the gate, tier, harness, model, and effort from Conductor's live model catalog. Returns `routeError` when no route exists. |
| `conductor_create_workspace` | Run the Jev gate, then create a workspace when the gate passes. Sends `fastMode: false`. |
| `conductor_start_session` | Start a session in an existing workspace. |
| `conductor_send_message` | Send a follow-up to an existing session. |
| `conductor_status` | Read session and workspace status. Status is operational, not a quality review. |
| `conductor_transcript` | Read `session_transcripts_view` through Conductor's read-only SQL API. With a `sessionId`, falls back to the public `GET /v0/sessions/{id}/messages` endpoint when SQL is unavailable and returns condensed prompts, replies, commands, and `finalAnswer` (`raw: true` returns every message). |
| `conductor_list_projects` | List projects visible to the API key. |
| `conductor_cancel` | Cancel a session. Archive only when `confirmedByUser` is `true`. |
| `conductor_feedback` | Store an explicit human review of a tracked session. |

`conductor_create_workspace` launches when the conductor probability is at least 0.65, or when `delegation` is `conductor` because the user asked for Conductor. A failed difficulty call uses the standard tier. A failed delegation call in `auto` mode does not launch. Pass `projectId` or `repositoryUrl`, not both.

Keep API keys, tokens, passwords, and cookies out of workspace `env`. The client rejects secret-looking names and values that match a secret already in the process environment.

Conductor 429 responses honor `Retry-After` (capped at 20 seconds) and retry up to two extra times. GET requests also retry 5xx and network drops. A workspace or session create that fails before a response is not retried.

## Conductor setup

1. Create an API key in Conductor and set `CONDUCTOR_API_KEY`.
2. Add the repository to the Conductor cloud machine. This package does not change machine permissions.
3. Configure the harness you want to run: Claude, Codex, or Cursor. ACP is accepted by the session API when you pass it explicitly.
4. Routing works without a snapshot: configured harnesses, models, and efforts are read from Conductor at runtime. For quota-aware routing, produce a `connections.json` snapshot. Pass `--agent` and `--model` when you want a fixed choice.

The public routes used here are `POST /v0/workspaces`, `POST /v0/sessions`, `POST /v0/sessions/{id}/messages`, session and workspace status, cancel, archive, `GET /v0/projects`, `POST /v0/sql`, and `GET /me`. The contract is the live OpenAPI document at `https://api.conductor.build/v0/openapi.json`.

## Limits

Workspaces are Conductor cloud machines. This package does not start a local sandbox, a laptop agent, or a second checkout on your machine.

The first 20,000 characters of a task are sent to the Jev provider you configured. Review the brief before it includes private code.

Discovery (`npm run discover`) is separate from routing. It runs only when `CONDUCTOR_DISCOVERY_OPT_IN=1` and only inside a Conductor cloud workspace. It calls undocumented broker routes, and the Cursor path can send a session cookie to `cursor.com`. The snapshot stores identity hashes, model ids, and quota windows. It does not store provider keys or transcripts. Refresh it often: stale quota becomes unknown, which is a penalty, not a full allowance.

## How a route is chosen

Availability is read from Conductor at runtime, not from this repository. Without a snapshot, the router calls the `list_models` tool on Conductor's hosted MCP server (`https://api.conductor.build/mcp`) with your `CONDUCTOR_API_KEY`. That returns each agent's accepted models and efforts and whether its credentials are connected (`configured`). Only configured `claude`, `codex`, and `cursor` harnesses are routed, only models Conductor currently lists are eligible, and each model's efforts are narrowed to what Conductor accepts. The catalog is cached for five minutes. If `list_models` is unavailable, the public OpenAPI document supplies the model list with a warning that connection status is unknown. Conductor does not expose quota, so catalog routes rank every harness with the same unknown-quota score.

`conductor_route` always returns either a `route` (agent, model, effort) or a `routeError` that says why none exists, plus an `availability` summary of what Conductor reported. The route is previewed even when the gate says direct; `wouldLaunch` is the gate decision. `conductor_create_workspace` reads the catalog only after the gate passes.

1. Jev classifies difficulty. An invalid or unavailable decision uses a disclosed standard fallback. Frontier requires at least 65% probability. The probability mass decides the tier: 54% routine plus 45% standard stays standard.
2. Filter by the discovered harnesses, model allowlists, explicit choices, capability floor, and known exhaustion. An explicit model is a constraint. It does not override a known exhausted allowance or a disabled connection.
3. Rank eligible models by quota headroom and capability fit. Unknown quota and near-exhausted subscriptions are penalized. Every launch sends `fastMode: false`.
4. Apply a bounded per-account adjustment for the same model, harness, effort, and difficulty. The explanation shows both scores.

Unknown quota scores −35. Quota below the reserve threshold scores `−60 + remainingPercent`. Otherwise the score is `remainingPercent / 5`. Extra capability costs 15 points per tier. The router does not drop below the task floor to spend spare quota.

`composer-2.5` and Cursor `auto` have no effort parameter. Set `efforts: []` in the policy. The wire payload omits `effort`. Other launches still send `fastMode: false`.

Review `examples/policy.json` against `conductor model --json`. Tiers are editorial policy (0 routine, 1 standard, 2 complex, 3 frontier), not benchmark scores. Models missing from the snapshot or from Conductor's live catalog cannot be selected. Catalog models the policy has not ranked are listed as `unrankedModels`; an explicit `model` that Conductor accepts still routes.

## Learning

`launch` writes `.jev-router-state.json` with mode `0600`. The account key is a SHA-256 of `organizationId:userId`.

```sh
node dist/cli.js status --session SESSION_ID
node dist/cli.js feedback --session SESSION_ID --success true
```

Record feedback from a human review of the task. A working-to-idle transition measures operational reliability only. Idle before working, cancellation, and an agent's own completion claim are not task success.

Learning uses a Beta(4,1) prior, at least five effective samples, a 30-day half-life, and a maximum 12-point adjustment. Quality and reliability have separate posteriors. At most 2,000 runs are kept. Set `learning.enabled` to `false` in the policy to stop adjustments. The state file stays on the machine that wrote it.

## Library

```ts
import { assessDelegation, assessTask } from "jev-conductor-router/jev";
import { selectRoute } from "jev-conductor-router";

const delegation = await assessDelegation(task);
if (delegation.useConductor) {
  const assessment = await assessTask(task);
  const route = selectRoute({ difficulty: assessment.level, policy, connections, evidence });
  // route.fastMode === false
}
```

```sh
npm test
npm run lint
npm run build
npm run evaluate -- --dataset examples/evaluation.json
```

The evaluator checks routing fixtures. It is a regression tool for this policy, not a Jev accuracy benchmark.

## Packaging

Marketplace manifests, the MCP registry `server.json`, and the exact commands a maintainer runs to publish are in [docs/publishing.md](docs/publishing.md). This repository does not publish itself.
