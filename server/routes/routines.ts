import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db";
import { projects } from "../db/schema";
import { NotFoundError, ValidationError } from "../lib/errors";
import { getGlobalPromptCandidates, isWritableGlobalPromptPath } from "../lib/global-prompt-paths";
import { requireProjectAccess } from "../lib/project-access";
import { requireAdmin } from "../middleware/auth";
import {
	disableRoutineForProject,
	disableRoutineGlobal,
	enableRoutineForProject,
	enableRoutineGlobal,
	getGlobalRoutineStatuses,
	getProjectRoutineStatusesWithOverride,
	resetRoutineForProject,
} from "../services/routine-service";

export const routineRoutes = new Hono();

/** List all built-in routines with global enabled status. */
routineRoutes.get("/", (c) => {
	return c.json({ routines: getGlobalRoutineStatuses() });
});

/** Toggle a routine globally. */
routineRoutes.post("/:id/toggle", async (c) => {
	const routineId = c.req.param("id");
	const body = await c.req.json<{ enabled: boolean }>();
	if (typeof body.enabled !== "boolean") {
		throw new ValidationError("enabled must be a boolean");
	}

	const userId = c.get("user").sub;
	if (body.enabled) {
		await enableRoutineGlobal(routineId, userId);
	} else {
		await disableRoutineGlobal(routineId, userId);
	}

	return c.json({ ok: true });
});

/** List all built-in routines with project-level status. */
routineRoutes.get("/project/:projectId", async (c) => {
	await requireProjectAccess(c, c.req.param("projectId"), "read");
	const projectId = c.req.param("projectId");
	const project = await db.query.projects.findFirst({
		where: eq(projects.id, projectId),
		columns: { chapterSettings: true },
	});
	if (!project) throw new NotFoundError("Project", projectId);

	let routinesConf: { disabledRoutines?: string[]; enabledRoutines?: string[] } | undefined;
	try {
		const cs =
			typeof project.chapterSettings === "string"
				? JSON.parse(project.chapterSettings)
				: project.chapterSettings;
		routinesConf = cs?.routines;
	} catch {
		// ignore
	}

	return c.json({ routines: getProjectRoutineStatusesWithOverride(routinesConf) });
});

/** Toggle a routine for a specific project. */
routineRoutes.post("/project/:projectId/:id/toggle", async (c) => {
	// Toggling a project routine changes behaviour for everyone working in it.
	await requireProjectAccess(c, c.req.param("projectId"), "manage");
	const projectId = c.req.param("projectId");
	const routineId = c.req.param("id");
	const body = await c.req.json<{ action: "enable" | "disable" | "reset" }>();

	if (!["enable", "disable", "reset"].includes(body.action)) {
		throw new ValidationError("action must be 'enable', 'disable', or 'reset'");
	}

	switch (body.action) {
		case "enable":
			await enableRoutineForProject(routineId, projectId);
			break;
		case "disable":
			await disableRoutineForProject(routineId, projectId);
			break;
		case "reset":
			await resetRoutineForProject(routineId, projectId);
			break;
	}

	return c.json({ ok: true });
});

