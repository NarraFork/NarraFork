import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { Hono } from "hono";
import { ValidationError } from "../lib/errors";
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from "../lib/platform";

export const fsRoutes = new Hono();

/**
 * GET /api/fs/browse?path=...&showHidden=1
 *
 * List directories under the given path. If no path is provided, returns
 * the user's home directory contents. On Windows with no path, also
 * returns available drive letters as top-level entries.
 *
 * Pass showHidden=1 to include hidden directories (dotfiles on Unix).
 */
fsRoutes.get("/browse", (c) => {
	const rawPath = c.req.query("path");
	const showHidden = c.req.query("showHidden") === "1";
	const isWin = process.platform === "win32";
	const drives = isWin ? getWindowsDrives() : [];

	// No path: on Windows show drives only; on Unix show home contents
	if (!rawPath) {
		if (isWin) {
			return c.json({ path: null, entries: [], drives, sep });
		}
		const home = homedir();
		const entries = listDirs(home, showHidden);
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

	const entries = listDirs(absPath, showHidden);
	// Compute parent (null if at root)
	const parent = getParent(absPath, isWin);

	return c.json({ path: absPath, entries, drives, parent, sep });
});

/**
 * GET /api/fs/shortcuts
 *
 * Return well-known quick-access directories (home, desktop, documents, downloads, root).
 * Uses platform-specific APIs to resolve actual paths:
 * - Linux: XDG user-dirs ($XDG_DESKTOP_DIR etc., falls back to ~/Desktop)
 * - macOS: ~/Desktop, ~/Documents, ~/Downloads (standard on macOS)
 * - Windows: Known Folder GUIDs via PowerShell, falls back to USERPROFILE subfolders
 *
 * Only includes paths that actually exist on the system.
 */
fsRoutes.get("/shortcuts", (c) => {
	const home = homedir();
	const isWin = process.platform === "win32";

	const desktop = resolveUserDir("desktop", home);
	const documents = resolveUserDir("documents", home);
	const downloads = resolveUserDir("downloads", home);

	const candidates: { key: string; path: string }[] = [{ key: "home", path: home }];

	if (desktop) candidates.push({ key: "desktop", path: desktop });
	if (documents) candidates.push({ key: "documents", path: documents });
	if (downloads) candidates.push({ key: "downloads", path: downloads });

	if (!isWin) {
		candidates.push({ key: "root", path: "/" });
	}

	const shortcuts = candidates.filter((c) => {
		try {
			return existsSync(c.path) && statSync(c.path).isDirectory();
		} catch {
			return false;
		}
	});

	const drives = isWin ? getWindowsDrives() : [];

	return c.json({ shortcuts, drives, sep });
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

// ── MIME type mapping for file preview ───────────────────────────────────────

const PREVIEW_MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".pdf": "application/pdf",
};

const MAX_PREVIEW_BYTES = 20 * 1024 * 1024; // 20 MB (images / PDFs)
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024; // 1 MB (text files — larger payloads choke syntax highlighting)

/**
 * GET /api/fs/preview?path=...
 *
 * Serve a file for inline preview. Supports images, PDFs, and text files.
 * Returns the file with appropriate Content-Type for browser rendering.
 */
fsRoutes.get("/preview", async (c) => {
	const rawPath = c.req.query("path");
	if (!rawPath) {
		throw new ValidationError("path is required");
	}

	const absPath = resolve(rawPath);
	if (!existsSync(absPath)) {
		throw new ValidationError(`File does not exist: ${absPath}`);
	}

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absPath);
	} catch {
		throw new ValidationError(`Cannot access: ${absPath}`);
	}

	if (!stat.isFile()) {
		throw new ValidationError(`Not a file: ${absPath}`);
	}

	const ext = extname(absPath).toLowerCase();
	const mime = PREVIEW_MIME[ext];

	if (stat.size > (mime ? MAX_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES)) {
		return c.json({ error: "File too large to preview" }, 413);
	}

	if (mime) {
		// Binary preview (image / PDF)
		const file = Bun.file(absPath);
		return new Response(file, {
			headers: {
				"Content-Type": mime,
				"Content-Disposition": "inline",
				"Content-Length": String(stat.size),
				"Cache-Control": "private, max-age=60",
			},
		});
	}

	// Text file fallback
	const file = Bun.file(absPath);
	const text = await file.text();
	return new Response(text, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Disposition": "inline",
			"Cache-Control": "private, max-age=60",
		},
	});
});

