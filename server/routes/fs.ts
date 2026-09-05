import { execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type Dir,
	type Dirent,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	opendirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Hono } from "hono";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import {
	applyLineEnding,
	decodeFileBytesAs,
	detectFileEncoding,
	detectLineEnding,
	encodeFileBytesAs,
	looksBinary,
	normalizeLineEndings,
} from "../lib/agent/tools/encoding";
import { wholeFileLineStats } from "../lib/agent/tools/file-diff-stats";
import { buildAttachmentDisposition } from "../lib/content-disposition";
import { AppError, ValidationError } from "../lib/errors";
import {
	isSecretPlatformPath,
	isSecretUserPath,
	SECRET_PATH_REFUSAL,
} from "../lib/fs-secret-paths";
import { checkWriteBoundary, describeWriteRefusal } from "../lib/fs-write-boundary";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import { requireNarratorAccess } from "../lib/narrator-access";
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from "../lib/platform";
import { settings } from "../lib/settings";
import { fsWriteSchema } from "../lib/validators/fs";
import { recordAttribution } from "../services/file-attribution-service";
import { closeClaim, openClaim, sealClaim } from "../services/worktree-write-claims";

export const fsRoutes = new Hono();

/**
 * GET /api/fs/browse?path=...&showHidden=1&includeFiles=1
 *
 * List directories under the given path. If no path is provided, returns
 * the user's home directory contents. On Windows with no path, also
 * returns available drive letters as top-level entries.
 *
 * Pass showHidden=1 to include hidden directories (dotfiles on Unix).
 *
 * Pass includeFiles=1 to also list regular files (and symlinks resolving to
 * files), each marked `isDirectory: false`. Opt-in rather than the default
 * because this route's original and still-dominant caller is the directory
 * PICKER, whose every entry must be selectable as a directory — returning files
 * there would offer choices that fail on click. The file tree is the caller that
 * needs both kinds, so it asks for both.
 *
 * The response carries `truncated: true` when some child of the directory is not
 * in `entries` (see the caps in {@link listDirs}); `entries.length` is then a
 * floor, not the directory's size. Both clients already slice long listings for
 * display, so they must not read the returned count as complete.
 */
