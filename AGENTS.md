# Dynalist MCP Server

Other agent prompt files (e.g. `CLAUDE.md`) are symlinks to `AGENTS.md`. All edits should be made in `AGENTS.md`.

MCP (Model Context Protocol) server that integrates Dynalist.io with Claude and other AI assistants. Allows reading, writing, searching, and organizing Dynalist documents programmatically.

## Setup

No build step. Bun runs TypeScript natively.

```bash
bun install          # Install dependencies
bun run start        # Run the MCP server
```

> **Warning:** MCP Inspector and MCP clients (e.g. Claude Code) connect to a live Dynalist account and can modify and delete data. Make sure your `DYNALIST_API_TOKEN` points to a **test account**, not your real one. If you are unsure, list all documents and confirm they look like a test account's documents, not real ones.

## **IMPORTANT: After making ANY code changes, run `bun run check`.**

```bash
bun run check        # Typecheck + lint + tests + generate docs
```

**This is mandatory before committing.** Under the hood, `check` runs four steps in order:

1. `bun run typecheck` (tsc --noEmit).
2. `bun run lint` (ESLint).
3. `bun test` (full test suite against dummy server).
4. `bun run generate-docs` (regenerate docs/tools.md, docs/configuration.md, docs/api-coverage.md, docs/instructions.md from source).

If any step fails, do not commit. Fix the issue first.

Individual steps if needed during development:

```bash
bun run typecheck    # Just tsc --noEmit
bun run lint         # Just ESLint
bun test             # Just the test suite
bun test --watch     # Watch mode for development
bun run generate-docs # Just regenerate docs
```

Tests run against a dummy Dynalist server (in-memory) via the real MCP protocol. Test files are in `src/tests/tools/`.

## Development workflow

1. Make changes.
2. Run `bun run check` to verify everything passes.

## Updating package.json

`package.json` is the single source of truth for project metadata. Keep it in sync when: adding or removing dependencies, adding new scripts, changing the project description, or bumping the version.

## Project structure

Only files of note are listed. Use the filesystem for a complete listing.

```
src/
├── index.ts                      # Entry point, server identity
├── instructions.ts               # MCP instructions prompt (shared with doc generator)
├── config.ts                     # Zod-validated config with mtime-based reloading
├── access-control.ts             # Path-based ACL (deny/read/allow policies)
├── document-store.ts             # LRU-cached document reader with version checks
├── types.ts                      # Shared types (OutputNode, NodeSummary, etc.)
├── dynalist-client.ts            # Wrapper for the Dynalist API
├── version-guard.ts              # Pre/post-write version checks for race detection
├── tools/
│   ├── index.ts                  # Aggregator - registers all tools
│   ├── descriptions.ts           # Shared parameter descriptions and guidance constants
│   ├── node-metadata.ts          # Heading/color string enums and API translation maps
│   ├── read.ts                   # Read tools (list, search, read_document, etc.)
│   ├── write.ts                  # Write tools (inbox, edit, insert)
│   ├── structure.ts              # Structure tools (delete, move)
│   └── files.ts                  # File management tools (create, rename, move)
├── utils/
│   └── dynalist-helpers.ts       # Shared tool helpers (size check, tree builder, etc.)
└── tests/
    └── tools/                    # Tool integration tests against dummy server
scripts/
├── bundle.sh                     # Build the .mcpb distribution artifact
├── generate-docs.ts              # Generate docs/tools.md, configuration.md, api-coverage.md, instructions.md
├── generate-manifest.ts          # Generate dist/manifest.json from package.json
├── haiku-validation.ts           # Weak-model instruction validation harness
└── release.sh                    # Tag, release, and upload .mcpb to GitHub

```

## MCP text: instructions vs. tool descriptions

There are three places text reaches the agent, each with a different role:

