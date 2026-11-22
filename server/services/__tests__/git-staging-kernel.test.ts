import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	GIT_STAGING_UNASSIGNED_LIST_ID,
	GIT_STAGING_UNASSIGNED_LIST_NAME,
	type GitStagingAction,
	GIT_STAGING_LIMITS as LIMITS,
} from "../../../shared/git-staging-lists";
import { parseUnifiedDiff } from "../../../shared/pretext-layout/parse-unified-diff";
import * as observer from "../git-changelist-observer";
import {
	CHANGELIST_APPLICATION_ID,
	ChangelistStore,
	type StoredFile,
} from "../git-changelist-store";
import { IndependentGitStagingKernel, resolveGitStagingRepository } from "../git-staging-kernel";
import * as processes from "../git-staging-process";

setDefaultTimeout(30_000);
const exec = promisify(execFile);
let root: string, kernel: IndependentGitStagingKernel;
const extras: string[] = [];
const restores: (() => void)[] = [];
const env = {
	...process.env,
	GIT_OPTIONAL_LOCKS: "0",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.test",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.test",
};
for (const key of [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_PARAMETERS",
])
	delete (env as Record<string, string | undefined>)[key];
async function git(...args: string[]) {
	return (
		await exec("git", ["--no-optional-locks", ...args], {
			cwd: root,
			env,
			timeout: 15_000,
			maxBuffer: 8_388_608,
		})
	).stdout.trimEnd();
}
async function file(path: string, bytes: string | Buffer) {
	await writeFile(join(root, path), bytes);
}
async function bytes() {
	return readFile((await resolveGitStagingRepository(root)).index).catch(() => null);
}
type Input<T = GitStagingAction> = T extends unknown
	? Omit<T, "expectedGeneration" | "observationId">
	: never;
async function act(input: Input) {
	if (input.action === "init" || input.action === "sync") return kernel.action(input);
	const s = await kernel.summary();
	return kernel.action({
		...input,
		expectedGeneration: s.generation,
		observationId: s.observationId as string,
	} as GitStagingAction);
}
async function create(name = "B") {
	const result = await act({ action: "create", name });
	return result.listId as string;
}
async function active() {
	return (await kernel.summary()).activeListId as string;
}
async function move(fromListId: string, toListId: string, paths: string[]) {
	return act({ action: "move", fromListId, toListId, paths });
}
async function commit(listId: string) {
	return act({
		action: "commit",
		listId,
		message: "Selected changes",
		identity: { name: "Fixture", email: "fixture@example.test" },
	});
}
async function db() {
	const repo = await resolveGitStagingRepository(root);
	return new Database(join(repo.directory, "changelists.sqlite"), { readonly: true });
}
async function legacyObservation(listId: string, publicFlags = true) {
	const store = await ChangelistStore.open(await resolveGitStagingRepository(root));
	if (!store) throw new Error("Missing fixture store");
	try {
		const state = store.state();
		const draft = await store.draft(state.head_oid, state.head_tree as string);
		for (const metadata of store.fileIds()) {
			const file = store.loadFile(metadata.file_id) as StoredFile;
			const structural = file.units.filter(
				(unit) => unit.kind !== "text" && unit.listId === listId,
			);
			await store.putFile(draft, {
				...file,
				versionId: crypto.randomUUID(),
				units: file.units.map((unit) =>
					publicFlags && unit.listId === listId
						? { ...unit, needsReview: true, reviewReason: "headChanged" }
						: unit,
				),
				ownership: file.ownership
					? {
							...file.ownership,
							units: file.ownership.units.map((unit) =>
								unit.groupId === listId
									? {
											...unit,
											needsReview: true,
											reviewReason: "headChanged" as const,
											sourceGroupIds: [listId],
										}
									: unit,
							),
							...(structural.length
								? {
										structuralSourceGroupIds: Object.fromEntries(
											structural.map((unit) => [unit.id, [listId]]),
										),
									}
								: {}),
						}
					: null,
			});
		}
		await store.publish(draft, state, state.head_oid, state.head_tree as string);
		return { ...store.state(), observation_id: draft };
	} finally {
		store.close();
	}
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "nf-dynamic-changelists-"));
	await git("init", "--quiet", "--initial-branch=main");
	await git("config", "user.name", "Fixture");
	await git("config", "user.email", "fixture@example.test");
	await git("config", "commit.gpgSign", "false");
	await file("f", "first\ncontext1\ncontext2\nlast\n");
	await file("a", "base\n");
	await file("b", "base\n");
	await git("add", "--", "f", "a", "b");
	await git("commit", "--quiet", "-m", "Base");
	kernel = new IndependentGitStagingKernel(root, "workspace");
});
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	await rm(root, { recursive: true, force: true });
	for (const extra of extras.splice(0)) await rm(extra, { recursive: true, force: true });
});

test("initialization publishes current HEAD-to-worktree changes to Changes and never reads old JSON/index", async () => {
	const repo = await resolveGitStagingRepository(root);
	await mkdir(join(repo.directory, "lists"), { recursive: true });
	await writeFile(join(repo.directory, "lists", "old.json"), "{corrupt old state");
	await mkdir(join(repo.directory, "indexes"));
	await writeFile(join(repo.directory, "indexes", "old.index"), "old");
	await file("a", "changed\n");
	await file("new", "untracked\n");
	const native = await bytes(),
		head = await git("rev-parse", "HEAD");
	expect((await kernel.summary()).initialized).toBe(false);
	await act({ action: "init" });
	const summary = await kernel.summary();
	expect(summary).toMatchObject({ initialized: true, state: "ready", generation: 1 });
	expect(summary.lists).toHaveLength(1);
	expect(summary.lists[0]).toMatchObject({ name: "Changes", active: true, fileCount: 2 });
	expect(await bytes()).toEqual(native);
	expect(await git("rev-parse", "HEAD")).toBe(head);
	expect(await readFile(join(repo.directory, "lists", "old.json"), "utf8")).toBe(
		"{corrupt old state",
	);
	const first = await active();
	await act({ action: "init" });
	expect(await active()).toBe(first);
});

test("observation baseline matches summary for missing, unobserved and published workspace states", async () => {
	const pick = ({
		initialized,
		generation,
		observationId,
		state,
	}: Awaited<ReturnType<typeof kernel.summary>>) => ({
		initialized,
		generation,
		observationId,
		state,
	});
	expect(await kernel.baseline()).toEqual(pick(await kernel.summary()));
	expect(await kernel.baseline()).toEqual({
		initialized: false,
		generation: 0,
		observationId: null,
		state: "uninitialized",
	});
	const repo = await resolveGitStagingRepository(root);
	await expect(lstat(repo.directory)).rejects.toMatchObject({ code: "ENOENT" });
	const store = await ChangelistStore.open(repo, true);
	if (!store) throw new Error("Missing fixture store");
	store.close();
	expect(await kernel.baseline()).toEqual(pick(await kernel.summary()));
	expect((await kernel.baseline()).initialized).toBe(false);
	await file("a", "edit\n");
	await act({ action: "init" });
	const writer = await ChangelistStore.open(repo);
	if (!writer) throw new Error("Missing fixture store");
	try {
		for (const state of ["ready", "stale", "incomplete", "conflict", "recovering"] as const) {
			await writer.transaction(() =>
				writer.db.query("UPDATE workspace_state SET state=?").run(state),
			);
			expect(await kernel.baseline()).toEqual(pick(await kernel.summary()));
			expect(await kernel.baseline()).toMatchObject({ initialized: true, state });
		}
	} finally {
		writer.close();
	}
});

test("observation baseline reads only workspace data and prepares a zero-row summary schema check", async () => {
	await file("a", "edit\n");
	await act({ action: "init" });
	const summary = await kernel.summary();
	const repo = await resolveGitStagingRepository(root);
	const store = await ChangelistStore.open(repo, false);
	if (!store) throw new Error("Missing fixture store");
	const schemaSql =
		"SELECT id,name,active,file_count,unit_count,added,removed,needs_review_count FROM v_changelists LIMIT 0";
	const schema = store.db.query(schemaSql);
	const all = spyOn(schema, "all"),
		get = spyOn(schema, "get"),
		iterate = spyOn(schema, "iterate"),
		values = spyOn(schema, "values"),
		run = spyOn(schema, "run");
	const query = spyOn(store.db, "query");
	const open = spyOn(ChangelistStore, "open").mockResolvedValueOnce(store);
	const close = spyOn(store, "close");
	const full = spyOn(kernel, "summary").mockRejectedValue(
		new Error("Full summary is not a baseline read"),
	);
	restores.push(
		() => query.mockRestore(),
		() => open.mockRestore(),
		() => close.mockRestore(),
		() => full.mockRestore(),
		() => all.mockRestore(),
		() => get.mockRestore(),
		() => iterate.mockRestore(),
		() => values.mockRestore(),
		() => run.mockRestore(),
	);
	expect(await kernel.baseline()).toEqual({
		initialized: summary.initialized,
		generation: summary.generation,
		observationId: summary.observationId,
		state: summary.state,
	});
	expect(open).toHaveBeenCalledWith(repo, false);
	expect(query.mock.calls).toEqual([["SELECT * FROM v_workspace_state"], [schemaSql]]);
	expect(query.mock.results[1]?.value).toBe(schema);
	for (const read of [all, get, iterate, values, run]) expect(read).not.toHaveBeenCalled();
	expect(close).toHaveBeenCalledTimes(1);
	expect(full).not.toHaveBeenCalled();
});

test("observation baseline closes the store and propagates a failed state read", async () => {
	await act({ action: "init" });
	const store = await ChangelistStore.open(await resolveGitStagingRepository(root), false);
	if (!store) throw new Error("Missing fixture store");
	const open = spyOn(ChangelistStore, "open").mockResolvedValueOnce(store);
	const close = spyOn(store, "close");
	const state = spyOn(store, "state").mockImplementation(() => {
		throw new Error("injected state read failure");
	});
	restores.push(
		() => open.mockRestore(),
		() => close.mockRestore(),
		() => state.mockRestore(),
	);
	await expect(kernel.baseline()).rejects.toThrow("injected state read failure");
	expect(close).toHaveBeenCalledTimes(1);
});

for (const fixture of ["empty", "reserved", "foreign", "corrupt"] as const)
	test(`observation baseline preserves ${fixture} storage failure without initializing it`, async () => {
		const repo = await resolveGitStagingRepository(root);
		await mkdir(repo.directory, { recursive: true });
		const path = join(repo.directory, "changelists.sqlite");
		if (fixture === "empty" || fixture === "corrupt")
			await writeFile(path, fixture === "empty" ? "" : "not a SQLite database");
		else {
			const database = new Database(path);
			database.exec(
				fixture === "reserved"
					? `PRAGMA application_id=${CHANGELIST_APPLICATION_ID};PRAGMA user_version=0`
					: "PRAGMA application_id=123;PRAGMA user_version=9;CREATE TABLE sentinel(value TEXT)",
			);
			database.close();
		}
		const before = await readFile(path);
		const code =
			fixture === "foreign"
				? "GIT_STAGING_UNSUPPORTED_FORMAT"
				: fixture === "corrupt"
					? "GIT_STAGING_STORAGE_INVALID"
					: "GIT_STAGING_INITIALIZATION_INCOMPLETE";
		await expect(kernel.baseline()).rejects.toMatchObject({ code });
		await expect(kernel.summary()).rejects.toMatchObject({ code });
		expect(await readFile(path)).toEqual(before);
	});

for (const failure of ["missing", "invalid-reference", "missing-column"] as const)
	test(`observation baseline rejects broken summary view structure: ${failure}`, async () => {
		await act({ action: "init" });
		const repo = await resolveGitStagingRepository(root);
		const path = join(repo.directory, "changelists.sqlite");
		const writer = new Database(path);
		try {
			writer.exec("DROP VIEW v_changelists");
			if (failure === "invalid-reference")
				writer.exec("CREATE VIEW v_changelists AS SELECT missing_schema_column FROM change_lists");
			if (failure === "missing-column")
				writer.exec("CREATE VIEW v_changelists AS SELECT name FROM change_lists");
		} finally {
			writer.close();
		}
		const before = await readFile(path);
		const message = failure === "missing" ? /no such table.*v_changelists/i : /no such column/i;
		await expect(kernel.summary()).rejects.toThrow(message);
		await expect(kernel.baseline()).rejects.toThrow(message);
		expect(await readFile(path)).toEqual(before);
	});

test("observation baseline retains the same locked-storage failure as summary", async () => {
	await act({ action: "init" });
	const repo = await resolveGitStagingRepository(root);
	const database = new Database(join(repo.directory, "changelists.sqlite"));
	try {
		database.exec("PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE");
		await expect(kernel.baseline()).rejects.toMatchObject({
			code: "GIT_STAGING_STORAGE_INVALID",
			message: expect.stringMatching(/locked|busy/i),
		});
		await expect(kernel.summary()).rejects.toMatchObject({
			code: "GIT_STAGING_STORAGE_INVALID",
			message: expect.stringMatching(/locked|busy/i),
		});
		database.exec("ROLLBACK");
		expect(await kernel.baseline()).toMatchObject({ initialized: true, state: "ready" });
	} finally {
		database.close();
	}
});

