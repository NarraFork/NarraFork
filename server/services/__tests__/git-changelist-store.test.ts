import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GIT_STAGING_LIMITS,
	GIT_STAGING_UNASSIGNED_LIST_ID,
	GIT_STAGING_UNASSIGNED_LIST_NAME,
} from "../../../shared/git-staging-lists";
import { createTextOwnership } from "../git-changelist-ownership";
import {
	CHANGELIST_SNAPSHOT_LIMITS,
	ChangelistStore,
	type StoredFile,
} from "../git-changelist-store";

let root: string;
let store: ChangelistStore;
const restores: (() => void)[] = [];
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "nf-changelist-batches-"));
	const gitDir = join(root, "git");
	await mkdir(gitDir);
	const opened = await ChangelistStore.open(
		{
			root,
			gitDir,
			directory: join(gitDir, "narrafork", "changelists"),
			index: join(gitDir, "index"),
			key: root,
		},
		true,
	);
	if (!opened) throw new Error("Expected fixture store");
	store = opened;
});
afterEach(async () => {
	for (const restore of restores.splice(0).reverse()) restore();
	store?.close();
	await rm(root, { recursive: true, force: true });
});
function binary(index: number, bytes = 8): StoredFile {
	const fileId = `file-${index}`;
	return {
		versionId: `version-${index}`,
		fileId,
		path: fileId,
		basePath: fileId,
		baseMode: "000000",
		workMode: "100644",
		baseOid: null,
		workOid: null,
		baseBytes: Buffer.alloc(0),
		workBytes: Buffer.alloc(bytes),
		identity: "fixture",
		ownership: null,
		units: [
			{
				id: `unit-${index}`,
				fileId,
				path: fileId,
				kind: "binary",
				listId: store.state().active_list_id,
				baseStart: 0,
				baseEnd: 0,
				workStart: 0,
				workEnd: 0,
				added: 0,
				removed: 0,
				needsReview: false,
			},
		],
	};
}
function text(index: number, lines: number): StoredFile {
	const file = binary(index);
	const ownership = createTextOwnership({
		fileId: file.fileId,
		baseText: "",
		workText: "x\n".repeat(lines),
		activeGroupId: store.state().active_list_id,
	});
	return {
		...file,
		workBytes: Buffer.from(ownership.workText),
		ownership,
		units: ownership.units.map((unit) => ({
			id: unit.id,
			fileId: file.fileId,
			path: file.path,
			kind: "text",
			listId: unit.groupId,
			baseStart: unit.baseStart,
			baseEnd: unit.baseEnd,
			workStart: unit.workStart,
			workEnd: unit.workEnd,
			added: unit.insertedLines.length,
			removed: unit.deletedLineIds.length,
			needsReview: unit.needsReview,
		})),
	};
}
function captureBatches(draft: string) {
	const batches: { files: number; records: number }[] = [];
	let previousFiles = 0,
		previousRecords = 0;
	const exec = store.db.exec.bind(store.db);
	const spy = spyOn(store.db, "exec").mockImplementation((sql) => {
		const result = exec(sql);
		if (sql === "COMMIT") {
			const files = store.fileIds(draft).length;
			const records = (
				store.db
					.query(
						"SELECT (SELECT count(*) FROM file_snapshots)+(SELECT count(*) FROM observation_files)+(SELECT count(*) FROM change_units)+(SELECT count(*) FROM tracking_lines) n",
					)
					.get() as { n: number }
			).n;
			batches.push({ files: files - previousFiles, records: records - previousRecords });
			previousFiles = files;
			previousRecords = records;
		}
		return result;
	});
	restores.push(() => spy.mockRestore());
	return batches;
}

function unassigned(index: number) {
	const file = binary(index);
	file.units = file.units.map((unit) => ({
		...unit,
		listId: GIT_STAGING_UNASSIGNED_LIST_ID,
		needsReview: true,
		reviewReason: "headChanged",
	}));
	return file;
}
function reservedList() {
	return store.db
		.query("SELECT id,name,archived,created_at FROM change_lists WHERE id=?")
		.get(GIT_STAGING_UNASSIGNED_LIST_ID);
}
function visibleReservedList() {
	return store.db
		.query("SELECT * FROM v_changelists WHERE id=?")
		.get(GIT_STAGING_UNASSIGNED_LIST_ID);
}

