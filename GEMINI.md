# Conductor Jev Router

Use the `jev-conductor-router` MCP tools. Call `conductor_route` before `conductor_create_workspace`. Launch only when the user wants a Conductor cloud workspace or Jev reports a conductor probability of at least 0.65. Do not put API keys in workspace `env`. Archiving requires the user to confirm.

The user must set `CONDUCTOR_API_KEY` and at least one of `ORBIO_API_KEY`, `OPENROUTER_API_KEY`, or `TYPESAFE_API_KEY` in the environment Gemini uses to start the server. This extension only operates Conductor cloud workspaces.
