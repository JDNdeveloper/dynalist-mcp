/**
 * File management tools: create_document, create_folder,
 * rename_document, rename_folder, move_document, move_folder.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient } from "../dynalist-client";
import { getConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
} from "../utils/dynalist-helpers";
import {
  CONFIRM_GUIDANCE, FILE_ID_DESCRIPTION, FOLDER_ID_DESCRIPTION,
  PARENT_FOLDER_ID_DESCRIPTION,
  DOCUMENT_TITLE_DESCRIPTION, FOLDER_TITLE_DESCRIPTION,
  FOLDER_INDEX_DESCRIPTION,
} from "./descriptions";

export function registerFileTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  server.registerTool(
    "create_document",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Create an empty document in a folder. Use the returned file_id with " +
        "insert_nodes to add content.",
      inputSchema: {
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_DESCRIPTION),
        title: z.string().optional().default("").describe(DOCUMENT_TITLE_DESCRIPTION),
        index: z.number().optional().default(-1).describe(FOLDER_INDEX_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
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
      const accessError = requireAccess(parentPolicy, "write");
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
      });
    })
  );

  server.registerTool(
    "create_folder",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Create an empty folder inside another folder.",
      inputSchema: {
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_DESCRIPTION),
        title: z.string().optional().default("").describe(FOLDER_TITLE_DESCRIPTION),
        index: z.number().optional().default(-1).describe(FOLDER_INDEX_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        title: z.string().describe(FOLDER_TITLE_DESCRIPTION),
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
      const accessError = requireAccess(parentPolicy, "write");
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

  server.registerTool(
    "rename_document",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Rename a document. The file_id does not change when renaming.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({ file_id, title }: { file_id: string; title: string }) => {
      const config = getConfig();

      // Access check: renaming requires allow policy on the file.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write");
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

  server.registerTool(
    "rename_folder",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Rename a folder. The file_id does not change when renaming.",
      inputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        title: z.string().describe(FOLDER_TITLE_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        title: z.string().describe(FOLDER_TITLE_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({ file_id, title }: { file_id: string; title: string }) => {
      const config = getConfig();

      // Access check: renaming requires allow policy on the folder.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write");
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

  server.registerTool(
    "move_document",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Move a document to a different folder, or reorder within its current folder. " +
        "Operates on the file tree, not document nodes.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_DESCRIPTION),
        index: z.number().optional().default(-1).describe(FOLDER_INDEX_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_DESCRIPTION),
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
      const sourceError = requireAccess(sourcePolicy, "write");
      if (sourceError) return makeErrorResponse(sourceError.error, sourceError.message);

      const destPolicy = await ac.getPolicy(parent_folder_id, config);
      const destError = requireAccess(destPolicy, "write");
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

  server.registerTool(
    "move_folder",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Move a folder to a different parent, or reorder within its current parent. " +
        "Contents move with it.",
      inputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_DESCRIPTION),
        index: z.number().optional().default(-1).describe(FOLDER_INDEX_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_DESCRIPTION),
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
      const sourceError = requireAccess(sourcePolicy, "write");
      if (sourceError) return makeErrorResponse(sourceError.error, sourceError.message);

      const destPolicy = await ac.getPolicy(parent_folder_id, config);
      const destError = requireAccess(destPolicy, "write");
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