test("unassigned stays archived through draft writes and becomes visible with its complete observation", async () => {
	const expected = store.state();
	await store.draft(null, "unused");
	expect(reservedList()).toBeNull();
	const draft = await store.draft("head", "tree", { unassigned: true });
	expect(reservedList()).toMatchObject({
		id: GIT_STAGING_UNASSIGNED_LIST_ID,
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		archived: 1,
	});
	expect(visibleReservedList()).toBeNull();
	await store.putFile(draft, unassigned(0));
	expect(visibleReservedList()).toBeNull();
	expect(store.state()).toEqual(expected);
	await store.publish(draft, expected, "head", "tree");
	expect(store.state()).toMatchObject({
		state: "ready",
		observation_id: draft,
		generation: expected.generation + 1,
		active_list_id: expected.active_list_id,
	});
	expect(visibleReservedList()).toMatchObject({ unit_count: 1, needs_review_count: 1, active: 0 });
});

for (const failure of ["draft", "stale", "publish"] as const) {
	test(`${failure} failure cannot publish a prepared unassigned list`, async () => {
		const stable = await store.draft(null, "base");
		await store.putFile(stable, binary(99));
		await store.publish(stable, store.state(), null, "base");
		const expected = store.state();
		const draft = await store.draft("head", "tree", { unassigned: true });
		if (failure === "draft") {
			store.db.exec(
				"CREATE TRIGGER fixture_failure BEFORE INSERT ON file_snapshots BEGIN SELECT RAISE(ABORT,'Fixture draft failure'); END",
			);
			await expect(store.putFile(draft, unassigned(0))).rejects.toThrow("Fixture draft failure");
		} else {
			await store.putFile(draft, unassigned(0));
			if (failure === "stale")
				await store.mutate(expected.generation, expected.observation_id, () => {});
			else
				store.db.exec(
					"CREATE TRIGGER fixture_failure BEFORE UPDATE ON workspace_state BEGIN SELECT RAISE(ABORT,'Fixture publication failure'); END",
				);
			await expect(store.publish(draft, expected, "head", "tree")).rejects.toThrow(
				failure === "stale" ? "observation changed" : "Fixture publication failure",
			);
		}
		expect(store.state().observation_id).toBe(stable);
		expect(store.fileIds().map((file) => file.file_id)).toEqual(["file-99"]);
		expect(reservedList()).toMatchObject({ archived: 1 });
		expect(visibleReservedList()).toBeNull();
		expect(store.db.query("SELECT complete FROM observations WHERE id=?").get(draft)).toEqual({
			complete: 0,
		});
	});
}

test("concurrent drafts share one reserved identity while only the current producer can publish", async () => {
	const expected = store.state();
	const first = await store.draft("head", "tree", { unassigned: true });
	const second = await store.draft("head", "tree", { unassigned: true });
	await store.putFile(first, unassigned(0));
	await store.putFile(second, unassigned(1));
	await store.publish(first, expected, "head", "tree");
	const published = store.state();
	await expect(store.publish(second, expected, "head", "tree")).rejects.toMatchObject({
		code: "GIT_STAGING_STALE_VERSION",
	});
	expect(store.state()).toEqual(published);
	expect(store.fileIds().map((file) => file.file_id)).toEqual(["file-0"]);
	expect(visibleReservedList()).toMatchObject({ unit_count: 1 });
});

