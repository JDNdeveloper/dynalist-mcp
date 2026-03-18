/**
 * Opaque sync token generation. Hashes the numeric document version into
 * a short hex string so agents cannot predict the next value and are
 * forced to re-read the document after writes.
 */

import { createHash } from "node:crypto";

/**
 * Generate a deterministic, opaque sync token from a file ID and version.
 * Returns a 5-character hex string.
 */
export function makeSyncToken(fileId: string, version: number): string {
  return createHash("sha256")
    .update(`${fileId}:${version}`)
    .digest("hex")
    .slice(0, 5);
}
