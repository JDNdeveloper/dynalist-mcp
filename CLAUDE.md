# Dynalist MCP Server

MCP (Model Context Protocol) server that integrates Dynalist.io with Claude and other AI assistants.

## What this project does

Allows Claude to read, write, and manipulate Dynalist documents programmatically via 12 MCP tools:

**Read**: `list_documents`, `search_documents`, `read_node_as_markdown`, `search_in_document`, `get_recent_changes`
**Write**: `send_to_inbox`, `edit_node`, `insert_node`, `insert_nodes_from_markdown`
**Structure**: `delete_node`, `move_node`, `move_node_relative`

## Project structure

```
src/
├── index.ts                 # Entry point - bootstrap MCP server
├── dynalist-client.ts       # Wrapper for the Dynalist API
├── tools/index.ts           # Definitions for all MCP tools
└── utils/
    ├── node-to-markdown.ts  # Convert nodes to Markdown
    ├── url-parser.ts        # Parse/build Dynalist URLs
    └── markdown-parser.ts   # Parse indented text into trees
```

## Tech stack

- `@modelcontextprotocol/sdk` - MCP framework
- `zod` - tool parameter validation
- TypeScript 5, Bun runtime (runs TS natively, no build step)

## Commands

```bash
bun run start      # Run the MCP server
bun run typecheck  # Type-check without emitting (run after making changes)
bun run inspector  # Debug with MCP Inspector
```

## Configuration

Requires `DYNALIST_API_TOKEN` in the environment. See `.env.example`.

## Architecture

```
Claude Desktop → MCP stdio → index.ts → tools/index.ts → DynalistClient → Dynalist API
```

## Development notes

- Tools accept both IDs and full Dynalist URLs (`https://dynalist.io/d/{id}#z={nodeId}`).
- `insert_nodes_from_markdown` does batch inserts for efficiency.
- `move_node_relative` provides intuitive positioning (after/before/as_child).
- All tools use Zod for strict parameter validation.