test("independent SQLite read-only views expose structured ranges without content columns", async () => {
	await file("a", "edit\n");
	await act({ action: "init" });
	const read = await db();
	try {
		expect(read.query("PRAGMA application_id").get()).toEqual({
			application_id: CHANGELIST_APPLICATION_ID,
		});
		expect(read.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
		expect(read.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		expect(read.query("SELECT name,file_count,unit_count FROM v_changelists").get()).toEqual({
			name: "Changes",
			file_count: 1,
			unit_count: 1,
		});
		expect(
			read.query("SELECT path,list_name,base_start,base_end,added,removed FROM v_changes").get(),
		).toEqual({
			path: "a",
			list_name: "Changes",
			base_start: 0,
			base_end: 1,
			added: 1,
			removed: 1,
		});
		expect(read.query("SELECT COUNT(*) n FROM tracking_lines").get()).toEqual({ n: 2 });
		expect(
			read.query("SELECT state,scanned_at IS NOT NULL fresh FROM v_workspace_state").get(),
		).toEqual({ state: "ready", fresh: 1 });
	} finally {
		read.close();
	}
});

test("metadata, files and diff queries do not run Git or implicitly synchronize", async () => {
	await file("a", "observed\n");
	await act({ action: "init" });
	const id = await active();
	await file("a", "later\n");
	const mock = spyOn(processes, "stagingGit").mockImplementation(async () => {
		throw new Error("query must not invoke Git");
	});
	restores.push(() => mock.mockRestore());
	expect((await kernel.summary()).lists[0].fileCount).toBe(1);
	expect((await kernel.files(id)).files).toHaveLength(1);
	expect((await kernel.diff(id, { path: "a" })).diff).toContain("+observed");
});

test("no-op scans across fresh Worker-style kernels preserve database and WAL bytes and mtimes", async () => {
	await file("a", "edit\n");
	await act({ action: "init" });
	const initial = await kernel.summary(),
		repo = await resolveGitStagingRepository(root);
	const capture = async () =>
		Promise.all(
			[
				join(repo.directory, "changelists.sqlite"),
				join(repo.directory, "changelists.sqlite-wal"),
			].map(async (path) => {
				const info = await lstat(path);
				return {
					path,
					size: info.size,
					mtime: info.mtimeMs,
					ino: info.ino,
					bytes: await readFile(path),
				};
			}),
		);
	const before = await capture();
	for (let i = 0; i < 3; i++) {
		const other = new IndependentGitStagingKernel(root, "workspace");
		expect((await other.action({ action: "sync" })).generation).toBe(initial.generation);
		expect((await other.summary()).observationId).toBe(initial.observationId);
		await other.files(initial.activeListId as string);
	}
	expect(await capture()).toEqual(before);
});

test("per-list content versions ignore other list metadata and independent same-file block edits", async () => {
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active(),
		b = await create(),
		units = (await kernel.diff(a, { path: "f" })).units;
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [units[1].id] });
	await act({ action: "activate", listId: b });
	const snapshot = (await kernel.files(a)).snapshotVersion;
	await act({ action: "rename", listId: b, name: "Renamed B" });
	expect((await kernel.files(a)).snapshotVersion).toBe(snapshot);
	await file("f", "FIRST\ncontext1\ncontext2\nLAST edited\n");
	await act({ action: "sync" });
	expect((await kernel.files(a)).snapshotVersion).toBe(snapshot);
	expect((await kernel.summary()).lists.find((l) => l.id === a)?.snapshotVersion).toBe(snapshot);
	expect((await kernel.diff(a, { path: "f" })).snapshotVersion).toBe(snapshot);
});

test("earlier insertions owned by another group preserve later unit versions and pagination", async () => {
	await file("a", "another edit\n");
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active();
	const b = await create();
	const units = (await kernel.diff(a, { path: "f" })).units;
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [units[0].id] });
	await act({ action: "activate", listId: b });
	const first = await kernel.files(a, { limit: 1 });
	expect(first.nextCursor).toBeDefined();
	await file("f", "FIRST\nextra line\ncontext1\ncontext2\nLAST\n");
	await act({ action: "sync" });
	expect((await kernel.files(a)).snapshotVersion).toBe(first.snapshotVersion);
	expect(
		(await kernel.files(a, { cursor: first.nextCursor as string })).files.map((file) => file.path),
	).toEqual(["f"]);
});

test("grouped commits support reftable branches and detached HEAD", async () => {
	await git("refs", "migrate", "--ref-format=reftable");
	await file("a", "selected\n");
	await act({ action: "init" });
	const a = await active();
	expect((await commit(a)).outcome).toBe("applied");
	expect(await git("show", "HEAD:a")).toBe("selected");
	await git("switch", "--detach");
	await file("a", "detached\n");
	await act({ action: "sync" });
	expect((await commit(a)).outcome).toBe("applied");
	expect(await git("show", "HEAD:a")).toBe("detached");
});

test("empty move scopes cannot implicitly select the entire source group", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const a = await active();
	const b = await create("B");
	for (const scope of [{}, { filter: [] }])
		await expect(act({ action: "move", fromListId: a, toListId: b, scope })).rejects.toMatchObject({
			code: "GIT_STAGING_INVALID",
		});
	expect((await kernel.files(a)).files.map((entry) => entry.path)).toEqual(["a"]);
	await act({ action: "move", fromListId: a, toListId: b, all: true });
	expect((await kernel.files(b)).files.map((entry) => entry.path)).toEqual(["a"]);
});

test("a mode unit in another group does not invalidate the text group's candidate or cursor", async () => {
	await file("a", "another text edit\n");
	await file("f", "FIRST\ncontext1\ncontext2\nlast\n");
	await chmod(join(root, "f"), 0o755);
	await act({ action: "init" });
	const a = await active(),
		b = await create(),
		mode = (await kernel.diff(a, { path: "f" })).units.find((unit) => unit.kind === "mode");
	if (!mode) throw new Error("Missing mode change unit");
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [mode.id] });
	const first = await kernel.files(a, { limit: 1 }),
		modeVersion = (await kernel.files(b)).snapshotVersion;
	expect(first.complete).toBe(false);
	await chmod(join(root, "f"), 0o644);
	await act({ action: "sync" });
	expect((await kernel.files(a)).snapshotVersion).toBe(first.snapshotVersion);
	expect((await kernel.summary()).lists.find((list) => list.id === a)?.snapshotVersion).toBe(
		first.snapshotVersion,
	);
	expect((await kernel.diff(a, { path: "f" })).snapshotVersion).toBe(first.snapshotVersion);
	expect(
		(await kernel.files(a, { cursor: first.nextCursor as string })).files.map((file) => file.path),
	).toEqual(["f"]);
	expect((await kernel.files(b)).snapshotVersion).not.toBe(modeVersion);
	expect((await kernel.files(b)).files).toEqual([]);
});

test("edited regions adopt the active list while untouched same-file blocks retain their owner", async () => {
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active(),
		b = await create();
	const units = (await kernel.diff(a, { path: "f" })).units;
	expect(units).toHaveLength(2);
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [units[1].id] });
	expect((await kernel.files(a)).files[0].stats).toEqual({ kind: "text", added: 1, removed: 1 });
	expect((await kernel.files(b)).files[0].stats).toEqual({ kind: "text", added: 1, removed: 1 });
	const target = await create("Current editing task");
	await act({ action: "activate", listId: target });
	expect((await kernel.diff(a, { path: "f" })).units.map((unit) => unit.id)).toEqual([units[0].id]);
	expect((await kernel.diff(b, { path: "f" })).units.map((unit) => unit.id)).toEqual([units[1].id]);
	await file("f", "FIRST edited\ncontext1\ncontext2\nLAST\n");
	await act({ action: "sync" });
	expect((await kernel.files(a)).files).toEqual([]);
	expect((await kernel.diff(target, { path: "f" })).diff).toContain("+FIRST edited");
	expect((await kernel.diff(b, { path: "f" })).units.map((unit) => unit.id)).toEqual([units[1].id]);
	expect((await kernel.diff(b, { path: "f" })).diff).toContain("+LAST");
});

test("preview maps selected coordinates after other-group insertions and deletions", async () => {
	await file("f", "foreign one\nforeign two\nfirst\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active();
	const b = await create();
	const target = (await kernel.diff(a, { path: "f" })).units.find(
		(unit) => unit.kind === "text" && unit.baseStart === 3,
	);
	if (!target) throw new Error("Missing final replacement unit");
	expect(target.workStart).not.toBe(target.baseStart);
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [target.id] });
	const preview = await kernel.diff(b, { path: "f" });
	const parsed = parseUnifiedDiff(preview.diff);
	expect(preview.units.map((unit) => unit.id)).toEqual([target.id]);
	expect(preview.unitMappings).toHaveLength(1);
	const mapped = preview.unitMappings?.[0];
	expect(mapped?.unitId).toBe(target.id);
	expect(
		mapped?.lineRanges.flatMap(({ start, end }) => parsed.lines.slice(start, end)),
	).toMatchObject([
		{ type: "removed", oldLineNo: 4, content: "last" },
		{ type: "added", newLineNo: 4, content: "LAST" },
	]);
	expect(preview.diff).not.toContain("foreign");
	expect(preview.diff).toContain(" context1");
});

test("merged-hunk mappings move explicit units without changing HEAD, worktree or index", async () => {
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active();
	const b = await create();
	const preview = await kernel.diff(a, { path: "f" });
	expect(parseUnifiedDiff(preview.diff).hunks).toHaveLength(1);
	expect(preview.unitMappings?.map((mapping) => mapping.unitId)).toEqual(
		preview.units.map((unit) => unit.id),
	);
	const beforeIndex = await bytes();
	const beforeHead = await git("rev-parse", "HEAD");
	const beforeWork = await readFile(join(root, "f"));
	const selectedId = preview.unitMappings?.[1].unitId;
	if (!selectedId) throw new Error("Missing second mapped unit");
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [selectedId] });
	expect((await kernel.diff(b, { path: "f" })).units.map((unit) => unit.id)).toEqual([selectedId]);
	expect((await kernel.diff(a, { path: "f" })).units.map((unit) => unit.id)).toEqual([
		preview.units[0].id,
	]);
	expect(await bytes()).toEqual(beforeIndex);
	expect(await git("rev-parse", "HEAD")).toBe(beforeHead);
	expect(await readFile(join(root, "f"))).toEqual(beforeWork);
});

test("structural selections remain in the list without text action ranges", async () => {
	await file("created", "new text\n");
	await file("binary", Buffer.from([0, 1, 2]));
	await chmod(join(root, "f"), 0o755);
	await act({ action: "init" });
	const a = await active();
	for (const path of ["f", "binary"])
		expect((await kernel.diff(a, { path })).unitMappings).toBeUndefined();
	const created = await kernel.diff(a, { path: "created" });
	expect(created.units.some((unit) => unit.kind === "create")).toBe(true);
	for (const mapping of created.unitMappings ?? [])
		expect(created.units.find((unit) => unit.id === mapping.unitId)?.kind).toBe("text");
});

for (const content of ["界".repeat(100_000), "\\".repeat(150_000)])
	test(`truncated UTF-8/JSON-budget preview keeps complete units and omits mappings (${content[0]})`, async () => {
		await file("a", `${content}\n`);
		await act({ action: "init" });
		const preview = await kernel.diff(await active(), { path: "a" });
		expect(preview.truncated).toBe(true);
		expect(preview.unitMappings).toBeUndefined();
		expect(preview.units).toHaveLength(1);
		expect(preview.diff).not.toContain("\uFFFD");
		expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(LIMITS.maxPageBytes);
	});

test("optional mapping metadata never shortens a complete near-budget patch", async () => {
	await file("a", "changed\n");
	await act({ action: "init" });
	const a = await active();
	const initial = await kernel.diff(a, { path: "a" });
	const { unitMappings: _mappings, ...withoutMappings } = initial;
	const extra = LIMITS.maxPageBytes - 1 - Buffer.byteLength(JSON.stringify(withoutMappings));
	await file("a", `changed${"x".repeat(extra)}\n`);
	await act({ action: "sync" });
	const preview = await kernel.diff(a, { path: "a" });
	expect(preview.truncated).toBe(false);
	expect(preview.unitMappings).toBeUndefined();
	expect(preview.diff).toContain(`+changed${"x".repeat(extra)}\n`);
	expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(LIMITS.maxPageBytes);
});

test("file move affects only source-list units and does not copy or change working/index bytes", async () => {
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active(),
		b = await create(),
		c = await create("C");
	const units = (await kernel.diff(a, { path: "f" })).units;
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [units[1].id] });
	const before = await bytes(),
		work = await readFile(join(root, "f"));
	await move(a, c, ["f"]);
	expect((await kernel.files(a)).files).toEqual([]);
	expect((await kernel.files(b)).files[0].unitCount).toBe(1);
	expect((await kernel.files(c)).files[0].unitCount).toBe(1);
	expect(await bytes()).toEqual(before);
	expect(await readFile(join(root, "f"))).toEqual(work);
});

test("activate synchronizes outstanding changes before changing their future default owner", async () => {
	await act({ action: "init" });
	const a = await active(),
		b = await create();
	await file("a", "before switch\n");
	await act({ action: "activate", listId: b });
	expect((await kernel.files(a)).files.map((f) => f.path)).toEqual(["a"]);
	await file("b", "after switch\n");
	await act({ action: "sync" });
	expect((await kernel.files(b)).files.map((f) => f.path)).toEqual(["b"]);
});

