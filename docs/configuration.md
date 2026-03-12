# Configuration

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNALIST_API_TOKEN` | Yes | Your Dynalist API token from [dynalist.io/developer](https://dynalist.io/developer) |
| `DYNALIST_MCP_CONFIG` | No | Override the config file path (default: `~/.dynalist-mcp.json`) |

## Config file

Optional. Located at `~/.dynalist-mcp.json` by default (override with `DYNALIST_MCP_CONFIG`). All fields are optional with sensible defaults. Validated with Zod on load. Automatically reloaded when the file is modified (mtime-based check on every tool call). Invalid config fails closed (all tools error until fixed or removed).

```json
{
  "access": {
    "default": "allow",
    "rules": [
      { "path": "/Private/**", "policy": "deny" },
      { "path": "/Private/Shopping List", "policy": "allow" },
      { "path": "/Archive/**", "policy": "read" }
    ]
  },
  "readDefaults": {
    "maxDepth": 5,
    "includeCollapsedChildren": false,
    "includeNotes": true,
    "includeChecked": true
  },
  "sizeWarning": {
    "warningTokenThreshold": 5000,
    "maxTokenThreshold": 24500
  },
  "inbox": {
    "defaultCheckbox": false
  },
  "readOnly": false,
  "cache": {
    "ttlSeconds": 300
  },
  "logLevel": "warn",
  "logFile": "/tmp/dynalist-mcp.log"
}
```

## Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `access.default` | `"allow"` \| `"read"` \| `"deny"` | `"allow"` | Default policy for files not matched by any rule |
| `access.rules` | array | `[]` | Access control rules (see [Access control](access-control.md)) |
| `readDefaults.maxDepth` | number \| null | `5` | Default max depth for `read_document`. `null` = unlimited |
| `readDefaults.includeCollapsedChildren` | boolean | `false` | Default for including collapsed nodes' children |
| `readDefaults.includeNotes` | boolean | `true` | Default for including node notes in responses |
| `readDefaults.includeChecked` | boolean | `true` | Default for including checked/completed nodes |
| `sizeWarning.warningTokenThreshold` | number | `5000` | Token count that triggers a size warning |
| `sizeWarning.maxTokenThreshold` | number | `24500` | Token count above which results are blocked entirely |
| `inbox.defaultCheckbox` | boolean | `false` | Default checkbox state for inbox items |
| `readOnly` | boolean | `false` | Reject all write operations when true |
| `cache.ttlSeconds` | number | `300` | File tree cache TTL in seconds |
| `logLevel` | `"error"` \| `"warn"` \| `"info"` \| `"debug"` | `"warn"` | Log verbosity |
| `logFile` | string | none | File path to write logs to (in addition to stderr) |

## Logging

All log output goes to stderr (stdout is reserved for MCP protocol). The `logLevel` setting controls verbosity:

- **error**: failures only.
- **warn** (default): includes rate limit retries and access rule warnings.
- **info**: batch progress, config reloads.
- **debug**: full request/response details.

Set `logFile` to redirect logs to a file, useful for debugging since stderr from MCP subprocesses is not always visible.
