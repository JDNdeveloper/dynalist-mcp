/**
 * File management tools: create_document, create_folder,
 * rename_document, rename_folder, move_file.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import { getConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
} from "../utils/dynalist-helpers";

export function registerFileTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: create_document
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "create_document",
    {
      description: "Create a new document in a folder.",
      inputSchema: {
        parent_folder_id: z.string().describe("Folder to create the document in"),
        title: z.string().optional().default("").describe("Document title"),
        index: z.number().optional().default(-1).describe("Position in folder (-1 = end, 0 = top)"),
      },
      outputSchema: {
        file_id: z.string().describe("ID of the new document"),
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

      const fileId = response.created_file_ids?.[0];
      if (!fileId) {
        return makeErrorResponse("Unknown", "Document created but no file ID was returned");
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
      description: "Create a new folder inside another folder.",
      inputSchema: {
        parent_folder_id: z.string().describe("Folder to create in"),
        title: z.string().optional().default("").describe("Folder title"),
        index: z.number().optional().default(-1).describe("Position in parent (-1 = end, 0 = top)"),
      },
      outputSchema: {
        file_id: z.string().describe("ID of the new folder"),
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

      const fileId = response.created_file_ids?.[0];
      if (!fileId) {
        return makeErrorResponse("Unknown", "Folder created but no file ID was returned");
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
      description: "Rename a document.",
      inputSchema: {
        file_id: z.string().describe("Document to rename"),
        title: z.string().describe("New title"),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        title: z.string().describe("The new title"),
      },
    },
    wrapToolHandler(async ({ file_id, title }: { file_id: string; title: string }) => {
      const config = getConfig();

      // Access check: renaming requires allow policy on the file.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      await client.editFiles([{
        action: "edit",
        type: "document",
        file_id,
        title,
      }]);

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
      description: "Rename a folder.",
      inputSchema: {
        file_id: z.string().describe("Folder to rename"),
        title: z.string().describe("New title"),
      },
      outputSchema: {
        file_id: z.string().describe("Folder ID"),
        title: z.string().describe("The new title"),
      },
    },
    wrapToolHandler(async ({ file_id, title }: { file_id: string; title: string }) => {
      const config = getConfig();

      // Access check: renaming requires allow policy on the folder.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      await client.editFiles([{
        action: "edit",
        type: "folder",
        file_id,
        title,
      }]);

      // Invalidate path cache since the file tree paths changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        title,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: move_file
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "move_file",
    {
      description: "Move a document or folder to a different parent folder.",
      inputSchema: {
        file_id: z.string().describe("Document or folder to move"),
        parent_folder_id: z.string().describe("Destination folder"),
        index: z.number().optional().default(-1).describe("Position in destination (-1 = end, 0 = top)"),
      },
      outputSchema: {
        file_id: z.string().describe("Moved file ID"),
        parent_folder_id: z.string().describe("Destination folder ID"),
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

      // The Dynalist file/edit move action requires a type, but we don't know
      // if the file is a document or folder. Try document first; if it fails,
      // the error will propagate.
      //
      // NOTE: The Dynalist API may accept either type for move operations.
      // This will be verified in Phase 6 (manual behavior discovery).
      await client.editFiles([{
        action: "move",
        type: "document",
        file_id,
        parent_id: parent_folder_id,
        index,
      }]);

      // Invalidate path cache since the file tree changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        parent_folder_id,
      });
    })
  );
}
