import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const errors = [];
const fail = (message) => errors.push(message);
const pkg = json("package.json");
const plugin = json("plugin.json");
const mcp = json("mcp.json");
const server = json("server.json");
const skill = read("skills/conductor-jev-router/SKILL.md");

if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") fail("plugin.json schema");
if (plugin.name !== "jev-conductor-router" || plugin.version !== pkg.version) fail("plugin.json identity");
if (mcp.$schema !== "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json") fail("mcp.json schema");
if (mcp.mcpServers["jev-conductor-router"]?.command !== "npx") fail("mcp.json command");
if (server.name !== pkg.mcpName || server.version !== pkg.version) fail("server.json identity");
if (server.packages[0].version !== pkg.version || server.packages[0].identifier !== pkg.name) fail("server.json package");
if (!server.packages[0].environmentVariables.some((item) => item.name === "CONDUCTOR_API_KEY" && item.isSecret === true)) fail("server.json secret");
if (!skill.startsWith("---\nname: conductor-jev-router\n")) fail("skill frontmatter");
if (!skill.includes("metadata:\n  openclaw:")) fail("openclaw metadata");
for (const path of ["assets/logo.svg", "assets/logo.png", ".mcp.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json", ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", "gemini-extension.json", "smithery.yaml", "llms-install.md", "docs/publishing.md", "README.md"]) {
  if (!existsSync(join(root, path))) fail(`missing ${path}`);
}
const versions = [plugin, json(".claude-plugin/plugin.json"), json(".cursor-plugin/plugin.json"), json(".grok-plugin/plugin.json"), json(".codex-plugin/plugin.json"), json("gemini-extension.json")];
if (versions.some((manifest) => manifest.version !== pkg.version)) fail("manifest versions diverge");
const privateText = read("README.md") + read("docs/publishing.md") + skill;
if (/railway\.app|robertoagent/i.test(privateText)) fail("private infrastructure reference");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("manifest checks passed");
