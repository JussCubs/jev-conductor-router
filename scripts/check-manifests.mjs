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
const npmArgs = JSON.stringify(["-y", "jev-conductor-router", "mcp"]);
if (JSON.stringify(mcp.mcpServers["jev-conductor-router"]?.args) !== npmArgs) fail("mcp.json args");
if (JSON.stringify(json(".mcp.json").mcpServers["jev-conductor-router"]?.args) !== npmArgs) fail(".mcp.json args");
if (JSON.stringify(json("gemini-extension.json").mcpServers["jev-conductor-router"]?.args) !== npmArgs) fail("gemini-extension.json args");
if (server.name !== pkg.mcpName || server.version !== pkg.version) fail("server.json identity");
if (server.packages[0].version !== pkg.version || server.packages[0].identifier !== pkg.name) fail("server.json package");
if (!server.packages[0].environmentVariables.some((item) => item.name === "CONDUCTOR_API_KEY" && item.isSecret === true)) fail("server.json secret");
if (!skill.startsWith("---\nname: conductor-jev-router\n")) fail("skill frontmatter");
if (!skill.includes("metadata:\n  openclaw:")) fail("openclaw metadata");
for (const path of ["assets/logo.svg", "assets/logo.png", "assets/logo-400.png", ".mcp.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".cursor-plugin/plugin.json", ".grok-plugin/plugin.json", ".codex-plugin/plugin.json", ".agents/plugins/marketplace.json", "gemini-extension.json", "smithery.yaml", "llms-install.md", "docs/publishing.md", "README.md"]) {
  if (!existsSync(join(root, path))) fail(`missing ${path}`);
}
const versions = [plugin, json(".claude-plugin/plugin.json"), json(".cursor-plugin/plugin.json"), json(".grok-plugin/plugin.json"), json(".codex-plugin/plugin.json"), json("gemini-extension.json"), json(".claude-plugin/marketplace.json").plugins[0]];
if (versions.some((manifest) => manifest.version !== pkg.version)) fail("manifest versions diverge");
if (!read("src/version.ts").includes(`export const VERSION = "${pkg.version}"`)) fail("src/version.ts");
const grokKeywords = json(".grok-plugin/plugin.json").keywords ?? [];
if (["routing", "mcp"].some((word) => grokKeywords.includes(word)) || ["conductor", "jev", "typesafe", "orbio"].some((word) => !grokKeywords.includes(word))) fail("grok keywords");
const publishing = read("docs/publishing.md");
if (!publishing.includes("https://cursor.directory/plugins/new") || !publishing.includes("https://cursor.com/marketplace/publish") || publishing.includes("kniparko@anysphere.com")) fail("cursor publish routes");
if (!publishing.includes("https://github.com/xai-org/plugin-marketplace/pull/946") || !publishing.includes('"keywords": ["conductor", "jev", "typesafe", "orbio"]')) fail("xai marketplace entry");
if (!publishing.includes("io.github.jusscubs/jev-conductor-router") || !publishing.includes("ClawHub slug: `conductor-jev-router`")) fail("registry notes");
const readme = read("README.md");
if (!readme.includes("npx -y jev-conductor-router mcp") || !readme.includes("npx -y github:JussCubs/jev-conductor-router mcp") || !readme.includes("img.shields.io/npm/v/jev-conductor-router")) fail("README install");
const installCard = read("llms-install.md");
if (!installCard.includes("npx -y jev-conductor-router mcp") || installCard.includes("github:JussCubs/jev-conductor-router")) fail("llms-install");
const privateText = read("README.md") + read("docs/publishing.md") + skill;
if (/railway\.app|robertoagent/i.test(privateText)) fail("private infrastructure reference");
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("manifest checks passed");
