# Dynalist MCP Server

MCP (Model Context Protocol) server that integrates Dynalist.io with Claude and other AI assistants. Allows reading, writing, searching, and organizing Dynalist documents programmatically via 17 MCP tools.

## Build

No build step. Bun runs TypeScript natively.

```bash
bun install          # Install dependencies
bun run start        # Run the MCP server
```

## Test

```bash
bun test             # Run the full test suite
bun test --watch     # Watch mode for development
```

Tests run against a dummy Dynalist server (in-memory) via the real MCP protocol. Test files are in `src/tests/tools/`.

## Typecheck

```bash
bun run typecheck    # Runs tsc --noEmit
```

**Required after making code changes.** Must pass before committing.

## Development workflow

1. Make changes.
2. Run `bun run typecheck` to verify no type errors.
3. Run `bun test` to verify no regressions.

## Updating package.json

`package.json` is the single source of truth for project metadata. Keep it in sync when: adding or removing dependencies, adding new scripts, changing the project description, or bumping the version.

## Project structure

```
src/
├── index.ts                      # Entry point, server identity, MCP instructions
├── config.ts                     # Zod-validated config with mtime-based reloading
├── access-control.ts             # Path-based ACL (deny/read/allow policies)
├── types.ts                      # Shared types (OutputNode, NodeSummary, etc.)
├── dynalist-client.ts            # Wrapper for the Dynalist API
├── tools/
│   ├── index.ts                  # Aggregator - registers all tools
│   ├── read.ts                   # Read tools (list, search, read_document, etc.)
│   ├── write.ts                  # Write tools (inbox, edit, insert)
│   ├── structure.ts              # Structure tools (delete, move)
│   └── files.ts                  # File management tools (create, rename, move)
├── utils/
│   ├── url-parser.ts             # Build Dynalist URLs
│   ├── markdown-parser.ts        # Parse indented text into trees
│   └── dynalist-helpers.ts       # Shared tool helpers (size check, tree builder, etc.)
└── tests/
    └── tools/                    # Tool integration tests against dummy server
scripts/
├── bundle.sh                     # Build the .mcpb distribution artifact
├── generate-manifest.ts          # Generate dist/manifest.json from package.json
└── release.sh                    # Tag, release, and upload .mcpb to GitHub
assets/
└── icon.png                      # Dynalist icon for the bundle
```

## Key conventions

- **Tool parameter validation**: all tools use Zod schemas for strict input and output validation.
- **Access control**: every tool handler checks access control (deny/read/allow) before making API calls.
- **Error handling**: all tool handlers are wrapped in `wrapToolHandler` which catches exceptions and returns structured MCP error responses.
- **Response format**: all tools return both `structuredContent` and a text content block for backwards compatibility, via `makeResponse()`.
- **IDs only**: tools accept `file_id` and `node_id` parameters, not URLs. URLs are included in responses for human convenience.
- **Config reloading**: config file is checked for mtime changes on every tool invocation (stat only, no read unless changed). Invalid config fails closed.
- **Cache invalidation**: file tree cache is invalidated after create/rename/move operations and on denial retries.

## Documentation

The following docs must be kept up to date when the corresponding features change:

- `README.md`: Getting started, feature summary, connect instructions, security model.
- `docs/tools.md`: Parameter tables, response shapes, and usage notes for all 17 tools. Update when tool parameters, responses, or descriptions change.
- `docs/configuration.md`: Config file reference, environment variables, field table, logging. Update when config schema or defaults change.
- `docs/access-control.md`: ACL rules, glob syntax, specificity, ID anchoring, examples. Update when access control behavior changes.
- `docs/client-setup.md`: Claude Desktop, Claude Code, and general MCP client setup. Update when supported clients or connection instructions change.
- `docs/api-coverage.md`: Mapping between Dynalist API endpoints and MCP tools. Update when tools are added or removed.
- `docs/dynalist_api_behavior.md`: Observed Dynalist API behavior and edge cases.

## Bundling and releasing

Anyone can run `bun run bundle` to build the `.mcpb` archive locally. It typechecks, tests, builds `dist/index.js`, generates `dist/manifest.json`, and packs the `.mcpb`. The bundled `dist/index.js` targets Node.js, so end users do not need Bun installed. The `dist/` directory is gitignored and fully regenerated on each build.

Releasing requires maintainer push access. After pushing changes to `main`, regenerate the bundle and publish a release:

1. Bump `version` in `package.json` (single source of truth for both the package and generated `manifest.json`).
2. Run `bun run release` to bundle, tag, create a GitHub release, and upload the `.mcpb` as a release asset. Requires a clean working tree on the `main` branch and the tag must not already exist.
