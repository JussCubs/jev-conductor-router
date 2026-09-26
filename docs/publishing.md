# Publishing

These steps are for a human maintainer. This repository does not publish to npm, the MCP registry, ClawHub, Smithery, or any plugin marketplace, and it does not create releases or tags.

Every manifest in the repo is version `0.2.0` and must stay aligned with `package.json`. Bump them together.

Users supply `CONDUCTOR_API_KEY` and their Jev keys at install time. Do not put key values in a manifest, a marketplace PR, or a release.

## npm

The package name is the unscoped `jev-conductor-router`, so `npx -y jev-conductor-router mcp` resolves. `prepublishOnly` runs `npm run build`. The tarball contains `dist`, `src/discover.mjs`, `README.md`, `LICENSE`, and `examples`.

```sh
npm run lint
npm test
npm run build
npm login
npm publish --access public
```

Confirm `https://www.npmjs.com/package/jev-conductor-router` shows `0.2.0` before any registry that checks npm ownership.

## Official MCP Registry

`server.json` name `io.github.jusscubs/jev-conductor-router` matches `package.json` `mcpName`. The npm package version matches `server.json` `version`. Secret env vars set `isSecret: true`. `packageArguments` passes `mcp` so a registry client starts the stdio server.

Install the publisher from [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md), then:

```sh
mcp-publisher login github
mcp-publisher validate
mcp-publisher publish
```

`login github` must be an account that can publish under `io.github.jusscubs`. Publish npm first. The registry checks that the npm package exists and that `mcpName` matches. Schema: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.

## Agent Plugins 1.0

Root `plugin.json` and `mcp.json` use:

- `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
- `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`

There is no separate Agent Plugins directory to submit. Clients that implement the spec read these files from the repo or from an installed copy. OpenAI-specific presentation lives under `extensions.com.openai` and is ignored by other clients.

## Claude Code

Manifests:

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json` (this repo is the marketplace; the plugin `source` is `./`)
- root `.mcp.json`

Validate from the repo root:

```sh
claude plugin validate .
```

Add it locally:

```sh
claude plugin marketplace add /path/to/jev-conductor-router
claude plugin install jev-conductor-router@jev-conductor-router
```

The official community catalog is a human submission. Follow the current form at <https://code.claude.com/docs/en/plugins> and <https://code.claude.com/docs/en/plugin-marketplaces>. The marketplace `name` is `jev-conductor-router`. Keep the default branch `master` available before telling anyone to add the GitHub repo, because Claude clones the default branch.

## Cursor