/** List immediate subdirectories of a path. */
function listDirs(dir: string, showHidden = false): { name: string; path: string }[] {
	try {
		const items = readdirSync(dir, { withFileTypes: true });
		return items
			.filter((d) => {
				if (!d.isDirectory()) return false;
				// Skip hidden dirs on Unix unless showHidden is true
				if (!showHidden && d.name.startsWith(".")) return false;
				// Always skip system dirs on Windows
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

// ── XDG / system directory resolution ────────────────────────────────────────

/** Cache for resolved XDG user dirs (parsed once from user-dirs.dirs). */
let _xdgCache: Record<string, string> | null = null;

/**
 * Parse ~/.config/user-dirs.dirs (XDG user directories config on Linux).
 * Format: XDG_DESKTOP_DIR="$HOME/Desktop"
 */
function parseXdgUserDirs(home: string): Record<string, string> {
	if (_xdgCache) return _xdgCache;
	_xdgCache = {};

	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const filePath = join(configHome, "user-dirs.dirs");

	try {
		if (!existsSync(filePath)) return _xdgCache;
		const content = readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
			const eqIdx = trimmed.indexOf("=");
			const key = trimmed.slice(0, eqIdx).trim();
			let val = trimmed.slice(eqIdx + 1).trim();
			// Remove surrounding quotes
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			// Expand $HOME
			val = val.replace(/\$HOME/g, home);
			_xdgCache[key] = val;
		}
	} catch {
		// ignore parse errors
	}
	return _xdgCache;
}

/**
 * Mapping from our key names to Windows SpecialFolder enum names.
 * Note: "Documents" is "MyDocuments" in the enum; "Downloads" has no enum entry.
 */
const WINDOWS_SPECIAL_FOLDER: Record<string, string | null> = {
	desktop: "Desktop",
	documents: "MyDocuments",
	downloads: null, // No SpecialFolder enum for Downloads
};

/** Known Folder GUIDs — used as fallback for folders not in SpecialFolder enum. */
const WINDOWS_KNOWN_FOLDER_GUID: Record<string, string> = {
	downloads: "{374DE290-123F-4565-9164-39C4925E467B}",
};

/** Cache for Windows known folder paths. */
const _winFolderCache: Record<string, string | null> = {};

/**
 * Resolve a Windows Known Folder path via PowerShell.
 *
 * Strategy:
 * 1. Try Environment.GetFolderPath with the correct SpecialFolder enum name
 * 2. For Downloads (no enum), use Shell.Application COM object with GUID
 * 3. Fall back to USERPROFILE\Downloads etc.
 */
function resolveWindowsKnownFolder(key: string, home: string): string | null {
	if (key in _winFolderCache) return _winFolderCache[key];

	const specialFolder = WINDOWS_SPECIAL_FOLDER[key];

	// Method 1: SpecialFolder enum (Desktop, MyDocuments)
	if (specialFolder) {
		try {
			const result = execSync(
				`powershell -NoProfile -Command "[Environment]::GetFolderPath('${specialFolder}')"`,
				{ encoding: "utf-8", timeout: 3000 },
			).trim();
			if (result && existsSync(result)) {
				_winFolderCache[key] = result;
				return result;
			}
		} catch {
			// PowerShell failed
		}
	}

	// Method 2: Known Folder GUID via Shell.Application (for Downloads etc.)
	const guid = WINDOWS_KNOWN_FOLDER_GUID[key];
	if (guid) {
		try {
			const result = execSync(
				`powershell -NoProfile -Command "(New-Object -ComObject Shell.Application).NameSpace('shell:${key}').Self.Path"`,
				{ encoding: "utf-8", timeout: 3000 },
			).trim();
			if (result && existsSync(result)) {
				_winFolderCache[key] = result;
				return result;
			}
		} catch {
			// Shell.Application failed
		}
	}

	// Method 3: Fallback to English name under home
	const englishNames: Record<string, string> = {
		desktop: "Desktop",
		documents: "Documents",
		downloads: "Downloads",
	};
	const fallback = join(home, englishNames[key] || key);
	_winFolderCache[key] = existsSync(fallback) ? fallback : null;
	return _winFolderCache[key];
}

/**
 * Resolve a well-known user directory (desktop, documents, downloads)
 * using platform-appropriate APIs.
 *
 * - Linux: XDG user-dirs.dirs → env vars → fallback ~/Desktop etc.
 * - macOS: ~/Desktop, ~/Documents, ~/Downloads (always English on macOS)
 * - Windows: Environment.GetFolderPath via PowerShell → fallback USERPROFILE subfolders
 */
function resolveUserDir(key: "desktop" | "documents" | "downloads", home: string): string | null {
	const xdgMap: Record<string, string> = {
		desktop: "XDG_DESKTOP_DIR",
		documents: "XDG_DOCUMENTS_DIR",
		downloads: "XDG_DOWNLOAD_DIR",
	};

	const englishName: Record<string, string> = {
		desktop: "Desktop",
		documents: "Documents",
		downloads: "Downloads",
	};

	if (IS_WINDOWS) {
		return resolveWindowsKnownFolder(key, home);
	}

	if (IS_LINUX) {
		// 1. Check XDG env var directly (rare but possible)
		const envKey = xdgMap[key];
		const envVal = process.env[envKey];
		if (envVal && existsSync(envVal)) return envVal;

		// 2. Parse user-dirs.dirs
		const xdgDirs = parseXdgUserDirs(home);
		const xdgVal = xdgDirs[envKey];
		if (xdgVal && existsSync(xdgVal)) return xdgVal;
	}

	// macOS always uses English names; Linux fallback
	const fallback = join(home, englishName[key]);
	return existsSync(fallback) ? fallback : null;
}
