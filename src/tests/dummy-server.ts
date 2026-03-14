/**
 * In-memory Dynalist API mock for testing. Implements the same method
 * signatures as DynalistClient but stores all state in memory.
 *
 * Behavioral fidelity follows docs/dynalist-api-behavior.md.
 */

import {
  DynalistClient,
  DynalistApiError,
  type DynalistFile,
  type DynalistNode,
  type ListFilesResponse,
  type ReadDocumentResponse,
  type EditDocumentChange,
  type EditDocumentResponse,
  type InboxAddResponse,
  type FileEditChange,
  type FileEditResponse,
  type CheckForUpdatesResponse,
} from "../dynalist-client";

interface DocumentState {
  title: string;
  version: number;
  nodes: DynalistNode[];
}

export class DummyDynalistServer {
  files = new Map<string, DynalistFile>();
  documents = new Map<string, DocumentState>();
  rootFileId = "root_folder";
  inboxFileId: string | null = null;
  inboxRootNodeId: string | null = null;
  private nodeCounter = 0;
  private fileCounter = 0;
  private editDocFailAfter: number | null = null;
  private editDocHook: ((fileId: string) => void) | null = null;
  private readDocHook: ((fileId: string) => void) | null = null;

  // ─── Setup helpers ───────────────────────────────────────────────

  /**
   * Initialize with a root folder. Call this before adding other files.
   */
  init(): void {
    this.files.set(this.rootFileId, {
      id: this.rootFileId,
      title: "Root",
      type: "folder",
      permission: 4,
      children: [],
    });
  }

  /**
   * Add a folder to the file tree.
   */
  addFolder(id: string, title: string, parentId: string, opts?: { permission?: number }): void {
    this.files.set(id, {
      id,
      title,
      type: "folder",
      permission: opts?.permission ?? 4,
      children: [],
    });
    const parent = this.files.get(parentId);
    if (parent?.children) {
      parent.children.push(id);
    }
  }

  /**
   * Add a document to the file tree and create its node storage.
   */
  addDocument(
    id: string,
    title: string,
    parentId: string,
    nodes?: DynalistNode[],
    opts?: { permission?: number },
  ): void {
    this.files.set(id, {
      id,
      title,
      type: "document",
      permission: opts?.permission ?? 4,
    });
    const parent = this.files.get(parentId);
    if (parent?.children) {
      parent.children.push(id);
    }

    // Create document with at least a root node.
    const docNodes = nodes ?? [this.makeNode("root", title, [])];
    this.documents.set(id, { title, version: 1, nodes: docNodes });
  }

  /**
   * Configure an inbox document.
   */
  setInbox(fileId: string, rootNodeId: string): void {
    this.inboxFileId = fileId;
    this.inboxRootNodeId = rootNodeId;
  }

  /**
   * Configure fault injection: editDocument will throw after N successful
   * calls. The counter resets after the fault triggers.
   */
  failEditAfterNCalls(n: number): void {
    this.editDocFailAfter = n;
  }

  /**
   * Clear any pending fault injection.
   */
  clearEditFault(): void {
    this.editDocFailAfter = null;
  }

  /**
   * Bump a document's version without changing any nodes.
   * Simulates another client editing the document concurrently.
   */
  simulateConcurrentEdit(fileId: string): void {
    const doc = this.documents.get(fileId);
    if (!doc) throw new Error(`simulateConcurrentEdit: document '${fileId}' not found.`);
    doc.version++;
  }

  /**
   * Register a one-shot hook that fires before the next editDocument
   * call processes its changes. The hook can mutate the document to
   * simulate a concurrent edit during the race window.
   */
  onNextEdit(hook: (fileId: string) => void): void {
    this.editDocHook = hook;
  }

  /**
   * Clear any pending edit hook.
   */
  clearEditHook(): void {
    this.editDocHook = null;
  }

  /**
   * Register a one-shot hook that fires before the next readDocument
   * call returns its data. Used to simulate concurrent edits in the
   * TOCTOU window between the version guard's pre-check and the
   * planning read inside the guarded function.
   */
  onNextRead(hook: (fileId: string) => void): void {
    this.readDocHook = hook;
  }

  /**
   * Clear any pending read hook.
   */
  clearReadHook(): void {
    this.readDocHook = null;
  }

  /**
   * Create a DynalistNode with sensible defaults.
   */
  makeNode(
    id: string,
    content: string,
    children: string[],
    extra?: Partial<DynalistNode>,
  ): DynalistNode {
    return {
      id,
      content,
      note: "",
      created: Date.now(),
      modified: Date.now(),
      children,
      collapsed: false,
      ...extra,
    };
  }

