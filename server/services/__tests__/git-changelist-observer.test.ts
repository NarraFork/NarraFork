import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import type { BigIntStats, StatOptions, Stats } from "node:fs";
import * as fsModule from "node:fs/promises";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	GIT_STAGING_UNASSIGNED_LIST_ID,
	GIT_STAGING_UNASSIGNED_LIST_NAME,
	type GitStagingAction,
} from "../../../shared/git-staging-lists";
import { AppError } from "../../lib/errors";
import {
	assertChangelistSourcesCurrent,
	changelistObservationPaths,
	OBSERVATION_LIMITS,
	type ObservationDiagnostics,
	observeChangelists,
	ownershipUnits,
	readChangelistMergeHead,
} from "../git-changelist-observer";
import {
	createTextOwnership,
	materializeTextOwnership,
	moveTextUnits,
	prepareTextCommit,
	rebaseTextOwnership,
	updateTextOwnership,
} from "../git-changelist-ownership";
import {
	type ChangelistRepository,
	ChangelistStore,
	type StoredFile,
} from "../git-changelist-store";
import { IndependentGitStagingKernel, resolveGitStagingRepository } from "../git-staging-kernel";
import {
	requestGitStagingObservation,
	subscribeGitStagingObservation,
} from "../git-staging-observation";
import * as processModule from "../git-staging-process";

setDefaultTimeout(30_000);
const exec = promisify(execFile);
let root: string;
let store: ChangelistStore | null = null;
const restores: (() => void)[] = [];
const env = {
	...process.env,
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
		await exec("git", args, { cwd: root, env, timeout: 15_000, maxBuffer: 8_388_608 })
	).stdout.trimEnd();
}
async function file(path: string, bytes: string | Buffer) {
	await writeFile(join(root, path), bytes);
}
async function setup() {
	const repo = await resolveGitStagingRepository(root);
	store = await ChangelistStore.open(repo, true);
	if (!store) throw new Error("Expected changelist store");
	return { repo, store };
}
function files() {
	return (store?.fileIds() ?? []).map((entry) => store?.loadFile(entry.file_id) as StoredFile);
}
async function measuredObservation(repo: ChangelistRepository, database: ChangelistStore) {
	const reports: ObservationDiagnostics[] = [];
	const state = await observeChangelists(
		repo,
		database,
		undefined,
		undefined,
		undefined,
		(report) => reports.push(report),
	);
	expect(reports).toHaveLength(1);
	return { state, metrics: reports[0] };
}
async function changeOwner(snapshot: StoredFile, groupId: string) {
	if (!store || !snapshot.ownership) throw new Error("Expected text ownership");
	const expected = store.state();
	await store.transaction(() => {
		store?.db
			.query("INSERT INTO change_lists(id,name,created_at) VALUES(?,?,?)")
			.run(groupId, groupId, Date.now());
	});
	const ownership = moveTextUnits(snapshot.ownership, {
		unitIds: snapshot.ownership.units.map((unit) => unit.id),
		targetGroupId: groupId,
	});
	const next = {
		...snapshot,
		versionId: crypto.randomUUID(),
		ownership,
		units: snapshot.units.map((unit) => ({ ...unit, listId: groupId })),
	};
	const draft = await store.draft(expected.head_oid, expected.head_tree as string);
	await store.putFile(draft, next);
	await store.publish(draft, expected, expected.head_oid, expected.head_tree as string);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "nf-observer-batch-"));
	await git("init", "--quiet", "--initial-branch=main");
	await git("config", "user.name", "Fixture");
	await git("config", "user.email", "fixture@example.test");
	await git("config", "commit.gpgSign", "false");
});
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	processModule.observeStagingChildren(() => {});
	store?.close();
	store = null;
	await rm(root, { recursive: true, force: true });
});

async function externalHeadConflict(mode = false, splitModeOwner = false) {
	const base = "first\ncontext one\ncontext two\nlast\n";
	const work = "FIRST\ncontext one\ncontext two\nLAST\n";
	await file("conflict", base);
	await file("retained", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("conflict", work);
	if (mode) await chmod(join(root, "conflict"), 0o755);
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	await changeOwner(files()[0], "previous-owner");
	if (splitModeOwner) {
		const expected = store.state();
		const previous = files()[0];
		await store.transaction(() => {
			store.db
				.query("INSERT INTO change_lists(id,name,created_at) VALUES('mode-owner','Mode owner',0)")
				.run();
		});
		const draft = await store.draft(expected.head_oid, expected.head_tree as string);
		await store.putFile(draft, {
			...previous,
			versionId: crypto.randomUUID(),
			units: previous.units.map((unit) =>
				unit.kind === "mode" ? { ...unit, listId: "mode-owner" } : unit,
			),
		});
		await store.publish(draft, expected, expected.head_oid, expected.head_tree as string);
	}
	await file("retained", "retained local edit\n");
	await observeChangelists(repo, store);
	const expected = store.state();
	const previous = files();
	await file("conflict", "external\ncontext one\ncontext two\nlast\n");
	if (mode) await chmod(join(root, "conflict"), 0o644);
	await git("add", "--", "conflict");
	await git("commit", "--quiet", "-m", "External HEAD");
	await file("conflict", work);
	if (mode) await chmod(join(root, "conflict"), 0o755);
	return { repo, store, expected, previous, work, native: await readFile(repo.index) };
}
function reservedList() {
	return store?.db
		.query("SELECT id,name,archived,created_at FROM change_lists WHERE id=?")
		.get(GIT_STAGING_UNASSIGNED_LIST_ID);
}
function visibleReservedList() {
	return store?.db
		.query("SELECT * FROM v_changelists WHERE id=?")
		.get(GIT_STAGING_UNASSIGNED_LIST_ID);
}

test("external HEAD conflicts publish all remaining text and mode units without changing other owners", async () => {
	const { repo, store, expected, previous, work, native } = await externalHeadConflict(true);
	await store.transaction(() => {
		store.db
			.query("INSERT INTO change_lists(id,name,created_at) VALUES('same-name',?,0)")
			.run(GIT_STAGING_UNASSIGNED_LIST_NAME);
	});
	expect(reservedList()).toBeNull();
	const result = await observeChangelists(repo, store);
	expect(result).toMatchObject({
		state: "ready",
		head_oid: await git("rev-parse", "HEAD"),
		active_list_id: expected.active_list_id,
		generation: expected.generation + 1,
	});
	const conflict = files().find((file) => file.path === "conflict") as StoredFile;
	const retained = files().find((file) => file.path === "retained") as StoredFile;
	const oldConflict = previous.find((file) => file.path === "conflict");
	const oldRetained = previous.find((file) => file.path === "retained");
	if (!oldConflict || !oldRetained) throw new Error("Expected complete fixture snapshots");
	expect(retained).toEqual(oldRetained);
	expect(conflict.fileId).toBe(oldConflict.fileId);
	expect(conflict.units.some((unit) => unit.kind === "mode")).toBe(true);
	expect(conflict.units.filter((unit) => unit.kind === "text")).toHaveLength(2);
	for (const unit of conflict.units)
		expect(unit).toMatchObject({
			listId: GIT_STAGING_UNASSIGNED_LIST_ID,
			needsReview: false,
		});
	expect(materializeTextOwnership(conflict.ownership as NonNullable<StoredFile["ownership"]>)).toBe(
		work,
	);
	for (const unit of conflict.ownership?.units ?? []) {
		expect(unit).toMatchObject({
			groupId: GIT_STAGING_UNASSIGNED_LIST_ID,
			needsReview: false,
		});
		expect(unit.sourceGroupIds).toEqual([GIT_STAGING_UNASSIGNED_LIST_ID]);
	}
	expect(visibleReservedList()).toMatchObject({
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		active: 0,
		unit_count: conflict.units.length,
		needs_review_count: 0,
	});
	expect(
		store.db.query("SELECT name,archived FROM change_lists WHERE id='same-name'").get(),
	).toEqual({
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		archived: 0,
	});
	const wal = await lstat(`${store.path}-wal`);
	const writes = (store.db.query("SELECT total_changes() n").get() as { n: number }).n;
	const versions = store.fileIds();
	expect(await observeChangelists(repo, store)).toEqual(result);
	expect(store.fileIds()).toEqual(versions);
	expect((store.db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes);
	expect(await lstat(`${store.path}-wal`)).toMatchObject({ size: wal.size, mtimeMs: wal.mtimeMs });
	expect(await readFile(repo.index)).toEqual(native);
	expect(await readFile(join(root, "conflict"), "utf8")).toBe(work);
});

for (const target of ["same", "other"] as const) {
	test(`${target}-group movement preserves untouched text and structural ownership`, async () => {
		const { repo, store, native } = await externalHeadConflict(true, true);
		await observeChangelists(repo, store);
		let snapshot = files().find((file) => file.path === "conflict") as StoredFile;
		const mode = snapshot.units.find((unit) => unit.kind === "mode");
		const firstText = snapshot.units.find((unit) => unit.kind === "text");
		if (!mode || !firstText || !snapshot.ownership) throw new Error("Expected text and mode units");
		expect(snapshot.ownership.structuralSourceGroupIds).toBeUndefined();
		for (const unit of snapshot.ownership.units)
			expect(unit.sourceGroupIds).toEqual([GIT_STAGING_UNASSIGNED_LIST_ID]);
		const kernel = new IndependentGitStagingKernel(root, "observer-test");
		let expected = store.state();
		await kernel.action({
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			unitIds: [firstText.id],
			expectedGeneration: expected.generation,
			observationId: expected.observation_id as string,
		});
		expect(store.state()).toEqual(expected);
		snapshot = store.loadFile(snapshot.fileId) as StoredFile;
		expect(snapshot.units.find((unit) => unit.id === firstText.id)?.needsReview).toBe(false);
		expect(snapshot.units.find((unit) => unit.id === mode.id)?.needsReview).toBe(false);
		expect(snapshot.ownership?.structuralSourceGroupIds).toBeUndefined();
		await file("conflict", "FIRST\ncontext one\ncontext two\nLAST edited\n");
		await observeChangelists(repo, store);
		snapshot = store.loadFile(snapshot.fileId) as StoredFile;
		expect(snapshot.ownership?.structuralSourceGroupIds).toBeUndefined();
		expect(snapshot.units.find((unit) => unit.id === mode.id)).toMatchObject({
			needsReview: false,
		});
		const repeated = await observeChangelists(repo, store);
		expect(store.loadFile(snapshot.fileId)).toEqual(snapshot);
		expected = repeated;
		const textUnits = snapshot.units.filter((unit) => unit.kind === "text");
		const toListId = target === "same" ? GIT_STAGING_UNASSIGNED_LIST_ID : expected.active_list_id;
		await kernel.action({
			action: "move",
			fromListId: GIT_STAGING_UNASSIGNED_LIST_ID,
			toListId,
			unitIds: [mode.id],
			expectedGeneration: expected.generation,
			observationId: expected.observation_id as string,
		});
		snapshot = store.loadFile(snapshot.fileId) as StoredFile;
		expect(snapshot.ownership?.structuralSourceGroupIds).toBeUndefined();
		expect(snapshot.units.find((unit) => unit.id === mode.id)).toMatchObject({
			listId: toListId,
			needsReview: false,
		});
		expect(snapshot.units.filter((unit) => unit.kind === "text")).toEqual(textUnits);
		await observeChangelists(repo, store);
		expect(store.loadFile(snapshot.fileId)?.ownership?.structuralSourceGroupIds).toBeUndefined();
		expect(await readFile(repo.index)).toEqual(native);
	});
}

test("repeated HEAD conflicts keep structural units in the unassigned list", async () => {
	const { repo, store } = await externalHeadConflict(true, true);
	await observeChangelists(repo, store);
	let snapshot = files().find((file) => file.path === "conflict") as StoredFile;
	const mode = snapshot.units.find((unit) => unit.kind === "mode");
	if (!mode) throw new Error("Expected mode unit");
	await file("conflict", "another external\ncontext one\ncontext two\nlast\n");
	await chmod(join(root, "conflict"), 0o644);
	await git("add", "--", "conflict");
	await git("commit", "--quiet", "-m", "Another external HEAD");
	await file("conflict", "FIRST\ncontext one\ncontext two\nLAST\n");
	await chmod(join(root, "conflict"), 0o755);
	await observeChangelists(repo, store);
	snapshot = store.loadFile(snapshot.fileId) as StoredFile;
	expect(snapshot.ownership?.structuralSourceGroupIds).toBeUndefined();
	expect(snapshot.units.find((unit) => unit.id === mode.id)).toMatchObject({
		listId: GIT_STAGING_UNASSIGNED_LIST_ID,
		needsReview: false,
	});
});

test("fully absorbed text leaves only the independently classified mode unit", async () => {
	const { repo, store, previous, native } = await externalHeadConflict(true, true);
	await file("conflict", "external\ncontext one\ncontext two\nlast\n");
	await observeChangelists(repo, store);
	const snapshot = files().find((file) => file.path === "conflict") as StoredFile;
	const mode = snapshot.units[0];
	expect(snapshot.units).toHaveLength(1);
	expect(mode).toMatchObject({
		kind: "mode",
		listId: GIT_STAGING_UNASSIGNED_LIST_ID,
		needsReview: false,
	});
	expect(snapshot.ownership?.units).toEqual([]);
	expect(snapshot.ownership?.structuralSourceGroupIds).toBeUndefined();
	for (let i = 0; i < 3; i++) await store.collect();
	const original = previous.find((file) => file.path === "conflict");
	if (!original) throw new Error("Expected original conflict snapshot");
	expect(
		store.db.query("SELECT 1 FROM file_snapshots WHERE version_id=?").get(original.versionId),
	).toBeNull();
	expect(await observeChangelists(repo, store)).toEqual(store.state());
	expect(store.loadFile(snapshot.fileId)).toEqual(snapshot);
	expect(await readFile(repo.index)).toEqual(native);
});

for (const representation of ["binary", "atomic"] as const) {
	test(`${representation} conversion of a single-owner file follows the current active list`, async () => {
		const { repo, store, native } = await externalHeadConflict();
		await observeChangelists(repo, store);
		const active = store.state().active_list_id;
		if (representation === "binary") await file("conflict", Buffer.from("binary\0content"));
		else await file(".gitattributes", "conflict working-tree-encoding=UTF-8\n");
		await observeChangelists(repo, store);
		const converted = files().find((entry) => entry.path === "conflict") as StoredFile;
		expect(converted.ownership).toBeNull();
		expect(converted.units).toHaveLength(1);
		expect(converted.units[0]).toMatchObject({
			kind: "binary",
			listId: active,
			needsReview: false,
		});
		expect(await readFile(repo.index)).toEqual(native);
	});
}

test("ambiguous rename pairing uses independent delete and additions with distinct identities", async () => {
	const { repo, store, native } = await externalHeadConflict();
	await observeChangelists(repo, store);
	const snapshot = files().find((entry) => entry.path === "conflict") as StoredFile;
	await file("copy-one", snapshot.workBytes);
	await file("copy-two", snapshot.workBytes);
	await rm(join(root, "conflict"));
	await observeChangelists(repo, store);
	const changed = files().filter((entry) => entry.path !== "retained");
	expect(changed).toHaveLength(3);
	expect(new Set(changed.map((entry) => entry.fileId)).size).toBe(3);
	expect(changed.every((entry) => entry.path === entry.basePath)).toBe(true);
	expect(
		changed
			.flatMap((entry) => entry.units)
			.every((unit) => !unit.needsReview && !unit.reviewReason),
	).toBe(true);
	expect(await readFile(repo.index)).toEqual(native);
});

test("a failed HEAD-rebuild draft stays invisible and a complete retry activates the same reserved identity", async () => {
	const { repo, store, expected, previous, native } = await externalHeadConflict();
	const put = spyOn(store, "putFiles").mockImplementationOnce(async () => {
		throw new Error("Fixture HEAD-rebuild draft failure");
	});
	restores.push(() => put.mockRestore());
	await expect(observeChangelists(repo, store)).rejects.toThrow(
		"Fixture HEAD-rebuild draft failure",
	);
	expect(store.state()).toMatchObject({
		state: "incomplete",
		observation_id: expected.observation_id,
		generation: expected.generation,
		active_list_id: expected.active_list_id,
	});
	expect(files()).toEqual(previous);
	const archived = reservedList();
	expect(archived).toMatchObject({ archived: 1 });
	expect(visibleReservedList()).toBeNull();
	await observeChangelists(repo, store);
	expect(reservedList()).toEqual({ ...(archived as object), archived: 0 });
	expect(store.state().active_list_id).toBe(expected.active_list_id);
	expect(await readFile(repo.index)).toEqual(native);
});

test("generation changes during a HEAD-rebuild draft fence both publication and reserved-list activation", async () => {
	const { repo, store, expected, previous } = await externalHeadConflict();
	const putFiles = store.putFiles.bind(store);
	const put = spyOn(store, "putFiles").mockImplementation(async (...args) => {
		await putFiles(...args);
		await store.mutate(expected.generation, expected.observation_id, () => {});
	});
	restores.push(() => put.mockRestore());
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_STALE_VERSION",
	});
	expect(store.state()).toMatchObject({
		state: "ready",
		generation: expected.generation + 1,
		observation_id: expected.observation_id,
		active_list_id: expected.active_list_id,
	});
	expect(files()).toEqual(previous);
	expect(reservedList()).toMatchObject({ archived: 1 });
	expect(visibleReservedList()).toBeNull();
});

