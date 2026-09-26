---
name: conductor-jev-router
description: Decide with Jev whether a coding task needs a Conductor cloud workspace, route a harness and model, and operate that workspace. Use when the user asks for Conductor, a cloud coding agent, or a routed launch of repository work.
license: MIT
compatibility: Node.js 20 or newer, user-supplied API keys, and a Conductor cloud workspace. Does not run local sandboxes.
metadata:
  openclaw:
    emoji: "🛤️"
    homepage: https://github.com/JussCubs/jev-conductor-router
    primaryEnv: CONDUCTOR_API_KEY
    requires:
      bins:
        - node
      env:
        - CONDUCTOR_API_KEY
    envVars:
      - name: CONDUCTOR_API_KEY
        required: true
        description: Bearer token for https://api.conductor.build. The user supplies it.
      - name: ORBIO_API_KEY
        required: false
        description: Orbio Jev key. Tried first when set.
      - name: OPENROUTER_API_KEY
        required: false
        description: OpenRouter Decisions API key.
      - name: TYPESAFE_API_KEY
        required: false
        description: TypeSafe System One key.
      - name: JEV_MODEL
        required: false
        description: Defaults to typesafe/jev-1.13.
---

# Conductor Jev Router

Route repository work to a Conductor cloud workspace. Explanations, summaries, and ordinary lookups stay in the current conversation.

## When to launch

Call `conductor_route` before any launch. Create a workspace only when one of these is true:

- The user explicitly asked for Conductor. Pass `delegation: "conductor"`.
- Jev returns a conductor probability of at least 0.65.

If difficulty classification fails, the router uses the standard tier. It does not escalate to frontier. If the delegation call fails, do not launch.

Pass `delegation: "conductor"` only for an explicit user request. That bypasses the probability gate. It does not bypass model, quota, or repository constraints.

## Tools

Prefer the MCP server (`npx -y github:JussCubs/jev-conductor-router mcp`) when the client can start it. That GitHub spec is the install path before the package is on npm. Otherwise use the CLI.

- `jev_decide` classifies a task and does not launch.
- `conductor_route` previews the gate, tier, harness, model, and effort. It never launches.
- `conductor_create_workspace` applies the gate, then creates a workspace with `fastMode: false`.
- `conductor_start_session`, `conductor_send_message`, `conductor_status`, `conductor_transcript`, and `conductor_list_projects` operate an existing workspace.
- `conductor_cancel` cancels a session. Set `archive: true` only together with `confirmedByUser: true` after the user agrees to archive.
- `conductor_feedback` records a human review of a tracked session. Do not invent that review.

Never put API keys, tokens, or passwords in workspace `env`. Credentials belong on the Conductor cloud machine.

## Setup the user must already have

- `CONDUCTOR_API_KEY` from Conductor.
- At least one Jev key: `ORBIO_API_KEY`, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY`.
- The repository added to the Conductor cloud machine.
- The harness (Claude, Codex, or Cursor) configured on that machine.

This package only talks to Conductor cloud workspaces. It does not start a local sandbox.

## CLI

```sh
npx -y github:JussCubs/jev-conductor-router mcp
npx -y github:JussCubs/jev-conductor-router route --task-file task.txt --snapshot connections.json
npx -y github:JussCubs/jev-conductor-router launch --task-file task.txt --snapshot connections.json --project PROJECT_ID
```

`route` never launches. `launch` does.

## Conductor limits

Workspaces are cloud machines. Discovery of quota is a separate opt-in helper (`CONDUCTOR_DISCOVERY_OPT_IN=1`) and uses undocumented broker routes. Routing and MCP do not require it when the user passes `agent` and `model`, or a connections snapshot.