`.cursor-plugin/plugin.json` matches the schema in [cursor/plugins](https://github.com/cursor/plugins/blob/main/schemas/plugin.schema.json) (`name` required, `additionalProperties: false`). `skills` is `skills/conductor-jev-router`. `mcpServers` is `.mcp.json`. `author` is `{ "name" }` only, because the schema rejects an `email` that is missing and rejects extra author fields.

Local check, using the template validator's rules: the name is kebab-case, the skill directory contains `SKILL.md`, and the MCP file exists.

Submission, from the [cursor/plugin-template](https://github.com/cursor/plugin-template) checklist: send the repository link to the Cursor team on Slack or by email to `kniparko@anysphere.com`. There is no public POST endpoint in that template.

## Grok Bot / xAI

Plugin metadata is `.grok-plugin/plugin.json` (`name`, `version`, `description`, `author`, `logo`, `skills`, `mcpServers`). Grok also discovers `skills/` and root `.mcp.json` without that file. Docs: <https://docs.x.ai/build/features/skills-plugins-marketplaces>.

Do not submit from this repo. A maintainer forks [xai-org/plugin-marketplace](https://github.com/xai-org/plugin-marketplace) and adds this entry to `.grok-plugin/marketplace.json`. Replace the SHA with the full 40-character commit you intend to ship (`git rev-parse HEAD` on that commit):

```json
{
  "name": "jev-conductor-router",
  "description": "Decide with Jev whether a coding task needs a Conductor cloud workspace, then route and operate it.",
  "category": "development",
  "source": {
    "source": "url",
    "url": "https://github.com/JussCubs/jev-conductor-router.git",
    "sha": "REPLACE_WITH_FULL_COMMIT_SHA"
  },
  "homepage": "https://github.com/JussCubs/jev-conductor-router",
  "keywords": ["conductor", "jev", "routing", "mcp"],
  "domains": ["conductor.build", "api.conductor.build"]
}
```

Then, in the fork:

```sh
python3 scripts/generate-plugin-index.py
python3 scripts/validate-catalog.py
```

Open a pull request. CI runs `python3 scripts/generate-plugin-index.py --check`. Remote entries must pin a full lowercase SHA. Grok verifies `git rev-parse HEAD` after clone.

Local install without the catalog:

```sh
grok --plugin-dir /path/to/jev-conductor-router
```

## Codex / OpenAI

Two manifests are kept in sync:

- Root `plugin.json` `extensions.com.openai` is what current Codex reads. When that object is present it replaces `.codex-plugin/plugin.json` rather than merging with it.
- `.codex-plugin/plugin.json` remains for clients that only read the compatibility path.

Skills are under `skills/`. MCP is root `mcp.json` (Agent Plugins) and `.mcp.json` (compatibility). The repo marketplace is `.agents/plugins/marketplace.json`. Current Codex treats `source.path` `./` as this repo root.

```sh
codex plugin marketplace add /path/to/jev-conductor-router
```

Restart the ChatGPT desktop app, choose this marketplace, and install the plugin. Docs: <https://developers.openai.com/plugins/build/plugins>.

The public Codex plugin directory documents remote HTTPS MCP servers and a registered `plugin_asdk_app…` id in `.app.json`. This package is local stdio and does not ship `.app.json`. Listing it in that public directory needs the process on that docs page (developer mode, then a remote MCP URL). Do not invent a submission URL.

## Agent skill, OpenClaw, Muse Code

One skill, two paths:

- `skills/conductor-jev-router/SKILL.md` for Claude, Codex, Cursor, Grok, and Gemini
- `.agents/skills/conductor-jev-router` → `../../skills/conductor-jev-router` for Muse Code

Frontmatter `name` is `conductor-jev-router` and matches the directory. `metadata.openclaw` declares the Conductor key and the optional Jev keys for ClawHub.

ClawHub, when a maintainer is ready:

```sh
npm i -g clawhub
clawhub login
clawhub skill publish ./skills/conductor-jev-router --slug conductor-jev-router --name "Conductor Jev Router" --dry-run
clawhub skill publish ./skills/conductor-jev-router --slug conductor-jev-router --name "Conductor Jev Router"
```

ClawHub publishes the skill under the MIT-0 terms described at <https://docs.openclaw.ai/clawhub/cli>. Read those terms before publishing. The skill text in git stays MIT, matching `LICENSE`.

Muse Code reads `.agents/skills/<name>/SKILL.md` after the workspace is trusted. If the Muse CLI is installed:

```sh
muse skills validate .agents/skills/conductor-jev-router
```

No Muse marketplace submission command was published in the docs checked for this release.

## Smithery

`smithery.yaml` is the historical local stdio config: `startCommand.type` is `stdio`, `configSchema` collects the user's keys, and `commandFunction` returns `node dist/cli.js mcp` with only the keys the user set.

Current Smithery publish is a public URL or an MCPB bundle, not an automatic read of `smithery.yaml`. Docs: <https://smithery.ai/docs/build/publish>.

```sh
smithery mcp publish "https://your-public-mcp-url" -n your-org/jev-conductor-router
# or, after you build an MCPB bundle yourself:
smithery mcp publish ./server.mcpb -n your-org/jev-conductor-router
```

This repo does not build or upload an MCPB. A URL publish would be a hosted server. Hosting one means holding user Conductor keys on that host, which this package is not set up to do.

## Gemini CLI

`gemini-extension.json` and `GEMINI.md` are at the repo root, which is what `gemini extensions install` requires.

```sh
gemini extensions install https://github.com/JussCubs/jev-conductor-router --ref master --consent
```

Reference: <https://geminicli.com/docs/extensions/reference/>. The gallery listing steps are in the Gemini extension releasing guide linked from <https://geminicli.com/docs/extensions/writing-extensions/>.

## Cline

[llms-install.md](../llms-install.md) is the install card. The Cline marketplace is a human pull request to [cline/mcp-marketplace](https://github.com/cline/mcp-marketplace) that includes this install card. Open that PR from a fork. Do not send API keys in the PR body.
