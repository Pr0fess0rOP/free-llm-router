import { createHash, timingSafeEqual } from "node:crypto";
import { readLocalNode, updateStoredLocalNode } from "./local-node-store.js";
import type { LocalNode } from "./local-node-types.js";

export function hashLocalNodeSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export async function authenticateLocalNode(
  nodeId: string,
  deviceCredential: string,
): Promise<LocalNode | undefined> {
  const stored = await readLocalNode(nodeId);
  const credentialValid = deviceCredential.startsWith("fln_") && stored && safeHashEquals(
    stored.credential.credentialHash,
    hashLocalNodeSecret(deviceCredential),
  );
  if (
    !stored ||
    stored.status === "revoked" ||
    stored.revokedAt ||
    stored.credential.revokedAt ||
    !credentialValid
  ) {
    if (stored && !stored.revokedAt && stored.status !== "revoked" && !credentialValid) {
      await updateStoredLocalNode(nodeId, (node) => {
        node.credentialFailureCount = (node.credentialFailureCount ?? 0) + 1;
        node.lastCredentialFailureAt = new Date().toISOString();
        node.lastCredentialError = "Invalid device credential";
      });
    }
    return undefined;
  }
  const { credential: _credential, ...node } = stored;
  return node;
}
