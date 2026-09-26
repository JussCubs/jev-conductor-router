# Install Conductor Jev Router for Cline

Follow this file exactly. Do not publish, deploy, or invent API keys.

## Requirements

- Node.js 22 or newer
- A Conductor API key from the user's Conductor account
- At least one Jev key: Orbio, OpenRouter, or TypeSafe
- The repository already added to the user's Conductor cloud machine
- Claude, Codex, or Cursor harnesses configured on that machine

This server only controls Conductor cloud workspaces. It does not start a local sandbox.

## Stdio config

Add this block to Cline's MCP settings (`cline_mcp_settings.json`). The `mcpServers` object is the root of that file. Put the user's keys in `env`. Do not commit those keys.

```json
{
  "mcpServers": {
    "jev-conductor-router": {
      "command": "npx",
      "args": ["-y", "jev-conductor-router", "mcp"],
      "env": {
        "CONDUCTOR_API_KEY": "PASTE_USER_CONDUCTOR_KEY",
        "ORBIO_API_KEY": "PASTE_USER_ORBIO_KEY_OR_OMIT",
        "OPENROUTER_API_KEY": "PASTE_USER_OPENROUTER_KEY_OR_OMIT",
        "TYPESAFE_API_KEY": "PASTE_USER_TYPESAFE_KEY_OR_OMIT",
        "JEV_MODEL": "typesafe/jev-1.13"
      }
    }
  }
}
```

Omit any Jev key the user does not have. The provider chain is Orbio, then OpenRouter, then TypeSafe, using only the keys that are set.

Restart Cline after saving the file.

## Check

Ask Cline to list MCP tools. These names must appear:

- `jev_decide`
- `conductor_route`
- `conductor_create_workspace`
- `conductor_start_session`
- `conductor_send_message`
- `conductor_status`
- `conductor_transcript`
- `conductor_list_projects`
- `conductor_cancel`
- `conductor_feedback`

`conductor_route` only previews. `conductor_create_workspace` launches a real cloud workspace after the Jev gate. Do not put secrets in workspace `env`. Archiving requires `confirmedByUser: true`.

If the server starts but no tools appear, the `mcpServers` block is nested too deeply or Cline was not restarted.
