# Dynalist MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for [Dynalist.io](https://dynalist.io/) -- the infinite document outliner.

Enables Claude and other AI assistants to read, write, search, and organize Dynalist documents programmatically via 17 MCP tools.

For Dynalist API documentation, see [apidocs.dynalist.io](https://apidocs.dynalist.io/).

## Setup

### Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- A Dynalist account with an API token

### Install

```bash
git clone https://github.com/your-username/dynalist-mcp.git
cd dynalist-mcp
bun install
```

### Get your API token

Visit [dynalist.io/developer](https://dynalist.io/developer) and generate an API token.

## Security model

### Transport

This server uses MCP stdio transport: it runs as a local subprocess of the MCP client (e.g. Claude Desktop, Claude Code) and communicates via stdin/stdout. There is no network listener, no HTTP server, no port binding. The server is not accessible from outside the machine or from other processes on the same machine.

### LLM access risks

While the server itself is local-only, the LLM interacting with it has full read/write access to your Dynalist data (subject to access control policy, if configured). This means the LLM could potentially read sensitive content, modify or delete nodes, or exfiltrate data by including it in responses. Use the access control system and `readOnly` mode to limit exposure.

### Access control limitations

The access control system is best-effort and should not be relied upon as a hard security boundary. Known limitations:

1. **Content leakage**: content within allowed documents may contain links or references to denied documents, exposing their IDs or titles. The ACL system does not scrub content.
2. **Cache staleness**: the file tree cache (default 5 minutes TTL) means external renames/moves may cause rules to match incorrectly until the cache refreshes.
3. **Inbox bypass**: the inbox is always writable regardless of deny rules.

Users who need strict isolation should use separate Dynalist accounts rather than relying solely on ACLs.

### Specificity-wins precedence

Rule precedence is based on path specificity, **not** policy severity. Unlike AWS IAM (where explicit deny always wins), a more-specific `allow` overrides a less-specific `deny`.

For example, if `/Private/**` is `deny` but `/Private/Shopping List` is `allow`, the Shopping List is accessible because the exact match is more specific. Deny rules are not absolute ceilings -- they can be overridden by more specific rules underneath them.

Audit your rules to ensure no more-specific allow/read rules punch holes through broader deny rules.

## Configuration

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DYNALIST_API_TOKEN` | Yes | Your Dynalist API token from [dynalist.io/developer](https://dynalist.io/developer) |
| `DYNALIST_MCP_CONFIG` | No | Override the config file path (default: `~/.dynalist-mcp.json`) |

### Config file

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

#### Field reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `access.default` | `"allow"` \| `"read"` \| `"deny"` | `"allow"` | Default policy for files not matched by any rule |
| `access.rules` | array | `[]` | Access control rules (see [Access control](#access-control)) |
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

### Logging

All log output goes to stderr (stdout is reserved for MCP protocol). The `logLevel` setting controls verbosity:

- **error**: failures only.
- **warn** (default): includes rate limit retries and access rule warnings.
- **info**: batch progress, config reloads.
- **debug**: full request/response details.

Set `logFile` to redirect logs to a file, useful for debugging since stderr from MCP subprocesses is not always visible.

## Access control

Path-based access control restricts which documents and folders the LLM can access. Each rule maps a file-tree path to a policy.

### How paths work

Paths are derived from the Dynalist folder tree. A document at the top level of a folder named "Work" has the path `/Work`. A document named "Notes" inside that folder has the path `/Work/Notes`.

### Policy levels

| Policy | Read | Write |
|--------|------|-------|
| `deny` | No | No |
| `read` | Yes | No |
| `allow` | Yes | Yes |

### Glob suffixes

Rules support two glob suffixes:

- `/**` (recursive): matches the path itself and all descendants at any depth.
- `/*` (single-level): matches only direct children, not the path itself or deeper descendants.

No other glob patterns (wildcards in segments, brace expansion) are supported. A path without a glob suffix targets a single document or folder exactly.

**Examples:**
- `/Work/**` matches `/Work`, `/Work/Notes`, `/Work/Projects/Alpha`.
- `/Work/*` matches `/Work/Notes` and `/Work/Projects` but not `/Work` itself or `/Work/Projects/Alpha`.
- `/Work/Notes` matches only the exact path `/Work/Notes`.

### Rule evaluation

The most-specific match wins. If no rule matches, the `default` policy applies.

Specificity is determined by: exact match > single-level glob > recursive glob, with longer prefixes beating shorter ones within the same type.

### ID anchoring

Rules can include an `id` field to anchor to a specific file ID:

```json
{ "path": "/Work/Notes", "policy": "deny", "id": "abc123" }
```

When an `id` is present, the rule uses the ID-resolved path (authoritative) even if the file has been renamed or moved. If the file's current path no longer matches the rule's path, a warning is logged suggesting a config update.

### Duplicate titles

Multiple files can have the same title, resulting in the same path. Use `id` anchoring to disambiguate. Without `id`, the rule applies to all files with the matching path.

### Examples

**Work machine allowlist** -- only allow access to specific folders:
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

**Personal machine denylist** -- allow everything except sensitive content:
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

## MCP client integration

### Environment isolation

MCP clients launch server subprocesses in a minimal environment that does NOT inherit your shell PATH or environment variables. This means `bun`, `node`, and env vars set in `.bashrc`/`.zshrc` will not be available.

Workarounds:
- **`env` field**: set environment variables directly in the MCP config. Values are literal strings (no `$HOME` or `~` expansion).
- **Absolute paths**: use the full path to `bun` in the `command` field (e.g. `/Users/you/.bun/bin/bun`).
- **Wrapper script**: a bash script that sets up PATH and env vars, then exec's the real command. Best when env vars are dynamic.

All paths in MCP config files must be absolute. `~` and `$HOME` are not expanded by any MCP client.

### Claude Desktop

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dynalist": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/dynalist-mcp/src/index.ts"],
      "env": {
        "DYNALIST_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Claude Code

`.mcp.json` in the project root or `~/.claude.json` globally:

```json
{
  "mcpServers": {
    "dynalist": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/dynalist-mcp/src/index.ts"],
      "env": {
        "DYNALIST_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `command not found: bun` | PATH not inherited | Use absolute path to `bun` in `command` field |
| `DYNALIST_API_TOKEN is required` | Env vars not inherited | Set the token in the `env` field |
| `~` or `$HOME` in paths | No shell expansion | Use absolute paths everywhere |

## Tools reference

### Read tools

#### `list_documents`

List all documents and folders in your Dynalist account. Returns the folder hierarchy so you can understand the organizational structure. Use the returned `file_id` values as parameters for all other tools.

**Parameters**: none.

**Response**:
```json
{
  "root_file_id": "abc123",
  "count": 5,
  "documents": [
    { "file_id": "...", "title": "...", "url": "...", "permission": "owner" }
  ],
  "folders": [
    { "file_id": "...", "title": "...", "children": ["...", "..."] }
  ]
}
```

#### `search_documents`

Search for documents and folders by name. Client-side filter on the file tree.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | | Text to search for (case-insensitive) |
| `type` | string | no | `"all"` | Filter: `"document"`, `"folder"`, or `"all"` |

**Response**:
```json
{
  "count": 3,
  "query": "notes",
  "matches": [
    {
      "file_id": "...", "title": "...", "type": "document",
      "url": "...", "permission": "owner"
    }
  ]
}
```

Folders include `children` instead of `url`/`permission`.

#### `read_document`

Read a Dynalist document as a structured JSON node tree. Omit `node_id` to read from the document root. Provide `node_id` to zoom into a specific subtree.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | no | root | Node to start reading from |
| `max_depth` | number \| null | no | `5` | Depth limit. 0 = target only, null = unlimited |
| `include_collapsed_children` | boolean | no | `false` | Include children of collapsed nodes |
| `include_notes` | boolean | no | `true` | Include node notes |
| `include_checked` | boolean | no | `true` | Include checked/completed nodes |
| `bypass_warning` | boolean | no | `false` | Only set after receiving a size warning |

**Response**:
```json
{
  "file_id": "...",
  "title": "My Document",
  "url": "https://dynalist.io/d/...",
  "node": {
    "node_id": "...",
    "content": "Top-level item",
    "checked": false,
    "checkbox": false,
    "collapsed": false,
    "children_count": 2,
    "children": [
      {
        "node_id": "...",
        "content": "Child item",
        "note": "A note on this node",
        "heading": 1,
        "color": 2,
        "collapsed": false,
        "children_count": 0,
        "children": []
      }
    ]
  }
}
```

**Controlling output size:**
- Response too large? Lower `max_depth` or rely on collapsed node filtering.
- See `depth_limited: true`? Call `read_document` with that node's `node_id` to zoom in.
- See `collapsed: true` with hidden children? Set `include_collapsed_children: true`.
- Need everything? Set `max_depth: null` and `include_collapsed_children: true`.

**Node properties:**
- `heading`: 0 = none, 1 = H1, 2 = H2, 3 = H3. Omitted when 0.
- `color`: 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple. Omitted when 0.
- `note`: omitted when empty (not present in JSON, saves tokens).
- `depth_limited`: true when the depth limit caused children to be hidden.
- `children_count`: always present, shows total direct children regardless of visibility.

#### `search_in_document`

Search for text in a document. Use `parent_levels` to include ancestor breadcrumbs -- the most efficient way to understand where matches live in the hierarchy without a separate `read_document` call.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `query` | string | yes | | Text to search for (case-insensitive) |
| `search_notes` | boolean | no | `true` | Also search in notes |
| `parent_levels` | number | no | `1` | How many parent levels to include (0 = none) |
| `include_children` | boolean | no | `false` | Include direct children of each match |
| `bypass_warning` | boolean | no | `false` | Only set after receiving a size warning |

**Response**:
```json
{
  "file_id": "...",
  "title": "...",
  "url": "...",
  "count": 5,
  "query": "search term",
  "matches": [
    {
      "node_id": "...",
      "content": "...",
      "note": "...",
      "url": "...",
      "checked": false,
      "checkbox": false,
      "heading": 0,
      "color": 0,
      "collapsed": false,
      "parents": [{ "node_id": "...", "content": "..." }],
      "children": [{ "node_id": "...", "content": "..." }]
    }
  ]
}
```

#### `get_recent_changes`

Get nodes created or modified within a time period. Timestamps are milliseconds since epoch. Date-only strings like `"2025-03-11"` are treated as start-of-day for `since` and end-of-day for `until`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `since` | string \| number | yes | | Start date (ISO string or ms timestamp) |
| `until` | string \| number | no | now | End date |
| `type` | string | no | `"both"` | `"created"`, `"modified"`, or `"both"` |
| `parent_levels` | number | no | `1` | Parent context levels (0 = none) |
| `sort` | string | no | `"newest_first"` | `"newest_first"` or `"oldest_first"` |
| `bypass_warning` | boolean | no | `false` | Only set after receiving a size warning |

**Response**:
```json
{
  "file_id": "...",
  "title": "...",
  "url": "...",
  "count": 3,
  "matches": [
    {
      "node_id": "...",
      "content": "...",
      "note": "...",
      "url": "...",
      "change_type": "created",
      "created": 1710000000000,
      "modified": 1710000000000,
      "checked": false,
      "checkbox": false,
      "heading": 0,
      "color": 0,
      "collapsed": false,
      "parents": [{ "node_id": "...", "content": "..." }]
    }
  ]
}
```

#### `check_document_versions`

Check version numbers for documents without fetching content. Useful for detecting changes before expensive reads. The version number increases on every edit.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_ids` | string[] | yes | | Array of document file IDs to check |

**Response**:
```json
{
  "versions": { "file_id_1": 42, "file_id_2": 17 },
  "denied": ["file_id_3"]
}
```

`denied` lists file IDs rejected by access control (IDs only, no metadata leaked).

### Write tools

#### `send_to_inbox`

Send items to your Dynalist inbox. The target document is the user's configured inbox -- it cannot be changed via this tool. For inserting into a specific document, use `insert_node` or `insert_nodes`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | yes | | Text content (single line or indented markdown with `- bullets`) |
| `note` | string | no | | Note for the first/root item |
| `checkbox` | boolean | no | config | Whether to add checkboxes |

**Response**:
```json
{
  "file_id": "...",
  "first_node_id": "...",
  "url": "...",
  "total_created": 5
}
```

#### `edit_node`

Edit an existing node. Only specified fields are updated -- omitted fields are left unchanged (not reset to defaults). This is a partial update.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | yes | | Node ID to edit |
| `content` | string | no | | New content text |
| `note` | string | no | | New note text. Set to `""` to clear. Supports multiline. |
| `checked` | boolean | no | | Checked state |
| `checkbox` | boolean | no | | Whether to show checkbox |
| `heading` | number | no | | 0 = none, 1 = H1, 2 = H2, 3 = H3 |
| `color` | number | no | | 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple |

**Response**:
```json
{
  "file_id": "...",
  "node_id": "...",
  "url": "..."
}
```

#### `insert_node`

Insert a single new node. For inserting multiple nodes with hierarchy, use `insert_nodes` instead.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `parent_id` | string | yes | | Parent node ID |
| `content` | string | yes | | Content text |
| `note` | string | no | | Note text |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |
| `checkbox` | boolean | no | `false` | Add a checkbox |
| `heading` | number | no | | 0 = none, 1 = H1, 2 = H2, 3 = H3 |
| `color` | number | no | | 0-6 (see `edit_node` color values) |
| `checked` | boolean | no | | Checked state. Automatically enables checkbox. |

**Response**:
```json
{
  "file_id": "...",
  "node_id": "...",
  "parent_id": "...",
  "url": "..."
}
```

#### `insert_nodes`

Insert multiple nodes from indented text, preserving hierarchy. Preferred over calling `insert_node` in a loop.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | no | root | Parent node ID |
| `content` | string | yes | | Indented text with `- bullets` or plain indented text |
| `position` | string | no | `"as_last_child"` | `"as_first_child"` or `"as_last_child"` |

Example input:
```
- Top level item
  - Child item
    - Grandchild
- Another top level item
```

**Response**:
```json
{
  "file_id": "...",
  "total_created": 12,
  "root_node_ids": ["...", "...", "..."],
  "url": "..."
}
```

### Structure tools

#### `delete_node`

Delete a node from a document. By default, children are promoted up to the deleted node's parent (the node is removed but its children survive in place). Set `include_children: true` to delete the entire subtree.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | yes | | Node ID to delete |
| `include_children` | boolean | no | `false` | Delete entire subtree if true; promote children if false |

**Response**:
```json
{
  "file_id": "...",
  "deleted_count": 5,
  "promoted_children": 3
}
```

`promoted_children` is present only when children were promoted (i.e. `include_children` is false and the node had children).

#### `move_node`

Move a node and its entire subtree to a new position relative to a reference node.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `node_id` | string | yes | | Node to move |
| `reference_node_id` | string | yes | | Reference node for positioning |
| `position` | string | yes | | `"after"`, `"before"`, `"first_child"`, `"last_child"` |

**Position values:**
- `after`: immediately after the reference (same parent).
- `before`: immediately before the reference (same parent).
- `first_child`: as first child inside the reference.
- `last_child`: as last child inside the reference.

**Response**:
```json
{
  "file_id": "...",
  "node_id": "...",
  "url": "..."
}
```

### File management tools

#### `create_document`

Create a new empty document in a folder. Use `insert_node` or `insert_nodes` to add content afterward.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `parent_folder_id` | string | yes | | Folder file ID |
| `title` | string | no | `""` | Document title |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "title": "...", "url": "..." }`

#### `create_folder`

Create a new empty folder inside another folder.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `parent_folder_id` | string | yes | | Parent folder file ID |
| `title` | string | no | `""` | Folder title |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "title": "..." }`

#### `rename_document`

Rename a document. The `file_id` does not change.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Document file ID |
| `title` | string | yes | | New title |

**Response**: `{ "file_id": "...", "title": "..." }`

#### `rename_folder`

Rename a folder. The `file_id` does not change.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | Folder file ID |
| `title` | string | yes | | New title |

**Response**: `{ "file_id": "...", "title": "..." }`

#### `move_file`

Move a document or folder to a different parent folder. If moving a folder, all its contents move with it.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_id` | string | yes | | File ID to move |
| `parent_folder_id` | string | yes | | Destination folder file ID |
| `index` | number | no | `-1` | Position. 0 = first, -1 = last |

**Response**: `{ "file_id": "...", "parent_folder_id": "..." }`

## Dynalist API coverage

| API Endpoint | MCP Tool(s) | Docs |
|-------------|-------------|------|
| `POST /file/list` | `list_documents`, `search_documents` | [/file/list](https://apidocs.dynalist.io/#get-all-documents-and-folders) |
| `POST /file/edit` | `create_document`, `create_folder`, `rename_document`, `rename_folder`, `move_file` | [/file/edit](https://apidocs.dynalist.io/#make-change-to-documents-folders) |
| `POST /doc/read` | `read_document`, `search_in_document`, `get_recent_changes` | [/doc/read](https://apidocs.dynalist.io/#get-content-of-a-document) |
| `POST /doc/edit` | `edit_node`, `insert_node`, `insert_nodes`, `delete_node`, `move_node` | [/doc/edit](https://apidocs.dynalist.io/#make-change-to-the-content-of-a-document) |
| `POST /doc/check_for_updates` | `check_document_versions` | [/doc/check_for_updates](https://apidocs.dynalist.io/#check-for-updates-of-documents) |
| `POST /inbox/add` | `send_to_inbox` | [/inbox/add](https://apidocs.dynalist.io/#add-to-inbox) |
| `POST /upload` | Not supported | Impractical for LLM tool calls |

## Development

```bash
bun run start        # Run the MCP server
bun run typecheck    # Type-check without emitting (run after making changes)
bun test             # Run the full test suite
bun test --watch     # Run tests in watch mode
bun run inspector    # Debug with MCP Inspector
```

**Typecheck is required after making changes** to ensure no type errors are introduced.

### Testing with MCP Inspector

```bash
DYNALIST_API_TOKEN=your_token bun run inspector
```

### Project structure

```
src/
├── index.ts                      # Entry point, server identity, instructions
├── config.ts                     # Zod-validated config with mtime-based reloading
├── access-control.ts             # Path-based ACL (deny/read/allow policies)
├── types.ts                      # Shared types (OutputNode, NodeSummary, etc.)
├── dynalist-client.ts            # Wrapper for the Dynalist API
├── tools/
│   ├── index.ts                  # Aggregator - registers all tools
│   ├── read.ts                   # Read tools
│   ├── write.ts                  # Write tools
│   ├── structure.ts              # Structure tools (delete, move)
│   └── files.ts                  # File management tools
├── utils/
│   ├── url-parser.ts             # Build Dynalist URLs
│   ├── markdown-parser.ts        # Parse indented text into trees
│   └── dynalist-helpers.ts       # Shared tool helpers
└── tests/
    └── tools/                    # Tool integration tests against dummy server
```

## Acknowledgments

Originally forked from [cristip73/dynalist-mcp](https://github.com/cristip73/dynalist-mcp).

## License

MIT