fsRoutes.get("/browse", (c) => {
	const rawPath = c.req.query("path");
	const showHidden = c.req.query("showHidden") === "1";
	const includeFiles = c.req.query("includeFiles") === "1";
	const isWin = process.platform === "win32";
	const drives = isWin ? getWindowsDrives() : [];

	// No path: on Windows show drives only; on Unix show home contents
	if (!rawPath) {
		if (isWin) {
			return c.json({ path: null, entries: [], drives, truncated: false, sep });
		}
		const home = homedir();
		const listing = listDirs(home, showHidden, includeFiles);
		const parent = getParent(home, isWin);
		return c.json({ ...listing, path: home, drives, parent, sep });
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

	const listing = listDirs(absPath, showHidden, includeFiles);
	// Compute parent (null if at root)
	const parent = getParent(absPath, isWin);

	return c.json({ ...listing, path: absPath, drives, parent, sep });
});

/**
 * GET /api/fs/shortcuts
 *
 * Return well-known quick-access directories (home, desktop, documents, downloads, root).
 * Uses platform-specific APIs to resolve actual paths:
 * - Linux: XDG user-dirs ($XDG_DESKTOP_DIR etc., falls back to ~/Desktop)
 * - macOS: ~/Desktop, ~/Documents, ~/Downloads (standard on macOS)
 * - Windows: PowerShell [Environment]::GetFolderPath (no USERPROFILE concatenation fallback)
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
 * Refuse the files whose bytes ARE credentials.
 *
 * These routes are deliberately not sandboxed — the file browser has always listed
 * the whole filesystem, and the viewer legitimately opens platform files outside any
 * project (request dumps, truncated tool output, subagent conclusions). What must not
 * follow from that is an escalation: `settings.json` carries `auth.jwtSecret` (forge
 * any user's session), `narrafork.db` carries every password hash, and `~/.ssh`
 * carries the user's keys. See `fs-secret-paths.ts` for why this is a deny-list.
 *
 * A 403 rather than a 404: pretending the file is absent would be a lie the caller
 * can disprove with `/browse`, and the refusal is the honest answer.
 */
function assertReadableThroughFileApi(absPath: string): void {
	if (isSecretPlatformPath(absPath) || isSecretUserPath(absPath, homedir())) {
		throw new ForbiddenPathError();
	}
}

/** 403 for a path the file API refuses to serve. */
class ForbiddenPathError extends AppError {
	constructor() {
		super(SECRET_PATH_REFUSAL, 403, "FORBIDDEN_PATH");
	}
}

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
	// Before the existence probe, for the same reason as `/download`: the refusal is
	// about the path, so it must not depend on whether the file is there.
	assertReadableThroughFileApi(absPath);

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

/**
 * Cap on the body of one human save.
 *
 * Matches `/preview`'s text cap: the editor can only open what preview serves, so a
 * larger body could not have come from a file this API showed. Also bounds the
 * whole-file diff computed for line stats, which runs on the server's only JS thread.
 */
const MAX_WRITE_BYTES = 1024 * 1024;

/**
 * Open flags for a human save: create/truncate as usual, but never follow a link at the
 * final component.
 *
 * Numeric rather than the `"w"` string because `"w"` has no spelling that includes
 * `O_NOFOLLOW`. See the write call for why this is needed at all (the boundary check and
 * the write are separated by several awaits).
 */
const WRITE_FLAGS =
	fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;

/**
 * `GET /api/fs/edit-source?path=...` — load a file FOR EDITING.
 *
 * ## Why the editor cannot just use `/preview`
 *
 * `/preview` decodes with `Bun.file().text()`, which is UTF-8 and only UTF-8. That is
 * correct for a viewer: a GBK file renders with replacement characters, the reader
 * sees it is garbled, and nothing is lost. It is destructive for an editor, because
 * the next save writes those U+FFFD characters back — every un-decodable byte in the
 * file is permanently replaced, including in the regions the user never touched.
 * This repository already knows legacy encodings exist (`encoding.ts`,
 * `originalEncoding` on file snapshots); the human save path has to know too.
 *
 * So this route sniffs the encoding, decodes with it, and reports the name for the
 * client to echo back on save. It also answers the question `/preview` has no reason
 * to ask: whether the file is editable AT ALL.
 *
 * ## What it refuses, and why refusing beats degrading
 *
 * Binary files are refused rather than opened read-only, because "text in, text out"
 * cannot round-trip them — `looksBinary` is the same NUL-byte heuristic git uses, and
 * the tool path consults it before persisting any content as text. Files above the
 * text cap are refused for the reason the cap exists: a partially-loaded buffer that
 * can be saved would truncate the file to whatever was shown.
 *
 * Both refusals are 4xx with a machine-readable `code`, so the UI can disable its
 * edit affordance instead of presenting a save button that destroys data.
 */
fsRoutes.get("/edit-source", async (c) => {
	const rawPath = c.req.query("path");
	if (!rawPath) throw new ValidationError("path is required");

	const absPath = resolve(rawPath);
	// Before the existence probe, exactly as `/preview` and `/download` do it: the
	// refusal is about the path, so it must not double as an existence oracle.
	assertReadableThroughFileApi(absPath);

	if (!existsSync(absPath)) throw new ValidationError(`File does not exist: ${absPath}`);
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absPath);
	} catch {
		throw new ValidationError(`Cannot access: ${absPath}`);
	}
	if (!stat.isFile()) throw new ValidationError(`Not a file: ${absPath}`);

	if (stat.size > MAX_WRITE_BYTES) {
		return c.json(
			{ error: "File too large to edit", code: "TOO_LARGE_TO_EDIT", size: stat.size },
			413,
		);
	}

	const bytes = new Uint8Array(await Bun.file(absPath).arrayBuffer());
	if (looksBinary(bytes)) {
		return c.json({ error: "File is binary and cannot be edited as text", code: "BINARY" }, 415);
	}

	const encoding = detectFileEncoding(bytes);
	const content = decodeFileBytesAs(bytes, encoding);
	return c.json({
		// LF, because CodeMirror hands its document back LF-only: serving the raw CRLF
		// text made the editor compare an LF buffer against a CRLF baseline, so a
		// Windows file showed as modified the instant it was opened and the save button
		// was live before anything had been typed.
		content: normalizeLineEndings(content),
		encoding,
		// The lock token, computed here so the client cannot disagree with the server
		// about which bytes it loaded — and so a browser without WebCrypto (plain HTTP
		// on a non-localhost origin) can still edit, where a client-side hash is
		// unavailable and an absent hash would read as "create this file".
		hash: sha256Hex(content),
		size: stat.size,
	});
});

