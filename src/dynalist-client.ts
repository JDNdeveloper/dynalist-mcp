/**
 * Dynalist API Client
 * API Docs: https://apidocs.dynalist.io/
 */

const API_BASE = "https://dynalist.io/api/v1";

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

const ERROR_GUIDANCE: Record<string, string> = {
  InvalidToken: "Check your DYNALIST_API_TOKEN environment variable.",
  NodeNotFound: "The specified node ID doesn't exist.",
  NotFound: "The specified document or file was not found.",
  NoInbox: "No inbox location is configured in your Dynalist settings.",
  Unauthorized: "You don't have permission to access this resource.",
  LockFail: "The document is locked by another operation. Try again shortly.",
  Invalid: "The request was malformed or contained invalid parameters.",
};

/**
 * Error class for Dynalist API errors. Preserves the API error code
 * (e.g. "InvalidToken", "NodeNotFound") for programmatic handling.
 */
export class DynalistApiError extends Error {
  readonly code: string;

  constructor(code: string, msg: string) {
    const guidance = ERROR_GUIDANCE[code];
    const fullMessage = guidance ? `${msg} -- ${guidance}` : msg;
    super(fullMessage);
    this.name = "DynalistApiError";
    this.code = code;
  }
}

// Types based on Dynalist API
export interface DynalistFile {
  id: string;
  title: string;
  type: "document" | "folder";
  permission: number; // 0=none, 1=read, 2=edit, 3=manage, 4=owner
  collapsed?: boolean;
  children?: string[];
}

export interface DynalistNode {
  id: string;
  content: string;
  note: string;
  created: number;
  modified: number;
  children: string[];
  checked?: boolean;
  checkbox?: boolean;
  heading?: number; // 0-3
  color?: number;   // 0-6
  collapsed?: boolean;
}

export interface ListFilesResponse {
  _code: string;
  _msg: string;
  root_file_id: string;
  files: DynalistFile[];
}

export interface ReadDocumentResponse {
  _code: string;
  _msg: string;
  file_id: string;
  title: string;
  version: number;
  nodes: DynalistNode[];
}

export interface EditDocumentChange {
  action: "insert" | "edit" | "move" | "delete";
  node_id?: string;
  parent_id?: string;
  index?: number;
  content?: string;
  note?: string;
  checked?: boolean;
  checkbox?: boolean;
  heading?: number;
  color?: number;
  collapsed?: boolean;
}

export interface EditDocumentResponse {
  _code: string;
  _msg: string;
  new_node_ids?: string[];
}

export interface InboxAddResponse {
  _code: string;
  _msg: string;
  file_id: string;
  node_id: string;
  index: number;
}

export class DynalistClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: this.token, ...body }),
      });

      const data = await response.json() as T & { _code: string; _msg: string };

      if (data._code.toLowerCase() === "ok") {
        return data;
      }

      // Retry on rate limit with exponential backoff.
      if (data._code === "TooManyRequests" && attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw new DynalistApiError(data._code, data._msg);
    }

    // Unreachable, but TypeScript needs it.
    throw new DynalistApiError("TooManyRequests", "Rate limit exceeded after retries.");
  }

  /**
   * Get all documents and folders
   */
  async listFiles(): Promise<ListFilesResponse> {
    return this.request<ListFilesResponse>("/file/list");
  }

  /**
   * Read content of a document
   */
  async readDocument(fileId: string): Promise<ReadDocumentResponse> {
    return this.request<ReadDocumentResponse>("/doc/read", { file_id: fileId });
  }

  /**
   * Make changes to document content
   */
  async editDocument(fileId: string, changes: EditDocumentChange[]): Promise<EditDocumentResponse> {
    return this.request<EditDocumentResponse>("/doc/edit", {
      file_id: fileId,
      changes
    });
  }

  /**
   * Send item to inbox
   */
  async sendToInbox(options: {
    content: string;
    note?: string;
    index?: number;
    checked?: boolean;
    checkbox?: boolean;
    heading?: number;
    color?: number;
  }): Promise<InboxAddResponse> {
    return this.request<InboxAddResponse>("/inbox/add", options);
  }
}

/**
 * Build a node map for quick lookup by ID
 */
export function buildNodeMap(nodes: DynalistNode[]): Map<string, DynalistNode> {
  const map = new Map<string, DynalistNode>();
  for (const node of nodes) {
    map.set(node.id, node);
  }
  return map;
}

/**
 * Build a parent map for O(1) parent lookups.
 * Maps each node ID to its parent ID and index within the parent's children array.
 */
export function buildParentMap(nodes: DynalistNode[]): Map<string, { parentId: string; index: number }> {
  const map = new Map<string, { parentId: string; index: number }>();
  for (const node of nodes) {
    const children = node.children || [];
    for (let i = 0; i < children.length; i++) {
      map.set(children[i], { parentId: node.id, index: i });
    }
  }
  return map;
}

/**
 * Find the root node (the one not referenced as a child by any other node)
 */
export function findRootNodeId(nodes: DynalistNode[]): string {
  const childIds = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.children || []) {
      childIds.add(childId);
    }
  }

  for (const node of nodes) {
    if (!childIds.has(node.id)) {
      return node.id;
    }
  }

  // Fallback to first node
  return nodes[0]?.id ?? "";
}

/**
 * Find the parent of a node and its index in the parent's children array
 */
export function findNodeParent(
  nodes: DynalistNode[],
  nodeId: string
): { parentId: string; index: number } | null {
  for (const node of nodes) {
    const children = node.children || [];
    const index = children.indexOf(nodeId);
    if (index !== -1) {
      return { parentId: node.id, index };
    }
  }
  return null;
}