test("delete atomically moves nonactive ownership to active and refuses deleting active", async () => {
	await file("a", "edit\n");
	await act({ action: "init" });
	const a = await active(),
		b = await create();
	await move(a, b, ["a"]);
	const before = await bytes();
	await act({ action: "delete", listId: b });
	expect((await kernel.files(a)).files).toHaveLength(1);
	expect((await kernel.summary()).lists.map((l) => l.id)).toEqual([a]);
	await expect(act({ action: "delete", listId: a })).rejects.toMatchObject({
		code: "GIT_STAGING_ACTIVE_LIST",
	});
	expect(await bytes()).toEqual(before);
});

test("list names preserve whitespace and count Unicode code points while rejecting controls", async () => {
	await act({ action: "init" });
	const name = `  meaningful name  `,
		id = await create(name);
	expect((await kernel.summary()).lists.find((l) => l.id === id)?.name).toBe(name);
	const unicode = "😀".repeat(120),
		other = await create(unicode);
	expect((await kernel.summary()).lists.find((l) => l.id === other)?.name).toBe(unicode);
	for (const name of ["bad\tname", "bad\u007fname", "\ud800"]) {
		await expect(create(name)).rejects.toMatchObject({ code: "GIT_STAGING_INVALID" });
	}
});

test("concurrent independent writers cannot both apply the same generation", async () => {
	await act({ action: "init" });
	const summary = await kernel.summary(),
		other = new IndependentGitStagingKernel(root, "workspace");
	const request = {
		action: "create" as const,
		name: "parallel",
		expectedGeneration: summary.generation,
		observationId: summary.observationId as string,
	};
	const outcomes = await Promise.allSettled([kernel.action(request), other.action(request)]);
	expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
	expect((await kernel.summary()).lists).toHaveLength(2);
});

test("unpublished drafts are invisible and initialization can resume after an incomplete scan", async () => {
	await file("a", "edit\n");
	const original = processes.stagingGit;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (args[0] === "cat-file") throw new Error("read interruption");
		return original(cwd, args, options);
	});
	await expect(act({ action: "init" })).rejects.toThrow("read interruption");
	mock.mockRestore();
	expect(await kernel.summary()).toMatchObject({
		initialized: false,
		state: "incomplete",
		observationId: null,
	});
	expect(await kernel.baseline()).toMatchObject({
		initialized: false,
		state: "incomplete",
		observationId: null,
	});
	await act({ action: "init" });
	expect((await kernel.summary()).lists[0].fileCount).toBe(1);
});

test("unsupported SQLite formats and symlinked metadata are rejected without rebuilding", async () => {
	const repo = await resolveGitStagingRepository(root);
	await mkdir(repo.directory, { recursive: true });
	const path = join(repo.directory, "changelists.sqlite"),
		foreign = new Database(path);
	foreign.exec("PRAGMA application_id=123;PRAGMA user_version=9;CREATE TABLE sentinel(value TEXT)");
	foreign.close();
	const before = await readFile(path);
	await expect(act({ action: "init" })).rejects.toMatchObject({
		code: "GIT_STAGING_UNSUPPORTED_FORMAT",
	});
	expect(await readFile(path)).toEqual(before);
	await rm(path);
	const target = join(root, "foreign");
	await writeFile(target, "preserved");
	await symlink(target, path);
	await expect(act({ action: "init" })).rejects.toMatchObject({
		code: "GIT_STAGING_STORAGE_UNSAFE",
	});
	await expect(kernel.baseline()).rejects.toMatchObject({ code: "GIT_STAGING_STORAGE_UNSAFE" });
	expect(await readFile(target, "utf8")).toBe("preserved");
});

test("reserved schema initialization resumes atomically and never initializes from a read request", async () => {
	const repo = await resolveGitStagingRepository(root);
	await mkdir(repo.directory, { recursive: true });
	const path = join(repo.directory, "changelists.sqlite");
	const interrupted = new Database(path);
	interrupted.exec(`PRAGMA application_id=${CHANGELIST_APPLICATION_ID};PRAGMA user_version=0`);
	interrupted.close();
	const before = await readFile(path);
	await expect(kernel.summary()).rejects.toMatchObject({
		code: "GIT_STAGING_INITIALIZATION_INCOMPLETE",
	});
	expect(await readFile(path)).toEqual(before);
	await file("a", "edit\n");
	await act({ action: "init" });
	expect((await kernel.summary()).lists[0]).toMatchObject({ name: "Changes", fileCount: 1 });
});

