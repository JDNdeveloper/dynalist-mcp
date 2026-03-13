/**
 * Path-based access control for Dynalist documents and folders.
 *
 * Resolves file IDs to title-based paths via the /file/list endpoint,
 * evaluates rules with most-specific-first matching, and caches the
 * file tree with configurable TTL.
 */

import type { DynalistClient, DynalistFile } from "./dynalist-client";
import type { Config, AccessRule } from "./config";
import { log, getConfigVersion } from "./config";

export type Policy = "allow" | "read" | "deny";

// ─── Rule matching ────────────────────────────────────────────────────

type MatchType = "exact" | "single" | "recursive";

interface RuleMatch {
  rule: AccessRule;
  type: MatchType;
  prefixLength: number;
}

/**
 * Check whether a rule's path pattern matches a given file path.
 * Returns match metadata for specificity ranking, or null if no match.
 */
function matchRule(rulePath: string, filePath: string): { type: MatchType; prefixLength: number } | null {
  if (rulePath.endsWith("/**")) {
    const prefix = rulePath.slice(0, -3);
    if (filePath === prefix || filePath.startsWith(prefix + "/")) {
      return { type: "recursive", prefixLength: prefix.length };
    }
  } else if (rulePath.endsWith("/*")) {
    const prefix = rulePath.slice(0, -2);
    const rest = filePath.slice(prefix.length);
    // Must start with "/" and have exactly one segment after.
    if (rest.startsWith("/") && rest.length > 1 && !rest.slice(1).includes("/")) {
      return { type: "single", prefixLength: prefix.length };
    }
  } else {
    if (filePath === rulePath) {
      return { type: "exact", prefixLength: filePath.length };
    }
  }
  return null;
}

/**
 * Compute a numeric specificity score for ranking matches.
 * Higher is more specific. Exact > single-level > recursive,
 * and longer prefix beats shorter prefix within the same type.
 */
function specificityScore(type: MatchType, prefixLength: number): number {
  const typeBonus = type === "exact" ? 2 : type === "single" ? 1 : 0;
  return prefixLength * 3 + typeBonus;
}

/**
 * Evaluate rules against a file path and return the effective policy.
 * Most-specific match wins; falls back to the default policy.
 */
/**
 * For ID-anchored rules, replace the base path with the ID-resolved
 * path while preserving the original glob suffix.
 */
function resolveRulePath(rule: AccessRule, pathMap: Map<string, string>): string {
  if (!rule.id) return rule.path;
  const resolvedBase = pathMap.get(rule.id);
  if (!resolvedBase) return rule.path;
  if (rule.path.endsWith("/**")) return resolvedBase + "/**";
  if (rule.path.endsWith("/*")) return resolvedBase + "/*";
  return resolvedBase;
}

function evaluateRules(filePath: string, rules: AccessRule[], defaultPolicy: Policy, pathMap: Map<string, string>): Policy {
  let bestMatch: RuleMatch | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    // If the rule has an ID, use the ID-resolved path (authoritative),
    // preserving the original glob suffix.
    const effectivePath = resolveRulePath(rule, pathMap);
    const match = matchRule(effectivePath, filePath);
    if (!match) continue;

    const score = specificityScore(match.type, match.prefixLength);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { rule, ...match };
    }
  }

  return bestMatch ? bestMatch.rule.policy : defaultPolicy;
}

// ─── Path resolution ──────────────────────────────────────────────────

interface PathCache {
  pathMap: Map<string, string>;
  fetchedAt: number;
}

/**
 * Build a map of fileId -> title-based path by walking the file tree
 * from the root. The root folder itself is not included in paths;
 * its children start at "/<title>".
 */
