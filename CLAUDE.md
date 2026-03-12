# Dynalist MCP Server

MCP (Model Context Protocol) server that integrates Dynalist.io with Claude and other AI assistants.

## What this project does

Allows Claude to read, write, and manipulate Dynalist documents programmatically via 17 MCP tools:

**Read**: `list_documents`, `search_documents`, `read_document`, `search_in_document`, `get_recent_changes`, `check_document_versions`
**Write**: `send_to_inbox`, `edit_node`, `insert_node`, `insert_nodes`
**Structure**: `delete_node`, `move_node`
**Files**: `create_document`, `create_folder`, `rename_document`, `rename_folder`, `move_file`

## Project structure

```
src/
├── index.ts                      # Entry point - bootstrap MCP server
├── config.ts                     # Zod-validated config with mtime-based reloading
├── access-control.ts             # Path-based ACL (deny/read/allow policies)
├── types.ts                      # Shared types (OutputNode, NodeSummary, etc.)
├── dynalist-client.ts            # Wrapper for the Dynalist API
├── tools/
│   ├── index.ts                  # Aggregator - imports and registers all tools
│   ├── read.ts                   # Read tools (list, search, read_document, etc.)
│   ├── write.ts                  # Write tools (inbox, edit, insert)
│   ├── structure.ts              # Structure tools (delete, move)
│   └── files.ts                  # File management tools (create, rename, move)
└── utils/
    ├── url-parser.ts             # Build Dynalist URLs
    ├── markdown-parser.ts        # Parse indented text into trees
    └── dynalist-helpers.ts       # Shared tool helpers (size check, tree builder, etc.)
```

## Tech stack

- `@modelcontextprotocol/sdk` - MCP framework
- `zod` - tool parameter and output schema validation
- TypeScript 5, Bun runtime (runs TS natively, no build step)

## Commands

```bash
bun run start      # Run the MCP server
bun run typecheck  # Type-check without emitting (run after making changes)
bun run inspector  # Debug with MCP Inspector
```

## Configuration

Requires `DYNALIST_API_TOKEN` in the environment. See `.env.example`.

Optional: `~/.dynalist-mcp.json` (or `DYNALIST_MCP_CONFIG` env var) for configuration.
All fields are optional with sensible defaults. Zod-validated, reloaded on mtime change.
```json
{
  "access": {
    "default": "allow",
    "rules": [
      { "path": "/Private/**", "policy": "deny" },
      { "path": "/Archive/**", "policy": "read" }
    ]
  },
  "readDefaults": {
    "maxDepth": 5,
    "includeCollapsedChildren": false,
    "includeNotes": true,
    "includeChecked": true
  },
  "sizeWarning": { "warningTokenThreshold": 5000, "maxTokenThreshold": 24500 },
  "inbox": { "defaultCheckbox": false },
  "readOnly": false,
  "cache": { "ttlSeconds": 300 },
  "logLevel": "warn"
}
```

## Architecture

```
Claude Desktop → MCP stdio → index.ts → tools/*.ts → DynalistClient → Dynalist API
```

## Development notes

- Tools accept only IDs (`file_id`, `node_id`), not URLs. URLs are included in responses for human convenience.
- All tools use `registerTool` with `outputSchema` and return `structuredContent` + text fallback.
- `insert_nodes` does batch inserts level-by-level for efficiency.
- `move_node` uses relative positioning (after/before/first_child/last_child).
- `read_document` returns a structured JSON tree with depth limiting and collapsed-node filtering.
- All tools use Zod for strict input and output schema validation.
- Every tool handler checks access control (deny/read/allow) before making API calls.
- File tree cache is invalidated after create/rename/move operations and on denial retries.
- Config is checked for mtime changes on every tool invocation (stat only, no read unless changed).
- Invalid config fails closed (all tools error until config is fixed or removed).
