import { createHash } from "node:crypto";

export function accountKey(organizationId: string, userId: string) {
  return createHash("sha256").update(organizationId + ":" + userId).digest("hex");
}
