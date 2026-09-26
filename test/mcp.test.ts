import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tools = ["jev_decide", "conductor_route", "conductor_create_workspace", "conductor_start_session", "conductor_send_message", "conductor_status", "conductor_transcript", "conductor_list_projects", "conductor_cancel", "conductor_feedback"];

test("mcp stdio server lists its tools", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "mcp"], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
    // Empty strings are already set, so a local .env cannot overwrite them.
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      CONDUCTOR_API_KEY: "", CONDUCTOR_API_TOKEN: "",
      ORBIO_API_KEY: "", OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "",
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map<number, (message: any) => void>();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    }
  });
  const request = (id: number, method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out\n${stderr}`)), 8_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } });
    assert.equal(initialized.result.serverInfo.name, "jev-conductor-router");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await request(2, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name).sort(), [...tools].sort());
    const missing = await request(3, "tools/call", { name: "conductor_list_projects", arguments: {} });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /CONDUCTOR_API_KEY/);
  } finally {
    child.kill();
    child.stdin.end();
  }
});