/**
 * `POST /api/fs/write` — save an edit a PERSON made in the browser.
 *
 * ## Why this is not simply the mirror of `/preview`
 *
 * Reading is guarded by a deny-list that is explicitly not a sandbox
 * (`fs-secret-paths.ts`). That is defensible for reads and unacceptable for writes: a
 * deny-list stops `settings.json` but not `~/.bashrc`, a git hook, or a systemd unit,
 * any of which converts "save a text file" into "run code as the server's user". So
 * this route is gated by an ALLOW-list (`checkWriteBoundary`) rooted at the narrator's
 * own worktree.
 *
 * ## Three things this must do besides writing bytes
 *
 * 1. **Optimistic lock.** An agent and a person editing the same file is this
 *    product's normal state, not an edge case. The client sends the hash it loaded;
 *    a mismatch is refused with 409 rather than overwriting, because the alternative
 *    silently destroys whatever the agent just wrote.
 *
 * 2. **A write claim.** `worktree-write-claims.ts` resolves "who owns this change" by
 *    subtracting *declared* writes from a tree delta, and its module header states
 *    that only shell commands produce undeclared writes. An unbracketed human save
 *    therefore lands inside any concurrent Bash call's owned set — so reverting that
 *    Bash call would also revert the person's save, looking entirely correct while
 *    doing it. Declaring the path is what prevents that.
 *
 * 3. **A `human` attribution.** Otherwise the watcher classifies the save as
 *    `external` on its next tick, and the user's own edit appears in the
 *    modification view as an anonymous foreign change.
 */
