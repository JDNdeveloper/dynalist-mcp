/**
 * Dynalist API Client
 * API Docs: https://apidocs.dynalist.io/
 */

import type { DynalistApiResponse } from "./types";
import { log } from "./config";

const API_BASE = "https://dynalist.io/api/v1";

// Retry config: exponential backoff on TooManyRequests.
// 5s base capped at 10s: 5s, 10s, 10s, ... up to 10 attempts (95s max).
// The API rate limit window clears in ~45-50s, so 10 retries gives ~2x
// headroom. If still limited after 95s, something is genuinely wrong.
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 10000;

// Batch config: the API silently drops changes beyond its burst limit
// (~500 changes). Batches of 200 stay safely within the limit. No
// inter-batch delay. The retry logic handles rate limits if needed.
const CHANGES_BATCH_SIZE = 200;
const INTER_BATCH_DELAY_MS = 0;

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
    const fullMessage = guidance ? `${msg}: ${guidance}` : msg;
    super(fullMessage);
    this.name = "DynalistApiError";
    this.code = code;
  }
}

// Types based on Dynalist API.
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
  root_file_id: string;
  files: DynalistFile[];
}

export interface ReadDocumentResponse {
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
}

export interface EditDocumentResponse {
  new_node_ids?: string[];
}

export interface InboxAddResponse {
  file_id: string;
  node_id: string;
  index: number;
}

export interface FileEditChange {
  action: "create" | "edit" | "move";
  type: "document" | "folder";
  file_id?: string;
  parent_id?: string;
  title?: string;
  index?: number;
}

export interface FileEditResponse {
  results: boolean[];
  created?: string[];
}

export interface CheckForUpdatesResponse {
  versions: Record<string, number>;
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

      const data = await response.json() as DynalistApiResponse<T>;

      if (data._code.toLowerCase() === "ok") {
        return data;
      }

      // Retry on rate limit with capped exponential backoff.
      if (data._code === "TooManyRequests" && attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        log("warn", `Rate limited on ${endpoint}, attempt ${attempt + 1}/${MAX_RETRIES}, retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw new DynalistApiError(data._code, data._msg);
    }

    // Unreachable, but TypeScript needs it.
    throw new DynalistApiError("TooManyRequests", "Rate limit exceeded after retries.");
  }

  /**
   * Get all documents and folders.
   */
  async listFiles(): Promise<ListFilesResponse> {
    return this.request<ListFilesResponse>("/file/list");
  }

  /**
   * Read content of a document.
   */
  async readDocument(fileId: string): Promise<ReadDocumentResponse> {
    return this.request<ReadDocumentResponse>("/doc/read", { file_id: fileId });
  }

  /**
   * Make changes to document content (insert, edit, move, delete nodes).
   * Automatically batches in chunks of 200 to stay within the API burst
   * limit. Returns merged new_node_ids across all batches.
   */
  async editDocument(fileId: string, changes: EditDocumentChange[]): Promise<EditDocumentResponse> {
    if (changes.length <= CHANGES_BATCH_SIZE) {
      return this.request<EditDocumentResponse>("/doc/edit", {
        file_id: fileId,
        changes,
      });
    }

    // Batch large change sets.
    const totalBatches = Math.ceil(changes.length / CHANGES_BATCH_SIZE);
    log("info", `Batching ${changes.length} changes into ${totalBatches} batches of ${CHANGES_BATCH_SIZE}.`);
    const allNewNodeIds: string[] = [];
    for (let i = 0; i < changes.length; i += CHANGES_BATCH_SIZE) {
      if (i > 0 && INTER_BATCH_DELAY_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, INTER_BATCH_DELAY_MS));
      }

      const batchNum = Math.floor(i / CHANGES_BATCH_SIZE) + 1;
      const batch = changes.slice(i, i + CHANGES_BATCH_SIZE);
      log("info", `Sending ${batch.length} changes (batch ${batchNum}/${totalBatches})`);
      const batchStart = Date.now();
      const response = await this.request<EditDocumentResponse>("/doc/edit", {
        file_id: fileId,
        changes: batch,
      });
      log("info", `Batch ${batchNum}/${totalBatches} completed in ${Date.now() - batchStart}ms`);
      if (response.new_node_ids) {
        allNewNodeIds.push(...response.new_node_ids);
      }
    }

    return { new_node_ids: allNewNodeIds.length > 0 ? allNewNodeIds : undefined };
  }

  /**
   * Send item to inbox.
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

  /**
   * Make changes to files/folders (create, rename, move).
   */
  async editFiles(changes: FileEditChange[]): Promise<FileEditResponse> {
    return this.request<FileEditResponse>("/file/edit", { changes });
  }

  /**
   * Check version numbers for a list of documents without fetching content.
   */
  async checkForUpdates(fileIds: string[]): Promise<CheckForUpdatesResponse> {
    return this.request<CheckForUpdatesResponse>("/doc/check_for_updates", {
      file_ids: fileIds,
    });
  }
}

/**
 * Build a node map for quick lookup by ID.
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
 * Find the root node (the one not referenced as a child by any other node).
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

  // Fallback to first node.
  return nodes[0]?.id ?? "";
}
