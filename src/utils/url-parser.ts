/**
 * Parse Dynalist URLs
 *
 * URL format: https://dynalist.io/d/{document_id}#z={node_id}
 * Examples:
 *   - https://dynalist.io/d/mTotmwoGt6GQNc5Vg9tuSnDo
 *   - https://dynalist.io/d/mTotmwoGt6GQNc5Vg9tuSnDo#z=VHVA8ki14SjaUpS3-tgJ4oTL
 */

export interface ParsedDynalistUrl {
  documentId: string;
  nodeId?: string;
}

/**
 * Parse a Dynalist URL into document ID and optional node ID
 */
export function parseDynalistUrl(url: string): ParsedDynalistUrl {
  // Handle both full URLs and just the document ID
  if (!url.includes("dynalist.io") && !url.startsWith("http")) {
    // Assume it's just a document ID
    return { documentId: url };
  }

  const urlObj = new URL(url);

  // Extract document ID from pathname: /d/{document_id}
  const pathMatch = urlObj.pathname.match(/^\/d\/([a-zA-Z0-9_-]+)/);
  if (!pathMatch) {
    throw new Error(`Invalid Dynalist URL format: ${url}`);
  }

  const documentId = pathMatch[1];

  // Extract node ID from hash: #z={node_id}
  let nodeId: string | undefined;
  if (urlObj.hash) {
    const hashMatch = urlObj.hash.match(/^#z=([a-zA-Z0-9_-]+)/);
    if (hashMatch) {
      nodeId = hashMatch[1];
    }
  }

  return { documentId, nodeId };
}

/**
 * Build a Dynalist URL from document ID and optional node ID
 */
export function buildDynalistUrl(documentId: string, nodeId?: string): string {
  let url = `https://dynalist.io/d/${documentId}`;
  if (nodeId) {
    url += `#z=${nodeId}`;
  }
  return url;
}
