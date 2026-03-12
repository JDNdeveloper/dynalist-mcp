/**
 * Dynalist URL utilities.
 *
 * URL format: https://dynalist.io/d/{document_id}#z={node_id}
 * Examples:
 *   - https://dynalist.io/d/mTotmwoGt6GQNc5Vg9tuSnDo
 *   - https://dynalist.io/d/mTotmwoGt6GQNc5Vg9tuSnDo#z=VHVA8ki14SjaUpS3-tgJ4oTL
 */

/**
 * Build a Dynalist URL from document ID and optional node ID.
 */
export function buildDynalistUrl(documentId: string, nodeId?: string): string {
  let url = `https://dynalist.io/d/${documentId}`;
  if (nodeId) {
    url += `#z=${nodeId}`;
  }
  return url;
}
