/**
 * `GET /api/fs/browse` — the listing behind the directory picker and the path
 * autocomplete.
 *
 * These tests exist because of one specific bug: `readdirSync(..., {
 * withFileTypes: true })` reports `Dirent` flags derived from **lstat**, so a
 * symlink pointing at a directory answers `isDirectory() === false`. Filtering on
 * that alone made every symlinked directory invisible in the picker — a project
 * reached through a link simply could not be selected.
 *
 * The rest of the cases pin the decisions that come with following links: a broken
 * or cyclic link must be dropped WITHOUT taking the rest of the listing with it
 * (a single dangling link used to be the difference between a usable directory and
 * an empty one), and `path` must stay the link's own path rather than its target,
 * because the user is choosing the path they navigated to.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { fsRoutes } from "../fs";

// The real app mounts these behind `requireSessionAuth`; authorization is covered
// elsewhere, so this harness only adds the app's own error serialization.
const app = new Hono().route("/fs", fsRoutes).onError((err, c) => {
	return buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500);
});

interface BrowseEntry {
	name: string;
	path: string;
	isSymlink?: boolean;
	isDirectory?: boolean;
	size?: number;
}

let dir: string;

async function browse(
	path: string,
	showHidden = false,
	includeFiles = false,
): Promise<BrowseEntry[]> {
	const qs = new URLSearchParams({ path });
	if (showHidden) qs.set("showHidden", "1");
	if (includeFiles) qs.set("includeFiles", "1");
	const res = await app.request(`http://localhost/fs/browse?${qs}`);
	expect(res.status).toBe(200);
	return ((await res.json()) as { entries: BrowseEntry[] }).entries;
}

function names(entries: BrowseEntry[]): string[] {
	return entries.map((e) => e.name);
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "nf-fs-browse-"));
	mkdirSync(join(dir, "real-dir"));
	mkdirSync(join(dir, ".hidden-dir"));
	writeFileSync(join(dir, "plain-file.txt"), "x");

	symlinkSync(join(dir, "real-dir"), join(dir, "link-to-dir"));
	symlinkSync(join(dir, "plain-file.txt"), join(dir, "link-to-file"));
	symlinkSync(join(dir, "does-not-exist"), join(dir, "dangling-link"));
	symlinkSync(join(dir, ".hidden-dir"), join(dir, ".hidden-link"));
	// A self-referential link: stat() answers ELOOP rather than ENOENT.
	symlinkSync(join(dir, "cyclic-link"), join(dir, "cyclic-link"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/fs/browse symlink handling", () => {
	test("lists a symlink whose target is a directory, flagged as a symlink", async () => {
		const entries = await browse(dir);
		const link = entries.find((e) => e.name === "link-to-dir");

		expect(link).toBeDefined();
		expect(link?.isSymlink).toBe(true);
	});

	test("returns the link's own path, not its resolved target", async () => {
		const entries = await browse(dir);
		const link = entries.find((e) => e.name === "link-to-dir");

		// The picker persists whatever it hands back, and the user navigated to the
		// link. Silently substituting the target would store a path they never chose.
		expect(link?.path).toBe(join(dir, "link-to-dir"));
	});

	test("marks a real directory as not a symlink", async () => {
		const entries = await browse(dir);

		expect(entries.find((e) => e.name === "real-dir")?.isSymlink).toBe(false);
	});

	test("omits a symlink pointing at a file, like any other file", async () => {
		expect(names(await browse(dir))).not.toContain("link-to-file");
	});

	test("omits dangling and cyclic links without losing the rest of the listing", async () => {
		const listed = names(await browse(dir));

		expect(listed).not.toContain("dangling-link");
		expect(listed).not.toContain("cyclic-link");
		// The regression this guards: one unusable link must not empty the directory.
		expect(listed).toContain("real-dir");
		expect(listed).toContain("link-to-dir");
	});

	test("hidden symlinks obey showHidden, exactly like hidden directories", async () => {
		expect(names(await browse(dir, false))).not.toContain(".hidden-link");

		const shown = names(await browse(dir, true));
		expect(shown).toContain(".hidden-link");
		expect(shown).toContain(".hidden-dir");
	});
});

/**
 * `includeFiles=1` — the file tree's mode.
 *
 * Opt-in because the directory PICKER, this route's original caller, requires every
 * entry to be selectable as a directory. These tests pin both halves of that: the
 * default stays directory-only, and the flag adds files without changing how
 * directories are reported.
 */