test("working-source changes after HEAD-rebuild draft writes retain the preceding complete observation", async () => {
	const { repo, store, expected, previous, native } = await externalHeadConflict();
	const putFiles = store.putFiles.bind(store);
	let changes = 0;
	const put = spyOn(store, "putFiles").mockImplementation(async (...args) => {
		await putFiles(...args);
		await file("conflict", `changing local edit ${++changes}\ncontext one\ncontext two\nLAST\n`);
	});
	restores.push(() => put.mockRestore());
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_CONCURRENT_CHANGE",
	});
	expect(changes).toBe(3);
	expect(store.state()).toMatchObject({
		state: "incomplete",
		generation: expected.generation,
		observation_id: expected.observation_id,
		active_list_id: expected.active_list_id,
	});
	expect(files()).toEqual(previous);
	expect(reservedList()).toMatchObject({ archived: 1 });
	expect(visibleReservedList()).toBeNull();
	expect(await readFile(repo.index)).toEqual(native);
});

for (const evidence of ["missing", "invalid"] as const) {
	test(`${evidence} commit projection evidence cannot opt into external HEAD ownership fallback`, async () => {
		const { repo, store, expected, previous } = await externalHeadConflict();
		const conflict = previous.find((file) => file.path === "conflict") as StoredFile;
		if (!conflict.ownership) throw new Error("Expected text ownership");
		const { mapping } = prepareTextCommit(conflict.ownership, { groupIds: ["previous-owner"] });
		const mappings = new Map(
			evidence === "missing" ? [] : [[conflict.fileId, { ...mapping, fileId: "invalid-file-id" }]],
		);
		await expect(
			observeChangelists(repo, store, undefined, {
				operationId: "strict-projection",
				sourceObservationId: expected.observation_id as string,
				mappings,
				selectedUnitIds: new Set(),
			}),
		).rejects.toMatchObject({
			code: evidence === "missing" ? "GIT_STAGING_HEAD_CONFLICT" : "invalidCommitMapping",
		});
		expect(store.state()).toEqual(expected);
		expect(files()).toEqual(previous);
		expect(reservedList()).toBeNull();
	});
}

test("real native unmerged entries remain a hard failure before external HEAD ownership fallback", async () => {
	const { repo, store, expected, previous, work } = await externalHeadConflict();
	const conflict = previous.find((file) => file.path === "conflict") as StoredFile;
	const oid = await git("rev-parse", "HEAD:conflict");
	await new Promise<void>((resolve, reject) => {
		const child = execFile(
			"git",
			["update-index", "--index-info"],
			{ cwd: root, env, timeout: 15_000, maxBuffer: 8_388_608 },
			(error) => (error ? reject(error) : resolve()),
		);
		child.stdin?.end(
			`0 ${"0".repeat(40)}\tconflict\n100644 ${conflict.baseOid} 1\tconflict\n100644 ${oid} 2\tconflict\n100644 ${conflict.workOid} 3\tconflict\n`,
		);
	});
	expect(await git("ls-files", "--unmerged")).toContain("conflict");
	await symlink(join(root, "missing-merge-target"), join(repo.gitDir, "MERGE_HEAD"));
	const native = await readFile(repo.index);
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_NATIVE_STAGED",
	});
	expect(store.state()).toMatchObject({
		state: "conflict",
		observation_id: expected.observation_id,
		generation: expected.generation,
	});
	expect(files()).toEqual(previous);
	expect(reservedList()).toBeNull();
	expect(await readFile(repo.index)).toEqual(native);
	expect(await readFile(join(root, "conflict"), "utf8")).toBe(work);
});

test("a file budget failure during external HEAD change preserves the complete prior ownership", async () => {
	const { repo, store, expected, previous, native } = await externalHeadConflict();
	await file("conflict", Buffer.alloc(OBSERVATION_LIMITS.maxFileBytes + 1, 120));
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state()).toMatchObject({
		state: "incomplete",
		observation_id: expected.observation_id,
		generation: expected.generation,
	});
	expect(files()).toEqual(previous);
	expect(reservedList()).toBeNull();
	expect(await readFile(repo.index)).toEqual(native);
});