- **MCP instructions** (`src/instructions.ts`): cross-tool workflow patterns, system-level concepts, and general rules of engagement. Example: "Read a document before writing to obtain the version." Do not repeat per-tool details here.
- **Tool description** (the `description` field on each tool): what the tool does and when to use it. Example: "Edit one or more nodes in a document."
- **Parameter descriptions** (Zod `.describe()` strings): what a single parameter means, where to get the value, and what happens on invalid input. Example: "Document version from your most recent read_document response."

### Writing style

All MCP text must be concise, precise, and unambiguous. Every sentence should carry information. Use imperative language and state constraints as rules, not suggestions.

Bad (verbose, hedging):
> You might want to consider reading the document first to get the version number, which you can then pass to the write tool.

Good (dense, imperative):
> Read the document before writing. Pass the returned version as expected_version.

Additional principles:

- **Drop context-redundant qualifiers.** Every tool runs inside the Dynalist MCP server, so "a Dynalist document" is just "a document". Do not restate context the agent already has.
- **Do not explain basic JSON schema usage.** Agents understand that an array parameter accepts one element. Hints like "for a single node, pass a one-element array" are noise.
- **Break long `.describe()` strings across lines.** Use string concatenation (`+`) and parentheses for readability. Short descriptions can stay inline.

### Deduplication

Do not duplicate guidance across levels. If something is tool-specific, put it in the tool or parameter description. If it is a cross-cutting pattern, put it in the MCP instructions. Factor commonly repeated strings and substrings into `src/tools/descriptions.ts` so wording changes only need to happen once. That file already uses `*_GUIDANCE` constants for shared policy wording that is interpolated into both parameter descriptions and MCP instructions.

**Exception:** Inline value meanings (enum values, etc.) are repeated wherever they appear within a single description level. This avoids the agent having to cross-reference a central definition to interpret a parameter. Examples: the color label enum (`'none', 'red', 'orange', ...`) and heading level enum (`'none', 'h1', 'h2', 'h3'`) are spelled out in each parameter that accepts them. Value meanings should NOT be repeated across levels (e.g. tool description restating what a parameter description already covers).

## Key conventions

- **Tool parameter validation**: all tools use Zod schemas for strict input and output validation.
- **Access control**: every tool handler checks access control (deny/read/allow) before making API calls.
- **Error handling**: all tool handlers are wrapped in `wrapToolHandler` which catches exceptions and returns structured MCP error responses.
- **Response format**: success responses return both `structuredContent` and a text content block for backwards compatibility, via `makeResponse()`. Error responses return only a text content block (no `structuredContent`) to avoid MCP client SDK schema validation failures.
- **IDs only**: tools accept `file_id` and `node_id` parameters, not URLs. URLs are included in responses for human convenience.
- **Config reloading**: config file is checked for mtime changes on every tool invocation (stat only, no read unless changed). Invalid config fails closed.
- **Cache invalidation**: file tree cache is invalidated after create/rename/move operations and on denial retries.
- **Property ordering**: any property whose value is a nested structure (array of objects, recursive tree, etc.) must be the last property on its containing object, in both schemas and response construction. This keeps scalar metadata visually adjacent to the primary content in serialized JSON. See `docs/agent-ux.md` "Property ordering" for the full canonical field order, rationale, and examples.

## When tools change

Changing a tool's input/output schema, description, or parameter descriptions can affect multiple files. After any such change:

1. **Source file** (`src/tools/*.ts`): the primary edit.
2. **Generated docs**: run `bun run generate-docs` (or `bun run check`). This regenerates `docs/tools.md`, `docs/configuration.md`, `docs/api-coverage.md`, and `docs/instructions.md` from source.
3. **MCP instructions** (`src/instructions.ts`): update if the change affects cross-tool workflow patterns, compositional patterns, or system-level concepts referenced in the `INSTRUCTIONS` constant.
4. **Shared descriptions** (`src/tools/descriptions.ts`): update if the change affects a `*_GUIDANCE` or `*_DESCRIPTION` constant shared across tools.
5. **Hand-maintained docs** (see list below): update any doc whose scope covers the changed behavior (e.g. `docs/agent-ux.md` for rendering changes, `docs/concurrency.md` for version guard changes).
6. **Tests** (`src/tests/tools/`): add or update tests covering the new behavior.