test("stale pagination and mutation versions are rejected after ownership changes", async () => {
	await file("a", "edit\n");
	await file("b", "edit\n");
	await act({ action: "init" });
	const a = await active(),
		page = await kernel.files(a, { limit: 1 }),
		s = await kernel.summary(),
		b = await create();
	expect(page.complete).toBe(false);
	expect(
		(await kernel.files(a, { cursor: page.nextCursor as string })).files.map((f) => f.path),
	).toEqual(["b"]);
	await move(a, b, ["a"]);
	await expect(kernel.files(a, { cursor: page.nextCursor as string })).rejects.toMatchObject({
		code: "GIT_STAGING_STALE_CURSOR",
	});
	await expect(
		kernel.action({
			action: "move",
			fromListId: a,
			toListId: b,
			all: true,
			expectedGeneration: s.generation,
			observationId: s.observationId as string,
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
});

test("all and directory/filter scope selections resolve complete source ranges independently of pagination", async () => {
	await mkdir(join(root, "dir"));
	for (let i = 0; i < 8; i++) await file(`dir/${i}`, "new\n");
	await file("a", "changed\n");
	await act({ action: "init" });
	const a = await active(),
		b = await create();
	expect((await kernel.files(a, { limit: 1 })).stats.total.A?.files).toBe(8);
	await act({
		action: "move",
		fromListId: a,
		toListId: b,
		scope: { directory: "dir", filter: ["A"] },
	});
	expect((await kernel.files(b)).files).toHaveLength(8);
	expect((await kernel.files(a)).files.map((f) => f.path)).toEqual(["a"]);
});

test("large source lists apply precise selectors before unit and file budgets without changing Git bytes", async () => {
	const directory = "z-scope%_[",
		literal = "z-path 'quote'\n[abc]*",
		modified = `${directory}/modified`,
		added = `${directory}/added`,
		neighbor = `${directory}extra/added`;
	await mkdir(join(root, directory));
	await mkdir(join(root, `${directory}extra`));
	await mkdir(join(root, "bulk"));
	await file(modified, "base\n");
	await git("add", "--", modified);
	await git("commit", "--quiet", "-m", "Scope base");
	await file(modified, "changed\n");
	await file(added, "new\n");
	await file(neighbor, "untouched\n");
	await file(literal, "literal\n");
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await file("bulk/template", Buffer.from([0, 1, 2]));
	await rm(join(root, "b"));
	await act({ action: "init" });
	const fromListId = await active(),
		toListId = await create(),
		textUnits = (await kernel.diff(fromListId, { path: "f" })).units,
		store = (await ChangelistStore.open(
			await resolveGitStagingRepository(root),
		)) as ChangelistStore;
	expect(textUnits).toHaveLength(2);
	let current = store.state();
	try {
		// Clone one observed binary snapshot in this temporary fixture, not thousands of CLI calls.
		const template = store.db
			.query("SELECT version_id FROM file_snapshots WHERE path='bulk/template'")
			.get() as { version_id: string };
		await store.transaction(() => {
			const snapshot = store.db.query(
				"INSERT INTO file_snapshots SELECT ?,?,?,?,base_mode,work_mode,base_oid,work_oid,base_bytes,work_bytes,identity,NULL FROM file_snapshots WHERE version_id=?",
			);
			const unit = store.db.query(
				"INSERT INTO change_units SELECT ?,? || ':' || kind,?,?,NULL,kind,list_id,base_start,base_end,work_start,work_end,added,removed,needs_review,review_reason,content_hash FROM change_units WHERE version_id=?",
			);
			const mapping = store.db.query("INSERT INTO observation_files VALUES(?,?,?)");
			for (let i = 0; i <= Math.floor(LIMITS.maxUnitsPerOperation / 2); i++) {
				const id = `bulk-${i}`,
					path = `bulk/${String(i).padStart(5, "0")}`;
				snapshot.run(id, id, path, path, template.version_id);
				unit.run(id, id, id, path, template.version_id);
				mapping.run(current.observation_id, id, id);
			}
		});
	} finally {
		store.close();
	}
	const native = await bytes(),
		head = await git("rev-parse", "HEAD"),
		paths = [literal, "f", modified, added, neighbor, "bulk/template", "b"],
		working = () => Promise.all(paths.map((path) => readFile(join(root, path)).catch(() => null))),
		before = await working();
	type Selection = Pick<
		Extract<GitStagingAction, { action: "move" }>,
		"paths" | "unitIds" | "scope" | "all"
	>;
	const request = (selection: Selection): Extract<GitStagingAction, { action: "move" }> => ({
		action: "move",
		fromListId,
		toListId,
		expectedGeneration: current.generation,
		observationId: current.observation_id as string,
		...selection,
	});
	const selected: Array<[Selection, string[]]> = [
		[{ paths: [literal, literal] }, [literal]],
		[{ unitIds: [textUnits[0].id, textUnits[0].id] }, ["f"]],
		[{ scope: { directory, filter: ["M"] } }, [modified]],
		[{ scope: { filter: ["D"] } }, ["b"]],
		[{ scope: { directory, filter: [] } }, [added]],
	];
	for (const [selection, expectedPaths] of selected) {
		const action = request(selection);
		expect(await kernel.actionPaths(action)).toEqual(expectedPaths);
		const result = await kernel.action(action);
		expect(result.outcome).toBe("applied");
		current = { ...current, generation: result.generation, observation_id: result.observationId };
	}
	const read = await db();
	try {
		const changes = read
			.query("SELECT unit_id,path,list_id FROM v_changes ORDER BY path,unit_id")
			.all() as {
			unit_id: string;
			path: string;
			list_id: string;
		}[];
		expect(
			[...new Set(changes.filter((u) => u.list_id === toListId).map((u) => u.path))].sort(),
		).toEqual([literal, "f", modified, "b", added].sort());
		expect(new Set(changes.map((u) => u.unit_id)).size).toBe(changes.length);
		expect(changes.find((u) => u.unit_id === textUnits[1].id)?.list_id).toBe(fromListId);
		expect(changes.find((u) => u.path === neighbor)?.list_id).toBe(fromListId);
		const bulk = changes.filter((u) => u.path.startsWith("bulk/"));
		expect(bulk).toHaveLength((Math.floor(LIMITS.maxUnitsPerOperation / 2) + 2) * 2);
		expect(bulk.length).toBeGreaterThan(LIMITS.maxUnitsPerOperation);
		expect(new Set(bulk.map((unit) => unit.path)).size).toBeGreaterThan(
			LIMITS.maxFilesPerOperation,
		);
		expect(bulk.every((u) => u.list_id === fromListId)).toBe(true);
		const pathBatch = [...new Set(bulk.map((unit) => unit.path))].slice(
			0,
			LIMITS.maxFilesPerOperation,
		);
		expect(await kernel.actionPaths(request({ paths: pathBatch }))).toEqual(pathBatch);
		const unitBatch = bulk.slice(0, LIMITS.maxUnitsPerOperation);
		expect(await kernel.actionPaths(request({ unitIds: unitBatch.map((u) => u.unit_id) }))).toEqual(
			[...new Set(unitBatch.map((u) => u.path))],
		);
	} finally {
		read.close();
	}
	for (const selection of [
		{ all: true as const },
		{ scope: { directory: "bulk", filter: ["A" as const] } },
	]) {
		const action = request(selection);
		await expect(kernel.actionPaths(action)).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
		await expect(kernel.action(action)).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
	}
	for (const selection of [
		{ paths: ["bulk/template", "missing"] },
		{ paths: [literal] },
		{ unitIds: [textUnits[1].id, "missing"] },
		{ unitIds: [textUnits[0].id] },
	]) {
		const action = request(selection);
		await expect(kernel.actionPaths(action)).rejects.toMatchObject({
			code: "GIT_STAGING_STALE_VERSION",
		});
		await expect(kernel.action(action)).rejects.toMatchObject({
			code: "GIT_STAGING_STALE_VERSION",
		});
	}
	expect(await kernel.actionPaths(request({ scope: { filter: ["M"] } }))).toEqual(["f"]);
	for (const selection of [
		{ paths: [] },
		{ paths: ["../outside"] },
		{ unitIds: [] },
		{ unitIds: ["invalid\nidentity"] },
		{ scope: { directory: "bulk/../outside" } },
	]) {
		const action = request(selection);
		await expect(kernel.actionPaths(action)).rejects.toMatchObject({ code: "GIT_STAGING_INVALID" });
		await expect(kernel.action(action)).rejects.toMatchObject({ code: "GIT_STAGING_INVALID" });
	}
	const empty = request({ scope: { directory: "absent" } });
	expect(await kernel.actionPaths(empty)).toEqual([]);
	expect(await kernel.action(empty)).toMatchObject({
		generation: current.generation,
		affectedListIds: [],
	});
	expect(await working()).toEqual(before);
	expect(await bytes()).toEqual(native);
	expect(await git("rev-parse", "HEAD")).toBe(head);
});

test.skipIf(process.platform === "win32")(
	"scope filters normalize type changes and authorize both rename paths",
	async () => {
		await rm(join(root, "a"));
		await symlink("f", join(root, "a"));
		await rename(join(root, "b"), join(root, "renamed"));
		await file("f", "modified\n");
		await file("new", "added\n");
		const native = await bytes();
		await act({ action: "init" });
		const fromListId = await active(),
			toListId = await create();
		for (const [filter, expectedPaths] of [
			[["M"], ["a", "f"]],
			[["R"], ["renamed", "b"]],
		] as const) {
			const version = await kernel.summary();
			const action: Extract<GitStagingAction, { action: "move" }> = {
				action: "move",
				fromListId,
				toListId,
				expectedGeneration: version.generation,
				observationId: version.observationId as string,
				scope: { filter: [...filter] },
			};
			expect(await kernel.actionPaths(action)).toEqual([...expectedPaths]);
			await kernel.action(action);
		}
		expect((await kernel.files(fromListId)).files.map((f) => f.path)).toEqual(["new"]);
		expect((await kernel.files(toListId)).files.map((f) => f.path)).toEqual(["a", "f", "renamed"]);
		expect(await bytes()).toEqual(native);
	},
);

test("native partial staging, assume-unchanged, skip-worktree and ITA bytes stay unchanged", async () => {
	await file("f", "partial\n");
	await git("add", "--", "f");
	await file("f", "working\n");
	await git("update-index", "--assume-unchanged", "a");
	await git("update-index", "--skip-worktree", "b");
	await file("ita", "intent\n");
	await git("add", "--intent-to-add", "--", "ita");
	const before = await bytes();
	await act({ action: "init" });
	const a = await active(),
		b = await create();
	await move(a, b, ["f", "ita"]);
	await kernel.files(b);
	await kernel.diff(b, { path: "f" });
	expect(await bytes()).toEqual(before);
	await expect(commit(b)).rejects.toMatchObject({ code: "GIT_STAGING_NATIVE_STAGED" });
	expect(await bytes()).toEqual(before);
});

test("ITA alone and native conflicts reject commit while preserving original index bytes", async () => {
	await file("a", "group\n");
	await act({ action: "init" });
	const a = await active();
	await file("ita", "intent\n");
	await git("add", "-N", "--", "ita");
	const before = await bytes();
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_NATIVE_STAGED" });
	expect(await bytes()).toEqual(before);
	await git("reset", "--", "ita");
	const oid = await git("rev-parse", "HEAD:a");
	await processes.stagingGit(root, ["update-index", "--index-info"], {
		input: `0 ${"0".repeat(40)}\ta\n100644 ${oid} 1\ta\n100644 ${oid} 2\ta\n100644 ${oid} 3\ta\n`,
	});
	const conflict = await bytes();
	const observed = await kernel.summary();
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_NATIVE_STAGED" });
	await expect(act({ action: "sync" })).rejects.toMatchObject({
		code: "GIT_STAGING_NATIVE_STAGED",
	});
	expect(await kernel.summary()).toMatchObject({
		generation: observed.generation,
		observationId: observed.observationId,
		state: "conflict",
	});
	expect(
		(await kernel.summary()).lists.some((list) => list.id === GIT_STAGING_UNASSIGNED_LIST_ID),
	).toBe(false);
	expect((await kernel.files(a)).files.map((entry) => entry.path)).toEqual(["a"]);
	expect(await bytes()).toEqual(conflict);
});

for (const publicFlags of [true, false])
	test(`legacy v1 ownership requires explicit sync before commit (public flags: ${publicFlags})`, async () => {
		await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
		await chmod(join(root, "f"), 0o755);
		await file("a", "healthy\n");
		await act({ action: "init" });
		const healthy = await active();
		const other = await create("Existing task");
		await move(healthy, other, ["f"]);
		const collect = spyOn(ChangelistStore.prototype, "collect").mockResolvedValue();
		restores.push(() => collect.mockRestore());
		const previous = await legacyObservation(other, publicFlags);
		const beforeUnits = (await kernel.diff(other, { path: "f" })).units;
		const native = await bytes();
		const work = await readFile(join(root, "f"));
		const read = await db();
		const old = read
			.query<{ version_id: string; ownership_json: string }, []>(
				"SELECT version_id,ownership_json FROM file_snapshots WHERE file_id=(SELECT file_id FROM v_changes WHERE path='f' LIMIT 1) ORDER BY version_id",
			)
			.all();
		read.close();
		expect(await move(other, other, ["f"])).toMatchObject({
			generation: previous.generation,
			observationId: previous.observation_id,
		});
		expect((await kernel.diff(other, { path: "f" })).units).toEqual(beforeUnits);
		await expect(move(other, healthy, ["f"])).rejects.toMatchObject({
			code: "GIT_STAGING_STALE_VERSION",
		});
		await expect(act({ action: "delete", listId: other })).rejects.toMatchObject({
			code: "GIT_STAGING_STALE_VERSION",
		});
		await expect(commit(healthy)).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
		expect(await kernel.summary()).toMatchObject({
			generation: previous.generation,
			observationId: previous.observation_id,
		});
		const check = await db();
		expect(check.query("SELECT COUNT(*) n FROM commit_operations").get()).toEqual({ n: 0 });
		expect(check.query("SELECT COUNT(*) n FROM observations WHERE complete=0").get()).toEqual({
			n: 0,
		});
		check.close();
		await act({ action: "sync" });
		const normalized = await kernel.summary();
		expect(normalized).toMatchObject({ state: "ready", activeListId: healthy });
		expect(normalized.generation).toBe(previous.generation + 1);
		const afterUnits = (await kernel.diff(other, { path: "f" })).units;
		expect(afterUnits.map(({ id, listId }) => ({ id, listId }))).toEqual(
			beforeUnits.map(({ id, listId }) => ({ id, listId })),
		);
		expect(afterUnits.every((unit) => !unit.needsReview && unit.reviewReason === undefined)).toBe(
			true,
		);
		const store = await ChangelistStore.open(await resolveGitStagingRepository(root));
		if (!store) throw new Error("Missing upgraded store");
		try {
			expect((await store.legacyReviewFileIds()).size).toBe(0);
			const snapshot = store.loadFile(afterUnits[0].fileId)?.ownership;
			expect(snapshot?.version).toBe(1);
			expect(snapshot?.structuralSourceGroupIds).toBeUndefined();
			expect(
				snapshot?.units.every(
					(unit) =>
						!unit.needsReview &&
						unit.reviewReason === undefined &&
						unit.sourceGroupIds.length === 1 &&
						unit.sourceGroupIds[0] === unit.groupId,
				),
			).toBe(true);
			for (const row of old) {
				expect(
					store.db
						.query("SELECT ownership_json FROM file_snapshots WHERE version_id=?")
						.get(row.version_id),
				).toEqual({ ownership_json: row.ownership_json });
			}
			expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
		} finally {
			store.close();
		}
		expect(await act({ action: "sync" })).toMatchObject({
			generation: normalized.generation,
			observationId: normalized.observationId,
		});
		expect(await bytes()).toEqual(native);
		expect(await readFile(join(root, "f"))).toEqual(work);
		expect((await commit(healthy)).outcome).toBe("applied");
		expect((await kernel.files(other)).files.map((entry) => entry.path)).toEqual(["f"]);
		expect((await move(other, healthy, ["f"])).outcome).toBe("applied");
		expect((await act({ action: "delete", listId: other })).outcome).toBe("applied");
		expect((await kernel.files(healthy)).files.map((entry) => entry.path)).toEqual(["f"]);
	});

for (const kind of ["create", "delete"] as const)
	test(`cross-list ${kind} and text dependencies preserve all Git bytes`, async () => {
		const path = kind === "create" ? "created" : "f";
		if (kind === "create") await file(path, "new text\n");
		else await rm(join(root, path));
		await act({ action: "init" });
		const original = await active();
		const textOwner = await create("Text task");
		const units = (await kernel.diff(original, { path })).units;
		const text = units.find((unit) => unit.kind === "text");
		if (!text) throw new Error("Missing fixture text unit");
		expect(units.some((unit) => unit.kind === kind)).toBe(true);
		await act({
			action: "move",
			fromListId: original,
			toListId: textOwner,
			unitIds: [text.id as string],
		});
		const native = await bytes();
		const head = await git("rev-parse", "HEAD");
		const work = await readFile(join(root, path)).catch(() => null);
		await expect(commit(kind === "create" ? textOwner : original)).rejects.toMatchObject({
			code: "GIT_STAGING_PATH_DEPENDENCY",
		});
		expect(await bytes()).toEqual(native);
		expect(await git("rev-parse", "HEAD")).toBe(head);
		expect(await readFile(join(root, path)).catch(() => null)).toEqual(work);
		expect((await kernel.diff(textOwner, { path })).units.map((unit) => unit.id)).toEqual([
			text.id,
		]);
		await move(textOwner, original, [path]);
		expect((await commit(original)).outcome).toBe("applied");
		expect(await readFile(join(root, path)).catch(() => null)).toEqual(work);
	});

for (const first of ["content", "mode"] as const)
	test.skipIf(process.platform === "win32")(
		`binary content and mode commit independently (${first} first)`,
		async () => {
			const base = Buffer.from([0, 1, 2]);
			const work = Buffer.from([0, 3, 4]);
			await file("binary", base);
			await git("add", "--", "binary");
			await git("commit", "--quiet", "-m", "Binary base");
			await file("binary", work);
			await chmod(join(root, "binary"), 0o755);
			await act({ action: "init" });
			const contentOwner = await active();
			const modeOwner = await create("Executable bit");
			const units = (await kernel.diff(contentOwner, { path: "binary" })).units;
			expect(units.map((unit) => unit.kind).sort()).toEqual(["binary", "mode"]);
			const mode = units.find((unit) => unit.kind === "mode");
			await act({
				action: "move",
				fromListId: contentOwner,
				toListId: modeOwner,
				unitIds: [mode?.id as string],
			});
			expect((await commit(first === "content" ? contentOwner : modeOwner)).outcome).toBe(
				"applied",
			);
			expect((await processes.stagingGit(root, ["show", "HEAD:binary"])).bytes).toEqual(
				first === "content" ? work : base,
			);
			expect(await git("ls-tree", "HEAD", "binary")).toStartWith(
				first === "mode" ? "100755" : "100644",
			);
			expect(await readFile(join(root, "binary"))).toEqual(work);
			expect((await lstat(join(root, "binary"))).mode & 0o777).toBe(0o755);
			const remaining = first === "content" ? modeOwner : contentOwner;
			expect(
				(await kernel.diff(remaining, { path: "binary" })).units.map((unit) => unit.kind),
			).toEqual([first === "content" ? "mode" : "binary"]);
			expect((await commit(remaining)).outcome).toBe("applied");
			expect((await processes.stagingGit(root, ["show", "HEAD:binary"])).bytes).toEqual(work);
			expect(await git("ls-tree", "HEAD", "binary")).toStartWith("100755");
			expect(await readFile(join(root, "binary"))).toEqual(work);
			expect((await kernel.files(contentOwner)).files).toEqual([]);
			expect((await kernel.files(modeOwner)).files).toEqual([]);
		},
	);

for (const type of ["binary", "symlink"] as const)
	for (const kind of ["create", "delete"] as const)
		test.skipIf(process.platform === "win32" && type === "symlink")(
			`${type} ${kind} and indivisible contents cannot commit across lists`,
			async () => {
				const path = "atomic";
				if (type === "binary") await file(path, Buffer.from([0, 1, 2]));
				else await symlink("literal-target", join(root, path));
				if (kind === "delete") {
					await git("add", "--", path);
					await git("commit", "--quiet", "-m", "Atomic base");
					await rm(join(root, path));
				}
				await act({ action: "init" });
				const pathOwner = await active();
				const contentOwner = await create("Atomic content");
				const units = (await kernel.diff(pathOwner, { path })).units;
				expect(units.map((unit) => unit.kind).sort()).toEqual([type, kind].sort());
				const content = units.find((unit) => unit.kind === type);
				await act({
					action: "move",
					fromListId: pathOwner,
					toListId: contentOwner,
					unitIds: [content?.id as string],
				});
				const native = await bytes();
				const head = await git("rev-parse", "HEAD");
				for (const selected of [pathOwner, contentOwner])
					await expect(commit(selected)).rejects.toMatchObject({
						code: "GIT_STAGING_PATH_DEPENDENCY",
					});
				expect(await bytes()).toEqual(native);
				expect(await git("rev-parse", "HEAD")).toBe(head);
				await move(contentOwner, pathOwner, [path]);
				expect((await commit(pathOwner)).outcome).toBe("applied");
				if (kind === "delete") expect(await lstat(join(root, path)).catch(() => null)).toBeNull();
				else if (type === "binary")
					expect(await readFile(join(root, path))).toEqual(Buffer.from([0, 1, 2]));
				else expect(await readlink(join(root, path))).toBe("literal-target");
			},
		);

test("gitlink deletion cannot discard an indivisible unit in another list", async () => {
	const oid = await git("rev-parse", "HEAD");
	await git("update-index", "--add", "--cacheinfo", `160000,${oid},sub`);
	await git("commit", "--quiet", "-m", "Gitlink base");
	await act({ action: "init" });
	const pathOwner = await active();
	const contentOwner = await create("Gitlink content");
	const units = (await kernel.diff(pathOwner, { path: "sub" })).units;
	expect(units.map((unit) => unit.kind).sort()).toEqual(["delete", "gitlink"]);
	const content = units.find((unit) => unit.kind === "gitlink");
	await act({
		action: "move",
		fromListId: pathOwner,
		toListId: contentOwner,
		unitIds: [content?.id as string],
	});
	const native = await bytes();
	const head = await git("rev-parse", "HEAD");
	for (const selected of [pathOwner, contentOwner])
		await expect(commit(selected)).rejects.toMatchObject({ code: "GIT_STAGING_PATH_DEPENDENCY" });
	expect(await bytes()).toEqual(native);
	expect(await git("rev-parse", "HEAD")).toBe(head);
	await move(contentOwner, pathOwner, ["sub"]);
	expect((await commit(pathOwner)).outcome).toBe("applied");
	expect(await git("ls-tree", "HEAD", "sub")).toBe("");
});

test("selective A then B commits preserve remaining same-file ownership and untouched worktree", async () => {
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active(),
		b = await create();
	const units = (await kernel.diff(a, { path: "f" })).units;
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [units[1].id] });
	const work = await readFile(join(root, "f"));
	const first = await commit(a);
	expect(first.outcome).toBe("applied");
	expect(await git("show", "HEAD:f")).toBe("FIRST\ncontext1\ncontext2\nlast");
	expect((await kernel.files(a)).files).toHaveLength(0);
	expect((await kernel.files(b)).files).toHaveLength(1);
	expect(await readFile(join(root, "f"))).toEqual(work);
	expect((await commit(b)).outcome).toBe("applied");
	expect(await git("show", "HEAD:f")).toBe("FIRST\ncontext1\ncontext2\nLAST");
	expect(await git("diff", "--cached", "--name-only")).toBe("");
	expect((await kernel.files(b)).files).toEqual([]);
});

test("commit rejects working content changed since the published observation without silently syncing", async () => {
	await file("a", "published A\n");
	await act({ action: "init" });
	const selected = await active(),
		snapshot = await kernel.summary(),
		head = await git("rev-parse", "HEAD"),
		native = await bytes();
	await file("a", "current B\n");
	await expect(commit(selected)).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	expect(await git("rev-parse", "HEAD")).toBe(head);
	expect(await bytes()).toEqual(native);
	expect((await kernel.summary()).observationId).toBe(snapshot.observationId);
	expect((await kernel.diff(selected, { path: "a" })).diff).toContain("+published A");
	await act({ action: "sync" });
	expect((await commit(selected)).outcome).toBe("applied");
	expect(await git("show", "HEAD:a")).toBe("current B");
});

test("commit rechecks the observation after awaited legacy ownership validation", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const snapshot = await kernel.summary();
	const native = await bytes();
	const head = await git("rev-parse", "HEAD");
	const original = ChangelistStore.prototype.legacyReviewFileIds;
	let checkedObservation: string | null | undefined;
	let raced = false;
	const scan = spyOn(ChangelistStore.prototype, "legacyReviewFileIds").mockImplementation(
		async function (this: ChangelistStore, ...args: Parameters<typeof original>) {
			const files = await original.apply(this, args);
			if (!raced) {
				raced = true;
				checkedObservation = args[0];
				await new IndependentGitStagingKernel(root, "another-writer").action({
					action: "create",
					name: "Concurrent task",
					expectedGeneration: snapshot.generation,
					observationId: snapshot.observationId as string,
				});
			}
			return files;
		},
	);
	restores.push(() => scan.mockRestore());
	await expect(commit(snapshot.activeListId as string)).rejects.toMatchObject({
		code: "GIT_STAGING_STALE_VERSION",
	});
	expect(checkedObservation).toBe(snapshot.observationId);
	expect(await bytes()).toEqual(native);
	expect(await git("rev-parse", "HEAD")).toBe(head);
	expect(await readFile(join(root, "a"), "utf8")).toBe("selected\n");
	const read = await db();
	try {
		expect(read.query("SELECT COUNT(*) n FROM commit_operations").get()).toEqual({ n: 0 });
	} finally {
		read.close();
	}
});