async function legacyObservation(kind: "public" | "ownership" | "sources") {
	await file("legacy", "first\ncontext one\ncontext two\nlast\n");
	await file("unaffected", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("legacy", "FIRST\ncontext one\ncontext two\nLAST\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	await changeOwner(files()[0], "legacy-owner");
	await file("unaffected", "other local edit\n");
	await observeChangelists(repo, store);
	const source = files().find((entry) => entry.path === "legacy") as StoredFile;
	if (!source.ownership) throw new Error("Expected ownership");
	const ownership = structuredClone(source.ownership);
	for (const unit of ownership.units) {
		unit.needsReview = kind !== "sources";
		if (kind !== "sources") unit.reviewReason = "headChanged";
		unit.sourceGroupIds = [unit.groupId, "historical-candidate"];
	}
	if (kind === "ownership")
		ownership.structuralSourceGroupIds = { historical: ["historical-candidate"] };
	const legacy = {
		...source,
		versionId: crypto.randomUUID(),
		ownership,
		units: source.units.map((unit) =>
			kind === "public" ? { ...unit, needsReview: true, reviewReason: "headChanged" } : unit,
		),
	};
	const expected = store.state();
	const draft = await store.draft(expected.head_oid, expected.head_tree as string);
	await store.copyFiles(draft, expected.observation_id as string, [source.fileId]);
	await store.putFile(draft, legacy);
	await store.publish(draft, expected, expected.head_oid, expected.head_tree as string);
	return {
		repo,
		store,
		legacy,
		expected: store.state(),
		unaffected: files().find((entry) => entry.path === "unaffected") as StoredFile,
	};
}

for (const kind of ["public", "ownership", "sources"] as const) {
	for (const edited of [false, true]) {
		test(`${kind} legacy ownership is immutably upgraded with ${edited ? "edited" : "unchanged"} work files`, async () => {
			const { repo, store, legacy, expected, unaffected } = await legacyObservation(kind);
			expect(await store.legacyReviewFileIds()).toEqual(new Set([legacy.fileId]));
			const collect = spyOn(store, "collect").mockResolvedValue();
			restores.push(() => collect.mockRestore());
			if (edited) await file("legacy", "FIRST\ncontext one\ncontext two\nLAST edited\n");
			const next = await observeChangelists(repo, store);
			const upgraded = store.loadFile(legacy.fileId) as StoredFile;
			expect(next.generation).toBe(expected.generation + 1);
			expect(upgraded.versionId).not.toBe(legacy.versionId);
			expect(
				upgraded.units.every((unit) => !unit.needsReview && unit.reviewReason === undefined),
			).toBe(true);
			expect(
				upgraded.ownership?.units.every(
					(unit) =>
						!unit.needsReview &&
						unit.reviewReason === undefined &&
						unit.sourceGroupIds.length === 1 &&
						unit.sourceGroupIds[0] === unit.groupId,
				),
			).toBe(true);
			expect(upgraded.ownership?.structuralSourceGroupIds).toBeUndefined();
			expect(await store.legacyReviewFileIds()).toEqual(new Set());
			expect(store.loadFile(legacy.fileId, expected.observation_id)).toEqual(legacy);
			expect(store.loadFile(unaffected.fileId)).toEqual(unaffected);
			if (edited) {
				expect(upgraded.units[0].listId).toBe("legacy-owner");
				expect(upgraded.units[1].listId).toBe(expected.active_list_id);
			} else {
				expect(upgraded.units.map((unit) => unit.id)).toEqual(legacy.units.map((unit) => unit.id));
				expect(upgraded.units.map((unit) => unit.listId)).toEqual(
					legacy.units.map((unit) => unit.listId),
				);
				expect(upgraded.ownership?.baseLineIds).toEqual(legacy.ownership.baseLineIds);
			}
			const writes = (store.db.query("SELECT total_changes() n").get() as { n: number }).n;
			expect(await observeChangelists(repo, store)).toEqual(next);
			expect((store.db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes);
		});
	}
}

test("an unchanged published v1 baseline alias upgrades without changing historical line or unit identities", async () => {
	const base = "a\nb\nc\nd\ne\n";
	const candidateText = "a\nb\nc\nd\nb\ne\n";
	const workText = "a\nc\nd\nb\ne\n";
	await file("legacy-alias", candidateText);
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Historical moved-line candidate");
	await file("legacy-alias", workText);
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const fileSnapshot = files()[0];
	const initial = createTextOwnership({
		fileId: fileSnapshot.fileId,
		baseText: base,
		workText: base,
		activeGroupId: "insert",
	});
	let source = updateTextOwnership(initial, { workText, activeGroupId: "insert" });
	source = moveTextUnits(source, {
		unitIds: source.units.filter((unit) => unit.insertedLines.length === 0).map((unit) => unit.id),
		targetGroupId: "delete",
	});
	const candidate = prepareTextCommit(source, { groupIds: ["insert"] });
	expect(candidate.text).toBe(candidateText);
	const projected = rebaseTextOwnership(source, {
		baseText: candidate.text,
		workText,
		activeGroupId: "active",
		mode: "commit",
		commitMapping: candidate.mapping,
	}).snapshot;
	const ids = candidate.mapping.lineIds;
	const aliases = new Map(projected.baseLineIds.map((id, i) => [id, ids[i]]));
	const legacy = {
		...projected,
		baseLineIds: ids,
		units: projected.units.map((unit) => ({
			...unit,
			deletedLineIds: ids.slice(unit.baseStart, unit.baseEnd),
			leftAnchor: ids[unit.baseStart - 1] ?? null,
			rightAnchor: ids[unit.baseEnd] ?? null,
			needsReview: true,
			reviewReason: "headChanged" as const,
		})),
		workLines: projected.workLines.map((line) =>
			line.baseLineId === null
				? line
				: {
						...line,
						id: aliases.get(line.baseLineId) as string,
						baseLineId: aliases.get(line.baseLineId) as string,
					},
		),
	};
	expect(new Set(legacy.baseLineIds).size).toBeLessThan(legacy.baseLineIds.length);
	const expected = store.state();
	await store.transaction(() =>
		store.db
			.query("INSERT INTO change_lists(id,name,created_at) VALUES('delete','Remaining deletion',0)")
			.run(),
	);
	const draft = await store.draft(expected.head_oid, expected.head_tree as string);
	await store.putFile(draft, {
		...fileSnapshot,
		versionId: crypto.randomUUID(),
		ownership: legacy,
		units: ownershipUnits(legacy, fileSnapshot.path),
	});
	await store.publish(draft, expected, expected.head_oid, expected.head_tree as string);
	const oldState = store.state();
	const oldFile = store.loadFile(fileSnapshot.fileId) as StoredFile;
	const collect = spyOn(store, "collect").mockResolvedValue();
	restores.push(() => collect.mockRestore());
	await observeChangelists(repo, store);
	const upgraded = store.loadFile(fileSnapshot.fileId) as StoredFile;
	expect(upgraded.versionId).not.toBe(oldFile.versionId);
	expect(upgraded.ownership?.baseLineIds).toEqual(legacy.baseLineIds);
	expect(upgraded.ownership?.workLines).toEqual(legacy.workLines);
	expect(upgraded.units.map((unit) => [unit.id, unit.listId])).toEqual(
		oldFile.units.map((unit) => [unit.id, unit.listId]),
	);
	expect(upgraded.units.every((unit) => !unit.needsReview && !unit.reviewReason)).toBe(true);
	expect(store.loadFile(fileSnapshot.fileId, oldState.observation_id)).toEqual(oldFile);
	expect(await store.legacyReviewFileIds()).toEqual(new Set());
	const ready = store.state();
	expect(await observeChangelists(repo, store)).toEqual(ready);
});

test("a failed legacy upgrade keeps its source snapshots and compatibility flags intact", async () => {
	const { repo, store, legacy, expected } = await legacyObservation("public");
	const put = spyOn(store, "putFiles").mockRejectedValueOnce(
		new Error("Fixture normalization write failure"),
	);
	restores.push(() => put.mockRestore());
	await expect(observeChangelists(repo, store)).rejects.toThrow(
		"Fixture normalization write failure",
	);
	expect(store.state()).toMatchObject({
		observation_id: expected.observation_id,
		generation: expected.generation,
		state: "incomplete",
	});
	expect(store.loadFile(legacy.fileId)).toEqual(legacy);
	expect(await store.legacyReviewFileIds()).toEqual(new Set([legacy.fileId]));
	await observeChangelists(repo, store);
	expect(await store.legacyReviewFileIds()).toEqual(new Set());
});

test("merge markers classify only newly rebuilt regions and new paths outside the active list", async () => {
	await file("f", "first\ncontext one\ncontext two\nlast\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("f", "FIRST\ncontext one\ncontext two\nlast\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	await changeOwner(files()[0], "previous-owner");
	const native = await readFile(repo.index);
	await writeFile(join(repo.gitDir, "MERGE_HEAD"), `${await git("rev-parse", "HEAD")}\n`);
	await file("f", "FIRST\ncontext one\ncontext two\nLAST\n");
	await file("new", "new during merge\n");
	const merged = await observeChangelists(repo, store);
	let snapshot = files().find((entry) => entry.path === "f") as StoredFile;
	expect(snapshot.units.map((unit) => unit.listId)).toEqual([
		"previous-owner",
		GIT_STAGING_UNASSIGNED_LIST_ID,
	]);
	expect(
		files()
			.find((entry) => entry.path === "new")
			?.units.every((unit) => unit.listId === GIT_STAGING_UNASSIGNED_LIST_ID && !unit.needsReview),
	).toBe(true);
	expect(merged.active_list_id).not.toBe(GIT_STAGING_UNASSIGNED_LIST_ID);
	expect(await observeChangelists(repo, store)).toEqual(merged);
	await rm(join(repo.gitDir, "MERGE_HEAD"));
	await file("f", "FIRST\ncontext one\ncontext two\nLAST edited\n");
	await observeChangelists(repo, store);
	snapshot = store.loadFile(snapshot.fileId) as StoredFile;
	expect(snapshot.units.map((unit) => unit.listId)).toEqual([
		"previous-owner",
		merged.active_list_id,
	]);
	expect(
		files()
			.find((entry) => entry.path === "new")
			?.units.every((unit) => unit.listId === GIT_STAGING_UNASSIGNED_LIST_ID),
	).toBe(true);
	expect(await readFile(repo.index)).toEqual(native);
});

for (const marker of ["created", "removed", "bytes"] as const) {
	test(`a merge marker ${marker} after draft writes causes bounded observation retry`, async () => {
		await file("f", "base\n");
		await git("add", ".");
		await git("commit", "--quiet", "-m", "Base");
		await file("f", "first local\n");
		const { repo, store } = await setup();
		await observeChangelists(repo, store);
		const expected = store.state();
		const merge = join(repo.gitDir, "MERGE_HEAD");
		if (marker !== "created") await writeFile(merge, "first-marker\n");
		await file("f", "second local\n");
		const putFiles = store.putFiles.bind(store);
		let changes = 0;
		const put = spyOn(store, "putFiles").mockImplementation(async (...args) => {
			await putFiles(...args);
			if (++changes !== 1) return;
			if (marker === "removed") await rm(merge);
			else await writeFile(merge, "second-marker\n");
		});
		restores.push(() => put.mockRestore());
		const result = await observeChangelists(repo, store);
		expect(changes).toBe(2);
		expect(result.generation).toBe(expected.generation + 1);
		expect(files()[0].units[0].listId).toBe(
			marker === "removed" ? expected.active_list_id : GIT_STAGING_UNASSIGNED_LIST_ID,
		);
	});
}

test("merge marker reads use the actual Git directory and reject symlinks, limits and projection mode", async () => {
	await git("commit", "--allow-empty", "--quiet", "-m", "Base");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const actual = join(root, "actual-git-dir");
	await mkdir(actual);
	await writeFile(join(actual, "MERGE_HEAD"), "actual-marker\n");
	expect(await readChangelistMergeHead({ ...repo, gitDir: actual })).toEqual(
		Buffer.from("actual-marker\n"),
	);
	const marker = join(repo.gitDir, "MERGE_HEAD");
	await symlink(join(actual, "MERGE_HEAD"), marker);
	await expect(readChangelistMergeHead(repo)).rejects.toMatchObject({ code: "ELOOP" });
	await rm(marker);
	await writeFile(marker, Buffer.alloc(OBSERVATION_LIMITS.maxMergeHeadBytes + 1));
	await expect(readChangelistMergeHead(repo)).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
	await writeFile(marker, "merge-marker\n");
	const state = store.state();
	await expect(
		observeChangelists(repo, store, undefined, {
			operationId: "strict",
			sourceObservationId: state.observation_id as string,
			mappings: new Map(),
			selectedUnitIds: new Set(),
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_REPOSITORY_BUSY" });
	expect(store.state()).toEqual(state);
});

test("a merge marker appearing at the no-op exit is rechecked without moving untouched units", async () => {
	await git("commit", "--allow-empty", "--quiet", "-m", "Base");
	await file("f", "local edit\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	await changeOwner(files()[0], "untouched-owner");
	const previous = files()[0];
	const original = processModule.stagingGit;
	let attrs = 0;
	const staging = spyOn(processModule, "stagingGit").mockImplementation(async (...args) => {
		const result = await original(...args);
		if (args[1][0] === "check-attr" && ++attrs === 2)
			await writeFile(join(repo.gitDir, "MERGE_HEAD"), "merge appeared\n");
		return result;
	});
	restores.push(() => staging.mockRestore());
	const { metrics } = await measuredObservation(repo, store);
	expect(metrics.attempts).toBe(2);
	expect(files()[0]).toEqual(previous);
	expect(reservedList()).toBeNull();
});

test("external HEAD changes classify unknown paths conservatively while unchanged file bases allow ordinary edits", async () => {
	await file("f", "first\ncontext one\ncontext two\nlast\n");
	await file("other", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("f", "FIRST\ncontext one\ncontext two\nLAST\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	await changeOwner(files()[0], "previous-owner");
	const active = store.state().active_list_id;
	await file("other", "external commit\n");
	await git("add", "--", "other");
	await git("commit", "--quiet", "-m", "Unrelated external HEAD");
	await file("f", "FIRST edited\ncontext one\ncontext two\nLAST\n");
	await file("unknown", "origin not proven\n");
	await observeChangelists(repo, store);
	const known = files().find((entry) => entry.path === "f") as StoredFile;
	expect(known.units.map((unit) => unit.listId)).toEqual([active, "previous-owner"]);
	expect(
		files()
			.find((entry) => entry.path === "unknown")
			?.units.every((unit) => unit.listId === GIT_STAGING_UNASSIGNED_LIST_ID),
	).toBe(true);
});

test("binary edits and permission changes have independent owners", async () => {
	await file("f", Buffer.from("base\0bytes"));
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("f", Buffer.from("local\0bytes"));
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const kernel = new IndependentGitStagingKernel(root, "observer-test");
	let state = store.state();
	const created = await kernel.action({
		action: "create",
		name: "Binary owner",
		expectedGeneration: state.generation,
		observationId: state.observation_id as string,
	});
	state = store.state();
	await kernel.action({
		action: "move",
		fromListId: state.active_list_id,
		toListId: created.listId as string,
		all: true,
		expectedGeneration: state.generation,
		observationId: state.observation_id as string,
	});
	await chmod(join(root, "f"), 0o755);
	await observeChangelists(repo, store);
	let snapshot = files()[0];
	expect(snapshot.units.find((unit) => unit.kind === "binary")?.listId).toBe(created.listId);
	expect(snapshot.units.find((unit) => unit.kind === "mode")?.listId).toBe(state.active_list_id);
	await file("f", Buffer.from("new local\0bytes"));
	await observeChangelists(repo, store);
	snapshot = files()[0];
	expect(
		snapshot.units.every((unit) => unit.listId === state.active_list_id && !unit.needsReview),
	).toBe(true);
});

test("text owned by multiple lists cannot collapse into one atomic item", async () => {
	const { repo, store, previous, expected } = await externalHeadConflict(true, true);
	await file("conflict", Buffer.from("binary\0conversion"));
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state().observation_id).toBe(expected.observation_id);
	expect(files()).toEqual(previous);
});

test("repeated merge-marker changes exhaust the bounded retry without publishing an empty unassigned list", async () => {
	await git("commit", "--allow-empty", "--quiet", "-m", "Base");
	await file("f", "first local\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const expected = store.state();
	const previous = files();
	const marker = join(repo.gitDir, "MERGE_HEAD");
	await writeFile(marker, "merge-0\n");
	await file("f", "second local\n");
	const putFiles = store.putFiles.bind(store);
	let attempts = 0;
	const put = spyOn(store, "putFiles").mockImplementation(async (...args) => {
		await putFiles(...args);
		await writeFile(marker, `merge-${++attempts}\n`);
	});
	restores.push(() => put.mockRestore());
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_CONCURRENT_CHANGE",
	});
	expect(attempts).toBe(3);
	expect(store.state()).toMatchObject({
		state: "incomplete",
		observation_id: expected.observation_id,
		generation: expected.generation,
	});
	expect(files()).toEqual(previous);
	expect(reservedList()).toMatchObject({ archived: 1 });
	expect(visibleReservedList()).toBeNull();
});

for (const count of [300, 815]) {
	test(`${count} changed files use a constant Git command budget and no-op refresh writes no WAL`, async () => {
		await Promise.all(
			Array.from({ length: count }, (_, i) => file(`f${i}.txt`, `base ${i}\ncontext\n`)),
		);
		await git("add", ".");
		await git("commit", "--quiet", "-m", "Base");
		await Promise.all(
			Array.from({ length: count }, (_, i) => file(`f${i}.txt`, `edit ${i}\ncontext\n`)),
		);
		const { repo, store } = await setup();
		const native = await readFile(repo.index),
			head = await git("rev-parse", "HEAD");
		let commands = 0;
		processModule.observeStagingChildren((_pid, running) => {
			if (running) commands++;
		});
		const first = await observeChangelists(repo, store);
		expect(files()).toHaveLength(count);
		expect(commands).toBeLessThanOrEqual(32);
		const firstCount = commands;
		const wal = await lstat(`${store.path}-wal`);
		const writes = (store.db.query("SELECT total_changes() n").get() as { n: number }).n;
		const versions = files().map((entry) => entry.versionId);
		commands = 0;
		const oldLoads = spyOn(store, "loadFile");
		restores.push(() => oldLoads.mockRestore());
		const { state: second, metrics } = await measuredObservation(repo, store);
		expect(second).toEqual(first);
		expect(oldLoads).not.toHaveBeenCalled();
		expect(metrics).toMatchObject({
			outcome: "reused",
			loadedSnapshots: 0,
			snapshotReadBytes: 0,
			rawReadBytes: 0,
			blobReadBytes: 0,
			canonicalizedPaths: 0,
			ownershipComputations: 0,
			putFileAttempts: 0,
			writtenSnapshots: 0,
			reusedMappings: 0,
		});
		expect(metrics.gitProcesses).toBe(commands);
		expect(commands).toBeLessThanOrEqual(24);
		expect(files().map((entry) => entry.versionId)).toEqual(versions);
		expect((store.db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes);
		const afterWal = await lstat(`${store.path}-wal`);
		expect({ size: afterWal.size, mtime: afterWal.mtimeMs }).toEqual({
			size: wal.size,
			mtime: wal.mtimeMs,
		});
		expect(await readFile(repo.index)).toEqual(native);
		expect(await git("rev-parse", "HEAD")).toBe(head);
		expect(await readdir(join(repo.directory, "operations"))).toEqual([]);
		const unchangedCount = commands;
		commands = 0;
		await assertChangelistSourcesCurrent(repo, store, {
			fileIds: files().map((entry) => entry.fileId),
		});
		expect(commands).toBeLessThanOrEqual(16);
		expect(store.state()).toEqual(first);
		expect((store.db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes);
		const verifiedWal = await lstat(`${store.path}-wal`);
		expect({ size: verifiedWal.size, mtime: verifiedWal.mtimeMs }).toEqual({
			size: wal.size,
			mtime: wal.mtimeMs,
		});
		expect(await readFile(repo.index)).toEqual(native);
		console.info(
			`observer Git budget (${count} files): initial=${firstCount}, unchanged=${unchangedCount}, verify=${commands}`,
		);
	});
}

test("one changed text file alone is loaded, normalized, recalculated and persisted", async () => {
	const count = 40;
	await Promise.all(
		Array.from({ length: count }, (_, index) => file(`file-${index}`, "head\nbody\nfoot\n")),
	);
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await Promise.all(
		Array.from({ length: count }, (_, index) => file(`file-${index}`, "head\nowned\nfoot\n")),
	);
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const previous = files();
	const before = store.state();
	const load = spyOn(store, "loadFile"),
		put = spyOn(store, "putFiles"),
		copy = spyOn(store, "copyFiles");
	restores.push(
		() => load.mockRestore(),
		() => put.mockRestore(),
		() => copy.mockRestore(),
	);
	await file("file-17", "head\nnew owned\nfoot\n");
	const { state, metrics } = await measuredObservation(repo, store);
	expect(state.generation).toBe(before.generation + 1);
	expect(metrics).toMatchObject({
		outcome: "published",
		loadedSnapshots: 1,
		canonicalizedPaths: 1,
		ownershipComputations: 1,
		writtenSnapshots: 1,
		putFileAttempts: 1,
		reusedMappings: count - 1,
		rawReadBytes: Buffer.byteLength("head\nnew owned\nfoot\n"),
	});
	expect(load).toHaveBeenCalledTimes(1);
	expect(put).toHaveBeenCalledTimes(1);
	expect(copy).toHaveBeenCalledTimes(1);
	const current = files();
	for (const old of previous) {
		const next = current.find((entry) => entry.fileId === old.fileId) as StoredFile;
		if (old.path === "file-17") {
			expect(next.versionId).not.toBe(old.versionId);
			expect(next.ownership?.units[0].id).toBe(old.ownership?.units[0].id);
			expect(next.ownership?.workLines[0].id).toBe(old.ownership?.workLines[0].id);
			expect(next.ownership?.workLines[2].id).toBe(old.ownership?.workLines[2].id);
			expect(next.ownership?.units[0].needsReview).toBe(false);
			expect(materializeTextOwnership(next.ownership as NonNullable<StoredFile["ownership"]>)).toBe(
				"head\nnew owned\nfoot\n",
			);
		} else expect(next).toEqual(old);
	}
});

test("incremental results equal complete normalization for mixed text, deletion and rename edits", async () => {
	const initial = {
		repeated: "head\nx\nx\nfoot\n",
		deleted: "head\nold\nfoot\n",
		mode: "head\nold\nfoot\n",
		crlf: "head\r\nold\r\nfoot",
		source: "first\nsecond\nthird\nfourth\n",
		recovered: "head\nold\nfoot\n",
		unchanged: "head\nold\nfoot\n",
	};
	await Promise.all(Object.entries(initial).map(([path, content]) => file(path, content)));
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("repeated", "head\nx\nx\nx\nfoot\n");
	await file("deleted", "head\nfoot\n");
	await file("mode", "head\nowned\nfoot\n");
	await file("crlf", "head\r\nowned\r\nfoot");
	await file("source", "first\nowned\nthird\nfourth\n");
	await file("recovered", "head\nowned\nfoot\n");
	await file("unchanged", "head\nowned\nfoot\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const previous = files();
	const baseline = store.state();
	const keepPrevious = spyOn(store, "collect").mockResolvedValue();
	restores.push(() => keepPrevious.mockRestore());
	await file("repeated", "head\nx\nx\nfoot\n");
	await file("deleted", "head\nnew\nfoot\n");
	await chmod(join(root, "mode"), 0o755);
	await file("crlf", "head\r\nupdated\r\nfoot");
	await rename(join(root, "source"), join(root, "destination"));
	await file("recovered", initial.recovered);
	await file("new", "new addition\n");
	const incremental = await measuredObservation(repo, store);
	const incrementalFiles = files();
	expect(incremental.metrics.canonicalizedPaths).toBeGreaterThanOrEqual(6);
	expect(incremental.metrics.canonicalizedPaths).toBeLessThanOrEqual(8);
	expect(incremental.metrics.reusedMappings).toBe(1);
	await store.transaction(() =>
		store.db
			.query("UPDATE workspace_state SET observation_id=?,state='incomplete' WHERE id=1")
			.run(baseline.observation_id),
	);
	const complete = await measuredObservation(repo, store);
	const completeFiles = files();
	expect(complete.metrics.canonicalizedPaths).toBeGreaterThanOrEqual(7);
	const oldIds = new Set(
		previous.flatMap((entry) => [
			entry.fileId,
			...entry.units.map((unit) => unit.id),
			...(entry.ownership?.baseLineIds ?? []),
			...(entry.ownership?.workLines.map((line) => line.id) ?? []),
		]),
	);
	const normalized = (entries: StoredFile[]) =>
		entries.map((entry) => {
			const replacements = new Map<string, string>();
			if (!oldIds.has(entry.fileId)) replacements.set(entry.fileId, "new-file");
			const units = [...entry.units].sort(
				(a, b) =>
					a.baseStart - b.baseStart || a.workStart - b.workStart || a.kind.localeCompare(b.kind),
			);
			units.forEach((unit, index) => {
				if (!oldIds.has(unit.id)) replacements.set(unit.id, `unit-${index}`);
			});
			entry.ownership?.workLines.forEach((line, index) => {
				if (!oldIds.has(line.id)) replacements.set(line.id, `line-${index}`);
			});
			return JSON.parse(
				JSON.stringify({ ...entry, units, versionId: undefined }, (_key, value) =>
					typeof value === "string" ? (replacements.get(value) ?? value) : value,
				),
			);
		});
	expect(normalized(completeFiles)).toEqual(normalized(incrementalFiles));
	for (const entry of completeFiles) {
		if (!entry.ownership) continue;
		const other = incrementalFiles.find((candidate) => candidate.path === entry.path)?.ownership;
		if (!other) throw new Error("Expected matching text ownership");
		expect(materializeTextOwnership(entry.ownership)).toBe(materializeTextOwnership(other));
		for (const group of new Set(entry.ownership.units.map((unit) => unit.groupId)))
			expect(materializeTextOwnership(entry.ownership, { groupIds: [group] })).toBe(
				materializeTextOwnership(other, { groupIds: [group] }),
			);
	}
});

test("lightweight metadata checks snapshot byte budgets and missing snapshots without loading bodies", async () => {
	await file("tracked", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const old = files()[0];
	const metadata = store.fileIds()[0];
	expect(metadata).toMatchObject({
		base_size: old.baseBytes.length,
		work_size: old.workBytes.length,
		has_ownership: 1,
	});
	expect(metadata.ownership_size).toBe(Buffer.byteLength(JSON.stringify(old.ownership)));
	const load = spyOn(store, "loadFile");
	restores.push(() => load.mockRestore());
	await store.transaction(() =>
		store.db
			.query("UPDATE file_snapshots SET work_bytes=zeroblob(?) WHERE version_id=?")
			.run(OBSERVATION_LIMITS.maxFileBytes + 1, old.versionId),
	);
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(load).not.toHaveBeenCalled();
	store.db.exec("PRAGMA foreign_keys=OFF");
	store.db.query("DELETE FROM file_snapshots WHERE version_id=?").run(old.versionId);
	store.db.exec("PRAGMA foreign_keys=ON");
	expect(() => store.fileIds()).toThrow("Missing or invalid file snapshot metadata");
});

test("reused mappings remain private when an unchanged source changes during batch copying", async () => {
	await file("changed", "base\n");
	await file("retained", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("changed", "owned\n");
	await file("retained", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const before = store.state(),
		versions = store.fileIds();
	await file("changed", "new owned\n");
	const copy = store.copyFiles.bind(store);
	let changes = 0,
		failedDraft = "";
	const spy = spyOn(store, "copyFiles").mockImplementation(async (...args) => {
		const count = await copy(...args);
		failedDraft = args[0];
		await file("retained", `modified while copying reused mappings ${++changes}\n`);
		expect(store.state()).toEqual(before);
		expect(store.fileIds()).toEqual(versions);
		return count;
	});
	restores.push(() => spy.mockRestore());
	const { state, metrics } = await measuredObservation(repo, store);
	expect(metrics).toMatchObject({ attempts: 2, canonicalizedPaths: 3, writtenSnapshots: 3 });
	expect(changes).toBe(1);
	expect(store.db.query("SELECT complete FROM observations WHERE id=?").get(failedDraft)).toEqual({
		complete: 0,
	});
	expect(state).toMatchObject({ state: "ready", generation: before.generation + 1 });
	expect(files().map((entry) => [entry.path, entry.workBytes.toString()])).toEqual([
		["changed", "new owned\n"],
		["retained", "modified while copying reused mappings 1\n"],
	]);
});

test("recovering an incomplete observation revalidates all paths and republishes retained versions", async () => {
	await file("tracked", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const before = store.state(),
		versions = store.fileIds();
	await store.mark("incomplete", "Fixture retry");
	const { state, metrics } = await measuredObservation(repo, store);
	expect(metrics).toMatchObject({
		outcome: "published",
		canonicalizedPaths: 1,
		loadedSnapshots: 0,
		writtenSnapshots: 0,
		reusedMappings: 1,
	});
	expect(state.state).toBe("ready");
	expect(state.generation).toBe(before.generation + 1);
	expect(state.observation_id).not.toBe(before.observation_id);
	expect(store.fileIds()).toEqual(versions);
});

test("object-check failures propagate when an edited observation actually reuses old objects", async () => {
	await file("tracked", "base\n");
	await file("edited", "another base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("tracked", "owned\n");
	await file("edited", "another owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const before = store.state();
	const run = processModule.stagingGit;
	const spy = spyOn(processModule, "stagingGit").mockImplementation(async (...args) => {
		if (args[1][0] === "cat-file")
			throw new processModule.GitStagingKernelError(
				"GIT_STAGING_TIMEOUT",
				"Fixture object deadline",
			);
		return run(...args);
	});
	restores.push(() => spy.mockRestore());
	const noop = await measuredObservation(repo, store);
	expect(noop.state).toEqual(before);
	expect(spy.mock.calls.some((call) => call[1][0] === "cat-file")).toBe(false);
	await file("edited", "new owned\n");
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_TIMEOUT",
	});
	expect(store.state().observation_id).toBe(before.observation_id);
	expect(store.state().state).toBe("incomplete");
});

test("a no-op keeps missing work objects untouched while preview and subsequent reuse remain safe", async () => {
	await file("tracked", "base\n");
	await file("edited", "another base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("tracked", "owned\n");
	await file("edited", "another owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const old = files().find((entry) => entry.path === "tracked") as StoredFile;
	if (!old.workOid) throw new Error("Expected loose work blob");
	const objectPath = join(repo.gitDir, "objects", old.workOid.slice(0, 2), old.workOid.slice(2));
	await rm(objectPath);
	const before = await sourceVerificationEvidence();
	const noop = await measuredObservation(repo, store);
	expect(noop.metrics).toMatchObject({
		outcome: "reused",
		gitProcesses: 21,
		loadedSnapshots: 0,
		writtenSnapshots: 0,
		canonicalizedPaths: 0,
	});
	expect(await sourceVerificationEvidence()).toEqual(before);
	expect(await lstat(objectPath).catch(() => null)).toBeNull();
	const preview = await new IndependentGitStagingKernel(root, "observer-test").diff(
		store.state().active_list_id,
		{ path: "tracked" },
	);
	expect(preview.diff).toContain("+owned");
	expect(preview.diff).toContain("-base");
	expect(await lstat(objectPath).catch(() => null)).toBeNull();
	await file("edited", "new owned\n");
	const changed = await measuredObservation(repo, store);
	expect(changed.metrics).toMatchObject({
		canonicalizedPaths: 2,
		loadedSnapshots: 1,
		writtenSnapshots: 1,
		reusedMappings: 1,
	});
	expect(files().find((entry) => entry.fileId === old.fileId)).toEqual(old);
	expect(await git("cat-file", "-p", old.workOid)).toBe("owned");
});

test("commit rebuilds selected content after a no-op leaves its old work object missing", async () => {
	await file("tracked", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const old = files()[0];
	if (!old.workOid) throw new Error("Expected loose work blob");
	await rm(join(repo.gitDir, "objects", old.workOid.slice(0, 2), old.workOid.slice(2)));
	const { state } = await measuredObservation(repo, store);
	const result = await new IndependentGitStagingKernel(root, "observer-test").action({
		action: "commit",
		listId: state.active_list_id,
		expectedGeneration: state.generation,
		observationId: state.observation_id as string,
		message: "Selected changes",
		identity: { name: "Fixture", email: "fixture@example.test" },
	});
	expect(result.outcome).toBe("applied");
	expect(await git("show", "HEAD:tracked")).toBe("owned");
	expect(await readFile(join(root, "tracked"), "utf8")).toBe("owned\n");
	expect(files()).toEqual([]);
});

async function sourceVerificationEvidence() {
	if (!store) throw new Error("Expected store");
	const database = await readFile(store.path);
	const wal = await readFile(`${store.path}-wal`);
	const databaseInfo = await lstat(store.path),
		walInfo = await lstat(`${store.path}-wal`);
	return {
		state: store.state(),
		database,
		wal,
		databaseIdentity: `${databaseInfo.ino}:${databaseInfo.mtimeMs}:${databaseInfo.size}`,
		walIdentity: `${walInfo.ino}:${walInfo.mtimeMs}:${walInfo.size}`,
	};
}

test("source verification hashes changed bytes even with the same path size and mtime", async () => {
	await file("f", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	const time = new Date("2020-01-01T00:00:00.000Z");
	await file("f", "AAAA\n");
	await utimes(join(root, "f"), time, time);
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const selected = files()[0],
		before = await sourceVerificationEvidence();
	await file("f", "BBBB\n");
	await utimes(join(root, "f"), time, time);
	expect((await lstat(join(root, "f"))).mtimeMs).toBe(time.getTime());
	await expect(
		assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] }),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	expect(await sourceVerificationEvidence()).toEqual(before);
	expect(await readFile(join(root, "f"), "utf8")).toBe("BBBB\n");
});

test("source verification rechecks external filter output without changing the observation", async () => {
	await file(".gitattributes", "*.custom filter=external\n");
	await git("config", "filter.external.clean", `cat '${join(root, ".git", "filter-output")}'`);
	await writeFile(join(root, ".git", "filter-output"), "FIRST\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("input.custom", "unchanged input\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const selected = files()[0],
		before = await sourceVerificationEvidence();
	await assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] });
	await writeFile(join(root, ".git", "filter-output"), "SECOND\n");
	await expect(
		assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] }),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	expect(await sourceVerificationEvidence()).toEqual(before);
});

test("source verification checks both the rename destination and the old path tombstone", async () => {
	const base = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
	await file("source", base);
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await rename(join(root, "source"), join(root, "destination"));
	await file("destination", base.replace("line 3\n", "changed\n"));
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const selected = files()[0],
		before = await sourceVerificationEvidence();
	expect(selected.basePath).toBe("source");
	await assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] });
	await file("source", base);
	await expect(
		assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] }),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	await rm(join(root, "source"));
	await rename(join(root, "destination"), join(root, "third"));
	await expect(
		assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] }),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	expect(await sourceVerificationEvidence()).toEqual(before);
});

test("source verification catches edits while its canonical index is being prepared", async () => {
	await file("f", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("f", "first edit\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const selected = files()[0],
		before = await sourceVerificationEvidence();
	const original = processModule.stagingGit;
	let injected = false;
	const spy = spyOn(processModule, "stagingGit").mockImplementation(async (cwd, args, options) => {
		const result = await original(cwd, args, options);
		if (!injected && args[0] === "add") {
			injected = true;
			await file("f", "late change\n");
		}
		return result;
	});
	restores.push(() => spy.mockRestore());
	await expect(
		assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] }),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	expect(await sourceVerificationEvidence()).toEqual(before);
});

test("source verification keeps selection narrow and compares normalized rather than raw bytes", async () => {
	await file(".gitattributes", "*.txt text eol=lf\n");
	await file("selected.txt", "base\n");
	await file("other", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("selected.txt", "selected change\n");
	await file("other", "observed change\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const selected = files().find((entry) => entry.path === "selected.txt") as StoredFile;
	const before = await sourceVerificationEvidence(),
		native = await readFile(repo.index);
	await file("selected.txt", "selected change\r\n");
	await file("other", "later unrelated change\n");
	await assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] });
	expect(await sourceVerificationEvidence()).toEqual(before);
	expect(await readFile(repo.index)).toEqual(native);
	expect(await readFile(join(root, "selected.txt"), "utf8")).toBe("selected change\r\n");
});

test("source verification rejects mode drift and keeps file byte limits", async () => {
	await file("f", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("f", "changed\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const selected = files()[0],
		before = await sourceVerificationEvidence();
	await chmod(join(root, "f"), 0o755);
	await expect(
		assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] }),
	).rejects.toMatchObject({ code: "GIT_STAGING_STALE_VERSION" });
	await chmod(join(root, "f"), 0o644);
	await file("f", Buffer.alloc(OBSERVATION_LIMITS.maxFileBytes + 1));
	await expect(
		assertChangelistSourcesCurrent(repo, store, { fileIds: [selected.fileId] }),
	).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
	expect(await sourceVerificationEvidence()).toEqual(before);
});

test("commit projection forwards its producer fence to publication and error state updates", async () => {
	await file("f", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("f", "first edit\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const observationId = store.state().observation_id as string;
	await file("f", "second edit\n");
	const failure = new Error("Publication stopped by the test");
	const publish = spyOn(store, "publish").mockRejectedValue(failure);
	const mark = spyOn(store, "mark").mockResolvedValue(undefined);
	restores.push(
		() => publish.mockRestore(),
		() => mark.mockRestore(),
	);
	const projection = {
		operationId: "operation",
		mappings: new Map(),
		selectedUnitIds: new Set<string>(),
		sourceObservationId: observationId,
	};
	await expect(
		observeChangelists(repo, store, undefined, { ...projection, fenceToken: "producer-fence" }),
	).rejects.toBe(failure);
	expect(publish.mock.calls[0]?.[5]).toBe("producer-fence");
	expect(mark).toHaveBeenCalledWith("incomplete", failure.message, {
		operationId: "operation",
		fenceToken: "producer-fence",
	});
	mark.mockClear();
	await expect(observeChangelists(repo, store, undefined, projection)).rejects.toBe(failure);
	expect(mark).not.toHaveBeenCalled();
});

test("internal editing of an added file changes text ownership independently from its creation unit", async () => {
	await git("commit", "--allow-empty", "--quiet", "-m", "Base");
	await file("added.txt", "start\nx\nx\nend\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	await changeOwner(files()[0], "owner-A");
	const previous = files()[0];
	const active = store.state().active_list_id;
	const native = await readFile(repo.index);
	await file("added.txt", "start\nx\nend\n");
	await observeChangelists(repo, store);
	const snapshot = files()[0];
	expect(snapshot.fileId).toBe(previous.fileId);
	expect(
		snapshot.units
			.filter((unit) => unit.kind === "text")
			.every((unit) => unit.listId === active && !unit.needsReview),
	).toBe(true);
	expect(snapshot.units.find((unit) => unit.kind === "create")?.listId).toBe("owner-A");
	if (!snapshot.ownership || !previous.ownership) throw new Error("Expected text ownership");
	expect(snapshot.ownership.units[0].id).toBe(previous.ownership.units[0].id);
	expect(snapshot.ownership.workLines[1].id).toBe(previous.ownership.workLines[1].id);
	expect(materializeTextOwnership(snapshot.ownership)).toBe("start\nx\nend\n");
	expect(materializeTextOwnership(snapshot.ownership, { groupIds: ["owner-A"] })).toBe("");
	expect(materializeTextOwnership(snapshot.ownership, { groupIds: [active] })).toBe(
		"start\nx\nend\n",
	);
	const state = store.state();
	const writes = (store.db.query("SELECT total_changes() n").get() as { n: number }).n;
	await observeChangelists(repo, store);
	expect(store.state()).toEqual(state);
	expect(files()[0].versionId).toBe(snapshot.versionId);
	expect(files()[0].ownership).toEqual(snapshot.ownership);
	expect((store.db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes);
	expect(await readFile(repo.index)).toEqual(native);
});

test("duplicate boundary insertion assigns the rebuilt region to the active owner", async () => {
	await git("commit", "--allow-empty", "--quiet", "-m", "Base");
	await file("added.txt", "x\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	await changeOwner(files()[0], "owner-A");
	const previous = files()[0];
	const active = store.state().active_list_id;
	await file("added.txt", "x\nx\n");
	await observeChangelists(repo, store);
	const snapshot = files()[0];
	if (!snapshot.ownership || !previous.ownership) throw new Error("Expected text ownership");
	expect(snapshot.ownership.units[0]).toMatchObject({
		id: previous.ownership.units[0].id,
		groupId: active,
		needsReview: false,
		sourceGroupIds: [active],
	});
	expect(snapshot.ownership.workLines[0].id).toBe(previous.ownership.workLines[0].id);
	expect(materializeTextOwnership(snapshot.ownership)).toBe("x\nx\n");
	expect(materializeTextOwnership(snapshot.ownership, { groupIds: ["owner-A"] })).toBe("");
	expect(materializeTextOwnership(snapshot.ownership, { groupIds: [active] })).toBe("x\nx\n");
	const state = store.state();
	await observeChangelists(repo, store);
	expect(store.state()).toEqual(state);
	expect(files()[0].ownership).toEqual(snapshot.ownership);
});

test("Git rename preserves file identity while edited text follows the current active list", async () => {
	const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
	await file("source.txt", base);
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("source.txt", base.replace("line 3\n", "owned A\n"));
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const original = files()[0];
	await changeOwner(original, "owner-A");
	await rename(join(root, "source.txt"), join(root, "destination.txt"));
	const moved = base.replace("line 3\n", "owned A edited\n").replace("line 25\n", "new B\n");
	await file("destination.txt", moved);
	await observeChangelists(repo, store);
	const result = files();
	expect(result).toHaveLength(1);
	expect(result[0]).toMatchObject({
		fileId: original.fileId,
		path: "destination.txt",
		basePath: "source.txt",
	});
	expect(result[0].units.find((unit) => unit.kind === "rename")).toMatchObject({
		oldPath: "source.txt",
		listId: store.state().active_list_id,
	});
	expect(
		result[0].ownership?.units.find((unit) =>
			unit.insertedLines.join("").includes("owned A edited"),
		)?.groupId,
	).toBe(store.state().active_list_id);
	expect(
		result[0].ownership?.units.find((unit) => unit.insertedLines.join("").includes("new B"))
			?.groupId,
	).toBe(store.state().active_list_id);
	expect(
		materializeTextOwnership(result[0].ownership as NonNullable<StoredFile["ownership"]>),
	).toBe(moved);
	const state = store.state();
	await observeChangelists(repo, store);
	expect(store.state()).toEqual(state);
	expect(files()[0].versionId).toBe(result[0].versionId);
	// A proven existing rename survives further editing even below Git's initial 50% threshold.
	await file("destination.txt", "completely rewritten after a proven move\n");
	await observeChangelists(repo, store);
	expect(files()[0]).toMatchObject({
		fileId: original.fileId,
		basePath: "source.txt",
		path: "destination.txt",
	});
});

test("Git pairing cannot overwrite an already independent destination identity", async () => {
	const base = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
	await file("source", base);
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("destination", base.replace("line 10\n", "destination change\n"));
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const previousDestination = files()[0];
	await changeOwner(previousDestination, "destination-owner");
	await rm(join(root, "source"));
	await observeChangelists(repo, store);
	expect(files()).toHaveLength(2);
	const destination = files().find((entry) => entry.path === "destination");
	expect(destination?.fileId).toBe(previousDestination.fileId);
	expect(
		destination?.units.every((unit) => unit.listId === "destination-owner" && !unit.needsReview),
	).toBe(true);
	expect(
		files()
			.flatMap((entry) => entry.units)
			.some((unit) => unit.kind === "rename"),
	).toBe(false);
});

test("duplicate rename candidates remain independent deletes and additions", async () => {
	const content = "same source\nshared context\n";
	await file("source-a", content);
	await file("source-b", content);
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await rm(join(root, "source-a"));
	await rm(join(root, "source-b"));
	await file("destination-a", content);
	await file("destination-b", content);
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	expect(files()).toHaveLength(4);
	expect(
		files()
			.flatMap((entry) => entry.units)
			.some((unit) => unit.kind === "rename"),
	).toBe(false);
	expect(
		files()
			.flatMap((entry) => entry.units)
			.every((unit) => !unit.needsReview && !unit.reviewReason),
	).toBe(true);
	const marked = files().find((entry) => entry.path === "destination-a");
	if (!marked?.ownership) throw new Error("Expected marked text ownership");
	const active = store.state().active_list_id;
	expect(marked.ownership.units[0].sourceGroupIds).toEqual([active]);
	const state = store.state();
	await observeChangelists(repo, store);
	expect(store.state()).toEqual(state);
	expect(files().find((entry) => entry.path === "destination-a")?.ownership).toEqual(
		marked.ownership,
	);
	await file("destination-a", "same source\nedited context\n");
	await observeChangelists(repo, store);
	const edited = files().find((entry) => entry.path === "destination-a");
	if (!edited?.ownership) throw new Error("Expected edited text ownership");
	expect(edited.fileId).toBe(marked.fileId);
	expect(edited.ownership.units[0]).toMatchObject({
		id: marked.ownership.units[0].id,
		groupId: active,
		needsReview: false,
		sourceGroupIds: [active],
	});
	expect(edited.ownership.workLines[0].id).toBe(marked.ownership.workLines[0].id);
	expect(materializeTextOwnership(edited.ownership, { groupIds: [active] })).toBe(
		"same source\nedited context\n",
	);
});

test("standard normalization, binary bytes, symlinks and literal special paths stay exact", async () => {
	await file(".gitattributes", "*.txt text eol=lf\n");
	await file("base.txt", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	const name = ":(glob)* 中文\t换行\n.txt";
	const raw = "first\r\nsecond\r\n";
	await file(name, raw);
	await file("binary", Buffer.from([0, 1, 255, 13, 10]));
	await symlink("base.txt", join(root, "link"));
	const { repo, store } = await setup();
	const native = await readFile(repo.index);
	await observeChangelists(repo, store);
	expect(
		files()
			.find((entry) => entry.path === name)
			?.workBytes.toString(),
	).toBe("first\nsecond\n");
	expect(files().find((entry) => entry.path === "binary")?.workBytes).toEqual(
		Buffer.from([0, 1, 255, 13, 10]),
	);
	expect(
		files()
			.find((entry) => entry.path === "link")
			?.workBytes.toString(),
	).toBe("base.txt");
	expect(await readFile(join(root, name), "utf8")).toBe(raw);
	expect(await readFile(repo.index)).toEqual(native);
});

test("custom clean filters still run and produce indivisible canonical content", async () => {
	await file(".gitattributes", "*.custom filter=normalize\n");
	await git("config", "filter.normalize.clean", "tr a-z A-Z");
	await file("base", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("file.custom", "lowercase\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	expect(files()[0].workBytes.toString()).toBe("LOWERCASE\n");
	expect(files()[0].ownership).toBeNull();
	expect(
		files()[0]
			.units.map((unit) => unit.kind)
			.sort(),
	).toEqual(["binary", "create"]);
	expect(await readFile(join(root, "file.custom"), "utf8")).toBe("lowercase\n");
});

test("changed normalization configuration invalidates identity reuse", async () => {
	await file(".gitattributes", "*.custom filter=normalize\n");
	await git("config", "filter.normalize.clean", "tr a-z A-Z");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("file.custom", "Mixed\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	expect(files()[0].workBytes.toString()).toBe("MIXED\n");
	await git("config", "filter.normalize.clean", "tr A-Z a-z");
	await observeChangelists(repo, store);
	expect(files()[0].workBytes.toString()).toBe("mixed\n");
});

test("oversized raw and clean-filtered objects preserve the preceding complete observation", async () => {
	await file("base", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("base", "changed\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const complete = store.state();
	await file("oversized", Buffer.alloc(OBSERVATION_LIMITS.maxFileBytes + 1, 65));
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state().observation_id).toBe(complete.observation_id);
	expect(files().map((entry) => entry.path)).toEqual(["base"]);
	await rm(join(root, "oversized"));
	await file(".gitattributes", "*.expand filter=expand\n");
	await git(
		"config",
		"filter.expand.clean",
		`head -c ${OBSERVATION_LIMITS.maxFileBytes + 1} /dev/zero`,
	);
	await file("small.expand", "tiny\n");
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state().observation_id).toBe(complete.observation_id);
});

test("authorization preflight covers init and rejects paths introduced before a later scan", async () => {
	await file("base", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("base", "changed\n");
	const { repo, store } = await setup();
	const authorized = await changelistObservationPaths(repo, store);
	expect(authorized).toEqual(["base"]);
	await file("later", "not authorized\n");
	await expect(
		observeChangelists(repo, store, undefined, undefined, authorized),
	).rejects.toMatchObject({ code: "GIT_STAGING_FORBIDDEN" });
	expect(store.state().observation_id).toBeNull();
});

test("a manifest change retains the complete source before a bounded conservative retry", async () => {
	await file("base", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("base", "changed\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const complete = store.state();
	await file("base", "changed again\n");
	const original = processModule.stagingGit;
	let injected = false;
	const spy = spyOn(processModule, "stagingGit").mockImplementation(async (cwd, args, options) => {
		const result = await original(cwd, args, options);
		if (!injected && args[0] === "cat-file" && args[1] === "--batch") {
			injected = true;
			await file("late", "arrived while scanning\n");
		}
		return result;
	});
	restores.push(() => spy.mockRestore());
	const mark = store.mark.bind(store);
	const markSpy = spyOn(store, "mark").mockImplementation(async (...args) => {
		const result = await mark(...args);
		expect(store.state()).toMatchObject({
			state: "incomplete",
			observation_id: complete.observation_id,
			generation: complete.generation,
		});
		expect(files()[0].workBytes.toString()).toBe("changed\n");
		return result;
	});
	restores.push(() => markSpy.mockRestore());
	const { state, metrics } = await measuredObservation(repo, store);
	expect(metrics).toMatchObject({ attempts: 2, canonicalizedPaths: 3, outcome: "published" });
	expect(markSpy).toHaveBeenCalledTimes(1);
	expect(state).toMatchObject({ state: "ready", generation: complete.generation + 1 });
	expect(files().map((entry) => [entry.path, entry.workBytes.toString()])).toEqual([
		["base", "changed again\n"],
		["late", "arrived while scanning\n"],
	]);
});

test("cancellation and Git output overflow remain hard failures", async () => {
	await file("base", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("base", "changed\n");
	const { repo, store } = await setup();
	const controller = new AbortController();
	controller.abort();
	await expect(observeChangelists(repo, store, controller.signal)).rejects.toBeDefined();
	expect(store.state().observation_id).toBeNull();
	await git(
		"config",
		"filter.noisy.clean",
		"sh -c 'i=0; while [ $i -lt 10000 ]; do printf excessive-error >&2; i=$((i+1)); done; cat'",
	);
	await file(".gitattributes", "*.noisy filter=noisy\n");
	await file("file.noisy", "text\n");
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state().observation_id).toBeNull();
	await chmod(join(root, "base"), 0o644);
});

for (const order of ["rename-first", "text-first"] as const) {
	test(`rename and edited text commit independently in ${order} order`, async () => {
		const base = Array.from({ length: 30 }, (_, index) => `line ${index}\n`).join("");
		await file("source.txt", base);
		await git("add", ".");
		await git("commit", "--quiet", "-m", "Base");
		await file("source.txt", base.replace("line 3\n", "owned A\n"));
		const { repo, store } = await setup();
		await observeChangelists(repo, store);
		const originalId = files()[0].fileId;
		const groupA = store.state().active_list_id;
		const kernel = new IndependentGitStagingKernel(root, "observer-test");
		const act = async (action: Record<string, unknown>) => {
			const state = await kernel.summary();
			return kernel.action({
				...action,
				expectedGeneration: state.generation,
				observationId: state.observationId,
			} as GitStagingAction);
		};
		const created = await act({ action: "create", name: "Path change" });
		const groupB = created.listId as string;
		await rename(join(root, "source.txt"), join(root, "destination.txt"));
		const work = base.replace("line 3\n", "owned A edited\n").replace("line 25\n", "another A\n");
		await file("destination.txt", work);
		await observeChangelists(repo, store);
		const renameUnit = files()[0].units.find((unit) => unit.kind === "rename");
		expect(renameUnit).toBeDefined();
		await act({ action: "move", fromListId: groupA, toListId: groupB, unitIds: [renameUnit?.id] });
		const groups = order === "rename-first" ? [groupB, groupA] : [groupA, groupB];
		for (const [index, listId] of groups.entries()) {
			const committed = await act({
				action: "commit",
				listId,
				message: `Commit ${index}`,
				identity: { name: "Fixture", email: "fixture@example.test" },
			});
			expect(committed.outcome).toBe("applied");
			expect(await readFile(join(root, "destination.txt"), "utf8")).toBe(work);
			expect(await lstat(join(root, "source.txt")).catch(() => null)).toBeNull();
			if (!index) {
				expect(files()).toHaveLength(1);
				expect(files()[0].fileId).toBe(originalId);
				expect(
					files()[0].units.every((unit) => unit.listId === groups[1] && !unit.needsReview),
				).toBe(true);
				const state = store.state();
				await observeChangelists(repo, store);
				expect(store.state()).toEqual(state);
			}
		}
		expect(files()).toEqual([]);
		expect(await git("show", "HEAD:destination.txt")).toBe(work.trimEnd());
		expect(await git("status", "--porcelain")).toBe("");
	});
}

test("external filter state is rechecked even when source file and configuration are unchanged", async () => {
	await file(".gitattributes", "*.custom filter=external\n");
	await git("config", "filter.external.clean", `cat '${join(root, ".git", "filter-output")}'`);
	await writeFile(join(root, ".git", "filter-output"), "FIRST\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("input.custom", "source remains unchanged\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	expect(files()[0].workBytes.toString()).toBe("FIRST\n");
	await writeFile(join(root, ".git", "filter-output"), "SECOND\n");
	const { metrics } = await measuredObservation(repo, store);
	expect(metrics).toMatchObject({ canonicalizedPaths: 1, loadedSnapshots: 1, writtenSnapshots: 1 });
	expect(files()[0].workBytes.toString()).toBe("SECOND\n");
});

test("whole-observation content budget counts every base and working file", async () => {
	const base = Buffer.alloc(1024 * 1024, 65);
	await Promise.all(Array.from({ length: 33 }, (_, index) => file(`large-${index}`, base)));
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	const work = Buffer.from(base);
	work[work.length - 1] = 66;
	await Promise.all(Array.from({ length: 33 }, (_, index) => file(`large-${index}`, work)));
	const { repo, store } = await setup();
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state().observation_id).toBeNull();
});

test("a held draft retries only changed files and preserves complete identities and ownership", async () => {
	const count = 20;
	await Promise.all(Array.from({ length: count }, (_, i) => file(`f-${i}`, "base\n")));
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await Promise.all(Array.from({ length: count }, (_, i) => file(`f-${i}`, "owned\n")));
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const complete = store.state(),
		previous = files();
	const native = await readFile(repo.index),
		head = await git("rev-parse", "HEAD");
	await file("f-0", "second edit\n");
	let held = false;
	let entered!: () => void, release!: () => void;
	const entry = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const persist = store.putFiles.bind(store);
	const spy = spyOn(store, "putFiles").mockImplementation(async (...args) => {
		await persist(...args);
		if (!held) {
			held = true;
			entered();
			await gate;
		}
	});
	const mark = spyOn(store, "mark");
	restores.push(
		() => spy.mockRestore(),
		() => mark.mockRestore(),
		() => release(),
	);
	const running = measuredObservation(repo, store);
	await entry;
	expect(store.state()).toEqual(complete);
	expect(files()).toEqual(previous);
	await file("f-1", "edit while writing the draft\n");
	release();
	const { state, metrics } = await running;
	expect(metrics).toMatchObject({
		attempts: 2,
		outcome: "published",
		canonicalizedPaths: 3,
		loadedSnapshots: 3,
		writtenSnapshots: 3,
		reusedMappings: count - 2,
	});
	expect(mark).not.toHaveBeenCalled();
	expect(state).toMatchObject({ state: "ready", generation: complete.generation + 1 });
	const current = files();
	for (const old of previous) {
		const next = current.find((entry) => entry.fileId === old.fileId) as StoredFile;
		if (old.path === "f-0" || old.path === "f-1") {
			expect(next.fileId).toBe(old.fileId);
			expect(next.units.map((unit) => unit.listId)).toEqual(old.units.map((unit) => unit.listId));
			expect(next.workBytes).toEqual(await readFile(join(root, old.path)));
		} else expect(next).toEqual(old);
	}
	expect(await readFile(repo.index)).toEqual(native);
	expect(await git("rev-parse", "HEAD")).toBe(head);
});

test("a file changed during a bounded read marks incomplete before conservative recovery", async () => {
	await file("tracked", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const before = store.state();
	await file("tracked", "new owned\n");
	const open = fsModule.open;
	let changed = false;
	const openSpy = spyOn(fsModule, "open").mockImplementation(async (...args) => {
		const handle = await open(...args);
		if (args[0] === join(root, "tracked") && !changed) {
			const stat = handle.stat.bind(handle);
			let checks = 0;
			function checkedStat(options?: StatOptions & { bigint?: false | undefined }): Promise<Stats>;
			function checkedStat(options: StatOptions & { bigint: true }): Promise<BigIntStats>;
			function checkedStat(options?: StatOptions): Promise<Stats | BigIntStats>;
			async function checkedStat(options?: StatOptions): Promise<Stats | BigIntStats> {
				if (++checks === 2 && !changed) {
					changed = true;
					await file("tracked", "changed during bounded read\n");
				}
				return stat(options);
			}
			const statSpy = spyOn(handle, "stat").mockImplementation(checkedStat);
			restores.push(() => statSpy.mockRestore());
		}
		return handle;
	});
	const mark = store.mark.bind(store);
	const markSpy = spyOn(store, "mark").mockImplementation(async (...args) => {
		const result = await mark(...args);
		expect(store.state()).toMatchObject({
			state: "incomplete",
			observation_id: before.observation_id,
		});
		expect(files()[0].workBytes.toString()).toBe("owned\n");
		return result;
	});
	restores.push(
		() => openSpy.mockRestore(),
		() => markSpy.mockRestore(),
	);
	const { state, metrics } = await measuredObservation(repo, store);
	expect(changed).toBe(true);
	expect(markSpy).toHaveBeenCalledTimes(1);
	expect(metrics).toMatchObject({ attempts: 2, canonicalizedPaths: 1, outcome: "published" });
	expect(state.state).toBe("ready");
	expect(files()[0].workBytes.toString()).toBe("changed during bounded read\n");
});

for (const source of ["HEAD", "index", "attributes"] as const) {
	test(`${source} changes use the same bounded conservative recovery budget`, async () => {
		await file("tracked.txt", "base\n");
		await git("add", ".");
		await git("commit", "--quiet", "-m", "Base");
		await file("tracked.txt", "owned\n");
		const { repo, store } = await setup();
		await observeChangelists(repo, store);
		await file("tracked.txt", "new owned\n");
		const persist = store.putFiles.bind(store);
		let injected = false;
		let native = await readFile(repo.index),
			head = await git("rev-parse", "HEAD");
		const spy = spyOn(store, "putFiles").mockImplementation(async (...args) => {
			await persist(...args);
			if (!injected) {
				injected = true;
				if (source === "HEAD")
					await git("commit", "--allow-empty", "--quiet", "-m", "External fixture change");
				else if (source === "index") await git("add", "tracked.txt");
				else await writeFile(join(repo.gitDir, "info", "attributes"), "*.txt -text\n");
				native = await readFile(repo.index);
				head = await git("rev-parse", "HEAD");
			}
		});
		const mark = spyOn(store, "mark");
		restores.push(
			() => spy.mockRestore(),
			() => mark.mockRestore(),
		);
		const { state, metrics } = await measuredObservation(repo, store);
		expect(metrics).toMatchObject({ attempts: 2, canonicalizedPaths: 2, outcome: "published" });
		expect(mark).toHaveBeenCalledTimes(1);
		expect(state).toMatchObject({ state: "ready", head_oid: head });
		expect(files()[0].workBytes.toString()).toBe("new owned\n");
		expect(await readFile(repo.index)).toEqual(native);
		expect(await git("rev-parse", "HEAD")).toBe(head);
	});
}

test("a concurrent failure with unchanged source bytes republishes a verified complete state", async () => {
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const previous = store.fileIds(),
		before = store.state();
	const run = processModule.stagingGit;
	let failed = false;
	const spy = spyOn(processModule, "stagingGit").mockImplementation(async (...args) => {
		if (!failed && args[1][0] === "ls-files" && args[1][1] === "--unmerged") {
			failed = true;
			throw new processModule.GitStagingKernelError(
				"GIT_STAGING_CONCURRENT_CHANGE",
				"Fixture source read changed",
			);
		}
		return run(...args);
	});
	restores.push(() => spy.mockRestore());
	const { state, metrics } = await measuredObservation(repo, store);
	expect(metrics).toMatchObject({
		attempts: 2,
		canonicalizedPaths: 1,
		writtenSnapshots: 0,
		reusedMappings: 1,
		outcome: "published",
	});
	expect(state).toMatchObject({ state: "ready", generation: before.generation + 1 });
	expect(store.fileIds()).toEqual(previous);
});

test("observer and coordinator share three total scans without multiplying retries", async () => {
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const before = store.state(),
		previous = store.fileIds();
	const run = processModule.stagingGit;
	let failures = 0;
	const spy = spyOn(processModule, "stagingGit").mockImplementation(async (...args) => {
		if (args[1][0] === "ls-files" && args[1][1] === "--unmerged") {
			failures++;
			throw new processModule.GitStagingKernelError(
				"GIT_STAGING_CONCURRENT_CHANGE",
				"Fixture source keeps changing",
			);
		}
		return run(...args);
	});
	restores.push(() => spy.mockRestore());
	const reports: ObservationDiagnostics[] = [];
	const identity = { rootPath: root, workspaceKey: repo.key };
	const stop = subscribeGitStagingObservation(identity, () => {});
	restores.push(stop);
	let runs = 0;
	await expect(
		requestGitStagingObservation(identity, {
			authorizationKey: "fixture-owner",
			prepare: async () => ({
				baseline: JSON.stringify(before),
				scope: "tracked",
				run: async (signal) => {
					runs++;
					try {
						await observeChangelists(repo, store, signal, undefined, ["tracked"], (report) =>
							reports.push(report),
						);
						throw new Error("Expected concurrent observation failure");
					} catch (error) {
						if (error instanceof processModule.GitStagingKernelError) {
							const appError = new AppError(error.message, 409, error.code);
							if (
								"observationRetriesExhausted" in error &&
								error.observationRetriesExhausted === true
							)
								Object.defineProperty(appError, "observationRetriesExhausted", { value: true });
							throw appError;
						}
						throw error;
					}
				},
			}),
		}),
	).rejects.toMatchObject({ code: "GIT_STAGING_CONCURRENT_CHANGE" });
	expect(runs).toBe(1);
	expect(reports).toHaveLength(1);
	expect(failures).toBe(3);
	expect(reports[0]).toMatchObject({ attempts: 3, outcome: "failed", canonicalizedPaths: 0 });
	expect(store.state()).toMatchObject({
		state: "incomplete",
		generation: before.generation,
		observation_id: before.observation_id,
	});
	expect(store.fileIds()).toEqual(previous);
});

for (const source of [
	"uninitialized",
	"incomplete",
	"recovering",
	"conflict",
	"unfinished",
	"head-mismatch",
] as const) {
	test(`${source} sources keep conservative canonicalization during concurrent recovery`, async () => {
		const count = 3;
		await Promise.all(Array.from({ length: count }, (_, i) => file(`f-${i}`, "base\n")));
		await git("add", ".");
		await git("commit", "--quiet", "-m", "Base");
		await Promise.all(Array.from({ length: count }, (_, i) => file(`f-${i}`, "owned\n")));
		const { repo, store } = await setup();
		if (source !== "uninitialized") await observeChangelists(repo, store);
		if (source === "incomplete" || source === "recovering" || source === "conflict")
			await store.mark(source, "Existing observation failure");
		if (source === "unfinished")
			store.db
				.query("UPDATE observations SET complete=0 WHERE id=?")
				.run(store.state().observation_id);
		if (source === "head-mismatch")
			store.db
				.query("UPDATE observations SET head_oid='different-head' WHERE id=?")
				.run(store.state().observation_id);
		await file("f-0", "new owned\n");
		const persist = store.putFiles.bind(store);
		let injected = false;
		const spy = spyOn(store, "putFiles").mockImplementation(async (...args) => {
			await persist(...args);
			if (!injected) {
				injected = true;
				await file("f-0", "changed while publishing\n");
			}
		});
		const mark = spyOn(store, "mark");
		restores.push(
			() => spy.mockRestore(),
			() => mark.mockRestore(),
		);
		const { state, metrics } = await measuredObservation(repo, store);
		expect(metrics).toMatchObject({
			attempts: 2,
			canonicalizedPaths:
				source === "unfinished" || source === "head-mismatch" ? count + 1 : count * 2,
			outcome: "published",
		});
		expect(mark).toHaveBeenCalledTimes(1);
		expect(state.state).toBe("ready");
		expect(files()).toHaveLength(count);
		expect(
			files()
				.find((entry) => entry.path === "f-0")
				?.workBytes.toString(),
		).toBe("changed while publishing\n");
	});
}

test("a pending recovery prevents every ordinary observation attempt", async () => {
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const before = store.state();
	await store.transaction(() =>
		store.db
			.query(
				"INSERT INTO commit_operations(id,list_id,expected_generation,observation_id,head_oid,head_tree,status,evidence_json,created_at,fence_token) VALUES(?,?,?,?,?,?,'recovering','{}',0,'fixture-fence')",
			)
			.run(
				"pending-fixture",
				before.active_list_id,
				before.generation,
				before.observation_id,
				before.head_oid,
				before.head_tree,
			),
	);
	await store.mark("recovering", "Pending fixture operation");
	const recovering = store.state();
	const reports: ObservationDiagnostics[] = [];
	await expect(
		observeChangelists(repo, store, undefined, undefined, undefined, (report) =>
			reports.push(report),
		),
	).rejects.toMatchObject({ code: "GIT_STAGING_RECOVERY_REQUIRED" });
	expect(reports[0]).toMatchObject({ attempts: 1, canonicalizedPaths: 0, writtenSnapshots: 0 });
	expect(store.state()).toEqual(recovering);
});

test("corrupt ownership cannot become a ready incremental recovery source", async () => {
	await file("tracked", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("tracked", "owned\n");
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const before = store.state(),
		previous = store.fileIds();
	store.db
		.query("UPDATE file_snapshots SET ownership_json='invalid' WHERE version_id=?")
		.run(previous[0].version_id);
	await file("tracked", "new owned\n");
	const reports: ObservationDiagnostics[] = [];
	await expect(
		observeChangelists(repo, store, undefined, undefined, undefined, (report) =>
			reports.push(report),
		),
	).rejects.toBeInstanceOf(SyntaxError);
	expect(reports[0].attempts).toBe(1);
	expect(store.state()).toMatchObject({
		state: "incomplete",
		generation: before.generation,
		observation_id: before.observation_id,
	});
	await expect(observeChangelists(repo, store)).rejects.toBeInstanceOf(SyntaxError);
	expect(store.state().state).toBe("incomplete");
});

test("a missing reused object forces conservative reconstruction during a retry", async () => {
	await Promise.all(Array.from({ length: 3 }, (_, i) => file(`f-${i}`, "base\n")));
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await Promise.all(Array.from({ length: 3 }, (_, i) => file(`f-${i}`, "owned\n")));
	const { repo, store } = await setup();
	await observeChangelists(repo, store);
	const previous = files();
	const retained = previous.find((entry) => entry.path === "f-1") as StoredFile;
	if (!retained.workOid) throw new Error("Expected loose work object");
	const object = join(
		repo.gitDir,
		"objects",
		retained.workOid.slice(0, 2),
		retained.workOid.slice(2),
	);
	await file("f-0", "new owned\n");
	const persist = store.putFiles.bind(store);
	let injected = false;
	const spy = spyOn(store, "putFiles").mockImplementation(async (...args) => {
		await persist(...args);
		if (!injected) {
			injected = true;
			await rm(object);
			await file("f-0", "changed while publishing\n");
		}
	});
	restores.push(() => spy.mockRestore());
	const { metrics } = await measuredObservation(repo, store);
	expect(metrics).toMatchObject({ attempts: 2, canonicalizedPaths: 4, outcome: "published" });
	expect(store.loadFile(retained.fileId)).toEqual(retained);
	expect(await git("cat-file", "-p", retained.workOid)).toBe("owned");
});

for (const failure of ["cancel", "deadline", "state", "permission", "budget"] as const) {
	test(`${failure} interrupts the shared retry budget and preserves the last complete observation`, async () => {
		await file("tracked", "base\n");
		await git("add", ".");
		await git("commit", "--quiet", "-m", "Base");
		await file("tracked", "owned\n");
		const { repo, store } = await setup();
		await observeChangelists(repo, store);
		const before = store.state(),
			previous = store.fileIds();
		await file("tracked", "new owned\n");
		const controller = new AbortController();
		const persist = store.putFiles.bind(store),
			now = Date.now;
		let changed = false;
		const spy = spyOn(store, "putFiles").mockImplementation(async (...args) => {
			await persist(...args);
			if (!changed) {
				changed = true;
				await file("tracked", "changed while publishing\n");
				if (failure === "state") await store.mark("conflict", "Another producer failed");
				if (failure === "permission") await file("unauthorized", "later\n");
				if (failure === "budget")
					await file("oversized", Buffer.alloc(OBSERVATION_LIMITS.maxFileBytes + 1));
			}
		});
		const complete = store.completeObservation.bind(store);
		const source = spyOn(store, "completeObservation").mockImplementation((expected) => {
			const result = complete(expected);
			if (failure === "cancel")
				queueMicrotask(() => controller.abort(new Error("Fixture retry cancelled")));
			if (failure === "deadline")
				queueMicrotask(() => {
					const clock = spyOn(Date, "now").mockImplementation(() => now() + 120_001);
					restores.push(() => clock.mockRestore());
				});
			return result;
		});
		restores.push(
			() => spy.mockRestore(),
			() => source.mockRestore(),
		);
		const reports: ObservationDiagnostics[] = [];
		const running = observeChangelists(
			repo,
			store,
			controller.signal,
			undefined,
			failure === "permission" ? ["tracked"] : undefined,
			(report) => reports.push(report),
		);
		if (failure === "cancel") await expect(running).rejects.toThrow("Fixture retry cancelled");
		else
			await expect(running).rejects.toMatchObject({
				code:
					failure === "deadline"
						? "GIT_STAGING_TIMEOUT"
						: failure === "permission"
							? "GIT_STAGING_FORBIDDEN"
							: failure === "budget"
								? "GIT_STAGING_LIMIT"
								: "GIT_STAGING_CONCURRENT_CHANGE",
			});
		expect(reports[0].attempts).toBe(failure === "permission" || failure === "budget" ? 2 : 1);
		expect(store.state()).toMatchObject({
			observation_id: before.observation_id,
			generation: before.generation,
			state: failure === "state" ? "conflict" : "incomplete",
		});
		if (failure === "state") expect(store.state().reason).toBe("Another producer failed");
		expect(store.fileIds()).toEqual(previous);
	});
}

for (const change of ["source", "version", "cancel"] as const) {
	test(`a ${change} change between write batches keeps the previous observation published`, async () => {
		const count = 20;
		await Promise.all(Array.from({ length: count }, (_, index) => file(`f-${index}`, "base\n")));
		await git("add", ".");
		await git("commit", "--quiet", "-m", "Base");
		await Promise.all(Array.from({ length: count }, (_, index) => file(`f-${index}`, "owned\n")));
		const { repo, store } = await setup();
		await observeChangelists(repo, store);
		const before = store.state(),
			versions = store.fileIds();
		await Promise.all(
			Array.from({ length: count }, (_, index) => file(`f-${index}`, "new owned\n")),
		);
		const controller = new AbortController();
		const transaction = store.transaction.bind(store);
		let changed = false;
		const changedDrafts = new Set<string>();
		const spy = spyOn(store, "transaction").mockImplementation(async (fn, signal, checkpoint) => {
			const result = await transaction(fn, signal, checkpoint);
			const batch = store.db
				.query(
					"SELECT observation_id FROM observation_files WHERE observation_id<>? GROUP BY observation_id HAVING count(*)=16",
				)
				.all(before.observation_id) as { observation_id: string }[];
			const fresh = batch.find((row) => !changedDrafts.has(row.observation_id));
			if (fresh && (!changed || change === "source")) {
				changed = true;
				changedDrafts.add(fresh.observation_id);
				if (change === "source")
					await file("f-0", `changed while persisting batch ${changedDrafts.size}\n`);
				else if (change === "version")
					store.db.query("UPDATE workspace_state SET generation=generation+1 WHERE id=1").run();
				else controller.abort(new Error("Fixture cancelled between batches"));
			}
			return result;
		});
		restores.push(() => spy.mockRestore());
		const observation = observeChangelists(repo, store, controller.signal);
		if (change === "cancel")
			await expect(observation).rejects.toThrow("Fixture cancelled between batches");
		else
			await expect(observation).rejects.toMatchObject({
				code: change === "source" ? "GIT_STAGING_CONCURRENT_CHANGE" : "GIT_STAGING_STALE_VERSION",
			});
		expect(changed).toBe(true);
		if (change === "source") expect(changedDrafts.size).toBe(3);
		expect(store.state().observation_id).toBe(before.observation_id);
		expect(store.state().generation).toBe(before.generation + (change === "version" ? 1 : 0));
		expect(store.fileIds()).toEqual(versions);
	});
}

test("observation operation storage cannot be redirected through a symlink", async () => {
	await file("base", "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await file("base", "changed\n");
	const { repo, store } = await setup();
	await mkdir(join(root, "target"));
	await symlink(join(root, "target"), join(repo.directory, "operations"));
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_STORAGE_UNSAFE",
	});
	expect(await readdir(join(root, "target"))).toEqual([]);
	expect(store.state().observation_id).toBeNull();
});

test("tracked descendants cannot be read through a replaced symlink parent", async () => {
	await mkdir(join(root, "directory"));
	await mkdir(join(root, "target"));
	await file("directory/file", "base\n");
	await file("target/file", "different\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await rm(join(root, "directory"), { recursive: true });
	await symlink("target", join(root, "directory"));
	const { repo, store } = await setup();
	const native = await readFile(repo.index);
	await expect(observeChangelists(repo, store)).rejects.toMatchObject({
		code: "GIT_STAGING_INVALID",
	});
	expect(store.state().observation_id).toBeNull();
	expect(await readFile(repo.index)).toEqual(native);
});
