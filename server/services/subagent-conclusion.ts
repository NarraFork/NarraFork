import { resolve } from "node:path";

/**
 * Per-subagent conclusion file ID map.
 *
 * Explore/plan subagents get a designated conclusion file
 * (`.narrafork/conclusion-{id}.md`) that Write/Edit are allowed to target
 * even in readOnly permission mode — mirroring how plan mode restricts
 * Write/Edit to a single plan file.
 *
 * Set by narrator-subagent.ts at subagent start, queried by
 * narrator-session.ts in handlePermission.
 */
const conclusionFileIds = new Map<string, string>();

export function setConclusionFileId(narratorId: string, fileId: string): void {
	conclusionFileIds.set(narratorId, fileId);
}

export function getConclusionFileId(narratorId: string): string | undefined {
	return conclusionFileIds.get(narratorId);
}

export function deleteConclusionFileId(narratorId: string): void {
	conclusionFileIds.delete(narratorId);
}

/** Resolve the absolute conclusion file path from cwd + fileId. */
export function resolveConclusionFilePath(cwd: string, fileId: string): string {
	return resolve(cwd, `.narrafork/conclusion-${fileId}.md`);
}