for (const changedState of ["incomplete", "conflict"] as const)
	for (const phase of ["scan", "reservation"] as const)
		test(`commit rejects same-version ${changedState} state changes after ${phase}`, async () => {
			await file("a", "selected\n");
			await act({ action: "init" });
			const snapshot = await kernel.summary();
			const native = await bytes();
			const head = await git("rev-parse", "HEAD");
			let changed = false;
			if (phase === "scan") {
				const original = ChangelistStore.prototype.legacyReviewFileIds;
				const scan = spyOn(ChangelistStore.prototype, "legacyReviewFileIds").mockImplementation(
					async function (this: ChangelistStore, ...args: Parameters<typeof original>) {
						const result = await original.apply(this, args);
						if (!changed) {
							changed = true;
							await this.mark(changedState, "Concurrent observation state");
						}
						return result;
					},
				);
				restores.push(() => scan.mockRestore());
			} else {
				const original = observer.assertChangelistSourcesCurrent;
				const sources = spyOn(observer, "assertChangelistSourcesCurrent").mockImplementation(
					async (...args) => {
						await original(...args);
						if (!changed) {
							changed = true;
							await args[1].mark(changedState, "Concurrent observation state");
						}
					},
				);
				restores.push(() => sources.mockRestore());
			}
			await expect(commit(snapshot.activeListId as string)).rejects.toMatchObject({
				code: "GIT_STAGING_STALE_VERSION",
			});
			expect(changed).toBe(true);
			expect(await kernel.summary()).toMatchObject({
				generation: snapshot.generation,
				observationId: snapshot.observationId,
				state: changedState,
			});
			expect(await bytes()).toEqual(native);
			expect(await git("rev-parse", "HEAD")).toBe(head);
			expect(await readFile(join(root, "a"), "utf8")).toBe("selected\n");
			const read = await db();
			try {
				expect(read.query("SELECT COUNT(*) n FROM commit_operations").get()).toEqual({ n: 0 });
				expect(read.query("SELECT state,reason FROM v_workspace_state").get()).toEqual({
					state: changedState,
					reason: "Concurrent observation state",
				});
			} finally {
				read.close();
			}
		});

test("commit rechecks selected sources after candidate construction and before Git invocation", async () => {
	await file("a", "published\n");
	await act({ action: "init" });
	const selected = await active(),
		head = await git("rev-parse", "HEAD"),
		native = await bytes(),
		original = processes.stagingGit;
	let changed = false,
		commits = 0;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (args[0] === "commit") commits++;
		if (!changed && args[0] === "update-ref" && args[1] !== "-d") {
			changed = true;
			await file("a", "changed while preparing\n");
		}
		return original(cwd, args, options);
	});
	restores.push(() => mock.mockRestore());
	await expect(commit(selected)).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	expect(commits).toBe(0);
	expect(await git("rev-parse", "HEAD")).toBe(head);
	expect(await bytes()).toEqual(native);
});

test("binary executable mode changes invalidate group content versions and existing cursors", async () => {
	await file("a", "text edit\n");
	await file("binary", Buffer.from([0, 255, 128]));
	await act({ action: "init" });
	const list = await active(),
		page = await kernel.files(list, { limit: 1 });
	await chmod(join(root, "binary"), 0o755);
	await act({ action: "sync" });
	expect((await kernel.files(list)).snapshotVersion).not.toBe(page.snapshotVersion);
	await expect(kernel.files(list, { cursor: page.nextCursor as string })).rejects.toMatchObject({
		code: "GIT_STAGING_STALE_CURSOR",
	});
});

test("ordinary and recovered index installation preserve preexisting file permissions", async () => {
	const repo = await resolveGitStagingRepository(root);
	await chmod(repo.index, 0o664);
	await file("a", "first\n");
	await act({ action: "init" });
	const list = await active();
	expect((await commit(list)).outcome).toBe("applied");
	expect((await lstat(repo.index)).mode & 0o7777).toBe(0o664);
	await file("a", "second\n");
	await act({ action: "sync" });
	const original = processes.stagingGit;
	let fail = true;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (
			fail &&
			args[0] === "read-tree" &&
			options?.env?.GIT_INDEX_FILE?.endsWith("/native.index")
		) {
			fail = false;
			throw new Error("native mode recovery barrier");
		}
		return original(cwd, args, options);
	});
	restores.push(() => mock.mockRestore());
	const partial = await commit(list);
	expect(partial.outcome).toBe("partial");
	expect(
		(await act({ action: "recover", operationId: partial.operationId as string })).outcome,
	).toBe("applied");
	expect((await lstat(repo.index)).mode & 0o7777).toBe(0o664);
});

test("selected blob batches and both source verifications have a constant Git budget for 100 and 300 files", async () => {
	const counts: number[] = [];
	for (const size of [100, 300]) {
		for (let i = 0; i < size; i++) await file(`selected-${size}-${i}`, `new ${i}\n`);
		await act({ action: size === 100 ? "init" : "sync" });
		const calls: string[][] = [],
			original = processes.stagingGit;
		const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
			calls.push(args);
			return original(cwd, args, options);
		});
		try {
			expect((await commit(await active())).outcome).toBe("applied");
			expect(calls.filter((args) => args[0] === "hash-object")).toEqual([
				["hash-object", "-w", "--stdin-paths"],
			]);
			counts.push(calls.length);
			expect((await kernel.files(await active())).files).toEqual([]);
		} finally {
			mock.mockRestore();
		}
	}
	// Two exact-source verifications add fixed batch work, not a subprocess for each file.
	expect(counts).toEqual([77, 77]);
});

test("edits made by commit hooks remain owned after the confirmed commit", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const a = await active();
	const repo = await resolveGitStagingRepository(root);
	await writeFile(
		join(repo.gitDir, "hooks", "pre-commit"),
		"#!/bin/sh\nprintf 'new during hook\\n' > a\n",
		{ mode: 0o755 },
	);
	expect((await commit(a)).outcome).toBe("applied");
	expect(await git("show", "HEAD:a")).toBe("selected");
	expect((await kernel.diff(a, { path: "a" })).diff).toContain("+new during hook");
});

test("normal hooks run; hook rejection and signer rejection preserve bytes and release known locks", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const a = await active(),
		repo = await resolveGitStagingRepository(root),
		before = await bytes();
	await writeFile(join(repo.gitDir, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_COMMIT_REJECTED" });
	expect(await bytes()).toEqual(before);
	await expect(lstat(`${repo.index}.lock`)).rejects.toThrow();
	await rm(join(repo.gitDir, "hooks", "pre-commit"));
	await git("config", "commit.gpgSign", "true");
	await git("config", "gpg.program", "/does-not-exist-nf-signer");
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_COMMIT_REJECTED" });
	expect(await bytes()).toEqual(before);
});

test("hook tree mutation is an unknown result and preserves the lock and durable operation evidence", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const a = await active(),
		repo = await resolveGitStagingRepository(root),
		before = await bytes();
	await writeFile(
		join(repo.gitDir, "hooks", "pre-commit"),
		"#!/bin/sh\nprintf 'hook tree\\n' > a\ngit add -- a\n",
		{ mode: 0o755 },
	);
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_COMMIT_UNKNOWN" });
	expect(await bytes()).toEqual(before);
	expect((await lstat(`${repo.index}.lock`)).isFile()).toBe(true);
	const read = await db();
	try {
		const row = read.query("SELECT id,status,evidence_json FROM commit_operations").get() as {
			id: string;
			status: string;
			evidence_json: string;
		};
		expect(row.status).toBe("unknown");
		expect(JSON.parse(row.evidence_json).candidate).toContain(`/operations/${row.id}/`);
		await expect(act({ action: "recover", operationId: row.id })).rejects.toMatchObject({
			code: "GIT_STAGING_COMMIT_UNKNOWN",
		});
		await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_INCOMPLETE" });
	} finally {
		read.close();
	}
});

test("recovery cancels an expired reservation interrupted before Git invocation", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const repo = await resolveGitStagingRepository(root);
	let reserved: { id: string; evidence_json: string } | undefined;
	const original = processes.stagingGit;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (args[0] === "read-tree" && options?.env?.GIT_INDEX_FILE?.endsWith("/candidate.index")) {
			const read = await db();
			try {
				reserved = read.query("SELECT id,evidence_json FROM commit_operations").get() as {
					id: string;
					evidence_json: string;
				};
			} finally {
				read.close();
			}
			throw new Error("preparation interruption");
		}
		return original(cwd, args, options);
	});
	restores.push(() => mock.mockRestore());
	await expect(commit(await active())).rejects.toThrow("preparation interruption");
	mock.mockRestore();
	if (!reserved) throw new Error("Missing reserved-operation fixture");
	const store = await ChangelistStore.open(repo);
	if (!store) throw new Error("Missing fixture store");
	try {
		const evidence = JSON.parse(reserved.evidence_json);
		evidence.leaseUntil = Date.now() + 60_000;
		await store.transaction(() => {
			store.db
				.query("UPDATE commit_operations SET status='reserved',evidence_json=? WHERE id=?")
				.run(JSON.stringify(evidence), reserved?.id as string);
			store.db.query("UPDATE workspace_state SET state='recovering'").run();
		});
		await expect(act({ action: "recover", operationId: reserved.id })).rejects.toMatchObject({
			code: "GIT_STAGING_LOCKED",
		});
		evidence.leaseUntil = 0;
		await store.transaction(() => {
			store.db
				.query("UPDATE commit_operations SET evidence_json=? WHERE id=?")
				.run(JSON.stringify(evidence), reserved?.id as string);
		});
		expect((await act({ action: "recover", operationId: reserved.id })).outcome).toBe("applied");
		expect(store.pending()).toBeNull();
		expect((await act({ action: "sync" })).outcome).toBe("applied");
		expect((await commit(await active())).outcome).toBe("applied");
	} finally {
		store.close();
	}
});

