# Jev Conductor Router

Route a coding task to a Conductor harness, model and reasoning effort using
Jev task assessment, discovered account quota and bounded outcome learning.
Every launch explicitly sends `fastMode: false`.

This is a standalone routing package: no application backend, database service,
private product code, telemetry collector, or hosted routing dependency. Node 22+
is required. Runtime dependencies: none. MIT licensed.

## Quick start

```sh
git clone https://github.com/JussCubs/jev-conductor-router.git
cd jev-conductor-router
npm ci
npm run build
cp .env.example .env
```

Choose `JEV_PROVIDER=openrouter` or `JEV_PROVIDER=typesafe` in `.env` and set the
corresponding API key. The CLI loads `.env` locally. Optional
`JEV_FALLBACK_PROVIDER` selects the other provider for network/server/rate-limit
failures. Authentication/request errors do not spend another provider's key.
No key is bundled. Calls use the providers' typed **Decisions/System One APIs**,
not chat completions. Requests send the first 20,000 characters of your task to
your selected Jev provider. Review your brief before sending private code.

Inside a **Conductor cloud workspace**, discover the effective cloud accounts:

```sh
node src/discover.mjs > connections.json
```

Run discovery in the account/organization that will execute the task. You can
copy the resulting snapshot to the machine that runs the router. It contains
identity hashes, model IDs and quota windows; it does not contain provider keys,
tokens, emails, source code or transcripts. It is gitignored. Refresh discovery
regularly: stale quota becomes **unknown**, never an invented full allowance.

Review `examples/policy.json` against `conductor model --json`. Capability tiers
are editable editorial policy (0 routine, 1 standard, 2 complex, 3 frontier),
not benchmark scores. Catalog order breaks ties. Models absent from the cloud
snapshot cannot be selected. Model availability changes; update your policy.

```sh
printf 'Fix the misspelled heading on the homepage. Run its existing checks.\n' > task.txt
npm run route -- --task-file task.txt
# Inspect the explanation first. This next command launches real coding work:
node dist/cli.js launch --task-file task.txt --project YOUR_CONDUCTOR_PROJECT_ID
```

Set `CONDUCTOR_API_KEY` for launch/status/feedback. Launch verifies that `/me`
matches the snapshot's owner and organization. It does not retry a creation
request after a dropped response. The repository must already be available on
your Conductor cloud machine. This package does not change machine permissions.

Overrides `--agent`, `--model`, `--effort`, `--policy`, `--snapshot` and `--state`
are supported. Explicit choices are constraints; they are not silently changed.
An explicit model overrides the classifier's capability floor, but never a
known exhausted allowance or a disabled connection. ACP/standalone Grok Build
is not automatically supported; Grok models exposed by Cursor are eligible.

## Account discovery

The helper reads the effective cloud harness configuration and CLI catalog:

- Codex: the same Conductor credential broker used to launch Codex; quota is
  matched to its ChatGPT account/workspace ID.
- Cursor: the actual cloud API key's `/v0/me` identity. CLI subscription quota
  is used only after the CLI login email matches that API-key identity.
- Claude: the effective token/key. Inference-only tokens may not permit account
  profile/usage requests; the connection remains usable with unknown quota.

Provider credentials stay in the workspace. Unrelated local or BYOK credentials
do not establish Conductor access. BYOK is not assumed to mean unlimited credit.
No credit purchases, quota resets, paid-overage activation or credential changes
are performed. Providers and Conductor's experimental/internal auth interfaces
can change; a failed probe is not proof of a disconnected account. Outside a
cloud workspace, supply a snapshot through your own trusted integration instead
of guessing account identity.

## How selection works

1. Jev classifies task difficulty. Invalid, uncertain or unavailable decisions
   conservatively require frontier capability. Missing configuration is an error.
2. Filter by discovered/enabled harnesses, model allowlists, explicit choices,
   capability and known exhaustion. The tightest quota window controls headroom.
3. Rank eligible models by quota headroom and capability fit. Unknown quota and
   near-exhausted subscriptions receive penalties. Always use slow mode.
4. Apply a bounded, per-account learned adjustment for the same model, harness,
   reasoning effort and task difficulty. The explanation shows both scores.

The base policy gives unknown quota −35 points; quota below the reserve threshold
gets `−60 + remainingPercent`, otherwise `remainingPercent / 5`. Excess capability
costs 15 points per tier. These are understandable routing weights, not a claim
of universal optimality. The algorithm never downgrades below the task's floor
just to consume spare quota.

## Learning without fabricated success

Launch saves an auditable decision in `.jev-router-state.json` (mode 0600).
Use status observations while a task is running and after it finishes:

```sh
node dist/cli.js status --session SESSION_ID
# After a human review against the actual task requirements:
node dist/cli.js feedback --session SESSION_ID --success true
```

The CLI is not a daemon. Automate `status` in your existing supervisor if desired;
respect Conductor's rate limits. A working-to-idle transition measures operational
reliability only. Idle before working, cancellation, and an agent's own completion
claim are not task success. `feedback` records your review. Do not have an LLM
invent human feedback. Repeated observations do not add samples; correcting a
review changes one label without resetting its age. Only the first tracked turn
is scored; use a fresh routed session for a new independently evaluated task.

Learning uses a Beta(4,1) prior, at least five effective samples, a 30-day
half-life and a maximum 12-point adjustment. Quality and reliability have separate
posteriors. Stale evidence fades so a provider can recover. At most 2,000 runs are
kept locally. State writes are locked and atomic; back up this file as needed.
Set `learning.enabled=false` in the policy to disable adjustments immediately.
No random experiment weakens a task's capability requirement. The learner does
not rewrite code or prompts, share observations with other accounts, or assert
quality improvements before reviewed outcomes exist.

Selection bias remains: observed success on chosen models cannot prove an
unchosen model would have been better. A bounded adaptive policy is useful,
but no finite dataset establishes the best router for every possible task.

## Library and evaluation

```ts
import { assessTask, selectRoute } from 'jev-conductor-router';
const assessment = await assessTask(task);
const route = selectRoute({
  difficulty: assessment.level, policy, connections, evidence,
});
// route.agent / route.model / route.effort / route.fastMode === false
```

```sh
npm test
npm run build
npm run evaluate -- --dataset examples/evaluation.json
```

The fixture evaluator compares baseline and learned selections against expected
routes. It is a routing regression tool, **not** a measured quality uplift or a
Jev accuracy benchmark. Maintain a held-out set of your own tasks and explicit
human reviews before changing tiers or weights. Provider tests use recorded
contract-shaped fixtures; live calls require your own key and incur normal usage.

## References

- [Conductor API](https://api.conductor.build/v0/openapi.json) and installed `conductor model --json`.
- [TypeSafe API](https://docs.typesafe.ai/api): `https://api.typesafe.ai/v1/systemone`.
- [OpenRouter Decisions API](https://openrouter.ai/api/alpha/decisions).
- [CodexBar provider documentation](https://github.com/steipete/CodexBar/tree/main/docs)
  informed the independent quota adapters. No CodexBar Swift source is included.

The scoring and learning policy is extracted from a production Conductor
integration. This repository contains only standalone routing, discovery,
provider adapters, local outcome storage and evaluation fixtures. Public provider
contracts and the example catalog were checked on 2026-09-25.