// ── Global Prompt (AGENTS.md / CLAUDE.md) ──

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Hard ceiling on the bytes this endpoint will read and return.
 *
 * The file is user-owned and outside NarraFork's control — `~/.agents/AGENTS.md` can be
 * a symlink to anything readable, or simply a file that grew — so a plain
 * `readFile(path, "utf-8")` was an unbounded read into the response of a route that the
 * settings page polls. That is the pattern the main-thread rules exist to prevent.
 *
 * Sized above the 50_000-character truncation the injection side applies
 * (`narrator-prompt`'s `MAX_GLOBAL_MD`), so anything that actually reaches a system
 * prompt is fully visible here: 50k characters cannot exceed 200k bytes even in the
 * worst UTF-8 case (4 bytes per code point covers astral characters, which count as two
 * JS characters each). A file bigger than this is already partly ignored by the injector,
 * and the reader learns its real size from `totalBytes`.
 */
const MAX_GLOBAL_PROMPT_BYTES = 200_000;

/**
 * Decode a byte prefix as UTF-8 without producing a broken trailing character.
 *
 * A byte-count cut can land inside a multi-byte sequence, which would decode to a
 * trailing U+FFFD — visible garbage at the end of every truncated CJK document. The scan
 * backs up to the last sequence boundary instead: UTF-8 continuation bytes are
 * `10xxxxxx`, so walking back over them (at most 3) reaches a lead byte, and the prefix
 * is cut there when that lead byte's sequence does not fit in what was read.
 */
function decodeUtf8Prefix(bytes: Uint8Array): string {
	let end = bytes.length;
	// Find the last lead byte, i.e. skip trailing continuation bytes.
	let lead = end - 1;
	while (lead >= 0 && (bytes[lead] & 0b1100_0000) === 0b1000_0000) lead--;
	if (lead >= 0) {
		const first = bytes[lead];
		const needed = first < 0x80 ? 1 : first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
		// An incomplete final sequence is dropped rather than decoded to U+FFFD.
		if (lead + needed > end) end = lead;
	}
	return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
}

/**
 * Read at most `MAX_GLOBAL_PROMPT_BYTES` from a candidate.
 *
 * Read through a file handle with an explicit length rather than `readFile`, so the cap
 * bounds the ALLOCATION and not just what is returned. `truncated` is decided from the
 * bytes actually read, not from the `stat` size the caller passed: the file can grow
 * between the two, and a report of "complete" that is short by whatever landed in between
 * is exactly the claim a client must not act on before overwriting the file.
 */
async function readGlobalPrompt(
	path: string,
	totalBytes: number,
): Promise<{ content: string; truncated: boolean }> {
	const want = Math.min(Math.max(totalBytes, 0), MAX_GLOBAL_PROMPT_BYTES);
	const handle = await open(path, "r");
	try {
		const buffer = new Uint8Array(want);
		const { bytesRead } = want > 0 ? await handle.read(buffer, 0, want, 0) : { bytesRead: 0 };
		return {
			content: decodeUtf8Prefix(buffer.subarray(0, bytesRead)),
			truncated: bytesRead < totalBytes,
		};
	} finally {
		await handle.close();
	}
}

/**
 * Read the global prompt file (first found among candidates).
 *
 * Deliberately NOT admin-gated, unlike the PUT below. The content is instructions the
 * user wrote for their own agents, and every narrator on this instance already receives
 * it in its system prompt, so a logged-in user can read it by asking any narrator. What
 * the response does leak is a set of local filesystem paths (the `candidates` array, and
 * therefore the operating account's home directory) — real but minor, and already
 * observable from any narrator's `bash` tool. Gating reads would break the settings
 * page's read-only view for non-admins while closing nothing.
 *
 * `content` keeps its meaning ("the file's text, or null when there is none") so existing
 * clients are unaffected; `truncated` and `totalBytes` are additive. A client that
 * offers editing MUST refuse to save while `truncated` is true — a PUT of a truncated
 * body would delete everything past the cut.
 */
routineRoutes.get("/global-prompt", async (c) => {
	const candidates: Array<{ path: string; exists: boolean }> = [];
	let content: string | null = null;
	let filePath: string | null = null;
	let truncated = false;
	let totalBytes: number | null = null;

	for (const candidate of getGlobalPromptCandidates()) {
		let size: number | null = null;
		try {
			const info = await stat(candidate);
			// A directory at a candidate path is not a readable prompt file. Treated as
			// absent rather than as an error: the next candidate may well be the real one.
			if (info.isFile()) size = info.size;
		} catch {
			size = null;
		}
		candidates.push({ path: candidate, exists: size !== null });
		if (!filePath && size !== null) {
			filePath = candidate;
			totalBytes = size;
			try {
				const read = await readGlobalPrompt(candidate, size);
				content = read.content;
				truncated = read.truncated;
			} catch {
				content = null;
			}
		}
	}

	return c.json({ content, filePath, candidates, truncated, totalBytes });
});

/**
 * Write the global prompt file.
 *
 * Admin-only. This writes `~/.agents/AGENTS.md` (or whichever candidate wins), whose
 * contents `narrator-prompt` injects into the system prompt of EVERY narrator on the
 * instance — the same blast radius as `settings.defaultSystemPrompt`, which
 * `settings.ts` has always required admin for. Being merely logged in was enough here,
 * so any user could rewrite the standing instructions of every other user's agents.
 */
routineRoutes.put("/global-prompt", requireAdmin, async (c) => {
	const body = await c.req.json<{ content: string; filePath?: string }>();
	if (typeof body.content !== "string") {
		throw new ValidationError("content must be a string");
	}

	const knownCandidates = getGlobalPromptCandidates();
	let targetPath = body.filePath;

	if (!targetPath) {
		// Write to the first existing file, or default to the highest-priority path.
		for (const candidate of knownCandidates) {
			if (await fileExists(candidate)) {
				targetPath = candidate;
				break;
			}
		}
		if (!targetPath) {
			targetPath = knownCandidates[0];
		}
	}

	// Two conditions, both required, and neither implies the other:
	//   1. the path is one of the known candidates (`resolve` first, so a relative or
	//      `..`-laden value cannot name a candidate it does not literally equal), and
	//   2. it still lands inside the home directory once symlinks are resolved.
	//
	// (2) is what makes this a boundary rather than a string comparison. `writeFile`
	// follows symlinks, so `~/.agents/AGENTS.md → /etc/crontab` passes (1) while writing
	// the request body to `/etc/crontab`. Both live in `isWritableGlobalPromptPath` so the
	// route cannot satisfy one and forget the other.
	if (!isWritableGlobalPromptPath(targetPath)) {
		throw new ValidationError(
			"filePath must be one of the known global prompt paths and must resolve inside the home directory",
		);
	}

	await mkdir(dirname(targetPath), { recursive: true });
	// `flag: "w"` is the default and follows an existing symlink, which is exactly what the
	// check above bounds: a link that stays inside home is the user's own layout and must
	// keep working, one that leaves is refused before reaching here.
	await writeFile(targetPath, body.content, "utf-8");

	return c.json({ ok: true, filePath: targetPath });
});
