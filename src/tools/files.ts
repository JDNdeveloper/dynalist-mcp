/**
 * File management tools: create_document, create_folder,
 * rename_document, rename_folder, move_document, move_folder.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, FileEditResponse } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import { getConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
} from "../utils/dynalist-helpers";
import { CONFIRM_GUIDANCE } from "./descriptions";

export function registerFileTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: create_document
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "create_document",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Create a new empty document in a folder. The returned file_id can be used with " +
        "insert_nodes to add content to the new document.",
      inputSchema: {
        parent_folder_id: z.string().describe("Folder file ID to create the document in"),
        title: z.string().optional().default("").describe("Document title"),
        index: z.number().optional().default(-1).describe(
          "Position in folder. 0 = first, -1 = last (default)."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("File ID of the new document"),
        title: z.string().describe("Document title"),
        url: z.string().describe("Dynalist URL for the new document"),
      },
    },
    wrapToolHandler(async ({
      parent_folder_id,
      title,
      index,
    }: {
      parent_folder_id: string;
      title: string;
      index: number;
    }) => {
      const config = getConfig();

      // Access check: creating requires allow on the parent folder.
      const parentPolicy = await ac.getPolicy(parent_folder_id, config);
      const accessError = requireAccess(parentPolicy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const response = await client.editFiles([{
        action: "create",
        type: "document",
        parent_id: parent_folder_id,
        title,
        index,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to create document. The parent folder may not exist.");
      }

      const fileId = response.created?.[0];
      if (!fileId) {
        return makeErrorResponse("ApiError", "Document created but no file ID was returned.");
      }

      // Invalidate path cache since the file tree changed.
      ac.invalidateCache();

      return makeResponse({
        file_id: fileId,
        title,
        url: buildDynalistUrl(fileId),
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: create_folder
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "create_folder",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Create a new empty folder inside another folder. Documents and other folders can be " +
        "created inside it or moved into it afterward.",
      inputSchema: {
        parent_folder_id: z.string().describe("Parent folder file ID to create in"),
        title: z.string().optional().default("").describe("Folder title"),
        index: z.number().optional().default(-1).describe(
          "Position in parent. 0 = first, -1 = last (default)."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("File ID of the new folder"),
        title: z.string().describe("Folder title"),
      },
    },
    wrapToolHandler(async ({
      parent_folder_id,
      title,
      index,
    }: {
      parent_folder_id: string;
      title: string;
      index: number;
    }) => {
      const config = getConfig();

      // Access check: creating requires allow on the parent folder.
      const parentPolicy = await ac.getPolicy(parent_folder_id, config);
      const accessError = requireAccess(parentPolicy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const response = await client.editFiles([{
        action: "create",
        type: "folder",
        parent_id: parent_folder_id,
        title,
        index,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to create folder. The parent folder may not exist.");
      }

      const fileId = response.created?.[0];
      if (!fileId) {
        return makeErrorResponse("ApiError", "Folder created but no file ID was returned.");
      }

      // Invalidate path cache since the file tree changed.
      ac.invalidateCache();

      return makeResponse({
        file_id: fileId,
        title,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: rename_document
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "rename_document",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Rename a document. The file_id does not change when renaming.",
      inputSchema: {
        file_id: z.string().describe("Document file ID to rename"),
        title: z.string().describe("New title"),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID (unchanged)"),
        title: z.string().describe("The new title"),
      },
    },
    wrapToolHandler(async ({ file_id, title }: { file_id: string; title: string }) => {
      const config = getConfig();

      // Access check: renaming requires allow policy on the file.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const response = await client.editFiles([{
        action: "edit",
        type: "document",
        file_id,
        title,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to rename document. It may not exist or you lack permission.");
      }

      // Invalidate path cache since the file tree paths changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        title,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: rename_folder
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "rename_folder",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Rename a folder. The file_id does not change when renaming.",
      inputSchema: {
        file_id: z.string().describe("Folder file ID to rename"),
        title: z.string().describe("New title"),
      },
      outputSchema: {
        file_id: z.string().describe("Folder file ID (unchanged)"),
        title: z.string().describe("The new title"),
      },
    },
    wrapToolHandler(async ({ file_id, title }: { file_id: string; title: string }) => {
      const config = getConfig();

      // Access check: renaming requires allow policy on the folder.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const response = await client.editFiles([{
        action: "edit",
        type: "folder",
        file_id,
        title,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to rename folder. It may not exist or you lack permission.");
      }

      // Invalidate path cache since the file tree paths changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        title,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: move_document
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "move_document",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Move a document to a different parent folder, or reorder it within its current " +
        "folder by passing the same parent_folder_id with a new index. This operates on the " +
        "file tree, not on nodes within a document. Use move_node for moving nodes.",
      inputSchema: {
        file_id: z.string().describe("Document file ID to move"),
        parent_folder_id: z.string().describe("Destination folder file ID"),
        index: z.number().optional().default(-1).describe(
          "Position in destination. 0 = first, -1 = last (default)."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Moved document file ID"),
        parent_folder_id: z.string().describe("Destination folder file ID"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      parent_folder_id,
      index,
    }: {
      file_id: string;
      parent_folder_id: string;
      index: number;
    }) => {
      const config = getConfig();

      // Access check: moving requires allow on both source and destination.
      const sourcePolicy = await ac.getPolicy(file_id, config);
      const sourceError = requireAccess(sourcePolicy, "write", config.readOnly);
      if (sourceError) return makeErrorResponse(sourceError.error, sourceError.message);

      const destPolicy = await ac.getPolicy(parent_folder_id, config);
      const destError = requireAccess(destPolicy, "write", config.readOnly);
      if (destError) return makeErrorResponse(destError.error, destError.message);

      // Verify the file is a document, not a folder.
      const listResponse = await client.listFiles();
      const file = listResponse.files.find((f) => f.id === file_id);
      if (!file) {
        return makeErrorResponse("NotFound", "Document not found.");
      }
      if (file.type !== "document") {
        return makeErrorResponse("InvalidArgument", "The specified file_id is a folder, not a document. Use move_folder instead.");
      }

      const response = await client.editFiles([{
        action: "move",
        type: "document",
        file_id,
        parent_id: parent_folder_id,
        index,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to move document. The destination folder may not exist.");
      }

      // Invalidate path cache since the file tree changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        parent_folder_id,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: move_folder
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "move_folder",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Move a folder to a different parent folder, or reorder it within its current folder " +
        "by passing the same parent_folder_id with a new index. All contents (documents and " +
        "subfolders) move with it.",
      inputSchema: {
        file_id: z.string().describe("Folder file ID to move"),
        parent_folder_id: z.string().describe("Destination folder file ID"),
        index: z.number().optional().default(-1).describe(
          "Position in destination. 0 = first, -1 = last (default)."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Moved folder file ID"),
        parent_folder_id: z.string().describe("Destination folder file ID"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      parent_folder_id,
      index,
    }: {
      file_id: string;
      parent_folder_id: string;
      index: number;
    }) => {
      const config = getConfig();

      // Access check: moving requires allow on both source and destination.
      const sourcePolicy = await ac.getPolicy(file_id, config);
      const sourceError = requireAccess(sourcePolicy, "write", config.readOnly);
      if (sourceError) return makeErrorResponse(sourceError.error, sourceError.message);

      const destPolicy = await ac.getPolicy(parent_folder_id, config);
      const destError = requireAccess(destPolicy, "write", config.readOnly);
      if (destError) return makeErrorResponse(destError.error, destError.message);

      // Verify the file is a folder, not a document.
      const listResponse = await client.listFiles();
      const file = listResponse.files.find((f) => f.id === file_id);
      if (!file) {
        return makeErrorResponse("NotFound", "Folder not found.");
      }
      if (file.type !== "folder") {
        return makeErrorResponse("InvalidArgument", "The specified file_id is a document, not a folder. Use move_document instead.");
      }

      const response = await client.editFiles([{
        action: "move",
        type: "folder",
        file_id,
        parent_id: parent_folder_id,
        index,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to move folder. The destination folder may not exist.");
      }

      // Invalidate path cache since the file tree changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        parent_folder_id,
      });
    })
  );
}
