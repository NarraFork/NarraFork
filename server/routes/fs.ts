import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { IS_MACOS, IS_WINDOWS } from "../lib/platform";

export const fsRoutes = new Hono();

/**
 * GET /api/fs/browse?path=...
 *
 * List directories under the given path. If no path is provided, returns
 * the user's home directory contents. On Windows with no path, also
 * returns available drive letters as top-level entries.
 */
fsRoutes.get("/browse", (c) => {
	const rawPath = c.req.query("path");
	const isWin = process.platform === "win32";
	const drives = isWin ? getWindowsDrives() : [];

	// No path: on Windows show drives only; on Unix show home contents
	if (!rawPath) {
		if (isWin) {
			return c.json({ path: null, entries: [], drives, sep });
		}
		const home = homedir();
		const entries = listDirs(home);
		const parent = getParent(home, isWin);
		return c.json({ path: home, entries, drives, parent, sep });
	}

	const absPath = resolve(rawPath);
	if (!existsSync(absPath)) {
		throw new ValidationError(`Path does not exist: ${absPath}`);
	}

	try {
		const s = statSync(absPath);
		if (!s.isDirectory()) {
			throw new ValidationError(`Not a directory: ${absPath}`);
		}
	} catch (err) {
		if (err instanceof ValidationError) throw err;
		throw new ValidationError(`Cannot access: ${absPath}`);
	}

	const entries = listDirs(absPath);
	// Compute parent (null if at root)
	const parent = getParent(absPath, isWin);

	return c.json({ path: absPath, entries, drives, parent, sep });
});

/**
 * POST /api/fs/mkdir
 *
 * Create a new directory. Body: { parent: string, name: string }
 */
fsRoutes.post("/mkdir", async (c) => {
	const body = await c.req.json<{ parent?: string; name?: string }>();
	const { parent, name } = body;

	if (!parent || !name) {
		throw new ValidationError("parent and name are required");
	}

	// Validate folder name: no path separators or special chars
	const invalidChars = /[/\\<>:"|?*]/;
	const hasControlChars = [...name].some((ch) => ch.charCodeAt(0) < 32);
	if (invalidChars.test(name) || hasControlChars) {
		throw new ValidationError("Invalid folder name");
	}

	const absParent = resolve(parent);
	if (!existsSync(absParent) || !statSync(absParent).isDirectory()) {
		throw new ValidationError(`Parent directory does not exist: ${absParent}`);
	}

	const newPath = join(absParent, name);
	if (existsSync(newPath)) {
		throw new ValidationError(`Already exists: ${basename(newPath)}`);
	}

	mkdirSync(newPath);
	return c.json({ path: newPath });
});

/**
 * POST /api/fs/reveal
 *
 * Open a directory in the system file manager.
 * Body: { path: string }
 *
 * - macOS: `open <path>`
 * - Windows: `explorer <path>`
 * - Linux: not supported (returns 400)
 */
fsRoutes.post("/reveal", async (c) => {
	const body = await c.req.json<{ path?: string }>();
	const { path: rawPath } = body;

	if (!rawPath) {
		throw new ValidationError("path is required");
	}

	const absPath = resolve(rawPath);
	if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
		throw new ValidationError(`Directory does not exist: ${absPath}`);
	}

	let cmd: string;
	let args: string[];

	if (IS_MACOS) {
		cmd = "open";
		args = [absPath];
	} else if (IS_WINDOWS) {
		cmd = "explorer";
		args = [absPath];
	} else {
		throw new ValidationError("Opening file manager is not supported on this platform");
	}

	// Fire-and-forget — don't wait for the file manager to close
	const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
	child.unref();

	return c.json({ ok: true });
});

/** List immediate subdirectories of a path. */
function listDirs(dir: string): { name: string; path: string }[] {
	try {
		const items = readdirSync(dir, { withFileTypes: true });
		return items
			.filter((d) => {
				if (!d.isDirectory()) return false;
				// Skip hidden dirs on Unix, skip system dirs on Windows
				if (d.name.startsWith(".")) return false;
				if (d.name === "$RECYCLE.BIN" || d.name === "System Volume Information") return false;
				return true;
			})
			.map((d) => ({ name: d.name, path: join(dir, d.name) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

/** Get parent directory, or null if at filesystem root. */
function getParent(absPath: string, isWin: boolean): string | null {
	const parent = resolve(absPath, "..");
	if (parent === absPath) return null; // at root
	// On Windows, if parent is a drive root like "C:\", still return it
	if (isWin && /^[A-Z]:\\$/i.test(parent)) return parent;
	return parent;
}

/** Enumerate available Windows drive letters. */
function getWindowsDrives(): { name: string; path: string }[] {
	const drives: { name: string; path: string }[] = [];
	for (let code = 65; code <= 90; code++) {
		const letter = String.fromCharCode(code);
		const drivePath = `${letter}:\\`;
		try {
			if (existsSync(drivePath)) {
				drives.push({ name: `${letter}:`, path: drivePath });
			}
		} catch {
			// skip inaccessible drives
		}
	}
	return drives;
}
