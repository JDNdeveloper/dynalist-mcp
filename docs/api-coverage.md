# Dynalist API Coverage

| API Endpoint | MCP Tool(s) | Docs |
|-------------|-------------|------|
| `POST /file/list` | `list_documents`, `search_documents` | [/file/list](https://apidocs.dynalist.io/#get-all-documents-and-folders) |
| `POST /file/edit` | `create_document`, `create_folder`, `rename_document`, `rename_folder`, `move_file` | [/file/edit](https://apidocs.dynalist.io/#make-change-to-documents-folders) |
| `POST /doc/read` | `read_document`, `search_in_document`, `get_recent_changes` | [/doc/read](https://apidocs.dynalist.io/#get-content-of-a-document) |
| `POST /doc/edit` | `edit_node`, `insert_node`, `insert_nodes`, `delete_node`, `move_node` | [/doc/edit](https://apidocs.dynalist.io/#make-change-to-the-content-of-a-document) |
| `POST /doc/check_for_updates` | `check_document_versions` | [/doc/check_for_updates](https://apidocs.dynalist.io/#check-for-updates-of-documents) |
| `POST /inbox/add` | `send_to_inbox` | [/inbox/add](https://apidocs.dynalist.io/#add-to-inbox) |
| `POST /upload` | Not supported | Impractical for LLM tool calls |