fsRoutes.post("/write", async (c) => {
	// Parsed through Zod rather than a hand-written `if` chain: a malformed body must
	// name the offending field, and `c.req.json()` on invalid JSON throws a raw
	// SyntaxError that bypasses the AppError serializer entirely.
	const raw = await readJsonBody(c.req);
	const parsed = fsWriteSchema.safeParse(raw);
	if (!parsed.success) {
		throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid request body");
	}
	const body = parsed.data;

	const rawPath = body.path;
	const narratorId = body.narratorId;
	const encoding = body.encoding ?? "utf-8";

	// The byte length is what the cap is about, and it is not the string's length: the
	// same 1 MB of code units is up to 3 MB of UTF-8, and re-encoding to a legacy
	// charset changes it again. A cheap pre-check before any file access; the bytes
	// actually written are recomputed below, once the target's line endings are known,
	// and re-checked against the same cap.
	if (encodeFileBytesAs(body.content, encoding).byteLength > MAX_WRITE_BYTES) {
		throw new ValidationError("Content exceeds the maximum writable size");
	}

	// Access first: this both authorizes the caller and yields the row carrying `cwd`.
	const narrator = await requireNarratorAccess(c, narratorId, "write");
	const cwd = narrator.cwd?.trim();
	if (!cwd) throw new ValidationError("This narrator has no workspace to write into");

	// `?? []` rather than relying on the defaults merge: a settings object built by any
	// path that skips `deepMerge` would otherwise spread `undefined` and throw here,
	// turning a missing optional key into a 500 on every save.
	const roots = [cwd, ...(settings.paths.extraWritableDirs ?? [])];
	const decision = checkWriteBoundary(rawPath, roots);

	if (!decision.allowed) {
		// Only `outside-allowed-roots` may be overridden by user confirmation.
		// Secret-path, git-internal and symlink-escape are hard refusals:
		// `confirmable` is never set on them because `checkWriteBoundary` runs
		// those checks first.
		if (decision.confirmable && !body.confirmOutsideRoots) {
			// 409 rather than 403: the write IS possible, it just needs the user to
			// see the real physical path and consciously agree. The physical path is
			// included so the confirmation dialog can show WHERE the bytes will land.
			return c.json(
				{
					error: describeWriteRefusal(decision.reason ?? "outside-allowed-roots"),
					code: "NEEDS_CONFIRMATION",
					physicalPath: decision.physicalPath,
					reason: "outside-allowed-roots",
				},
				409,
			);
		}
		if (decision.confirmable && body.confirmOutsideRoots) {
			// User confirmed — fall through to the normal write path.
		} else {
			throw new WriteRefusedError(describeWriteRefusal(decision.reason ?? "unresolvable"));
		}
	}
	// physicalPath is guaranteed here: either `allowed` is true (which always has it),
	// or we fell through the confirmable+confirmOutsideRoots branch (which also has it).
	const target = decision.physicalPath ?? resolve(rawPath);

	// Optimistic lock. Compared against the file's CURRENT bytes, so any writer since
	// the editor loaded it — agent, terminal, another person — is detected.
	let previousContent: string | null = null;
	if (existsSync(target)) {
		const stat = statSync(target);
		if (!stat.isFile()) throw new ValidationError("Target exists and is not a file");
		if (stat.size > MAX_WRITE_BYTES) {
			// Refused rather than truncated: the editor could not have loaded this file in
			// full, so it cannot know what it would be discarding.
			throw new ValidationError("Target file is too large to edit through this API");
		}
		const existingBytes = new Uint8Array(await Bun.file(target).arrayBuffer());
		if (looksBinary(existingBytes)) {
			// Text in, text out: this route re-encodes a decoded string, which does not
			// round-trip binary bytes. Refused rather than mangled, and `/edit-source`
			// already refuses to open such a file so a compliant client never gets here.
			throw new ValidationError("This file is binary and cannot be edited as text");
		}
		// Decoded the same way `/edit-source` decoded it for the editor, so the
		// optimistic-lock hash is computed over the same text the client hashed. Reading
		// UTF-8 here while the editor was served GBK would make every save on a legacy
		// file look like a conflict.
		previousContent = decodeFileBytesAs(existingBytes, encoding);
		const currentHash = sha256Hex(previousContent);
		if (body.baseHash && body.baseHash !== currentHash) {
			// 409 with both hashes plus the live content, so the client can show a diff
			// instead of only reporting failure.
			return c.json(
				{
					error: "The file changed since it was opened",
					code: "STALE_WRITE",
					currentHash,
					expectedHash: body.baseHash,
					// LF for the same reason `/edit-source` normalizes: this becomes the
					// editor's new baseline, and a CRLF baseline against its LF buffer would
					// render the conflict as a whole-file diff.
					currentContent: normalizeLineEndings(previousContent),
				},
				409,
			);
		}
		if (!body.baseHash) {
			// A missing hash means "I am creating this file". The file exists, so the
			// editor's premise is already wrong and overwriting would be a silent clobber.
			return c.json(
				{
					error: "The file already exists",
					code: "STALE_WRITE",
					currentHash,
					currentContent: normalizeLineEndings(previousContent),
				},
				409,
			);
		}
	}

	// The file's own line endings survive a save, the same way its encoding does. The
	// editor's document is LF-only, so writing it verbatim converted every line of a
	// CRLF file — one changed line, and `git diff` showed the whole file.
	const lineEnding = detectLineEnding(previousContent ?? body.content);
	const normalizedContent = normalizeLineEndings(body.content);
	const outputBytes = encodeFileBytesAs(applyLineEnding(normalizedContent, lineEnding), encoding);
	if (outputBytes.byteLength > MAX_WRITE_BYTES) {
		throw new ValidationError("Content exceeds the maximum writable size");
	}
	// What a later read would decode, which is what the optimistic lock compares
	// against. Hashing the REQUEST text instead made the lock disagree with the file
	// whenever encoding or line endings changed the bytes: a character the charset
	// cannot represent is written as "?", so the client's next save carried a hash the
	// file could never have, and every save from then on came back 409 STALE_WRITE.
	const persistedHash = sha256Hex(decodeFileBytesAs(outputBytes, encoding));

	const relPath = relative(cwd, target);
	// A path inside an extra writable dir is not inside the worktree, so it has no
	// worktree-relative form and takes no claim or attribution: those are workspace
	// concepts, and the snapshot machinery only covers the worktree.
	const insideWorktree = !!relPath && !relPath.startsWith("..");
	const claimPath = insideWorktree ? relPath.split(sep).join("/") : null;
	// A synthetic id: the claim registry is keyed by tool-use id, and a human save has
	// none. Prefixed so it is recognisable in a log or a leaked-claim warning.
	const claimId = `human-${generateShortId()}`;

	if (claimPath) openClaim(cwd, narratorId, claimId, [claimPath]);
	try {
		await mkdir(dirname(target), { recursive: true });
		// The bytes encoded above, not the string: writing the string would re-encode it
		// as UTF-8 and convert a legacy-charset file on every save.
		//
		// ── Why the flags ────────────────────────────────────────────────
		// `checkWriteBoundary` resolved this path minutes of event-loop time ago: the
		// narrator lookup, the existence check, the decode and the hash comparison all
		// awaited in between. A link planted in that window at the final component would
		// be followed by a plain `writeFile`, sending the bytes somewhere the boundary
		// never saw. `O_NOFOLLOW` makes the kernel refuse instead (ELOOP).
		//
		// Writing `target` — the RESOLVED path — is what keeps this compatible with the
		// legitimate case: a symlink that stays inside the workspace was already followed
		// during validation, so the final component here is the real file and the flag has
		// nothing to object to. Only a link that appeared AFTER validation trips it.
		//
		// Not complete, and cannot be with this API: `O_NOFOLLOW` covers the last
		// component only, so swapping an intermediate DIRECTORY for a link is still
		// possible in principle (that needs `openat2`/`RESOLVE_NO_SYMLINKS`, which Node's
		// fs does not expose). Both require local write access to the workspace, which in
		// this deployment model already implies the server's own privileges — so this
		// closes the cheap half and the remainder is bounded by the trust model, not left
		// unnoticed.
		await writeFile(target, outputBytes, { flag: WRITE_FLAGS });
	} catch (err) {
		// Sealed on the error path for the same reason the tool hooks do it: an unclosed
		// claim is read as "still running" and would shadow every later window.
		if (claimPath) sealClaim(cwd, claimId);
		throw new AppError(
			`Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
			500,
			"WRITE_FAILED",
		);
	}
	if (claimPath) closeClaim(cwd, claimId, [claimPath]);

	if (claimPath) {
		await recordAttribution({
			deviceId: LOCAL_DEVICE_ID,
			workspacePath: cwd,
			filePath: claimPath,
			// No narratorId: a person is not a session. The narrator only supplied the
			// workspace, and claiming it here would present a human edit as agent work.
			narratorId: null,
			userId: c.get("user").sub,
			action: "human",
			// Both sides LF: a CRLF baseline against LF input counted every line as
			// replaced, so a one-line save was attributed as a whole-file rewrite.
			lineStats: wholeFileLineStats(
				previousContent === null ? null : normalizeLineEndings(previousContent),
				normalizedContent,
			),
		});

		// ── Tree snapshot boundary for the save ──────────────────────────────
		//
		// Tree hashes are captured around agent TOOL calls, and a human save is not one,
		// so without this the bytes land inside whatever window the next tool opens.
		// Two consequences, both silent:
		//
		//   1. Reverting that tool call also reverts the person's edit, because the
		//      window's `before` predates it.
		//   2. Worse, `session._lastTreeHash` is reused as the next tool's `before`.
		//      Segment planning decides "nothing else wrote in between" by testing
		//      `previous.after === next.before`, so a stale `before` can MERGE two
		//      segments that should have stayed split — reversing whatever landed in
		//      between. See `invalidateWorkspaceTreeCache`.
		//
		// The watcher does eventually take a boundary, but not reliably soon: the
		// default path is polling, and a same-size edit to an already-dirty file keeps
		// the status signature byte-identical, so the boundary can wait for the
		// `MAX_SKIPPED_POLLS` sweep (~1 minute). A save is a discrete event we are
		// already inside, so it takes its own boundary instead of waiting to be noticed.
		//
		// Best-effort and ordered cache-first: the bytes are already on disk, so nothing
		// here may fail the request, and dropping the cache matters more than recording
		// the boundary (a missing boundary loses undo granularity, a stale one reverses
		// someone else's work).
		try {
			const { invalidateWorkspaceTreeCache } = await import("../services/narrator-session-state");
			invalidateWorkspaceTreeCache(cwd);
			const { worktreeTreeSnapshot } = await import("../services/worktree-tree-snapshot");
			const treeHash = await worktreeTreeSnapshot.tryCapture(cwd, LOCAL_DEVICE_ID);
			if (treeHash) {
				// Linked into the snapshot DAG for the same reason the watcher does it: a fork
				// taken after this save must start from a state that includes it.
				const { advanceChapterSnapshot } = await import("../services/chapter-snapshot-ref");
				await advanceChapterSnapshot(cwd, treeHash, "human editor save");
			}
		} catch (err) {
			logger.debug("Tree snapshot boundary failed after human save", {
				narratorId,
				path: claimPath,
				error: String(err),
			});
		}
	}

	// ── Notify narrator (best-effort) ────────────────────────────────────
	// Bytes are already on disk, so a notification failure must never surface as
	// a save failure. Logged at debug so it does not alarm operators.
	let notified: string | undefined;
	if (body.notifyAgent) {
		try {
			const { interjectFileEditAsUserMessage } = await import("../services/file-edit-interject");
			const lineStats = wholeFileLineStats(
				previousContent === null ? null : normalizeLineEndings(previousContent),
				normalizedContent,
			);
			const result = await interjectFileEditAsUserMessage(narratorId, {
				filePath: rawPath,
				worktreePath: cwd,
				lineStats,
				locale: (c.req.header("accept-language")?.startsWith("zh") ? "zh-CN" : "en") as
					| "en"
					| "zh-CN",
				userId: c.get("user").sub,
			});
			notified = result.delivered;
		} catch (err) {
			logger.debug("File-edit notification failed after successful save", {
				narratorId,
				path: rawPath,
				error: String(err),
			});
		}
	}

	return c.json({
		ok: true,
		path: target,
		hash: persistedHash,
		bytesWritten: outputBytes.byteLength,
		// Echoed so a client can keep its round trip honest without having to remember
		// what it sent — and so a save that fell back to UTF-8 for an unknown name says so.
		encoding,
		...(notified ? { notified } : {}),
	});
});

/** 403 for a path the write allow-list refuses. */
class WriteRefusedError extends AppError {
	constructor(message: string) {
		super(message, 403, "WRITE_REFUSED");
	}
}

/**
 * Parse a JSON body, reporting malformed input as a 400.
 *
 * `c.req.json()` throws a raw `SyntaxError` on invalid JSON, which is not an
 * `AppError` and so reaches the global handler as an unhandled 500 — a client bug
 * reported as a server fault, with the parse error in the response.
 */
async function readJsonBody(req: { json: () => Promise<unknown> }): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw new ValidationError("Request body must be valid JSON");
	}
}

/** Lowercase hex sha256 of a UTF-8 string, the editor's optimistic-lock token. */
function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Cap for `GET /api/fs/download`.
 *
 * Deliberately far above the preview caps: preview limits exist because the
 * payload is parsed, highlighted and held in the browser's memory, while a
 * download is streamed straight to disk. The ceiling is only here so a stray
 * request for a 100 GB file cannot pin the process streaming it.
 */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * GET /api/fs/download?path=...
 *
 * Serve a file as an attachment. Separate from `/preview` rather than a flag on
 * it: preview is capped for rendering (1 MB text / 20 MB binary) and marked
 * cacheable, whereas a download must reach files above those caps, must never be
 * cached under a session credential, and must not sniff as HTML.
 */
fsRoutes.get("/download", async (c) => {
	const rawPath = c.req.query("path");
	if (!rawPath) {
		throw new ValidationError("path is required");
	}

	const absPath = resolve(rawPath);
	// FIRST, before existence is probed: the refusal is a property of the path, and
	// answering "does not exist" for a secret that is absent on this machine would turn
	// the route into an existence oracle for exactly the files it is protecting.
	assertReadableThroughFileApi(absPath);

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
	if (stat.size > MAX_DOWNLOAD_BYTES) {
		return c.json({ error: "File too large to download" }, 413);
	}

	// BunFile as the body directly: Bun sets Content-Length from it, so the
	// browser can show real download progress (a ReadableStream would force
	// chunked encoding and drop the length).
	const file = Bun.file(absPath);
	return new Response(file, {
		headers: {
			// Always octet-stream: the point is to save the bytes, and an honest
			// `text/html` here would be a stored-XSS vector on a same-origin URL.
			"Content-Type": "application/octet-stream",
			"Content-Disposition": buildAttachmentDisposition(basename(absPath)),
			"Content-Length": String(stat.size),
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});

/**
 * Ceiling on the extra `statSync` calls one listing may spend resolving symlinks.
 *
 * This route is synchronous on the server's only JS thread, so the per-entry work
 * has to be bounded (see the main-thread rules in CLAUDE.md). Only symlinks are
 * probed, so an ordinary directory costs nothing; the cap exists for the
 * pathological case of a directory holding tens of thousands of links, possibly on
 * a network filesystem where each stat is a round trip.
 *
 * Same order as MAX_DIRECTORY_ENTRIES on the client: past that point the listing is
 * already unusable as a picker.
 */
const MAX_SYMLINK_PROBES = 1000;

/**
 * Ceiling on entries ONE listing may return.
 *
 * `MAX_SYMLINK_PROBES` bounds the cost of an entry whose kind is unknown, but until
 * this cap existed nothing bounded the count itself: `includeFiles=1` over a
 * `node_modules` or a build output directory returned every child, and the work grew
 * with the directory. Measured on 50 000 plain files (warm cache, local disk): 23 ms
 * to read the directory, 107 ms to stat them, 5.5 MB of JSON. All of it on the single
 * JS thread that carries the agent loop, and every figure worse on a network mount.
 *
 * Set ABOVE both clients' own display caps (1 000 in `DirectoryPicker` and in
 * `FileTreeContent`) on purpose. Those two already slice and render a "N more" row
 * from `entries.length`; a server cap at or below theirs would drive that count to
 * zero and turn a visible truncation into a silent one. `truncated` is what tells a
 * caller the count it can compute is itself a floor.
 */
const MAX_BROWSE_ENTRIES = 5_000;

/**
 * Ceiling on raw directory entries EXAMINED, accepted or not.
 *
 * Separate from `MAX_BROWSE_ENTRIES` because filtering happens before accepting:
 * without this, a directory of 200 000 dotfiles read with `showHidden=0` would be
 * walked in full to produce an empty listing — the accepted-entry cap never trips,
 * so it never stops anything.
 */
const MAX_BROWSE_SCAN = 50_000;

/**
 * Ceiling on `statSync` calls spent decorating files with a byte size.
 *
 * A size is the one field here that is pure decoration: `size` is already optional,
 * and a listing without it is complete and usable. So it gets a budget well below
 * `MAX_BROWSE_ENTRIES`, and past it entries are still listed, just without a size —
 * on a network mount, thousands of round trips for a number is the wrong trade.
 *
 * Which files lose their size follows directory order, not the sorted order the
 * client sees, so it is not "the last N alphabetically".
 */
const MAX_FILE_SIZE_PROBES = 1_000;

/** A directory entry returned by `/browse`. */
interface BrowseEntry {
	name: string;
	path: string;
	/** The entry is a symbolic link (to a directory, or to a file when files are listed). */
	isSymlink: boolean;
	/**
	 * Whether this entry is a directory.
	 *
	 * Always present, and always `true` unless `includeFiles` was requested. Sent
	 * even in directory-only mode so a client never has to infer the kind from the
	 * flag's absence: a tree that guesses "no field means file" would render every
	 * directory as a leaf the moment it talked to an older server.
	 */
	isDirectory: boolean;
	/** Size in bytes. Only set for files (`isDirectory: false`). */
	size?: number;
}

/** One directory level: the entries listed, and whether anything was left out. */
interface BrowseListing {
	entries: BrowseEntry[];
	/**
	 * Some child of this directory is NOT in `entries`.
	 *
	 * Set by any of the three caps below. A caller must then read
	 * `entries.length` as a floor rather than as the directory's size — the
	 * distinction the clients' own "N more entries" rows depend on.
	 */
	truncated: boolean;
}

/**
 * List immediate children of a path — directories always, files when asked.
 *
 * Symlinks need a second `stat` because `withFileTypes` reports `Dirent` flags from
 * **lstat**: a link pointing at a directory answers `isDirectory() === false` and
 * only `isSymbolicLink() === true`. Filtering on `isDirectory()` alone therefore
 * made every symlinked directory invisible in the picker — including the common
 * case of a project directory reached through a link.
 *
 * Links we deliberately do NOT list, in either mode:
 *  - dangling (`ENOENT`) and self-referential/cyclic (`ELOOP`) links, plus anything
 *    else `stat` refuses: every action offered on an entry (enter it, select it,
 *    open it in a viewer) needs the target to exist, so listing one just defers the
 *    error to the user's next click;
 *  - links to something that is neither a file nor a directory (sockets, devices):
 *    nothing in the UI can act on them.
 *
 * `includeFiles` widens what counts as listable, NOT the per-entry cost for
 * directories: a plain file is accepted from its `Dirent` alone, and only the
 * *size* needs a stat. That size is best-effort — a file whose stat fails is still
 * listed (it is really there and can still be opened), just without a size, since
 * dropping a readable file over a missing byte count would be the worse trade.
 *
 * ## Bounded on three axes, all of them because this runs on the shared JS thread
 *
 * `MAX_BROWSE_SCAN` (children examined), `MAX_BROWSE_ENTRIES` (children returned)
 * and `MAX_FILE_SIZE_PROBES` (sizes resolved) each bound a different cost, and each
 * is reachable without the others tripping. Hitting either of the first two stops
 * the walk and reports `truncated`; exhausting the size budget only drops the
 * decoration, so the listing stays complete and `truncated` stays false.
 *
 * The directory is STREAMED (`opendirSync` + `readSync`) rather than read into an
 * array first: `readdirSync` materializes every child before the caps can reject
 * any, which is exactly the allocation a cap on a huge directory exists to avoid.
 */
function listDirs(dir: string, showHidden = false, includeFiles = false): BrowseListing {
	let handle: Dir;
	try {
		handle = opendirSync(dir);
	} catch {
		return { entries: [], truncated: false };
	}

	const entries: BrowseEntry[] = [];
	let symlinkProbesLeft = MAX_SYMLINK_PROBES;
	let sizeProbesLeft = MAX_FILE_SIZE_PROBES;
	let scanned = 0;
	let truncated = false;

	try {
		while (true) {
			let d: Dirent | null;
			try {
				d = handle.readSync();
			} catch {
				// A directory that becomes unreadable mid-walk (removed, permissions
				// changed): keep what was already collected instead of discarding it, and
				// say so — the remaining children are unknown, not absent.
				truncated = true;
				break;
			}
			if (d === null) break;

			if (scanned >= MAX_BROWSE_SCAN) {
				truncated = true;
				break;
			}
			scanned++;

			// Skip hidden dirs on Unix unless showHidden is true
			if (!showHidden && d.name.startsWith(".")) continue;
			// Always skip system dirs on Windows
			if (d.name === "$RECYCLE.BIN" || d.name === "System Volume Information") continue;

			// Checked before accepting, so the cap is the number RETURNED. Placed after
			// the filters for the same reason `MAX_BROWSE_SCAN` exists separately: a
			// rejected child costs a name comparison, not an entry.
			if (entries.length >= MAX_BROWSE_ENTRIES) {
				truncated = true;
				break;
			}

			const path = join(dir, d.name);
			if (d.isDirectory()) {
				entries.push({ name: d.name, path, isSymlink: false, isDirectory: true });
				continue;
			}
			if (d.isSymbolicLink()) {
				if (symlinkProbesLeft <= 0) {
					// The kind of this link is unknowable within budget, so it is omitted
					// rather than guessed — and that omission is a truncation.
					truncated = true;
					continue;
				}
				symlinkProbesLeft--;
				try {
					// statSync follows the link; a broken or cyclic link throws here and the
					// entry is dropped rather than failing the whole listing.
					const target = statSync(path);
					if (target.isDirectory()) {
						entries.push({ name: d.name, path, isSymlink: true, isDirectory: true });
					} else if (includeFiles && target.isFile()) {
						// The size came free with the stat the link's kind already required.
						entries.push({
							name: d.name,
							path,
							isSymlink: true,
							isDirectory: false,
							size: target.size,
						});
					}
				} catch {
					// ENOENT (dangling) / ELOOP (cycle) / EACCES — not a usable entry.
				}
				continue;
			}
			if (!includeFiles || !d.isFile()) continue;
			let size: number | undefined;
			if (sizeProbesLeft > 0) {
				sizeProbesLeft--;
				size = statSizeOrUndefined(path);
			}
			entries.push({
				name: d.name,
				path,
				isSymlink: false,
				isDirectory: false,
				...(size === undefined ? {} : { size }),
			});
		}
	} finally {
		// The handle holds an OS file descriptor; leaking one per listing would
		// exhaust the process's table under a client that browses freely.
		try {
			handle.closeSync();
		} catch {
			// Already closed or gone — nothing left to release.
		}
	}

	return { entries: entries.sort(compareEntries), truncated };
}

/**
 * `statSync().size`, or undefined if the file cannot be stat'ed.
 *
 * Separate from `MAX_SYMLINK_PROBES`: that budget bounds links whose *kind* is
 * unknown until probed (omitting one changes the listing), whereas this only
 * decorates an entry already known to be a file. It has its own, smaller budget
 * (`MAX_FILE_SIZE_PROBES`) rather than none at all — see that constant.
 */
function statSizeOrUndefined(path: string): number | undefined {
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}

/**
 * Directories first, then files, each group alphabetical.
 *
 * Grouping matters more than it looks: the tree lazily loads a directory's
 * children, so with a flat alphabetical sort the expandable rows would be
 * scattered through a long list of leaves.
 */
function compareEntries(a: BrowseEntry, b: BrowseEntry): number {
	if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
	return a.name.localeCompare(b.name);
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
 * 3. Return null if all methods fail (no USERPROFILE concatenation fallback)
 */
function resolveWindowsKnownFolder(key: string, _home: string): string | null {
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

	// Method 3: No fallback - return null if PowerShell methods fail
	// Desktop should always use [Environment]::GetFolderPath, not USERPROFILE concatenation
	_winFolderCache[key] = null;
	return null;
}

/**
 * Resolve a well-known user directory (desktop, documents, downloads)
 * using platform-appropriate APIs.
 *
 * - Linux: XDG user-dirs.dirs → env vars → fallback ~/Desktop etc.
 * - macOS: ~/Desktop, ~/Documents, ~/Downloads (always English on macOS)
 * - Windows: Environment.GetFolderPath via PowerShell only (no fallback)
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
