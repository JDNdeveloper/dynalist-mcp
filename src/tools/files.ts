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
  resolveFilePosition,
} from "../utils/dynalist-helpers";
import type { PositionValue } from "../utils/dynalist-helpers";
import {
  CONFIRM_GUIDANCE, FILE_ID_DESCRIPTION, FOLDER_ID_DESCRIPTION,
  PARENT_FOLDER_ID_OUTPUT_DESCRIPTION,
  DOCUMENT_TITLE_DESCRIPTION, FOLDER_TITLE_DESCRIPTION,
  INSTRUCTIONS_FIRST_GUIDANCE,
} from "./descriptions";

const FILE_POSITION_DESCRIPTION =
  "'after'/'before': place relative to a sibling (reference_file_id required). " +
  "'first_child': prepend to start of folder. 'last_child': append to end.";

const REFERENCE_FILE_ID_DESCRIPTION =
  "For after/before: the sibling file (required). " +
  "For first_child/last_child: the parent folder. Omit for top level.";

export function registerFileTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  server.registerTool(
    "create_document",
    {
      description:
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Create an empty document in a folder. Use the returned file_id with " +
        "insert_items to add content.",
      inputSchema: {
        title: z.string().optional().default("").describe(DOCUMENT_TITLE_DESCRIPTION),
        reference_file_id: z.string().optional().describe(REFERENCE_FILE_ID_DESCRIPTION),
        position: z.enum(["after", "before", "first_child", "last_child"])
          .optional().default("last_child").describe(FILE_POSITION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      title,
      reference_file_id,
      position,
    }: {
      title: string;
      reference_file_id?: string;
      position: PositionValue;
    }) => {
      const config = getConfig();
      const listResponse = await client.listFiles();

      // Resolve position to parent folder and numeric index.
      const resolved = resolveFilePosition(
        reference_file_id, position, listResponse.files, listResponse.root_file_id,
      );
      if ("error" in resolved) return makeErrorResponse(resolved.error, resolved.message);

      // Access check: creating requires allow on the parent folder.
      const parentPolicy = await ac.getPolicy(resolved.parentId, config);
      const accessError = requireAccess(parentPolicy, "write");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const response = await client.editFiles([{
        action: "create",
        type: "document",
        parent_id: resolved.parentId,
        title,
        index: resolved.index,
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
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Create an empty folder inside another folder.",
      inputSchema: {
        title: z.string().optional().default("").describe(FOLDER_TITLE_DESCRIPTION),
        reference_file_id: z.string().optional().describe(REFERENCE_FILE_ID_DESCRIPTION),
        position: z.enum(["after", "before", "first_child", "last_child"])
          .optional().default("last_child").describe(FILE_POSITION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        title: z.string().describe(FOLDER_TITLE_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      title,
      reference_file_id,
      position,
    }: {
      title: string;
      reference_file_id?: string;
      position: PositionValue;
    }) => {
      const config = getConfig();
      const listResponse = await client.listFiles();

      // Resolve position to parent folder and numeric index.
      const resolved = resolveFilePosition(
        reference_file_id, position, listResponse.files, listResponse.root_file_id,
      );
      if ("error" in resolved) return makeErrorResponse(resolved.error, resolved.message);

      // Access check: creating requires allow on the parent folder.
      const parentPolicy = await ac.getPolicy(resolved.parentId, config);
      const accessError = requireAccess(parentPolicy, "write");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const response = await client.editFiles([{
        action: "create",
        type: "folder",
        parent_id: resolved.parentId,
        title,
        index: resolved.index,
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
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
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
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
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
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Move a document to a different folder, or reorder within its current folder. " +
        "Operates on the file tree, not document items.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        reference_file_id: z.string().optional().describe(REFERENCE_FILE_ID_DESCRIPTION),
        position: z.enum(["after", "before", "first_child", "last_child"])
          .optional().default("last_child").describe(FILE_POSITION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_OUTPUT_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      reference_file_id,
      position,
    }: {
      file_id: string;
      reference_file_id?: string;
      position: PositionValue;
    }) => {
      const config = getConfig();
      const listResponse = await client.listFiles();

      // Access check on source: moving requires allow on the file being moved.
      const sourcePolicy = await ac.getPolicy(file_id, config);
      const sourceError = requireAccess(sourcePolicy, "write");
      if (sourceError) return makeErrorResponse(sourceError.error, sourceError.message);

      // Verify the file is a document, not a folder.
      const file = listResponse.files.find((f) => f.id === file_id);
      if (!file) {
        return makeErrorResponse("NotFound", "Document not found.");
      }
      if (file.type !== "document") {
        return makeErrorResponse("InvalidArgument", "The specified file_id is a folder, not a document. Use move_folder instead.");
      }

      // Resolve position to parent folder and numeric index.
      const resolved = resolveFilePosition(
        reference_file_id, position, listResponse.files, listResponse.root_file_id,
      );
      if ("error" in resolved) return makeErrorResponse(resolved.error, resolved.message);

      // Access check on destination: moving requires allow on the target folder.
      const destPolicy = await ac.getPolicy(resolved.parentId, config);
      const destError = requireAccess(destPolicy, "write");
      if (destError) return makeErrorResponse(destError.error, destError.message);

      // The API uses post-removal indexing: it removes the file from its
      // current parent first, then inserts at the given index. When moving
      // within the same parent and the file is earlier than the target,
      // the removal shifts the target index down by 1.
      let apiIndex = resolved.index;
      const currentParent = listResponse.files.find(f => f.children?.includes(file_id));
      if (currentParent && currentParent.id === resolved.parentId) {
        const currentIndex = currentParent.children!.indexOf(file_id);
        if (currentIndex < apiIndex) {
          apiIndex--;
        }
      }

      const response = await client.editFiles([{
        action: "move",
        type: "document",
        file_id,
        parent_id: resolved.parentId,
        index: apiIndex,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to move document. The destination folder may not exist.");
      }

      // Invalidate path cache since the file tree changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        parent_folder_id: resolved.parentId,
      });
    })
  );

  server.registerTool(
    "move_folder",
    {
      description:
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Move a folder to a different parent, or reorder within its current parent. " +
        "Contents move with it.",
      inputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        reference_file_id: z.string().optional().describe(REFERENCE_FILE_ID_DESCRIPTION),
        position: z.enum(["after", "before", "first_child", "last_child"])
          .optional().default("last_child").describe(FILE_POSITION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
        parent_folder_id: z.string().describe(PARENT_FOLDER_ID_OUTPUT_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      reference_file_id,
      position,
    }: {
      file_id: string;
      reference_file_id?: string;
      position: PositionValue;
    }) => {
      const config = getConfig();
      const listResponse = await client.listFiles();

      // Access check on source: moving requires allow on the file being moved.
      const sourcePolicy = await ac.getPolicy(file_id, config);
      const sourceError = requireAccess(sourcePolicy, "write");
      if (sourceError) return makeErrorResponse(sourceError.error, sourceError.message);

      // Verify the file is a folder, not a document.
      const file = listResponse.files.find((f) => f.id === file_id);
      if (!file) {
        return makeErrorResponse("NotFound", "Folder not found.");
      }
      if (file.type !== "folder") {
        return makeErrorResponse("InvalidArgument", "The specified file_id is a document, not a folder. Use move_document instead.");
      }

      // Resolve position to parent folder and numeric index.
      const resolved = resolveFilePosition(
        reference_file_id, position, listResponse.files, listResponse.root_file_id,
      );
      if ("error" in resolved) return makeErrorResponse(resolved.error, resolved.message);

      // Access check on destination: moving requires allow on the target folder.
      const destPolicy = await ac.getPolicy(resolved.parentId, config);
      const destError = requireAccess(destPolicy, "write");
      if (destError) return makeErrorResponse(destError.error, destError.message);

      // Same-parent post-removal index adjustment (see move_document).
      let apiIndex = resolved.index;
      const currentParent = listResponse.files.find(f => f.children?.includes(file_id));
      if (currentParent && currentParent.id === resolved.parentId) {
        const currentIndex = currentParent.children!.indexOf(file_id);
        if (currentIndex < apiIndex) {
          apiIndex--;
        }
      }

      const response = await client.editFiles([{
        action: "move",
        type: "folder",
        file_id,
        parent_id: resolved.parentId,
        index: apiIndex,
      }]);

      if (!response.results?.[0]) {
        return makeErrorResponse("ApiError", "Failed to move folder. The destination folder may not exist.");
      }

      // Invalidate path cache since the file tree changed.
      ac.invalidateCache();

      return makeResponse({
        file_id,
        parent_folder_id: resolved.parentId,
      });
    })
  );
}
