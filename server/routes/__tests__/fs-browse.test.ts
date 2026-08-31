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
}

let dir: string;

async function browse(path: string, showHidden = false): Promise<BrowseEntry[]> {
	const qs = new URLSearchParams({ path });
	if (showHidden) qs.set("showHidden", "1");
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