  private generateNodeId(): string {
    return `node_${++this.nodeCounter}`;
  }

  private generateFileId(): string {
    return `file_${++this.fileCounter}`;
  }

  // ─── DynalistClient-compatible methods ───────────────────────────

  async listFiles(): Promise<ListFilesResponse> {
    return {
      root_file_id: this.rootFileId,
      files: Array.from(this.files.values()),
    };
  }

  async readDocument(fileId: string): Promise<ReadDocumentResponse> {
    const doc = this.documents.get(fileId);
    if (!doc) {
      throw new DynalistApiError("NotFound", "Document not found.");
    }

    // One-shot hook: fire before returning data to simulate concurrent edits.
    if (this.readDocHook) {
      const hook = this.readDocHook;
      this.readDocHook = null;
      hook(fileId);
    }

    // Clone nodes to match real API behavior: each response is independent
    // JSON, not a shared mutable reference to internal state. Without this,
    // in-place mutations from editDocument would silently update cached
    // responses, masking cache invalidation bugs.
    const cloned = structuredClone(doc.nodes);

    // The real Dynalist API omits `children` for leaf nodes. Strip empty
    // children arrays to match, so tests catch code that assumes `children`
    // is always present.
    for (const node of cloned) {
      if (node.children && node.children.length === 0) {
        delete node.children;
      }
    }

    return {
      file_id: fileId,
      title: doc.title,
      version: doc.version,
      nodes: cloned,
    };
  }

  async editDocument(fileId: string, changes: EditDocumentChange[]): Promise<EditDocumentResponse> {
    const doc = this.documents.get(fileId);
    if (!doc) {
      throw new DynalistApiError("NotFound", "Document not found.");
    }

    // One-shot hook: fire before processing to simulate concurrent edits.
    if (this.editDocHook) {
      const hook = this.editDocHook;
      this.editDocHook = null;
      hook(fileId);
    }

    // Fault injection: decrement counter and throw when it reaches zero.
    if (this.editDocFailAfter !== null) {
      if (this.editDocFailAfter <= 0) {
        this.editDocFailAfter = null;
        throw new DynalistApiError("ServerError", "Injected fault: editDocument failed.");
      }
      this.editDocFailAfter--;
    }

    const newNodeIds: string[] = [];

    // Snapshot parent child counts before processing changes. The real
    // Dynalist API snapshots parent state before processing a batch, so
    // index -1 resolves to the same position for every insert or move
    // targeting the same parent. This causes items to reverse when
    // multiple inserts/moves use -1 on the same parent.
    const snapshotChildCounts = new Map<string, number>();
    for (const change of changes) {
      const parentId = change.action === "insert" ? change.parent_id : change.action === "move" ? change.parent_id : undefined;
      if (parentId && !snapshotChildCounts.has(parentId)) {
        const parent = doc.nodes.find((n) => n.id === parentId);
        if (parent) {
          snapshotChildCounts.set(parentId, parent.children!.length);
        }
      }
    }

    for (const change of changes) {
      switch (change.action) {
        case "insert": {
          const nodeId = this.generateNodeId();
          const node: DynalistNode = {
            id: nodeId,
            content: change.content ?? "",
            note: change.note ?? "",
            created: Date.now(),
            modified: Date.now(),
            children: [],
            collapsed: false,
          };
          if (change.checked !== undefined) node.checked = change.checked;
          if (change.checkbox !== undefined) node.checkbox = change.checkbox;
          if (change.heading !== undefined) node.heading = change.heading;
          if (change.color !== undefined) node.color = change.color;

          doc.nodes.push(node);

          // Add to parent's children at the specified index. Resolve -1
          // against the snapshotted child count to match real API behavior.
          const parent = doc.nodes.find((n) => n.id === change.parent_id);
          if (parent) {
            if (change.index === -1 || change.index === undefined) {
              const snapshotCount = snapshotChildCounts.get(change.parent_id!) ?? parent.children!.length;
              parent.children!.splice(snapshotCount, 0, nodeId);
            } else {
              parent.children!.splice(change.index, 0, nodeId);
            }
          }

          newNodeIds.push(nodeId);
          break;
        }

        case "edit": {
          const node = doc.nodes.find((n) => n.id === change.node_id);
          if (!node) {
            throw new DynalistApiError("NodeNotFound", `Node '${change.node_id}' not found.`);
          }

          // Partial update: only set fields that are present in the change.
          if (change.content !== undefined) node.content = change.content;
          if (change.note !== undefined) node.note = change.note;
          if (change.checked !== undefined) node.checked = change.checked;
          if (change.checkbox !== undefined) node.checkbox = change.checkbox;
          if (change.heading !== undefined) {
            if (change.heading === 0) {
              delete node.heading;
            } else {
              node.heading = change.heading;
            }
          }
          if (change.color !== undefined) {
            if (change.color === 0) {
              delete node.color;
            } else {
              node.color = change.color;
            }
          }
          node.modified = Date.now();
          break;
        }

        case "move": {
          const node = doc.nodes.find((n) => n.id === change.node_id);
          if (!node) break;

          // Remove from current parent.
          for (const n of doc.nodes) {
            const idx = n.children!.indexOf(change.node_id!);
            if (idx !== -1) {
              n.children!.splice(idx, 1);
              break;
            }
          }

          // Add to new parent. Resolve -1 against the snapshotted child
          // count to match real API behavior (same as inserts).
          const newParent = doc.nodes.find((n) => n.id === change.parent_id);
          if (newParent) {
            if (change.index === -1 || change.index === undefined) {
              const snapshotCount = snapshotChildCounts.get(change.parent_id!) ?? newParent.children!.length;
              newParent.children!.splice(snapshotCount, 0, change.node_id!);
            } else {
              newParent.children!.splice(change.index, 0, change.node_id!);
            }
          }

          node.modified = Date.now();
          break;
        }

        case "delete": {
          // Per API behavior: single-node delete, children become orphaned.
          const nodeId = change.node_id!;

          // Remove from parent's children array.
          for (const n of doc.nodes) {
            const idx = n.children!.indexOf(nodeId);
            if (idx !== -1) {
              n.children!.splice(idx, 1);
              break;
            }
          }

          // Remove the node itself from the document's node array.
          const nodeIdx = doc.nodes.findIndex((n) => n.id === nodeId);
          if (nodeIdx !== -1) {
            doc.nodes.splice(nodeIdx, 1);
          }
          break;
        }
      }
    }

    doc.version++;
    return {
      new_node_ids: newNodeIds.length > 0 ? newNodeIds : undefined,
      batches_sent: 1,
    };
  }

