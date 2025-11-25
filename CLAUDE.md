# Dynalist MCP Server

Server MCP (Model Context Protocol) care integrează Dynalist.io cu Claude și alți asistenți AI.

## Ce face proiectul

Permite Claude să citească, scrie și manipuleze documente Dynalist programatic prin 10 tool-uri MCP:

**Read**: `list_documents`, `read_node_as_markdown`, `search_in_document`
**Write**: `send_to_inbox`, `edit_node`, `insert_node`, `insert_nodes_from_markdown`
**Structure**: `delete_node`, `move_node`, `move_node_after`

## Structura proiectului

```
src/
├── index.ts                 # Entry point - bootstrap MCP server
├── dynalist-client.ts       # Wrapper pentru Dynalist API
├── tools/index.ts           # Definițiile celor 10 tool-uri MCP
└── utils/
    ├── node-to-markdown.ts  # Conversie noduri → Markdown
    ├── url-parser.ts        # Parse/build URL-uri Dynalist
    └── markdown-parser.ts   # Parse text indentat în arbori
```

## Stack tehnic

- `@modelcontextprotocol/sdk` - framework MCP
- `zod` - validare parametri tool-uri
- TypeScript 5.5, Node.js ES2022

## Comenzi

```bash
npm run build      # Compilare TypeScript → dist/
npm run inspector  # Debug cu MCP Inspector
```

## Configurare

Necesită `DYNALIST_API_TOKEN` în environment. Vezi `.env.example`.

## Arhitectura fluxului

```
Claude Desktop → MCP stdio → index.ts → tools/index.ts → DynalistClient → Dynalist API
```

## Note pentru dezvoltare

- Tool-urile acceptă atât ID-uri cât și URL-uri complete Dynalist (`https://dynalist.io/d/{id}#z={nodeId}`)
- `insert_nodes_from_markdown` face batch insert pentru eficiență
- `move_node_after` oferă poziționare intuitivă (after/before/as_child)
- Toate tool-urile folosesc Zod pentru validare strictă a parametrilor
