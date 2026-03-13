/**
 * Path-based access control for Dynalist documents and folders.
 *
 * Resolves file IDs to title-based paths via the /file/list endpoint,
 * evaluates rules with most-specific-first matching, and caches the
 * file tree with configurable TTL.
 */

import type { DynalistClient, DynalistFile } from "./dynalist-client";
import type { Config, AccessRule } from "./config";
import { log, getConfigVersion, ConfigError } from "./config";

export type Policy = "allow" | "read" | "deny";

// ─── Path escaping ───────────────────────────────────────────────────

/**
 * Escape a file/folder title for use as a path segment. Normalizes
 * to NFC first for consistent Unicode comparison, then escapes
 * backslashes (\ -> \\), slashes (/ -> \/), and asterisks (* -> \*),
 * so that unescaped "/" always means "path separator" and unescaped
 * "*" always means "glob".
 */
function escapePathSegment(title: string): string {
  return title.normalize("NFC")
    .replace(/\\/g, "\\\\")
    .replace(/\//g, "\\/")
    .replace(/\*/g, "\\*");
}

/**
 * Replace control characters (U+0000..U+001F, U+007F..U+009F) with
 * their \xNN hex representation. Used to sanitize paths before
 * including them in log messages to prevent log injection.
 */
function sanitizeForLog(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, (ch) =>
    `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
}

/**
 * Count consecutive backslashes immediately before the given index.
 */
function countPrecedingBackslashes(s: string, index: number): number {
  let count = 0;
  for (let j = index - 1; j >= 0 && s[j] === "\\"; j--) {
    count++;
  }
  return count;
}

/**
 * Check whether the character at the given index is escaped (preceded
 * by an odd number of backslashes).
 */
function isEscapedChar(s: string, index: number): boolean {
  return countPrecedingBackslashes(s, index) % 2 !== 0;
}

/**
 * Check whether a string contains at least one unescaped forward slash.
 * Used by the single-level glob matcher to detect nested path
 * segments inside an escaped title.
 */
function hasUnescapedSlash(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "/" && !isEscapedChar(s, i)) return true;
  }
  return false;
}

/**
 * Check whether a string contains at least one unescaped asterisk.
 * Used to detect interior globs while allowing escaped literal
 * asterisks from title escaping.
 */
function hasUnescapedStar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "*" && !isEscapedChar(s, i)) return true;
  }
  return false;
}

/**
 * Check whether a string ends with a dangling (unescaped) backslash.
 * An odd number of trailing backslashes means the last one is not
 * part of a \\ pair and is escaping nothing.
 */
function hasDanglingBackslash(s: string): boolean {
  let count = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) {
    count++;
  }
  return count % 2 !== 0;
}

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
  // Normalize to NFC for consistent comparison. File paths are already
  // NFC from escapePathSegment; rule paths are normalized here as a
  // defensive measure (Zod also normalizes, but callers may bypass it).
  rulePath = rulePath.normalize("NFC");

  if (rulePath.endsWith("/**")) {
    const prefix = rulePath.slice(0, -3);
    // Check that the "/" after the prefix in the file path is an
    // unescaped separator, not part of an escaped "\/" sequence.
    if (filePath === prefix ||
        (filePath.length > prefix.length && filePath.startsWith(prefix) &&
         filePath[prefix.length] === "/" && !isEscapedChar(filePath, prefix.length))) {
      return { type: "recursive", prefixLength: prefix.length };
    }
  } else if (rulePath.endsWith("/*")) {
    const prefix = rulePath.slice(0, -2);
    // Must match the prefix, then have an unescaped "/" followed by
    // exactly one segment (no further unescaped slashes).
    if (filePath.length > prefix.length && filePath.startsWith(prefix) &&
        filePath[prefix.length] === "/" && !isEscapedChar(filePath, prefix.length) &&
        !hasUnescapedSlash(filePath.slice(prefix.length + 1))) {
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
function evaluateRules(filePath: string, rules: AccessRule[], defaultPolicy: Policy): Policy {
  let bestMatch: RuleMatch | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    const match = matchRule(rule.path, filePath);
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

  // Recursively walk a file's children, computing each child's path
  // as parentPath + "/" + escaped title. The root is never passed as
  // fileId; instead, its children are seeded with parentPath = "".
  function walkChildren(parentId: string, parentPath: string) {
    const parent = fileById.get(parentId);
    if (!parent?.children) return;

    for (const childId of parent.children) {
      const child = fileById.get(childId);
      if (!child) continue;

      // Empty titles produce ambiguous path segments (/ or //). Skip
      // the file and its descendants; they receive the default policy.
      if (child.title === "") {
        log("warn", `File '${child.id}' has an empty title; excluded from access control path map.`);
        continue;
      }

      const childPath = `${parentPath}/${escapePathSegment(child.title)}`;
      pathMap.set(childId, childPath);
      walkChildren(childId, childPath);
    }
  }

  walkChildren(rootFileId, "");

  return pathMap;
}

/**
 * Validate access rules against the current file tree. Checks for
 * interior globs, missing IDs, path drift, unresolvable paths, and
 * duplicate-title ambiguity.
 *
 * IMPORTANT: Strings pushed to `errors` are agent-facing (thrown as
 * ConfigError and returned via wrapToolHandler). They must never
 * include rule paths, file IDs, resolved paths, or titles. Use
 * log() for detailed diagnostics visible only to the server operator.
 */
function validateRules(rules: AccessRule[], pathMap: Map<string, string>): string[] {
  const errors: string[] = [];
  const allPaths = new Set(pathMap.values());

  // Reject rules with structural problems in the path syntax. These
  // are checked before semantic validation (path existence, ID drift)
  // because they indicate a fundamentally malformed rule.
  for (const rule of rules) {
    const base = rule.path.normalize("NFC").replace(/\/\*\*?$/, "");
    if (hasUnescapedStar(base)) {
      log("error", `Access rule '${sanitizeForLog(rule.path)}' contains an unsupported interior glob.`);
      errors.push(
        "An access rule contains an unsupported interior glob. " +
        "Only trailing '/**' and '/*' patterns are supported. " +
        "Literal asterisks in titles must be escaped as '\\*'."
      );
    }
    if (hasDanglingBackslash(base)) {
      log("error", `Access rule '${sanitizeForLog(rule.path)}' has a dangling backslash in its path.`);
      errors.push(
        "An access rule has a dangling backslash. " +
        "Literal backslashes must be escaped as '\\\\'."
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
        log("error", `Access rule '${sanitizeForLog(rule.path)}' has id '${rule.id}' which does not exist in the file tree.`);
        errors.push("An id-anchored rule references an id that does not exist in the file tree.");
        continue;
      }
      // Check for path drift.
      const ruleBase = rule.path.normalize("NFC").replace(/\/\*\*?$/, "");
      if (resolvedPath !== ruleBase) {
        log("error", `Access rule '${sanitizeForLog(rule.path)}' has id '${rule.id}' which now resolves to '${sanitizeForLog(resolvedPath)}'.`);
        errors.push("An id-anchored rule's path no longer matches its id.");
      }
    } else {
      // Path-only: the base path must match at least one file/folder.
      const ruleBase = rule.path.normalize("NFC").replace(/\/\*\*?$/, "");
      // Root-level globs like /** and /* produce an empty ruleBase, which is valid.
      if (ruleBase !== "" && !allPaths.has(ruleBase)) {
        log("error", `Access rule path '${sanitizeForLog(rule.path)}' does not match any file or folder in the account.`);
        errors.push("A path-only rule does not match any file or folder in the account.");
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
    const ruleBase = rule.path.normalize("NFC").replace(/\/\*\*?$/, "");
    const ids = pathToIds.get(ruleBase);
    if (ids && ids.length > 1) {
      log("error",
        `Access rule for '${sanitizeForLog(rule.path)}' matches ${ids.length} files with the same path. ` +
        `Add an 'id' field to disambiguate.`
      );
      errors.push(
        "A path-only rule matches multiple files with the same path. " +
        "Add an 'id' field to disambiguate."
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
          throw new ConfigError(
            `Access rule validation failed:\n  ${errors.join("\n  ")}`
          );
        }
      }

      this.cache = { pathMap, fetchedAt: Date.now() };
      return pathMap;
    } catch (err) {
      // Config errors must propagate to the agent, not be swallowed.
      if (err instanceof ConfigError) throw err;
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

    return evaluateRules(filePath, access.rules, access.default);
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
        const policy = evaluateRules(filePath, access.rules, access.default);
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
          result.set(id, evaluateRules(filePath, access.rules, access.default));
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
