import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validatePolicy, type Policy } from "./router.js";

/** The routing policy bundled with the package, resolved relative to this
 * module so it works from src/ (tsx), dist/ (npm) and any working directory. */
export const DEFAULT_POLICY_PATH = fileURLToPath(new URL("../examples/policy.json", import.meta.url));

export async function loadDefaultPolicy(): Promise<Policy> {
  let raw: string;
  try { raw = await readFile(DEFAULT_POLICY_PATH, "utf8"); }
  catch { throw new Error(`Default routing policy not found at ${DEFAULT_POLICY_PATH}`); }
  return validatePolicy(JSON.parse(raw));
}
