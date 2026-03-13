# Access Control

Path-based access control restricts which documents and folders the LLM can access. Each rule maps a file-tree path to a policy.

## How paths work

Paths are derived from the Dynalist folder tree. A document at the top level of a folder named "Work" has the path `/Work`. A document named "Notes" inside that folder has the path `/Work/Notes`.

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

No other glob patterns (wildcards in segments, brace expansion) are supported. A path without a glob suffix targets a single document or folder exactly.

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

When an `id` is present, the rule tracks the file by ID even if it is renamed or moved. The ID pins the document or folder, not the glob pattern. A rule like `{ "path": "/Work/**", "policy": "deny", "id": "abc123" }` pins `/Work` to `abc123`; if that folder is later renamed to `/Projects`, the rule automatically applies to `/Projects/**`. If the file's current path no longer matches the rule's path, a warning is logged suggesting a config update.

## Fail-closed behavior

If a rule references a path that does not exist in the file tree (e.g. a typo, or a deleted folder), rule validation fails and all tools are denied until the config is fixed. This prevents accidental exposure from misconfigured rules.

Similarly, if the file tree cannot be fetched (network error, invalid token), all tools are denied until the fetch succeeds.

## Cache staleness

When a tool evaluates access and gets a denial, the file tree cache is automatically refreshed and the evaluation retried. This handles cases where a document was recently renamed or moved and the cached path is stale. This retry applies to both single-file and batch operations.

## Duplicate paths constraint

Each `path` value in `access.rules` must be unique. Duplicate paths are rejected during config validation.

## Duplicate titles

Multiple files can have the same title, resulting in the same path. Use `id` anchoring to disambiguate. Without `id`, the rule applies to all files with the matching path.

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
