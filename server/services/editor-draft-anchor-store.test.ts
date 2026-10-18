import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreateEditorDraftAnchorInput } from "../../shared/editor-document";
import { testEnvironment } from "../../tests/preload";
import { EDITOR_DRAFT_ANCHOR_LIMITS, EditorDraftAnchorStore } from "./editor-draft-anchor-store";

let root: string, store: EditorDraftAnchorStore, now: number;
const owner = "a".repeat(64),
	resourceKey = "b".repeat(64);
const input = (writerId = "writer-a", revision = 1): CreateEditorDraftAnchorInput => ({
	writerId,
	resourceKey,
	revision,
	modelLifetime: "model-a",
	deviceId: "local",
	origin: "reference",
});
beforeEach(async () => {
	root = await mkdtemp(join(testEnvironment.isolatedHome, "draft-anchor-"));
	now = Date.now();
	store = new EditorDraftAnchorStore(join(root, "private"), EDITOR_DRAFT_ANCHOR_LIMITS, () => now);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const create = async (writer = "writer-a") => {
	const row = await store.create(owner, input(writer));
	await store.publish(owner, row.anchorId);
	return row;
};
test("published anchor survives a cold store instance and contains no path or transfer credential", async () => {
	const row = await create();
	const cold = new EditorDraftAnchorStore(store.root);
	expect((await cold.get(owner, row.anchorId)).status).toBe("no-dispatch");
	const json = await readFile(join(store.root, "anchors.json"), "utf8");
	for (const key of ["docId", "token", "confirmationToken", "canonicalPath", "body"])
		expect(json).not.toContain(`"${key}"`);
	expect(row.checkpointGeneration).not.toBe(row.anchorId);
});
test("durable operation association survives restart and is isolated by owner, writer and resource", async () => {
	const a = await create("a"),
		b = await create("b");
	const operation = { operationId: crypto.randomUUID(), snapshotRevision: 7 };
	await store.beforeDispatch(owner, "a", resourceKey, "model-a", operation);
	const cold = new EditorDraftAnchorStore(store.root);
	expect((await cold.get(owner, a.anchorId)).operation).toEqual(operation);
	expect((await cold.get(owner, b.anchorId)).status).toBe("no-dispatch");
	await expect(cold.get("other-user", a.anchorId)).rejects.toMatchObject({ statusCode: 404 });
	await expect(
		cold.beforeDispatch(owner, "a", "other-resource", "model-a", operation),
	).rejects.toMatchObject({ statusCode: 503 });
});
test("claim-first atomically fences a late old-lifetime dispatch without affecting another writer", async () => {
	const a = await create("a"),
		b = await create("b");
	const other = new EditorDraftAnchorStore(store.root);
	const claim = await store.claim(owner, a.anchorId);
	expect(claim).toMatchObject({ status: "no-dispatch", retired: true });
	await expect(
		other.beforeDispatch(owner, "a", resourceKey, "model-a", {
			operationId: crypto.randomUUID(),
			snapshotRevision: 2,
		}),
	).rejects.toMatchObject({ code: "EDITOR_DRAFT_WRITER_RETIRED" });
	expect((await other.get(owner, b.anchorId)).status).toBe("no-dispatch");
	const next = await other.create(owner, { ...input("a"), modelLifetime: "new-lifetime" });
	expect(next.retired).toBe(false);
});
test("dispatch-first returns query-first, never a claimed ordinary restoration", async () => {
	const a = await create();
	const operation = { operationId: crypto.randomUUID(), snapshotRevision: 1 };
	await store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", operation);
	const claim = await store.claim(owner, a.anchorId);
	expect(claim).toMatchObject({ status: "query-first", retired: false, operation });
});
test("inflight snapshots cannot manufacture a no-dispatch coverage point", async () => {
	const operation = { operationId: crypto.randomUUID(), snapshotRevision: 4 };
	const a = await store.create(owner, { ...input(), operation });
	expect((await store.claim(owner, a.anchorId)).status).toBe("query-first");
});
test("publication retires only this lifetime's old pointers, not another live writer or model", async () => {
	const a = await create("a"),
		b = await create("b");
	const lifetime = await store.create(owner, { ...input("a"), modelLifetime: "model-b" });
	await store.publish(owner, lifetime.anchorId);
	const next = await store.create(owner, input("a", 2));
	await store.publish(owner, next.anchorId);
	await expect(store.get(owner, a.anchorId)).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_UNKNOWN",
	});
	expect((await store.get(owner, b.anchorId)).status).toBe("no-dispatch");
	expect((await store.get(owner, lifetime.anchorId)).status).toBe("no-dispatch");
});
test("metadata persistence failure is a write-before-dispatch failure, not proof of application", async () => {
	const a = await create();
	const fault = spyOn(store, "persist").mockRejectedValue(new Error("fixture storage failure"));
	try {
		await expect(
			store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", {
				operationId: crypto.randomUUID(),
				snapshotRevision: 1,
			}),
		).rejects.toMatchObject({ code: "EDITOR_DRAFT_PROVENANCE_UNAVAILABLE" });
	} finally {
		fault.mockRestore();
	}
	expect((await new EditorDraftAnchorStore(store.root).get(owner, a.anchorId)).status).toBe(
		"no-dispatch",
	);
});
test("record count and bytes are bounded without deleting active unknown anchors", async () => {
	store = new EditorDraftAnchorStore(
		store.root,
		{ ...EDITOR_DRAFT_ANCHOR_LIMITS, records: 2 },
		() => now,
	);
	const a = await create("a"),
		b = await create("b");
	await store.beforeDispatch(owner, "a", resourceKey, "model-a", {
		operationId: crypto.randomUUID(),
		snapshotRevision: 1,
	});
	await expect(store.create(owner, input("c"))).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_LIMIT",
	});
	expect((await store.get(owner, a.anchorId)).status).toBe("query-first");
	expect((await store.get(owner, b.anchorId)).status).toBe("no-dispatch");
	const tiny = new EditorDraftAnchorStore(join(root, "tiny"), {
		...EDITOR_DRAFT_ANCHOR_LIMITS,
		bytes: 100,
	});
	await expect(tiny.create(owner, input())).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_LIMIT",
	});
});
test("staged, published and unknown TTLs fail closed after expiry, never report not-applied", async () => {
	const staged = await store.create(owner, input("staged"));
	now += EDITOR_DRAFT_ANCHOR_LIMITS.stagedMs;
	await expect(store.get(owner, staged.anchorId)).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_UNKNOWN",
	});
	const a = await create("a"),
		b = await create("b");
	await store.beforeDispatch(owner, "a", resourceKey, "model-a", {
		operationId: crypto.randomUUID(),
		snapshotRevision: 1,
	});
	now += EDITOR_DRAFT_ANCHOR_LIMITS.publishedMs;
	await expect(store.get(owner, b.anchorId)).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_UNKNOWN",
	});
	expect((await store.get(owner, a.anchorId)).status).toBe("query-first");
	now += EDITOR_DRAFT_ANCHOR_LIMITS.unknownMs;
	await expect(store.claim(owner, a.anchorId)).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_UNKNOWN",
	});
});
test("a new checkpoint cannot hide an existing unknown operation by omitting an IDB marker", async () => {
	const old = await create();
	const operation = { operationId: crypto.randomUUID(), snapshotRevision: 9 };
	await store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", operation);
	const next = await store.create(owner, input("writer-a", 2));
	await store.publish(owner, next.anchorId);
	expect(await store.get(owner, next.anchorId)).toMatchObject({ status: "query-first", operation });
	await expect(store.get(owner, old.anchorId)).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_UNKNOWN",
	});
});
test("a newly dispatched operation cannot be cleared by stale terminal-receipt evidence", async () => {
	await create();
	const a = { operationId: crypto.randomUUID(), snapshotRevision: 1 },
		b = { operationId: crypto.randomUUID(), snapshotRevision: 2 };
	await store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", a);
	await store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", b, [a.operationId]);
	const next = await store.create(owner, input("writer-a", 3), [a.operationId]);
	expect(next).toMatchObject({ status: "query-first", operation: b });
	expect(await store.pendingOperations(owner, "writer-a", resourceKey, "model-a")).toEqual([b]);
});
test("an input operation that is already settled produces no-dispatch and leaves no pending history", async () => {
	await create();
	const operation = { operationId: crypto.randomUUID(), snapshotRevision: 4 };
	const next = await store.create(owner, { ...input("writer-a", 2), operation }, [
		operation.operationId,
	]);
	expect(next.status).toBe("no-dispatch");
	expect(next.operation).toBeUndefined();
	expect(await store.pendingOperations(owner, "writer-a", resourceKey, "model-a")).toEqual([]);
});
test("an input operation without an id remains unverifiable even when the id-only history is settled", async () => {
	await create();
	const prior = { operationId: crypto.randomUUID(), snapshotRevision: 1 };
	await store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", prior);
	const anonymous = { snapshotRevision: 2 };
	const next = await store.create(owner, { ...input("writer-a", 2), operation: anonymous }, [
		prior.operationId,
	]);
	expect(next.status).toBe("query-first");
	expect(next.operation).toEqual(anonymous);
});
test("at most eight unresolved operations are retained; overflow fails before another dispatch", async () => {
	const anchor = await create();
	for (let revision = 1; revision <= 8; revision++)
		await store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", {
			operationId: crypto.randomUUID(),
			snapshotRevision: revision,
		});
	await expect(
		store.beforeDispatch(owner, "writer-a", resourceKey, "model-a", {
			operationId: crypto.randomUUID(),
			snapshotRevision: 9,
		}),
	).rejects.toMatchObject({ code: "EDITOR_DRAFT_PROVENANCE_UNAVAILABLE" });
	expect((await store.get(owner, anchor.anchorId)).operation?.snapshotRevision).toBe(8);
});
test("releasing a confirmed-deleted checkpoint never removes retirement fences or a replacement pointer", async () => {
	const old = await create();
	const next = await store.create(owner, input("writer-a", 2));
	await store.publish(owner, next.anchorId);
	expect(await store.release(owner, old.anchorId)).toEqual({ released: false });
	expect((await store.get(owner, next.anchorId)).status).toBe("no-dispatch");
	await store.claim(owner, next.anchorId);
	expect(await store.release(owner, next.anchorId)).toEqual({ released: false });
	const other = await create("writer-other");
	expect(await store.release(owner, other.anchorId)).toEqual({ released: true });
	await expect(store.get(owner, other.anchorId)).rejects.toMatchObject({
		code: "EDITOR_DRAFT_ANCHOR_UNKNOWN",
	});
});
test("corrupt, unknown-schema and oversized journals never generate trusted no-dispatch records", async () => {
	await create();
	const path = join(store.root, "anchors.json");
	const original = await readFile(path, "utf8");
	for (const text of [
		"incomplete json",
		original.replace('"version":1', '"version":2'),
		" ".repeat(EDITOR_DRAFT_ANCHOR_LIMITS.bytes + 1),
	]) {
		await writeFile(path, text, { mode: 0o600 });
		await expect(
			new EditorDraftAnchorStore(store.root).create(owner, input("new")),
		).rejects.toMatchObject({ code: "EDITOR_DRAFT_PROVENANCE_UNAVAILABLE" });
	}
});