function buildPathMap(files: DynalistFile[], rootFileId: string): Map<string, string> {
  const fileById = new Map<string, DynalistFile>();
  for (const f of files) {
    fileById.set(f.id, f);
  }

  const pathMap = new Map<string, string>();

  function walk(fileId: string, parentPath: string) {
    const file = fileById.get(fileId);
    if (!file) return;

    const path = parentPath === "" ? "" : `${parentPath}/${file.title}`;
    if (path !== "") {
      pathMap.set(fileId, path);
    }

    if (file.children) {
      for (const childId of file.children) {
        walk(childId, path);
      }
    }
  }

  // Walk root's children directly (root itself has no path segment).
  const rootFile = fileById.get(rootFileId);
  if (rootFile?.children) {
    for (const childId of rootFile.children) {
      const child = fileById.get(childId);
      if (child) {
        const childPath = `/${child.title}`;
        pathMap.set(childId, childPath);
        if (child.children) {
          for (const grandchildId of child.children) {
            walk(grandchildId, childPath);
          }
        }
      }
    }
  }

  return pathMap;
}

/**
 * Log warnings for rules with ID mismatches and for ambiguous
 * duplicate-title paths.
 */
function validateRules(rules: AccessRule[], pathMap: Map<string, string>): string[] {
  const errors: string[] = [];
  const allPaths = new Set(pathMap.values());

  // Reject rules with unsupported glob patterns. Only trailing /** and /*
  // are recognized; a * anywhere else silently produces wrong behavior.
  for (const rule of rules) {
    const base = rule.path.replace(/\/\*\*?$/, "");
    if (base.includes("*")) {
      errors.push(
        `Access rule path '${rule.path}' contains an unsupported interior glob. ` +
        `Only trailing '/**' and '/*' patterns are supported.`
      );
    }
  }
  if (errors.length > 0) return errors;

  // Check that every rule matches at least one valid path.
  for (const rule of rules) {
    if (rule.id) {
      // ID-anchored: the ID must exist in the tree.
      const resolvedPath = pathMap.get(rule.id);
      if (!resolvedPath) {
        errors.push(`Access rule for '${rule.path}' has id '${rule.id}' which does not exist in the file tree.`);
        continue;
      }
      // Check for path drift.
      const ruleBase = rule.path.replace(/\/\*\*?$/, "");
      if (resolvedPath !== ruleBase) {
        log("warn",
          `Access rule for '${rule.path}' has id '${rule.id}' which now resolves to '${resolvedPath}'. Update your config.`
        );
      }
    } else {
      // Path-only: the base path must match at least one file/folder.
      const ruleBase = rule.path.replace(/\/\*\*?$/, "");
      // Root-level globs like /** and /* produce an empty ruleBase, which is valid.
      if (ruleBase !== "" && !allPaths.has(ruleBase)) {
        errors.push(
          `Access rule path '${rule.path}' does not match any file or folder in the account. ` +
          `Check for typos, or remove the rule if the path was deleted.`
        );
      }
    }
  }

  // Check for duplicate titles that could cause ambiguous rules.
  const pathToIds = new Map<string, string[]>();
  for (const [id, path] of pathMap) {
    const existing = pathToIds.get(path);
    if (existing) {
      existing.push(id);
    } else {
      pathToIds.set(path, [id]);
    }
  }

  for (const rule of rules) {
    if (rule.id) continue;
    const ruleBase = rule.path.replace(/\/\*\*?$/, "");
    const ids = pathToIds.get(ruleBase);
    if (ids && ids.length > 1) {
      log("warn",
        `Access rule for '${rule.path}' matches ${ids.length} files with the same path. ` +
        `Add an 'id' field to disambiguate.`
      );
    }
  }

  return errors;
}

// ─── AccessController ─────────────────────────────────────────────────

export class AccessController {
  private client: DynalistClient;
  private cache: PathCache | null = null;
  // Tracks the last seen config version so we can invalidate the path
  // cache when the config file is reloaded (rules may have changed).
  private lastConfigVersion = -1;

  constructor(client: DynalistClient) {
    this.client = client;
  }

  /**
   * Invalidate the cached file tree. Called after create/move/rename
   * operations and on denial retries.
   */
  invalidateCache(): void {
    this.cache = null;
  }