  async sendToInbox(options: {
    content: string;
    note?: string;
    index?: number;
    checked?: boolean;
    checkbox?: boolean;
    heading?: number;
    color?: number;
  }): Promise<InboxAddResponse> {
    if (!this.inboxFileId || !this.inboxRootNodeId) {
      throw new DynalistApiError("NoInbox", "No inbox location configured.");
    }

    const doc = this.documents.get(this.inboxFileId);
    if (!doc) {
      throw new DynalistApiError("NotFound", "Inbox document not found.");
    }

    const nodeId = this.generateNodeId();
    const node: DynalistNode = {
      id: nodeId,
      content: options.content,
      note: options.note ?? "",
      created: Date.now(),
      modified: Date.now(),
      children: [],
      collapsed: false,
    };
    if (options.checked !== undefined) node.checked = options.checked;
    if (options.checkbox !== undefined) node.checkbox = options.checkbox;
    if (options.heading !== undefined && options.heading > 0) node.heading = options.heading;
    if (options.color !== undefined && options.color > 0) node.color = options.color;

    doc.nodes.push(node);

    const root = doc.nodes.find((n) => n.id === this.inboxRootNodeId);
    const index = options.index ?? -1;
    if (root) {
      if (index === -1) {
        root.children!.push(nodeId);
      } else {
        root.children!.splice(index, 0, nodeId);
      }
    }

    doc.version++;
    return {
      file_id: this.inboxFileId,
      node_id: nodeId,
      index: index === -1 ? (root?.children!.length ?? 1) - 1 : index,
    };
  }