test.each([
	"unpublished",
	"published",
	"foreign",
])("pre-invocation recovery respects durable native lock ownership (%s)", async (phase) => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const repo = await resolveGitStagingRepository(root);
	const lockPath = `${repo.index}.lock`;
	const retainedLock = join(root, "retained-native.lock");
	let saved: { id: string; evidence_json: string } | undefined;
	const original = processes.stagingGit;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (!saved && args[0] === "rev-parse" && (await lstat(lockPath).catch(() => null))) {
			const read = await db();
			try {
				saved = read
					.query("SELECT id,evidence_json FROM commit_operations WHERE status='prepared'")
					.get() as typeof saved;
			} finally {
				read.close();
			}
			await link(lockPath, retainedLock);
			throw new Error("interrupted after native lock publication");
		}
		return original(cwd, args, options);
	});
	restores.push(() => mock.mockRestore());
	await expect(commit(await active())).rejects.toThrow("interrupted after native lock publication");
	mock.mockRestore();
	if (!saved) throw new Error("Missing durable preparation evidence");
	if (phase === "published") await link(retainedLock, lockPath);
	else if (phase === "foreign") await writeFile(lockPath, "foreign writer");
	await rm(retainedLock);
	const store = await ChangelistStore.open(repo);
	if (!store) throw new Error("Missing fixture store");
	try {
		const evidence = JSON.parse(saved.evidence_json);
		evidence.leaseUntil = 0;
		await store.transaction(() => {
			store.db
				.query("UPDATE commit_operations SET status='prepared',evidence_json=? WHERE id=?")
				.run(JSON.stringify(evidence), saved?.id as string);
			store.db.query("UPDATE workspace_state SET state='recovering'").run();
		});
		if (phase === "foreign") {
			await expect(act({ action: "recover", operationId: saved.id })).rejects.toMatchObject({
				code: "GIT_STAGING_LOCKED",
			});
			expect(await readFile(lockPath, "utf8")).toBe("foreign writer");
		} else {
			expect((await act({ action: "recover", operationId: saved.id })).outcome).toBe("applied");
			await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
			expect(store.pending()).toBeNull();
			await git("add", "--", "a");
			await git("reset", "--quiet", "--", "a");
			expect((await act({ action: "sync" })).outcome).toBe("applied");
			expect((await commit(await active())).outcome).toBe("applied");
		}
	} finally {
		store.close();
	}
});