When adding a **new** tool, also:

7. **Tool count in `README.md`**: update the "**N tools**" count in the Features section.

If the new tool goes in a **new category file** (i.e., a new `src/tools/*.ts` register function rather than adding to an existing one), also:

8. **Tool aggregator** (`src/tools/index.ts`): import and call the new register function.
9. **Test helpers** (`src/tests/tools/test-helpers.ts`): import and call the new register function so tests discover the tool.
10. **Doc generator** (`scripts/generate-docs.ts`): import the new register function and add a `captureGroup()` call.

## When adding a new source file

Update the project structure trees in both `AGENTS.md` and `README.md`. Both trees list only files of note, not every file. Add the new file if it represents a distinct responsibility worth calling out (not every helper or one-off script needs an entry). The `README.md` tree is a subset of the `AGENTS.md` tree and omits `scripts/`.

## Documentation

The following docs must be kept up to date when the corresponding features change:

- `README.md`: Getting started, feature summary, connect instructions, security model.
- `docs/tools.md`: **Generated.** Do not edit by hand. Run `bun run generate-docs` (or `bun run check`).
- `docs/configuration.md`: **Generated.** Do not edit by hand. Run `bun run generate-docs` (or `bun run check`).
- `docs/access-control.md`: ACL rules, glob syntax, specificity, ID anchoring, examples. Update when access control behavior changes.
- `docs/client-setup.md`: Claude Desktop, Claude Code, and general MCP client setup. Update when supported clients or connection instructions change.
- `docs/api-coverage.md`: **Generated.** Do not edit by hand. Run `bun run generate-docs` (or `bun run check`).
- `docs/instructions.md`: **Generated.** Do not edit by hand. Run `bun run generate-docs` (or `bun run check`).
- `docs/agent-ux.md`: How MCP instructions shape agent rendering, confirmations, size management, and composability. Update when instruction text or description constants change.
- `docs/concurrency.md`: Version guards, position resolution, deletion ordering, cache invalidation, race testing. Update when write-path concurrency logic changes.
- `docs/performance.md`: Document cache, file tree cache, config reloading, batching, node maps. Update when caching or performance-related logic changes.
- `docs/dynalist-api-behavior.md`: Observed Dynalist API behavior and edge cases.
- `docs/testing.md`: Dummy server, race simulation, agent-driven live testing, weak-model instruction validation. Update when testing strategies or infrastructure change.

## Bundling and releasing

Anyone can run `bun run bundle` to build the `.mcpb` archive locally. It typechecks, tests, builds `dist/index.js`, generates `dist/manifest.json`, and packs the `.mcpb`. The bundled `dist/index.js` targets Node.js, so end users do not need Bun installed. The `dist/` directory is gitignored and fully regenerated on each build.

Releasing requires maintainer push access. After pushing changes to `main`, regenerate the bundle and publish a release:

1. Confirm the target version with the user before editing `package.json`. Suggest a reasonable SemVer bump based on scope, such as patch (`x.y.z` -> `x.y.(z+1)`), minor (`x.y.z` -> `x.(y+1).0`), or major (`x.y.z` -> `(x+1).0.0`).
2. Bump `version` in `package.json` (single source of truth for both the package and generated `manifest.json`).
3. Run `bun run check` as a final sanity check before release.
4. Commit and push the version bump and release-ready changes before running the release pipeline.
5. Run `bun run release` to bundle, tag, create a GitHub release, and upload the `.mcpb` as a release asset. Requires a clean working tree on the `main` branch and the tag must not already exist.
