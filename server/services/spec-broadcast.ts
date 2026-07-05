/**
 * Shared helper to broadcast a spec_changed WS event after any spec file write.
 * Extracted to avoid circular import issues (tools → services → websocket).
 */

import { broadcastToNarrator } from "../websocket/narrator-ws";
import type { SpecResolvedFile } from "./spec-vfs-service";

export function broadcastSpecChanged(
	narratorId: string,
	file: Pick<SpecResolvedFile, "uri" | "path" | "revisionId">,
	source: "ui" | "tool" | "task_create",
	updatedBy: "user" | "assistant" | "system" = "assistant",
): void {
	broadcastToNarrator(narratorId, {
		type: "spec_changed",
		narratorId,
		uri: file.uri,
		path: file.path,
		revisionId: file.revisionId ?? null,
		updatedBy,
		source,
	});
}
