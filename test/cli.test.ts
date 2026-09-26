import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

const run = (args: string[], cwd: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      CONDUCTOR_API_KEY: "", CONDUCTOR_API_TOKEN: "",
      ORBIO_API_KEY: "", OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out\n${stdout}\n${stderr}`)); }, 15_000);
  child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

test("help flags print usage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-cli-"));
  try {
    for (const flag of ["--help", "-h"]) {
      const result = await run([flag], cwd);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Commands:\n {2}mcp\b/);
      assert.match(result.stdout, /--policy/);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("no command reads the package policy instead of a cwd-relative examples/policy.json", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-cli-"));
  try {
    const result = await run([], cwd);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Commands: mcp, route, launch, status, feedback, evaluate/);
    assert.doesNotMatch(result.stderr, /ENOENT|examples\/policy\.json/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an explicit policy path overrides the package default", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-cli-"));
  try {
    const policy = join(cwd, "custom-policy.json");
    await writeFile(policy, "{}\n");
    const result = await run(["--policy", policy], cwd);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid routing policy/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("mcp mode starts without a policy file in the working directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "jev-cli-"));
  const child = spawn(process.execPath, ["--import", tsxLoader, cli, "mcp"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      CONDUCTOR_API_KEY: "", CONDUCTOR_API_TOKEN: "",
      ORBIO_API_KEY: "", OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "",
    },
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let buffer = "";
  const pending = new Map<number, (message: any) => void>();
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
    const timer = setTimeout(() => reject(new Error(`${method} timed out\n${stderr}`)), 15_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } });
    assert.equal(initialized.result.serverInfo.name, "jev-conductor-router");
    assert.equal(initialized.result.serverInfo.version, "0.2.1");
    assert.doesNotMatch(stderr, /ENOENT|examples\/policy\.json/);
  } finally {
    child.kill();
    child.stdin.end();
    await rm(cwd, { recursive: true, force: true });
  }
});
