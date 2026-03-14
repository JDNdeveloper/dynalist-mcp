# Access Control

Path-based access control restricts which documents and folders the LLM can access. Each rule maps a file-tree path to a policy.

## How paths work

Paths are derived from the Dynalist folder tree. A document at the top level of a folder named "Work" has the path `/Work`. A document named "Notes" inside that folder has the path `/Work/Notes`.

### Special characters in titles

If a folder or document title contains a literal `/`, `\`, or `*`, it is escaped in the path. This prevents ambiguity between path separators and title characters, and between glob patterns and literal asterisks.

| Character | Escaped form |
|-----------|-------------|
| `/` | `\/` |
| `\` | `\\` |
| `*` | `\*` |

| Title | Path segment |
|-------|-------------|
| `Work` | `Work` |
| `Coding/Career` | `Coding\/Career` |
| `A\B` | `A\\B` |
| `Important*` | `Important\*` |

A folder titled "Coding/Career" containing a document "Resume" has the path `/Coding\/Career/Resume`. The corresponding rule path uses the same escaping:

```json
{ "path": "/Coding\\/Career/**", "policy": "allow" }
```

Note the doubled backslash in JSON (`\\/`). JSON requires `\\` to represent a single `\` character, so the escaped path segment `\/` is written as `\\/` in the config file.

## Policy levels

| Policy | Read | Write |
|--------|------|-------|
| `deny` | No | No |
| `read` | Yes | No |
| `allow` | Yes | Yes |

## Glob suffixes

Rules support two glob suffixes:

- `/**` (recursive): matches the path itself and all descendants at any depth.
- `/*` (single-level): matches only direct children, not the path itself or deeper descendants.

No other glob patterns are supported. Interior globs like `/foo/*/bar` or `/foo/**/bar` are rejected during validation. Literal asterisks in titles must be escaped as `\*` in rule paths (written as `\\*` in JSON). A path without a glob suffix targets a single document or folder exactly.

Dangling backslashes (an odd number of trailing `\` before the glob suffix or at the end of a non-glob path) are also rejected during validation.

**Examples:**
- `/Work/**` matches `/Work`, `/Work/Notes`, `/Work/Projects/Alpha`.
- `/Work/*` matches `/Work/Notes` and `/Work/Projects` but not `/Work` itself or `/Work/Projects/Alpha`.
- `/Work/Notes` matches only the exact path `/Work/Notes`.

## Rule evaluation

The most-specific match wins. If no rule matches, the `default` policy applies.

Specificity is determined by: exact match > single-level glob > recursive glob, with longer prefixes beating shorter ones within the same type.

## ID anchoring

Rules can include an `id` field to anchor to a specific file ID:

```json
{ "path": "/Work/Notes", "policy": "deny", "id": "abc123" }
```

The `id` field serves two purposes: it disambiguates when multiple files share the same path (see [Duplicate titles](#duplicate-titles)), and it validates that the rule's path is correct. The path in the rule must match the ID's actual location in the file tree. If the path does not match (due to a typo, rename, move, or other mistake), validation fails and all tools are denied until the config is fixed.

## Fail-closed behavior

If a rule references a path that does not exist in the file tree (e.g. a typo, or a deleted folder), rule validation fails and all tools are denied until the config is fixed. This prevents accidental exposure from misconfigured rules.

Similarly, if the file tree cannot be fetched (network error, invalid token), all tools are denied until the fetch succeeds.

## Cache staleness

When a tool evaluates access and gets a denial, the file tree cache is automatically refreshed and the evaluation retried. This handles cases where a document was recently renamed or moved and the cached path is stale. This retry applies to both single-file and batch operations.

## Duplicate paths constraint

Each `path` value in `access.rules` must be unique. Duplicate paths are rejected during config validation.

## Duplicate titles

Multiple files can have the same title, resulting in the same path. If a non-ID-anchored rule matches multiple files with the same path, validation fails and all tools are denied until the config is fixed. Add an `id` field to the rule to disambiguate. ID-anchored rules are exempt from this check.

## Examples

**Work machine allowlist.** Only allow access to specific folders:
```json
{
  "access": {
    "default": "deny",
    "rules": [
      { "path": "/Work/**", "policy": "allow" },
      { "path": "/Shared/**", "policy": "read" }
    ]
  }
}
```

**Personal machine denylist.** Allow everything except sensitive content:
```json
{
  "access": {
    "default": "allow",
    "rules": [
      { "path": "/Private/**", "policy": "deny" },
      { "path": "/Private/Shopping List", "policy": "allow" }
    ]
  }
}
```

**Mixed read/write/deny**:
```json
{
  "access": {
    "default": "read",
    "rules": [
      { "path": "/Drafts/**", "policy": "allow" },
      { "path": "/Archive/**", "policy": "deny" },
      { "path": "/Archive/Important", "policy": "read", "id": "xyz789" }
    ]
  }
}
```
