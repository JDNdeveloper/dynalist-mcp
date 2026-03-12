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
├── config.ts                     # Load ~/.dynalist-mcp.json user config
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

Optional: `~/.dynalist-mcp.json` for user-configurable defaults:
```json
{
  "readDefaults": {
    "maxDepth": 5,
    "includeNotes": true,
    "includeChecked": true
  }
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