  /**
   * Get or refresh the path map, respecting the configured TTL.
   * On fetch failure, returns null (fail-closed).
   */
  private async getPathMap(config: Config): Promise<Map<string, string> | null> {
    // Invalidate cache if the config was reloaded (rules may have changed).
    const currentVersion = getConfigVersion();
    if (currentVersion !== this.lastConfigVersion) {
      this.cache = null;
      this.lastConfigVersion = currentVersion;
    }

    const ttlMs = config.cache.ttlSeconds * 1000;
    if (this.cache && Date.now() - this.cache.fetchedAt < ttlMs) {
      return this.cache.pathMap;
    }

    try {
      const response = await this.client.listFiles();
      const pathMap = buildPathMap(response.files, response.root_file_id);

      if (config.access?.rules) {
        const errors = validateRules(config.access.rules, pathMap);
        if (errors.length > 0) {
          log("error", `Access rule validation failed:\n  ${errors.join("\n  ")}`);
          // Fail closed: return null so all tools are denied.
          return null;
        }
      }

      this.cache = { pathMap, fetchedAt: Date.now() };
      return pathMap;
    } catch (err) {
      log("error", `Failed to fetch file tree for access control: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Resolve the policy for a given file ID. Returns "allow" if no
   * access config is defined. On denial, retries with a fresh cache
   * to handle stale paths from renames/moves.
   */
  async getPolicy(fileId: string, config: Config): Promise<Policy> {
    if (!config.access) return "allow";

    const policy = await this.evaluateForFile(fileId, config);

    // Retry on denial with a fresh cache to handle stale paths.
    if (policy === "deny") {
      this.invalidateCache();
      return this.evaluateForFile(fileId, config);
    }

    return policy;
  }

  /**
   * Evaluate the policy for a single file ID against the current cache.
   */
  private async evaluateForFile(fileId: string, config: Config): Promise<Policy> {
    const access = config.access!;
    const pathMap = await this.getPathMap(config);

    // Fail-closed: if we can't fetch the file tree, deny everything.
    if (!pathMap) return "deny";

    const filePath = pathMap.get(fileId);
    if (!filePath) {
      // File not in tree. Apply default policy.
      return access.default;
    }

    return evaluateRules(filePath, access.rules, access.default, pathMap);
  }

  /**
   * Batch-evaluate policies for multiple file IDs. Used by tools that
   * operate on lists (list_documents, search_documents, check_document_versions).
   */
  async getPolicies(fileIds: string[], config: Config): Promise<Map<string, Policy>> {
    const result = new Map<string, Policy>();

    if (!config.access) {
      for (const id of fileIds) {
        result.set(id, "allow");
      }
      return result;
    }

    // Ensure cache is populated once for the batch.
    const pathMap = await this.getPathMap(config);
    const access = config.access;

    let hasDenials = false;
    for (const id of fileIds) {
      if (!pathMap) {
        result.set(id, "deny");
        hasDenials = true;
        continue;
      }
      const filePath = pathMap.get(id);
      if (!filePath) {
        const policy = access.default;
        result.set(id, policy);
        if (policy === "deny") hasDenials = true;
      } else {
        const policy = evaluateRules(filePath, access.rules, access.default, pathMap);
        result.set(id, policy);
        if (policy === "deny") hasDenials = true;
      }
    }

    // Retry with fresh cache if any files were denied, to handle stale
    // paths from renames/moves (same logic as getPolicy's denial-retry).
    if (hasDenials) {
      this.invalidateCache();
      const freshPathMap = await this.getPathMap(config);
      for (const id of fileIds) {
        if (result.get(id) !== "deny") continue;
        if (!freshPathMap) {
          result.set(id, "deny");
          continue;
        }
        const filePath = freshPathMap.get(id);
        if (!filePath) {
          result.set(id, access.default);
        } else {
          result.set(id, evaluateRules(filePath, access.rules, access.default, freshPathMap));
        }
      }
    }

    return result;
  }
}

// ─── Enforcement helpers ──────────────────────────────────────────────

/**
 * Check whether the given policy allows the requested access level.
 * Returns an error response object if access is denied, or null if OK.
 */
export function requireAccess(
  policy: Policy,
  level: "read" | "write",
  readOnly: boolean,
): { error: string; message: string } | null {
  if (policy === "deny") {
    return { error: "NotFound", message: "Document not found or access denied." };
  }
  if (level === "write" && readOnly) {
    return { error: "ReadOnly", message: "Server is in read-only mode." };
  }
  if (level === "write" && policy === "read") {
    return { error: "ReadOnly", message: "Document is read-only per access policy." };
  }
  return null;
}