test("same-name lists stay distinct and archived unassigned keeps its name without old members", async () => {
	store.db
		.query("INSERT INTO change_lists(id,name,created_at) VALUES('ordinary',?,0)")
		.run(GIT_STAGING_UNASSIGNED_LIST_NAME);
	let expected = store.state();
	const first = await store.draft("head", "tree", { unassigned: true });
	await store.putFile(first, unassigned(0));
	await store.publish(first, expected, "head", "tree");
	store.db
		.query("UPDATE change_lists SET name='Needs my confirmation' WHERE id=?")
		.run(GIT_STAGING_UNASSIGNED_LIST_ID);
	const custom = reservedList();
	const visibleDraft = await store.draft("head", "tree", { unassigned: true });
	expect(reservedList()).toEqual(custom);
	expect(store.fileIds(visibleDraft)).toEqual([]);
	expect(
		store.db.query("SELECT name,archived FROM change_lists WHERE id='ordinary'").get(),
	).toEqual({
		name: GIT_STAGING_UNASSIGNED_LIST_NAME,
		archived: 0,
	});
	expected = store.state();
	const moved = await store.draft("head", "tree");
	await store.putFile(moved, { ...binary(0), versionId: "moved-version" });
	await store.publish(moved, expected, "head", "tree");
	store.db
		.query("UPDATE change_lists SET archived=1 WHERE id=?")
		.run(GIT_STAGING_UNASSIGNED_LIST_ID);
	await store.collect();
	await store.collect();
	expect(reservedList()).toMatchObject({ name: "Needs my confirmation", archived: 1 });
	expected = store.state();
	const revived = await store.draft("next-head", "next-tree", { unassigned: true });
	await store.copyFiles(revived, expected.observation_id as string, []);
	await store.putFile(revived, unassigned(1));
	expect(visibleReservedList()).toBeNull();
	await store.publish(revived, expected, "next-head", "next-tree");
	expect(visibleReservedList()).toMatchObject({
		name: "Needs my confirmation",
		unit_count: 1,
		needs_review_count: 1,
	});
	expect(store.loadFile("file-0")?.units[0].listId).toBe(expected.active_list_id);
	expect(store.loadFile("file-1")?.units[0].listId).toBe(GIT_STAGING_UNASSIGNED_LIST_ID);
});

test("invalid reserved identity occupancy is rejected before a draft is written", async () => {
	store.db
		.query("INSERT INTO change_lists(id,name,created_at,archived) VALUES(?, '', 0, 1)")
		.run(GIT_STAGING_UNASSIGNED_LIST_ID);
	const expected = store.state();
	await expect(store.draft("head", "tree", { unassigned: true })).rejects.toMatchObject({
		code: "GIT_STAGING_STORAGE_CORRUPT",
	});
	expect(store.state()).toEqual(expected);
	expect(store.db.query("SELECT 1 FROM observations").get()).toBeNull();
});

test("a draft without remaining unassigned members does not reactivate its archived container", async () => {
	const expected = store.state();
	const draft = await store.draft("head", "tree", { unassigned: true });
	await store.publish(draft, expected, "head", "tree");
	expect(reservedList()).toMatchObject({ archived: 1 });
	expect(visibleReservedList()).toBeNull();
});

test("reserved-list activation keeps the existing visible-list budget and rolls publication back", async () => {
	await store.transaction(() => {
		const insert = store.db.query("INSERT INTO change_lists(id,name,created_at) VALUES(?,?,0)");
		for (let i = 1; i < GIT_STAGING_LIMITS.maxSummaryLists; i++)
			insert.run(`list-${i}`, `List ${i}`);
	});
	const expected = store.state();
	const draft = await store.draft("head", "tree", { unassigned: true });
	await store.putFile(draft, unassigned(0));
	await expect(store.publish(draft, expected, "head", "tree")).rejects.toMatchObject({
		code: "GIT_STAGING_LIMIT",
	});
	expect(store.state()).toEqual(expected);
	expect(reservedList()).toMatchObject({ archived: 1 });
	expect(visibleReservedList()).toBeNull();
});

