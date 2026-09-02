import { accessSync, constants, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { narraforkDir } from "../lib/settings";

/**
 * Per-subagent conclusion file ID map.
 *
 * Explore/plan subagents get a designated conclusion file
 * that Write/Edit are allowed to target even in readOnly permission mode
 * — mirroring how plan mode restricts Write/Edit to a single plan file.
 *
 * The conclusion file is placed under `<cwd>/.narrafork/` when the cwd is
 * writable, otherwise falls back to `~/.narrafork/conclusions/` so that
 * subagents exploring read-only directories can still write conclusions.
 *
 * The file is KEPT after the run ends (like plan files): its content is read
 * once as the subagent's finalText, but the file itself stays on disk because
 * some workflows rely on the subagent leaving a durable markdown artifact.
 *
 * Set by narrator-subagent.ts at subagent start, queried by
 * narrator-permission.ts in handlePermission.
 */

interface ConclusionEntry {
	fileId: string;
	/** Pre-resolved absolute path to the conclusion file. */
	absPath: string;
	/** Relative path suitable for `file_path` input (relative to cwd). Only set when inside cwd. */
	relPath: string;
}

const conclusionEntries = new Map<string, ConclusionEntry>();

/** Fallback directory when cwd is not writable. */
const FALLBACK_DIR = resolve(narraforkDir, "conclusions");

function isCwdWritable(cwd: string): boolean {
	try {
		accessSync(cwd, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export function setConclusionFileId(narratorId: string, fileId: string, cwd: string): void {
	const fileName = `conclusion-${fileId}.md`;
	let absPath: string;
	let relPath: string;

	if (isCwdWritable(cwd)) {
		absPath = resolve(cwd, ".narrafork", fileName);
		relPath = `.narrafork/${fileName}`;
	} else {
		// Ensure fallback dir exists
		mkdirSync(FALLBACK_DIR, { recursive: true });
		absPath = resolve(FALLBACK_DIR, fileName);
		relPath = absPath; // absolute path — will be used as-is
	}

	conclusionEntries.set(narratorId, { fileId, absPath, relPath });
}

export function getConclusionFileId(narratorId: string): string | undefined {
	return conclusionEntries.get(narratorId)?.fileId;
}

export function getConclusionEntry(narratorId: string): ConclusionEntry | undefined {
	return conclusionEntries.get(narratorId);
}

export function deleteConclusionFileId(narratorId: string): void {
	conclusionEntries.delete(narratorId);
}

/** Resolve the absolute conclusion file path. Uses the pre-resolved path from the entry. */
export function resolveConclusionFilePath(cwd: string, fileId: string): string {
	// Check if there's an entry with this fileId that has a pre-resolved path
	for (const entry of conclusionEntries.values()) {
		if (entry.fileId === fileId) return entry.absPath;
	}
	// Fallback: resolve relative to cwd (legacy behavior)
	return resolve(cwd, `.narrafork/conclusion-${fileId}.md`);
}