test("a recovered preparation cannot publish its native lock after losing the fence", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const repo = await resolveGitStagingRepository(root);
	let recovered = false;
	const transaction = ChangelistStore.prototype.transaction;
	const mock = spyOn(ChangelistStore.prototype, "transaction").mockImplementation(async function <
		T,
	>(this: ChangelistStore, fn: () => T, signal?: AbortSignal, checkpoint?: () => void): Promise<T> {
		const value = (await transaction.call(this, fn, signal, checkpoint)) as T;
		const row = this.db
			.query("SELECT id,evidence_json FROM commit_operations WHERE status='prepared'")
			.get() as { id: string; evidence_json: string } | null;
		if (!recovered && row && !(await lstat(`${repo.index}.lock`).catch(() => null))) {
			recovered = true;
			const evidence = JSON.parse(row.evidence_json);
			evidence.leaseUntil = 0;
			await transaction.call(this, () =>
				this.db
					.query("UPDATE commit_operations SET evidence_json=? WHERE id=?")
					.run(JSON.stringify(evidence), row.id),
			);
			expect((await act({ action: "recover", operationId: row.id })).outcome).toBe("applied");
		}
		return value;
	});
	restores.push(() => mock.mockRestore());
	await expect(commit(await active())).rejects.toMatchObject({ code: "GIT_STAGING_FENCED" });
	expect(recovered).toBe(true);
	await expect(lstat(`${repo.index}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
});

test("finished commits remove private projection artifacts and remain recoverable idempotently", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const outcome = await commit(await active());
	const read = await db();
	try {
		const row = read
			.query("SELECT status,evidence_json FROM commit_operations WHERE id=?")
			.get(outcome.operationId as string) as { status: string; evidence_json: string };
		expect(row.status).toBe("finished");
		await expect(lstat(JSON.parse(row.evidence_json).directory)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(
			(await act({ action: "recover", operationId: outcome.operationId as string })).commitOid,
		).toBe(outcome.commitOid);
	} finally {
		read.close();
	}
});

test("completed artifact cleanup failures preserve success and recovery retries cleanup", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const original = processes.stagingGit;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (args[0] === "update-ref" && args[1] === "-d") throw new Error("cleanup unavailable");
		return original(cwd, args, options);
	});
	restores.push(() => mock.mockRestore());
	const outcome = await commit(await active());
	expect(outcome).toMatchObject({ outcome: "applied", reason: expect.stringContaining("cleanup") });
	const read = await db();
	const row = read
		.query("SELECT evidence_json FROM commit_operations WHERE id=?")
		.get(outcome.operationId as string) as { evidence_json: string };
	read.close();
	const directory = JSON.parse(row.evidence_json).directory;
	expect((await lstat(directory)).isDirectory()).toBe(true);
	mock.mockRestore();
	expect(
		(await act({ action: "recover", operationId: outcome.operationId as string })).outcome,
	).toBe("applied");
	await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("a confirmed commit recovers native index installation without creating another commit", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const a = await active(),
		before = await bytes();
	const original = processes.stagingGit;
	let fail = true,
		commits = 0;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (args[0] === "commit") commits++;
		if (
			fail &&
			args[0] === "read-tree" &&
			options?.env?.GIT_INDEX_FILE?.endsWith("/native.index")
		) {
			fail = false;
			throw new Error("native installation interrupted");
		}
		return original(cwd, args, options);
	});
	restores.push(() => mock.mockRestore());
	const outcome = await commit(a);
	expect(outcome.outcome).toBe("partial");
	expect(outcome.commitOid).toBe(await git("rev-parse", "HEAD"));
	expect(await bytes()).toEqual(before);
	expect(outcome.operationId).toBeDefined();
	const recovered = await act({ action: "recover", operationId: outcome.operationId as string });
	expect(recovered).toMatchObject({ outcome: "applied", commitOid: outcome.commitOid });
	expect(commits).toBe(1);
	expect(await git("diff", "--cached", "--name-only")).toBe("");
	expect((await kernel.files(a)).files).toEqual([]);
	expect(
		(await act({ action: "recover", operationId: outcome.operationId as string })).commitOid,
	).toBe(outcome.commitOid);
	expect(commits).toBe(1);
});

test("legacy receipt recovery preserves strict sources and refuses a merge without repeating commit", async () => {
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const selected = await active();
	const other = await create("Remaining task");
	const units = (await kernel.diff(selected, { path: "f" })).units;
	await act({ action: "move", fromListId: selected, toListId: other, unitIds: [units[1].id] });
	const collect = spyOn(ChangelistStore.prototype, "collect").mockResolvedValue();
	restores.push(() => collect.mockRestore());
	const source = await legacyObservation(other);
	const originalPublish = ChangelistStore.prototype.publish;
	let interrupted = false;
	const publish = spyOn(ChangelistStore.prototype, "publish").mockImplementation(async function (
		this: ChangelistStore,
		...args: Parameters<typeof originalPublish>
	) {
		if (args[4] && !interrupted) {
			interrupted = true;
			throw new Error("Legacy producer finalization interrupted");
		}
		return originalPublish.apply(this, args);
	});
	restores.push(() => publish.mockRestore());
	const originalGit = processes.stagingGit;
	let commits = 0;
	const gitMock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (args[0] === "commit") commits++;
		return originalGit(cwd, args, options);
	});
	restores.push(() => gitMock.mockRestore());
	// The legacy producer permitted a clean selected list beside another list's old markers.
	const preflight = spyOn(ChangelistStore.prototype, "legacyReviewFileIds").mockResolvedValue(
		new Set(),
	);
	let outcome: Awaited<ReturnType<typeof commit>>;
	try {
		outcome = await commit(selected);
	} finally {
		preflight.mockRestore();
	}
	expect(outcome.outcome).toBe("partial");
	expect(commits).toBe(1);
	const read = await db();
	const operation = read
		.query<{ evidence_json: string; observation_id: string }, [string]>(
			"SELECT evidence_json,observation_id FROM commit_operations WHERE id=?",
		)
		.get(outcome.operationId as string);
	read.close();
	expect(operation?.observation_id).toBe(source.observation_id);
	const evidence = JSON.parse(operation?.evidence_json ?? "{}") as {
		mappingFile: string;
		directory: string;
		fenceToken: string;
	};
	const mapping = await readFile(evidence.mappingFile);
	const receiptPath = join(evidence.directory, `commit-${evidence.fenceToken}.receipt.json`);
	const receipt = await readFile(receiptPath);
	const repo = await resolveGitStagingRepository(root);
	const native = await bytes();
	await expect(act({ action: "sync" })).rejects.toMatchObject({
		code: "GIT_STAGING_RECOVERY_REQUIRED",
	});
	await writeFile(join(repo.gitDir, "MERGE_HEAD"), `${outcome.commitOid}\n`);
	await expect(
		act({ action: "recover", operationId: outcome.operationId as string }),
	).rejects.toMatchObject({ code: "GIT_STAGING_REPOSITORY_BUSY" });
	expect(await bytes()).toEqual(native);
	expect(await readFile(evidence.mappingFile)).toEqual(mapping);
	expect(await readFile(receiptPath)).toEqual(receipt);
	await rm(join(repo.gitDir, "MERGE_HEAD"));
	await file("f", "FIRST\ncontext1\ncontext2\nLAST edited during recovery\n");
	const recovered = await act({ action: "recover", operationId: outcome.operationId as string });
	expect(recovered).toMatchObject({ outcome: "applied", commitOid: outcome.commitOid });
	expect(await git("rev-parse", "HEAD")).toBe(outcome.commitOid as string);
	expect(commits).toBe(1);
	expect((await kernel.files(selected)).files).toEqual([]);
	const remaining = (await kernel.diff(other, { path: "f" })).units;
	expect(remaining).toHaveLength(1);
	expect(remaining[0]).toMatchObject({ listId: other, needsReview: false });
	expect(remaining[0].reviewReason).toBeUndefined();
	expect((await kernel.diff(other, { path: "f" })).diff).toContain("+LAST edited during recovery");
	await expect(lstat(evidence.directory)).rejects.toMatchObject({ code: "ENOENT" });
	const store = await ChangelistStore.open(repo);
	if (!store) throw new Error("Missing recovery store");
	try {
		expect((await store.legacyReviewFileIds()).size).toBe(0);
		expect(
			store
				.loadFile(units[0].fileId, source.observation_id)
				?.units.find((unit) => unit.listId === other),
		).toMatchObject({ needsReview: true, reviewReason: "headChanged" });
	} finally {
		store.close();
	}
	expect(
		(await act({ action: "recover", operationId: outcome.operationId as string })).commitOid,
	).toBe(outcome.commitOid);
	expect(commits).toBe(1);
});

test("SQL finalization failure preserves the commit mapping and retries only projection", async () => {
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await act({ action: "init" });
	const a = await active(),
		b = await create(),
		units = (await kernel.diff(a, { path: "f" })).units;
	await act({ action: "move", fromListId: a, toListId: b, unitIds: [units[1].id] });
	const original = ChangelistStore.prototype.publish;
	let fail = true;
	const mock = spyOn(ChangelistStore.prototype, "publish").mockImplementation(async function (
		this: ChangelistStore,
		...args: Parameters<typeof original>
	) {
		if (fail && args[4]) {
			fail = false;
			throw new Error("SQL finalization interrupted");
		}
		return original.apply(this, args);
	});
	restores.push(() => mock.mockRestore());
	const outcome = await commit(a),
		head = await git("rev-parse", "HEAD");
	expect(outcome.outcome).toBe("partial");
	expect(outcome.commitOid).toBe(head);
	expect(await git("diff", "--cached", "--name-only")).toBe("");
	expect(
		(await act({ action: "recover", operationId: outcome.operationId as string })).outcome,
	).toBe("applied");
	expect(await git("rev-parse", "HEAD")).toBe(head);
	expect((await kernel.files(a)).files).toEqual([]);
	expect((await kernel.files(b)).files[0].stats).toEqual({ kind: "text", added: 1, removed: 1 });
	expect((await commit(b)).outcome).toBe("applied");
});

test.skipIf(process.platform === "win32")(
	"expired producer resumes after recovery without rewriting the installed or subsequently staged index",
	async () => {
		await file("a", "selected\n");
		await act({ action: "init" });
		const repo = await resolveGitStagingRepository(root),
			marker = join(repo.gitDir, "producer-paused"),
			resultPath = join(repo.gitDir, "producer-result.json"),
			script = join(repo.gitDir, "producer-fixture.ts");
		await writeFile(
			join(repo.gitDir, "hooks", "post-commit"),
			'#!/bin/sh\nprintf paused > "$NF_TEST_PRODUCER_MARKER"\nkill -STOP "$NF_TEST_PRODUCER_PID"\n',
			{ mode: 0o755 },
		);
		await writeFile(
			script,
			`import{writeFile}from"node:fs/promises";const{IndependentGitStagingKernel}=await import(${JSON.stringify(join(import.meta.dir, "..", "git-staging-kernel.ts"))});process.env.NF_TEST_PRODUCER_PID=String(process.pid);const k=new IndependentGitStagingKernel(process.argv[2],"producer");const s=await k.summary();try{const r=await k.action({action:"commit",listId:s.activeListId,message:"paused producer",identity:{name:"Fixture",email:"fixture@example.test"},expectedGeneration:s.generation,observationId:s.observationId});await writeFile(process.argv[3],JSON.stringify(r));}catch(e){await writeFile(process.argv[3],JSON.stringify({code:e.code,message:e.message}));}`,
		);
		const child = Bun.spawn([process.execPath, script, root, resultPath], {
			// Reuse the observing kernel's normalization context, including system Git filters.
			env: { ...process.env, NF_TEST_PRODUCER_MARKER: marker },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const deadline = Date.now() + 15_000;
			while (!(await lstat(marker).catch(() => null))) {
				if (child.exitCode !== null)
					throw new Error(
						`Producer exited ${child.exitCode}: ${await readFile(resultPath, "utf8").catch(() => "no result")} ${await new Response(child.stderr).text()}`,
					);
				if (Date.now() > deadline) throw new Error("Producer did not reach the pause barrier");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const write = new Database(join(repo.directory, "changelists.sqlite"));
			let operationId: string;
			try {
				const row = write
					.query(
						"SELECT id,evidence_json FROM commit_operations WHERE status NOT IN ('finished','rejected')",
					)
					.get() as { id: string; evidence_json: string };
				operationId = row.id;
				const evidence = JSON.parse(row.evidence_json);
				evidence.leaseUntil = 0;
				write
					.query("UPDATE commit_operations SET evidence_json=? WHERE id=?")
					.run(JSON.stringify(evidence), row.id);
			} finally {
				write.close();
			}
			expect((await act({ action: "recover", operationId })).outcome).toBe("applied");
			await file("b", "external native staging\n");
			const externalIndex = join(repo.gitDir, "external-native.index");
			await processes.stagingGit(root, ["read-tree", "HEAD"], {
				env: { GIT_INDEX_FILE: externalIndex },
			});
			await processes.stagingGit(root, ["add", "--", "b"], {
				env: { GIT_INDEX_FILE: externalIndex },
			});
			await writeFile(repo.index, await readFile(externalIndex));
			const installed = await bytes(),
				installedInode = (await lstat(repo.index)).ino;
			process.kill(child.pid, "SIGCONT");
			const code = await Promise.race([
				child.exited,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("Resumed producer did not exit")), 15_000),
				),
			]);
			expect(code).toBe(0);
			expect(await bytes()).toEqual(installed);
			expect((await lstat(repo.index)).ino).toBe(installedInode);
			expect(await git("diff", "--cached", "--name-only")).toBe("b");
		} finally {
			if (child.exitCode === null) {
				try {
					process.kill(child.pid, "SIGCONT");
				} catch {}
				child.kill("SIGKILL");
				await child.exited;
			}
			await rm(join(repo.gitDir, "hooks", "post-commit"), { force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"recovery cannot cross a producer paused inside the fenced filesystem publication",
	async () => {
		await file("a", "selected\n");
		await act({ action: "init" });
		const repo = await resolveGitStagingRepository(root),
			marker = join(repo.gitDir, "publication-paused"),
			resultPath = join(repo.gitDir, "publication-result.json"),
			script = join(repo.gitDir, "publication-fixture.ts");
		await writeFile(
			script,
			`import{spyOn}from"bun:test";import*as fs from"node:fs";import{writeFile}from"node:fs/promises";const rename=fs.renameSync;spyOn(fs,"renameSync").mockImplementation((from,to)=>{if(String(to)===process.argv[4]){fs.writeFileSync(process.argv[5],"paused");process.kill(process.pid,"SIGSTOP");}return rename(from,to);});const{IndependentGitStagingKernel}=await import(${JSON.stringify(join(import.meta.dir, "..", "git-staging-kernel.ts"))});const k=new IndependentGitStagingKernel(process.argv[2],"publication");const s=await k.summary();try{const r=await k.action({action:"commit",listId:s.activeListId,message:"fenced publication",identity:{name:"Fixture",email:"fixture@example.test"},expectedGeneration:s.generation,observationId:s.observationId});await writeFile(process.argv[3],JSON.stringify(r));}catch(e){await writeFile(process.argv[3],JSON.stringify({code:e.code,message:e.message}));}`,
		);
		const child = Bun.spawn([process.execPath, script, root, resultPath, repo.index, marker], {
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const deadline = Date.now() + 15_000;
			while (!(await lstat(marker).catch(() => null))) {
				if (child.exitCode !== null)
					throw new Error(
						`Producer exited ${child.exitCode}: ${await readFile(resultPath, "utf8").catch(() => "no result")} ${await new Response(child.stderr).text()}`,
					);
				if (Date.now() > deadline)
					throw new Error("Producer did not reach synchronous publication barrier");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const read = await db();
			let operationId: string;
			try {
				operationId = (
					read
						.query("SELECT id FROM commit_operations WHERE status NOT IN ('finished','rejected')")
						.get() as { id: string }
				).id;
			} finally {
				read.close();
			}
			const before = await bytes(),
				clock = Date.now.bind(Date),
				advanced = spyOn(Date, "now").mockImplementation(() => clock() + 10 * 60_000);
			try {
				await expect(act({ action: "recover", operationId })).rejects.toThrow(/locked|busy/i);
			} finally {
				advanced.mockRestore();
			}
			expect(await bytes()).toEqual(before);
			process.kill(child.pid, "SIGCONT");
			expect(
				await Promise.race([
					child.exited,
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("Publication producer did not exit")), 15_000),
					),
				]),
			).toBe(0);
			expect(JSON.parse(await readFile(resultPath, "utf8")).outcome).toBe("applied");
			expect(await git("diff", "--cached", "--name-only")).toBe("");
		} finally {
			if (child.exitCode === null) {
				try {
					process.kill(child.pid, "SIGCONT");
				} catch {}
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	},
);

test("a replaced operation fence rejects stale SQL publication and stale error-state writes", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const repo = await resolveGitStagingRepository(root),
		store = await ChangelistStore.open(repo);
	if (!store) throw new Error("Missing changelist database");
	try {
		const state = store.state(),
			operationId = crypto.randomUUID();
		await store.transaction(() => {
			store.db
				.query(
					"INSERT INTO commit_operations(id,list_id,expected_generation,observation_id,head_oid,head_tree,status,evidence_json,created_at,fence_token) VALUES(?,?,?,?,?,?,'recovering','{}',?,'old-fence')",
				)
				.run(
					operationId,
					state.active_list_id,
					state.generation,
					state.observation_id,
					state.head_oid,
					state.head_tree,
					Date.now(),
				);
		});
		const draft = await store.draft(state.head_oid, state.head_tree as string);
		await store.copyFiles(draft, state.observation_id as string, []);
		await store.transaction(() => {
			store.db
				.query("UPDATE commit_operations SET fence_token='new-fence' WHERE id=?")
				.run(operationId);
		});
		await expect(
			store.publish(
				draft,
				state,
				state.head_oid,
				state.head_tree as string,
				operationId,
				"old-fence",
			),
		).rejects.toMatchObject({ code: "GIT_STAGING_FENCED" });
		await store.mark("incomplete", "stale producer error", {
			operationId,
			fenceToken: "old-fence",
		});
		expect(store.state()).toEqual(state);
		await store.publish(
			draft,
			state,
			state.head_oid,
			state.head_tree as string,
			operationId,
			"new-fence",
		);
		expect(store.state().generation).toBe(state.generation + 1);
		expect(store.state().state).toBe("ready");
	} finally {
		store.close();
	}
});

test("recovery refuses an external native index edit after the confirmed commit", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const original = processes.stagingGit;
	let fail = true;
	const mock = spyOn(processes, "stagingGit").mockImplementation(async (cwd, args, options) => {
		if (
			fail &&
			args[0] === "read-tree" &&
			options?.env?.GIT_INDEX_FILE?.endsWith("/native.index")
		) {
			fail = false;
			throw new Error("interrupted native installation");
		}
		return original(cwd, args, options);
	});
	restores.push(() => mock.mockRestore());
	const outcome = await commit(await active());
	expect(outcome.outcome).toBe("partial");
	const repo = await resolveGitStagingRepository(root);
	await writeFile(repo.index, Buffer.from("external index bytes"));
	const before = await bytes();
	await expect(
		act({ action: "recover", operationId: outcome.operationId as string }),
	).rejects.toMatchObject({ code: "GIT_STAGING_CONCURRENT_CHANGE" });
	expect(await bytes()).toEqual(before);
});

test("unfinished merge and an existing native lock stop commit before invoking Git commit", async () => {
	await file("a", "selected\n");
	await act({ action: "init" });
	const a = await active(),
		repo = await resolveGitStagingRepository(root);
	await writeFile(join(repo.gitDir, "MERGE_HEAD"), `${await git("rev-parse", "HEAD")}\n`);
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_REPOSITORY_BUSY" });
	await rm(join(repo.gitDir, "MERGE_HEAD"));
	await writeFile(`${repo.index}.lock`, "other writer");
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_LOCKED" });
	expect(await readFile(`${repo.index}.lock`, "utf8")).toBe("other writer");
});

test("successful commits preserve unrelated native skip-worktree and assume-unchanged flags", async () => {
	await git("update-index", "--assume-unchanged", "a");
	await git("update-index", "--skip-worktree", "b");
	const flags = await git("ls-files", "-v", "--", "a", "b");
	await file("f", "group\n");
	await act({ action: "init" });
	await commit(await active());
	expect(await git("ls-files", "-v", "--", "a", "b")).toBe(flags);
});

test("external HEAD divergence requires synchronization and assigns uncertain files to unassigned", async () => {
	await file("a", "group\n");
	await act({ action: "init" });
	const a = await active();
	await file("a", "external\n");
	await git("add", "a");
	await git("commit", "--quiet", "-m", "External");
	await file("a", "group\n");
	const before = await bytes();
	await expect(commit(a)).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	expect((await act({ action: "sync" })).outcome).toBe("applied");
	expect(await bytes()).toEqual(before);
	expect(await readFile(join(root, "a"), "utf8")).toBe("group\n");
	expect((await kernel.files(a)).files).toHaveLength(0);
	expect(await kernel.summary()).toMatchObject({ state: "ready", activeListId: a });
	expect((await kernel.diff(GIT_STAGING_UNASSIGNED_LIST_ID, { path: "a" })).units).toEqual([
		expect.objectContaining({
			listId: GIT_STAGING_UNASSIGNED_LIST_ID,
			needsReview: false,
		}),
	]);
	expect(
		(await kernel.diff(GIT_STAGING_UNASSIGNED_LIST_ID, { path: "a" })).units[0].reviewReason,
	).toBeUndefined();
});

test("multiple HEAD overlaps publish together, absorb committed edits and keep healthy groups usable", async () => {
	const ignoreBase = "build/\n*.log\n# exceptions\n";
	await file(".gitignore", ignoreBase);
	await git("add", "--", ".gitignore");
	await git("commit", "--quiet", "-m", "Ignore base");
	await file(".gitignore", `${ignoreBase}!local.log\n`);
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	await file("a", "healthy local change\n");
	await file("b", "absorbed by external HEAD\n");
	await act({ action: "init" });
	const healthy = await active();
	const owned = await create("Original task");
	await move(healthy, owned, [".gitignore", "f"]);
	const future = await create("Future changes");
	const sameName = await create(GIT_STAGING_UNASSIGNED_LIST_NAME);
	await act({ action: "activate", listId: future });
	const previous = await kernel.summary();
	await file(".gitignore", `${ignoreBase}!external.log\n`);
	await file("f", "external first\ncontext1\ncontext2\nlast\n");
	await git("add", "--", ".gitignore", "f", "b");
	await git("commit", "--quiet", "-m", "External overlapping task and absorbed edit");
	const head = await git("rev-parse", "HEAD");
	await file(".gitignore", `${ignoreBase}!local.log\n`);
	await file("f", "FIRST\ncontext1\ncontext2\nLAST\n");
	const native = await bytes();
	const paths = [".gitignore", "f", "a", "b"];
	const work = await Promise.all(paths.map((path) => readFile(join(root, path))));
	const synced = await act({ action: "sync" });
	const current = await kernel.summary();
	expect(current).toMatchObject({
		state: "ready",
		activeListId: future,
		generation: previous.generation + 1,
		observationId: synced.observationId,
	});
	expect(current.lists.map((list) => list.id).sort()).toEqual(
		[healthy, owned, future, sameName, GIT_STAGING_UNASSIGNED_LIST_ID].sort(),
	);
	for (const list of previous.lists) {
		expect(current.lists.find((candidate) => candidate.id === list.id)).toMatchObject({
			name: list.name,
			active: list.active,
		});
	}
	expect(current.lists.find((list) => list.id === sameName)).toMatchObject({
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		unitCount: 0,
	});
	expect((await kernel.files(owned)).files).toEqual([]);
	expect((await kernel.files(healthy)).files.map((entry) => entry.path)).toEqual(["a"]);
	expect(
		(await kernel.files(GIT_STAGING_UNASSIGNED_LIST_ID)).files.map((entry) => entry.path),
	).toEqual([".gitignore", "f"]);
	const read = await db();
	try {
		expect(read.query("SELECT head_oid,state FROM v_workspace_state").get()).toEqual({
			head_oid: head,
			state: "ready",
		});
		const changes = read
			.query<{ path: string; needs_review: number; review_reason: string | null }, [string]>(
				"SELECT path,needs_review,review_reason FROM v_changes WHERE list_id = ? ORDER BY path,unit_id",
			)
			.all(GIT_STAGING_UNASSIGNED_LIST_ID);
		expect(changes.length).toBeGreaterThanOrEqual(3);
		expect(new Set(changes.map((change) => change.path))).toEqual(new Set([".gitignore", "f"]));
		expect(
			changes.every((change) => change.needs_review === 0 && change.review_reason === null),
		).toBe(true);
		expect(read.query("SELECT COUNT(*) n FROM v_changes WHERE path = 'b'").get()).toEqual({ n: 0 });
	} finally {
		read.close();
	}
	expect(await act({ action: "sync" })).toMatchObject({
		generation: current.generation,
		observationId: current.observationId,
	});
	expect(await bytes()).toEqual(native);
	expect(await Promise.all(paths.map((path) => readFile(join(root, path))))).toEqual(work);
	expect(await git("rev-parse", "HEAD")).toBe(head);
	expect((await commit(healthy)).outcome).toBe("applied");
	expect(await git("show", "HEAD:a")).toBe("healthy local change");
	expect(await git("show", "HEAD:.gitignore")).toBe(`${ignoreBase}!external.log`);
	expect((await kernel.files(healthy)).files).toEqual([]);
	expect((await kernel.summary()).activeListId).toBe(future);
	expect(
		(await kernel.diff(GIT_STAGING_UNASSIGNED_LIST_ID, { path: "f" })).units.every(
			(unit) => !unit.needsReview && unit.reviewReason === undefined,
		),
	).toBe(true);
	expect((await commit(GIT_STAGING_UNASSIGNED_LIST_ID)).outcome).toBe("applied");
	expect(await git("show", "HEAD:.gitignore")).toBe(`${ignoreBase}!local.log`);
	expect(await git("show", "HEAD:f")).toBe("FIRST\ncontext1\ncontext2\nLAST");
	expect((await kernel.files(GIT_STAGING_UNASSIGNED_LIST_ID)).files).toEqual([]);
	expect((await kernel.summary()).lists.map((list) => list.id).sort()).toEqual(
		[healthy, owned, future, sameName, GIT_STAGING_UNASSIGNED_LIST_ID].sort(),
	);
	expect(await git("diff", "--cached", "--name-only")).toBe("");
	expect(await Promise.all(paths.map((path) => readFile(join(root, path))))).toEqual(work);
});

test("same-list moves validate the selection without publishing and edited unassigned regions use active", async () => {
	const local = "FIRST\ncontext1\ncontext2\nLAST\n";
	await file("f", local);
	await act({ action: "init" });
	const original = await active();
	await file("f", "external\ncontext1\ncontext2\nlast\n");
	await git("add", "--", "f");
	await git("commit", "--quiet", "-m", "External first-line edit");
	await file("f", local);
	await act({ action: "sync" });
	const before = await kernel.summary();
	const native = await bytes();
	const initial = (await kernel.diff(GIT_STAGING_UNASSIGNED_LIST_ID, { path: "f" })).units;
	expect(initial).toHaveLength(2);
	expect(initial.every((unit) => !unit.needsReview && unit.reviewReason === undefined)).toBe(true);
	const [selected, pending] = initial;
	const noOp = await act({
		action: "move",
		fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
		toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
		unitIds: [selected.id],
	});
	expect(noOp).toMatchObject({
		generation: before.generation,
		observationId: before.observationId,
	});
	expect((await kernel.diff(GIT_STAGING_UNASSIGNED_LIST_ID, { path: "f" })).units).toEqual(initial);
	await expect(
		act({
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			unitIds: ["missing-unit"],
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	await expect(
		act({
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			paths: ["../outside"],
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_INVALID" });
	await expect(
		act({
			action: "move",
			fromListId: original,
			toListId: original,
			unitIds: [selected.id],
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	await expect(
		kernel.action({
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			unitIds: [selected.id],
			expectedGeneration: before.generation,
			observationId: before.observationId as string,
			authorizedPaths: [],
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_FORBIDDEN" });
	await expect(
		act({
			action: "move",
			fromListId: "missing-list",
			toListId: "missing-list",
			all: true,
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_NOT_FOUND" });
	expect(await kernel.summary()).toMatchObject({
		generation: before.generation,
		observationId: before.observationId,
	});
	const page = await kernel.actionPaths({
		action: "move",
		fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
		toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
		unitIds: [selected.id],
		expectedGeneration: before.generation,
		observationId: before.observationId as string,
	});
	expect(page).toEqual(["f"]);
	await create("Another task");
	await expect(
		kernel.action({
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			unitIds: [pending.id],
			expectedGeneration: before.generation,
			observationId: before.observationId as string,
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	await file("f", "FIRST\ncontext1\ncontext2\nLAST edited\n");
	await act({ action: "sync" });
	const edited = (await kernel.diff(original, { path: "f" })).units;
	expect(edited).toHaveLength(1);
	expect(edited[0]).toMatchObject({ baseStart: 3, listId: original, needsReview: false });
	expect(edited[0].reviewReason).toBeUndefined();
	const remaining = (await kernel.diff(GIT_STAGING_UNASSIGNED_LIST_ID, { path: "f" })).units;
	expect(remaining).toEqual([expect.objectContaining({ id: selected.id, needsReview: false })]);
	await act({
		action: "move",
		fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
		toListId: original,
		unitIds: [selected.id],
	});
	expect((await kernel.files(GIT_STAGING_UNASSIGNED_LIST_ID)).files).toEqual([]);
	expect((await kernel.diff(original, { path: "f" })).units).toHaveLength(2);
	expect(await bytes()).toEqual(native);
	expect(await readFile(join(root, "f"), "utf8")).toBe("FIRST\ncontext1\ncontext2\nLAST edited\n");
});

test("archived unassigned identity returns for new HEAD conflicts without reclaiming moved members", async () => {
	await file("a", "local A\n");
	await act({ action: "init" });
	const original = await active();
	await file("a", "external A\n");
	await git("add", "--", "a");
	await git("commit", "--quiet", "-m", "External A");
	await file("a", "local A\n");
	await act({ action: "sync" });
	await act({ action: "rename", listId: GIT_STAGING_UNASSIGNED_LIST_ID, name: "Review queue" });
	await act({ action: "delete", listId: GIT_STAGING_UNASSIGNED_LIST_ID });
	expect(
		(await kernel.summary()).lists.some((list) => list.id === GIT_STAGING_UNASSIGNED_LIST_ID),
	).toBe(false);
	expect((await kernel.files(original)).files.map((entry) => entry.path)).toEqual(["a"]);
	await file("b", "local B\n");
	await act({ action: "sync" });
	await file("b", "external B\n");
	await git("add", "--", "b");
	await git("commit", "--quiet", "-m", "External B");
	await file("b", "local B\n");
	const native = await bytes();
	await act({ action: "sync" });
	const published = await kernel.summary();
	expect(published).toMatchObject({ state: "ready", activeListId: original });
	expect(published.lists.find((list) => list.id === GIT_STAGING_UNASSIGNED_LIST_ID)).toMatchObject({
		name: "Review queue",
		fileCount: 1,
	});
	expect(
		(await kernel.files(GIT_STAGING_UNASSIGNED_LIST_ID)).files.map((entry) => entry.path),
	).toEqual(["b"]);
	expect((await kernel.files(original)).files.map((entry) => entry.path)).toEqual(["a"]);
	expect(await act({ action: "sync" })).toMatchObject({
		generation: published.generation,
		observationId: published.observationId,
	});
	expect(await bytes()).toEqual(native);
	expect(await readFile(join(root, "a"), "utf8")).toBe("local A\n");
	expect(await readFile(join(root, "b"), "utf8")).toBe("local B\n");
});

test("literal NUL-delimited paths, binary bytes, symlinks and modes retain their own semantics", async () => {
	const paths = [
		"space name",
		"line\nbreak",
		"tab\tname",
		"*.txt",
		":(exclude)no",
		"-dash",
		"中文",
	];
	for (const path of paths) await file(path, "new\n");
	await file("binary", Buffer.from([0, 255, 128, 3]));
	await symlink("outside-target", join(root, "symbolic"));
	await chmod(join(root, "a"), 0o755);
	await act({ action: "init" });
	const a = await active();
	const rows = (await kernel.files(a)).files;
	expect(rows.map((f) => f.path)).toEqual([...paths, "a", "binary", "symbolic"].sort());
	expect(rows.find((f) => f.path === "binary")?.stats).toEqual({ kind: "binary" });
	await commit(a);
	expect(Buffer.from((await processes.stagingGit(root, ["show", "HEAD:binary"])).bytes)).toEqual(
		Buffer.from([0, 255, 128, 3]),
	);
	expect(await git("show", "HEAD:symbolic")).toBe("outside-target");
	expect(await git("ls-tree", "HEAD", "a")).toContain("100755");
});

test("CRLF attributes normalize canonical blobs while worktree bytes remain untouched", async () => {
	await file(".gitattributes", "*.txt text eol=crlf\n");
	await file("crlf.txt", "base\r\n");
	await git("add", ".gitattributes", "crlf.txt");
	await git("commit", "--quiet", "-m", "Attributes");
	await file("crlf.txt", "next\r\n");
	await act({ action: "init" });
	const work = await readFile(join(root, "crlf.txt"));
	await commit(await active());
	expect((await processes.stagingGit(root, ["show", "HEAD:crlf.txt"])).bytes).toEqual(
		Buffer.from("next\n"),
	);
	expect(await readFile(join(root, "crlf.txt"))).toEqual(work);
});

test("unique unchanged rename keeps a structural unit and commits only the path movement", async () => {
	await rename(join(root, "a"), join(root, "renamed"));
	await act({ action: "init" });
	const a = await active();
	const rows = (await kernel.files(a)).files;
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ path: "renamed", oldPath: "a", status: "R" });
	await commit(a);
	expect(await git("ls-tree", "--name-only", "HEAD", "a", "renamed")).toBe("renamed");
});

test("unborn SHA-256 repositories and detached HEAD commits use their native object format", async () => {
	await kernel.summary();
	await rm(join(root, ".git"), { recursive: true, force: true });
	await git("init", "--quiet", "--initial-branch=main", "--object-format=sha256");
	await git("config", "commit.gpgSign", "false");
	kernel = new IndependentGitStagingKernel(root, "sha256");
	await act({ action: "init" });
	const a = await active();
	expect((await commit(a)).commitOid).toHaveLength(64);
	expect(await git("diff", "--cached", "--name-only")).toBe("");
	await git("checkout", "--detach", "--quiet", "HEAD");
	await file("a", "detached change\n");
	await act({ action: "sync" });
	const result = await commit(a);
	expect(result.commitOid).toHaveLength(64);
	expect(await git("show", "HEAD:a")).toBe("detached change");
});

test("linked Git-dir pointers isolate SQLite per worktree without reading common-dir JSON", async () => {
	const linked = await mkdtemp(join(tmpdir(), "nf-gitdir-pointer-"));
	extras.push(linked);
	const common = (await resolveGitStagingRepository(root)).gitDir;
	const linkedGitDir = join(common, "worktrees", "fixture");
	await mkdir(linkedGitDir, { recursive: true });
	await writeFile(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
	await writeFile(join(linkedGitDir, "commondir"), "../..\n");
	await writeFile(join(linkedGitDir, "gitdir"), `${join(linked, ".git")}\n`);
	await writeFile(join(linkedGitDir, "HEAD"), `${await git("rev-parse", "HEAD")}\n`);
	await writeFile(join(linkedGitDir, "index"), (await bytes()) as Buffer);
	for (const path of ["a", "b", "f"])
		await writeFile(join(linked, path), await readFile(join(root, path)));
	const other = new IndependentGitStagingKernel(linked, "linked");
	await writeFile(join(linked, "a"), "linked edit\n");
	await other.action({ action: "init" });
	const repo = await resolveGitStagingRepository(linked);
	expect(repo.directory).toContain("/.git/worktrees/");
	expect((await other.summary()).lists[0].fileCount).toBe(1);
	expect((await kernel.summary()).initialized).toBe(false);
});

test("oversized input retains complete prior ownership and never reports a false empty group", async () => {
	await file("a", "edit\n");
	await act({ action: "init" });
	const a = await active(),
		before = await kernel.summary();
	await file("a", Buffer.alloc(2 * 1024 * 1024 + 1, 65));
	await expect(act({ action: "sync" })).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
	expect((await kernel.summary()).observationId).toBe(before.observationId);
	expect((await kernel.summary()).state).toBe("incomplete");
	expect((await kernel.files(a)).files).toHaveLength(1);
});

test("Git bytes are lossless; bounded output, deadline and cancellation remain failures", async () => {
	await file("binary", Buffer.from([0, 255, 128]));
	const blob = await processes.stagingGit(root, ["hash-object", "-w", "--stdin"], {
		input: Buffer.from([0, 255, 128]),
	});
	expect(
		(await processes.stagingGit(root, ["cat-file", "blob", blob.stdout.trim()])).bytes,
	).toEqual(Buffer.from([0, 255, 128]));
	await expect(
		processes.stagingGit(root, ["ls-files", "-z"], { maxBytes: 1 }),
	).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
	await expect(
		processes.stagingGit(root, ["-c", "alias.wait=!sleep 2", "wait"], { timeoutMs: 10 }),
	).rejects.toMatchObject({ code: "GIT_STAGING_TIMEOUT" });
	const controller = new AbortController();
	controller.abort();
	await expect(
		processes.stagingGit(root, ["status"], { signal: controller.signal }),
	).rejects.toThrow();
});