  async editFiles(changes: FileEditChange[]): Promise<FileEditResponse> {
    const results: boolean[] = [];
    const created: string[] = [];

    for (const change of changes) {
      switch (change.action) {
        case "create": {
          const parentFile = this.files.get(change.parent_id!);
          if (!parentFile || parentFile.type !== "folder") {
            results.push(false);
            break;
          }

          const fileId = this.generateFileId();
          const title = change.title || "Untitled";

          if (change.type === "document") {
            this.files.set(fileId, {
              id: fileId,
              title,
              type: "document",
              permission: 4,
            });
            // Create document with root node.
            this.documents.set(fileId, {
              title,
              version: 1,
              nodes: [this.makeNode("root", title, [])],
            });
          } else {
            this.files.set(fileId, {
              id: fileId,
              title,
              type: "folder",
              permission: 4,
              children: [],
            });
          }

          // Add to parent.
          const idx = change.index ?? -1;
          if (idx === -1) {
            parentFile.children!.push(fileId);
          } else {
            parentFile.children!.splice(idx, 0, fileId);
          }

          results.push(true);
          created.push(fileId);
          break;
        }

        case "edit": {
          const file = this.files.get(change.file_id!);
          if (!file) {
            results.push(false);
            break;
          }
          if (change.title !== undefined) {
            file.title = change.title;
            // Also update document title if it's a document.
            const doc = this.documents.get(change.file_id!);
            if (doc) doc.title = change.title;
          }
          results.push(true);
          break;
        }

        case "move": {
          const file = this.files.get(change.file_id!);
          const destFolder = this.files.get(change.parent_id!);
          if (!file || !destFolder || destFolder.type !== "folder") {
            results.push(false);
            break;
          }

          // Remove from current parent.
          for (const f of this.files.values()) {
            if (f.children) {
              const idx = f.children.indexOf(change.file_id!);
              if (idx !== -1) {
                f.children.splice(idx, 1);
                break;
              }
            }
          }

          // Add to new parent.
          const moveIdx = change.index ?? -1;
          if (moveIdx === -1) {
            destFolder.children!.push(change.file_id!);
          } else {
            destFolder.children!.splice(moveIdx, 0, change.file_id!);
          }

          results.push(true);
          break;
        }
      }
    }

    return { results, created: created.length > 0 ? created : undefined };
  }

  async checkForUpdates(fileIds: string[]): Promise<CheckForUpdatesResponse> {
    const versions: Record<string, number> = {};
    for (const id of fileIds) {
      const doc = this.documents.get(id);
      if (doc) {
        versions[id] = doc.version;
      }
      // Non-existent IDs are silently dropped per API behavior.
    }
    return { versions };
  }
}

/**
 * DynalistClient subclass that delegates to a DummyDynalistServer.
 * Allows tools to receive a real DynalistClient type while using
 * in-memory state.
 */
export class MockDynalistClient extends DynalistClient {
  readonly server: DummyDynalistServer;

  constructor(server: DummyDynalistServer) {
    super("mock-token");
    this.server = server;
  }

  override listFiles() {
    return this.server.listFiles();
  }

  override readDocument(fileId: string) {
    return this.server.readDocument(fileId);
  }

  override editDocument(fileId: string, changes: EditDocumentChange[]) {
    return this.server.editDocument(fileId, changes);
  }

  override sendToInbox(options: {
    content: string;
    note?: string;
    index?: number;
    checked?: boolean;
    checkbox?: boolean;
    heading?: number;
    color?: number;
  }) {
    return this.server.sendToInbox(options);
  }

  override editFiles(changes: FileEditChange[]) {
    return this.server.editFiles(changes);
  }

  override checkForUpdates(fileIds: string[]) {
    return this.server.checkForUpdates(fileIds);
  }
}

/**
 * Create a standard test scenario with a root folder, two folders,
 * and two documents with sample nodes.
 */
export function createTestScenario(): { server: DummyDynalistServer; client: MockDynalistClient } {
  const server = new DummyDynalistServer();
  server.init();

  // Folder structure: Root > [Folder A, Folder B].
  server.addFolder("folder_a", "Folder A", "root_folder");
  server.addFolder("folder_b", "Folder B", "root_folder");

  // Document in Folder A with a small tree.
  server.addDocument("doc1", "Test Document", "folder_a", [
    server.makeNode("root", "Test Document", ["n1", "n2"]),
    server.makeNode("n1", "First item", ["n1a", "n1b"]),
    server.makeNode("n1a", "Child A", []),
    server.makeNode("n1b", "Child B", []),
    server.makeNode("n2", "Second item", ["n2a"]),
    server.makeNode("n2a", "Nested child", []),
  ]);

  // Document in Folder B.
  server.addDocument("doc2", "Another Document", "folder_b", [
    server.makeNode("root", "Another Document", ["m1"]),
    server.makeNode("m1", "Only item", []),
  ]);

  // Set up inbox.
  server.addDocument("inbox_doc", "Inbox", "root_folder", [
    server.makeNode("inbox_root", "Inbox", []),
  ]);
  server.setInbox("inbox_doc", "inbox_root");

  return { server, client: new MockDynalistClient(server) };
}
