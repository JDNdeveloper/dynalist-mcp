/**
 * Shared types used across the codebase.
 */

/**
 * Lightweight reference to a node, used in parent/child context fields.
 */
export interface NodeSummary {
  id: string;
  content: string;
}

/**
 * Generic wrapper for Dynalist API responses. Every endpoint returns
 * _code and _msg alongside the endpoint-specific payload.
 */
export type DynalistApiResponse<T> = T & { _code: string; _msg: string };

/**
 * A node in the read_document output tree. Mirrors the Dynalist node
 * structure but includes truncation signals (depth_limited, children_count).
 */
export interface OutputNode {
  node_id: string;
  content: string;
  note?: string;
  checked?: boolean;
  checkbox?: boolean;
  heading?: number;
  color?: number;
  collapsed: boolean;
  depth_limited?: true;
  children_count: number;
  children: OutputNode[];
}

/**
 * Options for insertTreeUnderParent.
 */
export interface InsertTreeOptions {
  startIndex?: number;
}