for (const legacy of ["units", "json", "sources", "structural", "invalid"] as const) {
	test(`legacy ${legacy} metadata is detected read-only without changing the v1 schema or views`, async () => {
		const file = text(0, 2);
		if (!file.ownership) throw new Error("Expected text ownership");
		if (legacy === "units") file.units[0].needsReview = true;
		if (legacy === "json") file.ownership.units[0].reviewReason = "headChanged";
		if (legacy === "sources") file.ownership.units[0].sourceGroupIds.push("other-owner");
		if (legacy === "structural") file.ownership.structuralSourceGroupIds = { old: ["other-owner"] };
		const draft = await store.draft(null, "tree");
		await store.putFile(draft, file);
		await store.publish(draft, store.state(), null, "tree");
		if (legacy === "invalid")
			store.db
				.query("UPDATE file_snapshots SET ownership_json='invalid-json' WHERE version_id=?")
				.run(file.versionId);
		const state = store.state();
		const views = store.db
			.query("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name")
			.all();
		const writes = (store.db.query("SELECT total_changes() n").get() as { n: number }).n;
		if (legacy === "invalid")
			await expect(store.legacyReviewFileIds()).rejects.toBeInstanceOf(SyntaxError);
		else expect(await store.legacyReviewFileIds()).toEqual(new Set([file.fileId]));
		expect(await store.legacyReviewFileIds(null)).toEqual(new Set());
		expect(store.state()).toEqual(state);
		expect((store.db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes);
		expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
		expect(
			store.db.query("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name").all(),
		).toEqual(views);
	});
}

async function publishedFiles(files: StoredFile[]) {
	const draft = await store.draft(null, "tree");
	await store.putFiles(draft, files);
	await store.publish(draft, store.state(), null, "tree");
	return store.fileIds();
}
function scanQueries() {
	const query = spyOn(store.db, "query");
	restores.push(() => query.mockRestore());
	return {
		clear: () => query.mockClear(),
		json: () =>
			query.mock.calls.filter(([sql]) => sql.includes("SELECT ownership_json FROM")).length,
		units: () =>
			query.mock.calls.filter(
				([sql]) => sql.includes("FROM change_units") && sql.includes("LIMIT 256"),
			).length,
	};
}

for (const excess of ["ownership-file", "content-file", "content-total", "files"] as const) {
	test(`${excess} metadata limits stop legacy scanning before content or unit hydration`, async () => {
		const [metadata] = await publishedFiles([text(0, 2)]);
		const files =
			excess === "files"
				? Array.from({ length: GIT_STAGING_LIMITS.maxRowsPerList + 1 }, () => metadata)
				: excess === "content-total"
					? Array.from({ length: 33 }, (_, i) => ({
							...metadata,
							file_id: `meta-${i}`,
							base_size: CHANGELIST_SNAPSHOT_LIMITS.maxFileBytes,
							work_size: 1,
						}))
					: [
							{
								...metadata,
								...(excess === "ownership-file"
									? { ownership_size: CHANGELIST_SNAPSHOT_LIMITS.maxOwnershipFileBytes + 1 }
									: { work_size: CHANGELIST_SNAPSHOT_LIMITS.maxFileBytes + 1 }),
							},
						];
		const ids = spyOn(store, "fileIds").mockReturnValue(files);
		restores.push(() => ids.mockRestore());
		const queries = scanQueries();
		await expect(store.legacyReviewFileIds()).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
		expect(queries.json()).toBe(0);
		expect(queries.units()).toBe(0);
	});
}

test("ownership JSON has an independent 256 MiB total budget and cached files still undergo preflight", async () => {
	const files = Array.from({ length: 100 }, (_, i) => {
		const file = text(i, 2);
		file.units[0].needsReview = true;
		return file;
	});
	const metadata = await publishedFiles(files);
	// Only byte metadata is enlarged; public legacy flags avoid allocating the modeled JSON bodies.
	const modeled = metadata.map((file) => ({ ...file, ownership_size: 3 * 1024 * 1024 }));
	const ids = spyOn(store, "fileIds").mockReturnValue(modeled.slice(0, 36));
	restores.push(() => ids.mockRestore());
	const queries = scanQueries();
	expect(await store.legacyReviewFileIds()).toEqual(
		new Set(modeled.slice(0, 36).map((file) => file.file_id)),
	);
	expect(queries.json()).toBe(0);
	queries.clear();
	ids.mockReturnValue(modeled.slice(0, 80));
	expect((await store.legacyReviewFileIds()).size).toBe(80);
	queries.clear();
	ids.mockReturnValue(modeled);
	await expect(store.legacyReviewFileIds()).rejects.toMatchObject({ code: "GIT_STAGING_LIMIT" });
	expect(queries.json()).toBe(0);
	expect(queries.units()).toBe(0);
});

test("a mismatched actual JSON byte length is rejected before parse and never cached", async () => {
	const [metadata] = await publishedFiles([text(0, 2)]);
	const ids = spyOn(store, "fileIds").mockReturnValue([
		{ ...metadata, ownership_size: metadata.ownership_size - 1 },
	]);
	restores.push(() => ids.mockRestore());
	const queries = scanQueries();
	await expect(store.legacyReviewFileIds()).rejects.toMatchObject({
		code: "GIT_STAGING_STORAGE_CORRUPT",
	});
	expect(queries.json()).toBe(1);
	queries.clear();
	await expect(store.legacyReviewFileIds()).rejects.toMatchObject({
		code: "GIT_STAGING_STORAGE_CORRUPT",
	});
	expect(queries.json()).toBe(1);
});

for (const reason of ["cancel", "deadline"] as const) {
	test(`${reason} interrupts indexed unit pagination and incomplete results do not enter the cache`, async () => {
		const file = binary(0);
		file.units = Array.from({ length: 600 }, (_, i) => ({
			...file.units[0],
			id: `u-${String(i).padStart(4, "0")}`,
		}));
		await publishedFiles([file]);
		const queries = scanQueries();
		const controller = new AbortController();
		const now = Date.now();
		let expired = false;
		const clock = spyOn(Date, "now").mockImplementation(() => (expired ? now + 1000 : now));
		restores.push(() => clock.mockRestore());
		const scan = store.legacyReviewFileIds(undefined, {
			signal: controller.signal,
			deadline: now + 100,
			checkpoint: () => {
				if (!queries.units()) return;
				if (reason === "cancel") controller.abort(new Error("Fixture ownership cancellation"));
				else expired = true;
			},
		});
		if (reason === "cancel") await expect(scan).rejects.toThrow("Fixture ownership cancellation");
		else await expect(scan).rejects.toMatchObject({ code: "GIT_STAGING_TIMEOUT" });
		clock.mockRestore();
		expect(queries.units()).toBe(1);
		queries.clear();
		expect(await store.legacyReviewFileIds()).toEqual(new Set());
		expect(queries.units()).toBe(3);
	});
}

test("cancellation during JSON scanning does not cache any earlier file from that incomplete scan", async () => {
	await publishedFiles([text(0, 2), text(1, 2)]);
	const queries = scanQueries();
	const controller = new AbortController();
	await expect(
		store.legacyReviewFileIds(undefined, {
			signal: controller.signal,
			checkpoint: () => {
				if (queries.json() === 2) controller.abort(new Error("Fixture mid-JSON cancellation"));
			},
		}),
	).rejects.toThrow("Fixture mid-JSON cancellation");
	expect(queries.json()).toBe(2);
	queries.clear();
	expect(await store.legacyReviewFileIds()).toEqual(new Set());
	expect(queries.json()).toBe(2);
});

test("JSON parsing is bounded by input bytes and rechecks the deadline immediately afterward", async () => {
	await publishedFiles([text(0, 2)]);
	const queries = scanQueries();
	const now = Date.now();
	let expired = false;
	const clock = spyOn(Date, "now").mockImplementation(() => (expired ? now + 1000 : now));
	const originalParse = JSON.parse;
	const parse = spyOn(JSON, "parse").mockImplementation((...args) => {
		const result = originalParse(...args);
		expired = true;
		return result;
	});
	restores.push(
		() => parse.mockRestore(),
		() => clock.mockRestore(),
	);
	await expect(store.legacyReviewFileIds(undefined, { deadline: now + 100 })).rejects.toMatchObject(
		{ code: "GIT_STAGING_TIMEOUT" },
	);
	parse.mockRestore();
	clock.mockRestore();
	expect(queries.json()).toBe(1);
	queries.clear();
	expect(await store.legacyReviewFileIds()).toEqual(new Set());
	expect(queries.json()).toBe(1);
});

test("unchanged immutable versions reuse bounded detection results across store connections", async () => {
	await publishedFiles([text(0, 2), text(1, 2)]);
	let queries = scanQueries();
	expect(await store.legacyReviewFileIds()).toEqual(new Set());
	expect(queries.json()).toBe(2);
	queries.clear();
	expect(await store.legacyReviewFileIds()).toEqual(new Set());
	expect(queries.json()).toBe(0);
	expect(queries.units()).toBe(0);
	store.close();
	const gitDir = join(root, "git");
	const reopened = await ChangelistStore.open({
		root,
		gitDir,
		directory: join(gitDir, "narrafork", "changelists"),
		index: join(gitDir, "index"),
		key: root,
	});
	if (!reopened) throw new Error("Expected reopened store");
	store = reopened;
	queries = scanQueries();
	expect(await store.legacyReviewFileIds()).toEqual(new Set());
	expect(queries.json()).toBe(0);
	expect(queries.units()).toBe(0);
});

test("invalid JSON remains a failure after repeated scans rather than a cached clean version", async () => {
	const [file] = await publishedFiles([text(0, 2)]);
	store.db
		.query("UPDATE file_snapshots SET ownership_json='not-json' WHERE version_id=?")
		.run(file.version_id);
	const queries = scanQueries();
	for (let i = 0; i < 2; i++)
		await expect(store.legacyReviewFileIds()).rejects.toBeInstanceOf(SyntaxError);
	expect(queries.json()).toBe(2);
});

test("sixteen small files share a transaction and the final partial batch is committed", async () => {
	const draft = await store.draft(null, "tree");
	const batches = captureBatches(draft);
	const files = Array.from({ length: 35 }, (_, index) => binary(index));
	await store.putFiles(draft, files);
	expect(batches.map((batch) => batch.files)).toEqual([16, 16, 3]);
	expect(batches.map((batch) => batch.records)).toEqual([48, 48, 9]);
	expect(store.fileIds()).toEqual([]);
	for (const file of files) expect(store.loadFile(file.fileId, draft)).toEqual(file);
});

test("pending SQL bytes bound batches before sixteen files", async () => {
	const draft = await store.draft(null, "tree");
	const batches = captureBatches(draft);
	await store.putFiles(draft, [binary(0, 700_000), binary(1, 700_000), binary(2, 700_000)]);
	expect(batches.map((batch) => batch.files)).toEqual([2, 1]);
});

test("4096 SQL records finish a batch before the next file", async () => {
	const draft = await store.draft(null, "tree");
	const batches = captureBatches(draft);
	await store.putFiles(draft, [text(0, 2045), text(1, 2045), binary(2)]);
	expect(batches).toEqual([
		{ files: 2, records: 4096 },
		{ files: 1, records: 3 },
	]);
});

test("oversized files retain the single-file path between small batches", async () => {
	const draft = await store.draft(null, "tree");
	const batches = captureBatches(draft);
	const single = spyOn(store, "putFile");
	restores.push(() => single.mockRestore());
	const files = [binary(0), binary(1, 2 * 1024 * 1024), text(2, 4094), binary(3)];
	await store.putFiles(draft, files);
	expect(single).toHaveBeenCalledTimes(2);
	expect(batches.map((batch) => batch.files)).toEqual([1, 1, 1, 1]);
	for (const file of files) expect(store.loadFile(file.fileId, draft)).toEqual(file);
});

test("a SQL failure rolls back its whole batch and keeps the stable observation", async () => {
	const stable = await store.draft(null, "tree");
	await store.putFile(stable, binary(99));
	await store.publish(stable, store.state(), null, "tree");
	const state = store.state();
	const draft = await store.draft(null, "tree");
	store.db.exec(
		"CREATE TRIGGER fixture_failure BEFORE INSERT ON file_snapshots WHEN NEW.file_id='file-17' BEGIN SELECT RAISE(ABORT,'Fixture batch failure'); END",
	);
	await expect(
		store.putFiles(
			draft,
			Array.from({ length: 20 }, (_, index) => binary(index)),
		),
	).rejects.toThrow("Fixture batch failure");
	expect(store.fileIds(draft)).toHaveLength(16);
	expect(store.loadFile("file-16", draft)).toBeNull();
	expect(
		store.db.query("SELECT 1 FROM file_snapshots WHERE version_id='version-16'").get(),
	).toBeNull();
	expect(store.state()).toEqual(state);
	expect(store.fileIds()).toHaveLength(1);
});

for (const size of ["small", "large"] as const) {
	for (const reason of ["cancel", "deadline"] as const) {
		test(`${reason} stops a locked ${size} write before the next BEGIN retry`, async () => {
			const draft = await store.draft(null, "tree");
			const blocker = new Database(store.path);
			blocker.exec("BEGIN IMMEDIATE");
			const controller = new AbortController();
			let deadline = Number.POSITIVE_INFINITY;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const exec = store.db.exec.bind(store.db);
			let attempts = 0;
			const spy = spyOn(store.db, "exec").mockImplementation((sql) => {
				if (sql === "BEGIN IMMEDIATE" && ++attempts === 1) {
					deadline = performance.now() + 40;
					timer = setTimeout(() => controller.abort(new Error("Fixture locked cancellation")), 40);
				}
				return exec(sql);
			});
			try {
				await expect(
					store.putFiles(draft, [binary(0, size === "large" ? 2 * 1024 * 1024 : 8)], {
						signal: reason === "cancel" ? controller.signal : undefined,
						checkpoint: () => {
							if (reason === "deadline" && performance.now() >= deadline)
								throw new Error("Fixture locked deadline");
						},
					}),
				).rejects.toThrow(
					reason === "cancel" ? "Fixture locked cancellation" : "Fixture locked deadline",
				);
			} finally {
				spy.mockRestore();
				clearTimeout(timer);
				blocker.exec("ROLLBACK");
				blocker.close();
			}
			expect(attempts).toBeGreaterThan(0);
			expect(store.fileIds(draft)).toEqual([]);
			expect(store.db.query("SELECT 1 FROM file_snapshots").get()).toBeNull();
		});
	}
}

test("complete observation evidence binds completion to the source HEAD and tree", async () => {
	const draft = await store.draft(null, "tree");
	const expected = store.state();
	expect(store.completeObservation({ ...expected, observation_id: draft, head_tree: "tree" })).toBe(
		false,
	);
	await store.publish(draft, expected, null, "tree");
	const ready = store.state();
	expect(store.completeObservation(ready)).toBe(true);
	expect(store.completeObservation({ ...ready, head_oid: "another-head" })).toBe(false);
	expect(store.completeObservation({ ...ready, head_tree: "another-tree" })).toBe(false);
	store.db.query("UPDATE observations SET complete=0 WHERE id=?").run(draft);
	expect(store.completeObservation(ready)).toBe(false);
});

for (const field of [
	"state",
	"reason",
	"head_oid",
	"head_tree",
	"active_list_id",
	"scanned_at",
] as const) {
	test(`same-version ${field} changes fence publication, reuse and stale error marks`, async () => {
		const stable = await store.draft(null, "tree");
		await store.putFile(stable, binary(99));
		await store.publish(stable, store.state(), null, "tree");
		const expected = store.state(),
			previous = store.fileIds();
		const draft = await store.draft(null, "tree");
		store.db.query("INSERT INTO change_lists(id,name,created_at) VALUES('other','Other',0)").run();
		const value =
			field === "state"
				? "conflict"
				: field === "scanned_at"
					? (expected.scanned_at as number) + 1
					: field === "active_list_id"
						? "other"
						: "other producer";
		store.db.query(`UPDATE workspace_state SET ${field}=? WHERE id=1`).run(value);
		const changed = store.state();
		expect(store.assertVersion(expected.generation, expected.observation_id)).toEqual(changed);
		expect(() => store.reuse(expected)).toThrow("observation state changed");
		await expect(store.publish(draft, expected, null, "tree")).rejects.toMatchObject({
			code: "GIT_STAGING_STALE_VERSION",
		});
		expect(await store.mark("incomplete", "stale producer", undefined, expected)).toBeNull();
		expect(store.state()).toEqual(changed);
		expect(store.fileIds()).toEqual(previous);
		expect(store.db.query("SELECT complete FROM observations WHERE id=?").get(draft)).toEqual({
			complete: 0,
		});
	});
}

test("guarded failure marking checks the state again inside its write transaction", async () => {
	const expected = store.state();
	const transaction = store.transaction.bind(store);
	let injected = false;
	const spy = spyOn(store, "transaction").mockImplementation(async (...args) => {
		if (!injected) {
			injected = true;
			await transaction(() =>
				store.db
					.query("UPDATE workspace_state SET state='conflict',reason='another producer' WHERE id=1")
					.run(),
			);
		}
		return transaction(...args);
	});
	restores.push(() => spy.mockRestore());
	expect(await store.mark("incomplete", "ours", undefined, expected)).toBeNull();
	expect(store.state()).toMatchObject({
		state: "conflict",
		reason: "another producer",
		generation: expected.generation,
	});
});

test("cancellation and deadline checkpoints stop between complete batches", async () => {
	for (const reason of ["cancel", "deadline"]) {
		const draft = await store.draft(null, "tree");
		const controller = new AbortController();
		let afterFirst = false;
		const exec = store.db.exec.bind(store.db);
		const spy = spyOn(store.db, "exec").mockImplementation((sql) => {
			const result = exec(sql);
			if (sql === "COMMIT") {
				afterFirst = true;
				if (reason === "cancel") controller.abort(new Error("Fixture cancellation"));
			}
			return result;
		});
		try {
			await expect(
				store.putFiles(
					draft,
					Array.from({ length: 20 }, (_, index) => binary(index)),
					{
						signal: controller.signal,
						checkpoint: () => {
							if (reason === "deadline" && afterFirst) throw new Error("Fixture deadline");
						},
					},
				),
			).rejects.toThrow(reason === "cancel" ? "Fixture cancellation" : "Fixture deadline");
		} finally {
			spy.mockRestore();
		}
		expect(store.fileIds(draft)).toHaveLength(16);
		expect(store.fileIds()).toEqual([]);
	}
});