describe("GET /api/fs/browse?includeFiles=1", () => {
	test("omits files by default, so the directory picker is unaffected", async () => {
		const listed = names(await browse(dir));

		expect(listed).not.toContain("plain-file.txt");
		expect(listed).not.toContain("link-to-file");
	});

	test("lists files when asked, marked as non-directories with a size", async () => {
		const entries = await browse(dir, false, true);
		const file = entries.find((e) => e.name === "plain-file.txt");

		expect(file).toBeDefined();
		expect(file?.isDirectory).toBe(false);
		// The fixture wrote a single byte.
		expect(file?.size).toBe(1);
	});

	test("marks directories explicitly rather than by the absence of a flag", async () => {
		// A client that inferred "no isDirectory field means file" would render every
		// directory as an unexpandable leaf. The field is always sent.
		const entries = await browse(dir, false, true);

		expect(entries.find((e) => e.name === "real-dir")?.isDirectory).toBe(true);
		expect(entries.find((e) => e.name === "link-to-dir")?.isDirectory).toBe(true);
	});

	test("sends isDirectory even in directory-only mode", async () => {
		const entries = await browse(dir);

		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((e) => e.isDirectory === true)).toBe(true);
	});

	test("follows a symlink to a file and reports it as a file", async () => {
		const entries = await browse(dir, false, true);
		const link = entries.find((e) => e.name === "link-to-file");

		expect(link?.isDirectory).toBe(false);
		expect(link?.isSymlink).toBe(true);
		// The link's own path, for the same reason directories keep theirs.
		expect(link?.path).toBe(join(dir, "link-to-file"));
	});

	test("still drops dangling and cyclic links", async () => {
		// Nothing in the UI can act on a link whose target is missing — opening it in a
		// viewer fails exactly like entering it did.
		const listed = names(await browse(dir, false, true));

		expect(listed).not.toContain("dangling-link");
		expect(listed).not.toContain("cyclic-link");
		expect(listed).toContain("plain-file.txt");
	});

	test("hidden files obey showHidden", async () => {
		const hiddenFile = join(dir, ".hidden-file");
		writeFileSync(hiddenFile, "x");
		try {
			expect(names(await browse(dir, false, true))).not.toContain(".hidden-file");
			expect(names(await browse(dir, true, true))).toContain(".hidden-file");
		} finally {
			rmSync(hiddenFile, { force: true });
		}
	});

	test("groups directories before files", async () => {
		// The tree lazily loads children, so expandable rows must not be scattered
		// through a long run of leaves.
		const entries = await browse(dir, false, true);
		const firstFileIndex = entries.findIndex((e) => e.isDirectory === false);
		const lastDirIndex = entries.reduce((acc, e, i) => (e.isDirectory === true ? i : acc), -1);

		expect(firstFileIndex).toBeGreaterThan(-1);
		expect(lastDirIndex).toBeLessThan(firstFileIndex);
	});
});

/**
 * The three caps in `listDirs` (`MAX_BROWSE_SCAN`, `MAX_BROWSE_ENTRIES`,
 * `MAX_FILE_SIZE_PROBES`).
 *
 * The route is synchronous on the server's only JS thread, so a listing has to be
 * bounded on every axis it can spend time on. Each test pins a different way a cap
 * can be reached, and — the part that actually matters to callers — that reaching
 * one is REPORTED (`truncated: true`) rather than silent. A client that cannot tell
 * "this is everything" from "this is the first N" would render a truncated listing
 * as a complete one.
 */
describe("GET /api/fs/browse listing caps", () => {
	interface BrowseResponse {
		entries: BrowseEntry[];
		truncated?: boolean;
	}

	async function browseFull(path: string, showHidden = false): Promise<BrowseResponse> {
		const qs = new URLSearchParams({ path });
		if (showHidden) qs.set("showHidden", "1");
		qs.set("includeFiles", "1");
		const res = await app.request(`http://localhost/fs/browse?${qs}`);
		expect(res.status).toBe(200);
		return (await res.json()) as BrowseResponse;
	}

	test("a small directory is not truncated", async () => {
		const res = await browseFull(dir);

		expect(res.truncated).toBe(false);
		expect(names(res.entries)).toContain("plain-file.txt");
	});

	test("more entries than the entry cap reports truncated, and the count is the cap", async () => {
		const overflow = mkdtempSync(join(tmpdir(), "nf-fs-browse-cap-"));
		try {
			// One past MAX_BROWSE_ENTRIES, so the cap — not the directory size — is what
			// the response length reflects. createFileSync keeps this cheap.
			for (let i = 0; i <= 5_000; i++) {
				writeFileSync(join(overflow, `f${i}`), "");
			}

			const res = await browseFull(overflow);

			expect(res.entries.length).toBe(5_000);
			expect(res.truncated).toBe(true);
		} finally {
			rmSync(overflow, { recursive: true, force: true });
		}
	});

	test("files past the size budget are listed but lose their size", async () => {
		const sizes = mkdtempSync(join(tmpdir(), "nf-fs-browse-size-"));
		try {
			// MAX_FILE_SIZE_PROBES files WITH sizes, then one more that must still
			// appear — decorated entries become undecorated, never unlisted.
			for (let i = 0; i <= 1_000; i++) {
				writeFileSync(join(sizes, `s${i}`), "x");
			}

			const res = await browseFull(sizes);

			expect(res.truncated).toBe(false);
			expect(res.entries.length).toBe(1_001);
			const withSize = res.entries.filter((e) => e.size !== undefined);
			expect(withSize.length).toBe(1_000);
			expect(withSize.every((e) => e.size === 1)).toBe(true);
		} finally {
			rmSync(sizes, { recursive: true, force: true });
		}
	});

	test("filtered children count against the scan cap, not the returned count", async () => {
		const filtered = mkdtempSync(join(tmpdir(), "nf-fs-browse-scan-"));
		try {
			// Every child is a dotfile. A scan cap that only counted ACCEPTED entries
			// would walk all of them for an empty listing; what pins the separate scan
			// budget is that far more than MAX_BROWSE_ENTRIES hidden names still trips
			// it and reports truncated.
			for (let i = 0; i < 50_001; i++) {
				writeFileSync(join(filtered, `.h${i}`), "");
			}

			const res = await browseFull(filtered);

			expect(res.entries.length).toBe(0);
			expect(res.truncated).toBe(true);
		} finally {
			rmSync(filtered, { recursive: true, force: true });
		}
	});
});
