import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { IDBObjectStore as FakeObjectStore, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
	draftEditable,
	EDITOR_DRAFT_LIMITS,
	type EditorDraftInput,
	type EditorDraftMetadata,
	EditorDraftStore,
} from "./editor-draft-store";

let factory: IDBFactory, store: EditorDraftStore, now: number;
const scope = {
	recoveryKey: "server-owner",
	resourceKey: "server-full-binding",
	narratorId: "actual-narrator",
	deviceId: "local",
	origin: "reference" as const,
	canonicalPath: "/repo/a",
};
const input = (writerId = "realm-a", revision = 1): EditorDraftInput => ({
	scope,
	writerId,
	modelLifetime: "model-lifetime-a",
	revision,
	alternativeVersionId: revision,
	length: 5,
	baseVersion: { hash: "original-disk-hash", hashKind: "v1-decoded-sha256" },
	encoding: "utf-8",
	protocol: "v1",
	bodyCodec: "utf8-v1",
});
beforeEach(() => {
	globalThis.IDBKeyRange = IDBKeyRange;
	factory = new IDBFactory();
	now = 1_000_000;
	store = new EditorDraftStore(
		() => factory,
		EDITOR_DRAFT_LIMITS,
		() => now,
		"test-drafts",
	);
});
afterEach(async () => {
	await store.close();
});
const write = (writer = "realm-a", revision = 1, text = "hello") =>
	store.write({ ...input(writer, revision), length: text.length }, new Blob([text]));
const mutate = async (name: string, action: (db: IDBDatabase) => IDBTransaction) => {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const r = factory.open(name, 1);
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
	const tx = action(db);
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
	});
	db.close();
};
test("uniform raw checkpoint format is constant metadata, not one record per newline", async () => {
	const body = new TextEncoder().encode("x\r\n".repeat(1000)),
		tags = new Uint8Array(1000).fill(2),
		digest = bytesToHex(sha256(body));
	const row = await store.write(
		{
			...input(),
			length: 2000,
			protocol: "raw-v2",
			bodyCodec: "raw-v2",
			rawDigest: digest,
			textDigest: bytesToHex(sha256(new TextEncoder().encode("x\n".repeat(1000)))),
			bom: "none",
			preferredEol: "CRLF",
			baseVersion: { hash: digest, hashKind: "raw-sha256" },
			format: {
				revision: 1,
				codec: "eol-uniform-v1",
				root: { tag: 2, count: 1000, digest: bytesToHex(sha256(tags)) },
			},
		},
		new Blob([body]),
	);
	expect(draftEditable(row)).toBe(true);
	expect(JSON.stringify(row.format).length).toBeLessThan(256);
	expect(await store.readFormat(row, scope.recoveryKey)).toEqual(tags);
	await expect(
		store.readFormat(
			{
				...row,
				format: {
					revision: 1,
					codec: "eol-uniform-v1",
					root: { tag: 1, count: 1000, digest: bytesToHex(sha256(tags)) },
				},
			},
			scope.recoveryKey,
		),
	).rejects.toThrow("EDITOR_FORMAT_UNAVAILABLE");
	expect(draftEditable({ ...row, format: undefined })).toBe(false);
});
test("raw checkpoint publishes body and sidecar at one revision, without large format metadata", async () => {
	const digest = "5".repeat(64),
		tags = Uint8Array.from({ length: 100_000 }, (_, i) => (i % 3) + 1);
	const row = await store.write(
		{
			...input(),
			protocol: "raw-v2",
			bodyCodec: "raw-v2",
			rawDigest: digest,
			textDigest: digest,
			bom: "none",
			preferredEol: "LF",
			baseVersion: { hash: digest, hashKind: "raw-sha256" },
		},
		new Blob(["hello"]),
		undefined,
		tags,
	);
	expect(JSON.stringify(row).length).toBeLessThan(2048);
	expect(await store.readFormat(row, scope.recoveryKey)).toEqual(tags);
	await store.close();
	expect(await store.readFormat(row, scope.recoveryKey)).toEqual(tags);
	await mutate("test-drafts", (db) => {
		const tx = db.transaction("chunks", "readwrite");
		tx.objectStore("chunks").delete([row.generation, 1024]);
		return tx;
	});
	await expect(store.readFormat(row, scope.recoveryKey)).rejects.toThrow(
		"EDITOR_FORMAT_UNAVAILABLE",
	);
	expect(await (await store.read(row, scope.recoveryKey)).text()).toBe("hello");
});
test("raw sidecar is counted against total quota and an older deletion cannot delete its replacement", async () => {
	const limited = new EditorDraftStore(
		() => factory,
		{ ...EDITOR_DRAFT_LIMITS, bytes: 10 },
		() => now,
		"sidecar-quota",
	);
	try {
		const tags = Uint8Array.of(1, 2, 3),
			first = await limited.write(input(), new Blob(["hello"]), undefined, tags);
		await expect(
			limited.write({ ...input("other") }, new Blob(["hi"]), undefined, tags),
		).rejects.toThrow("EDITOR_DRAFT_LIMIT");
		await limited.removeSaved(
			first.writerId,
			scope.resourceKey,
			first.revision,
			first.modelLifetime,
		);
		const second = await limited.write(
			{ ...input(), revision: 2 },
			new Blob(["new"]),
			undefined,
			tags,
		);
		await limited.removeSaved(
			first.writerId,
			scope.resourceKey,
			first.revision,
			first.modelLifetime,
		);
		expect(await limited.readFormat(second, scope.recoveryKey)).toEqual(tags);
	} finally {
		await limited.close();
	}
});
test("independent database separates metadata from chunks; never reads body during discovery", async () => {
	const row = await write();
	expect(await store.list(scope.recoveryKey)).toEqual([row]);
	expect(await store.list("different-user-or-narrator")).toEqual([]);
	expect(store.diagnostics.bodyReads).toBe(0);
	expect(await (await store.read(row, scope.recoveryKey)).text()).toBe("hello");
	expect(store.diagnostics.bodyReads).toBe(1);
	expect(row.schemaVersion).toBe(1);
	expect(row).not.toHaveProperty("docId");
	expect(row).not.toHaveProperty("token");
	expect(row).not.toHaveProperty("confirmationToken");
	expect(row).not.toHaveProperty("rawDigest");
	expect(row).not.toHaveProperty("format");
});
test("exact 32-entry boundary refuses a 33rd without evicting another window", async () => {
	for (let i = 0; i < 32; i++) await write(`realm-${i}`);
	await expect(write("realm-overflow")).rejects.toThrow("EDITOR_DRAFT_LIMIT");
	expect(await store.list(scope.recoveryKey)).toHaveLength(32);
	expect(store.diagnostics.bodyReads).toBe(0);
});
test("128MiB accounting includes old complete body and staged replacement", async () => {
	const limits = { ...EDITOR_DRAFT_LIMITS, bytes: 128, entryBytes: 64, chunkBytes: 16 };
	const limited = new EditorDraftStore(
		() => factory,
		limits,
		() => now,
		"byte-boundary",
	);
	try {
		await limited.write(input("a"), new Blob([new Uint8Array(64)]));
		await limited.write(input("b"), new Blob([new Uint8Array(64)]));
		await expect(limited.write(input("c"), new Blob([new Uint8Array(1)]))).rejects.toThrow(
			"EDITOR_DRAFT_LIMIT",
		);
		await expect(limited.write(input("a", 2), new Blob([new Uint8Array(1)]))).rejects.toThrow(
			"EDITOR_DRAFT_LIMIT",
		);
		expect((await limited.list(scope.recoveryKey)).reduce((sum, row) => sum + row.bytes, 0)).toBe(
			128,
		);
	} finally {
		await limited.close();
	}
});
test("actual 128MiB and 64MiB byte ceilings apply to chunk records, not just scaled estimates", async () => {
	const chunk = new Uint8Array(64 * 1024);
	const body = new Blob(Array.from({ length: 1024 }, () => chunk));
	const raw = {
		...input("large-a"),
		protocol: "raw-v2" as const,
		bodyCodec: "future-raw-codec",
		length: 0,
	};
	await store.write(raw, body);
	await store.write({ ...raw, writerId: "large-b" }, body);
	await expect(
		store.write({ ...raw, writerId: "one-byte-over" }, new Blob([new Uint8Array(1)])),
	).rejects.toThrow("EDITOR_DRAFT_LIMIT");
	await expect(
		store.write({ ...raw, writerId: "single-too-large" }, new Blob([body, new Uint8Array(1)])),
	).rejects.toThrow("EDITOR_DRAFT_LIMIT");
	const rows = await store.list(scope.recoveryKey);
	expect(rows).toHaveLength(2);
	expect(rows.reduce((sum, row) => sum + row.bytes, 0)).toBe(128 * 1024 * 1024);
	expect(rows.every((row) => row.chunks === 1024 && !draftEditable(row))).toBe(true);
	expect(store.diagnostics.bodyReads).toBe(0);
}, 30_000);
test("default budgets are exactly 32 / 128MiB / 7 days / 64MiB per draft", () => {
	expect(EDITOR_DRAFT_LIMITS.count).toBe(32);
	expect(EDITOR_DRAFT_LIMITS.bytes).toBe(128 * 1024 * 1024);
	expect(EDITOR_DRAFT_LIMITS.ttlMs).toBe(7 * 86400_000);
	expect(EDITOR_DRAFT_LIMITS.entryBytes).toBe(64 * 1024 * 1024);
});
test("TTL boundary expires without body scans and reclaims quota", async () => {
	for (let i = 0; i < 32; i++) await write(`realm-${i}`);
	now += EDITOR_DRAFT_LIMITS.ttlMs - 1;
	expect(await store.list(scope.recoveryKey)).toHaveLength(32);
	now++;
	expect(await store.list(scope.recoveryKey)).toHaveLength(0);
	await write("new-realm");
	expect(await store.list(scope.recoveryKey)).toHaveLength(1);
	expect(store.diagnostics.bodyReads).toBe(0);
});
test("concurrent windows cannot overwrite or delete one another", async () => {
	const other = new EditorDraftStore(
		() => factory,
		EDITOR_DRAFT_LIMITS,
		() => now,
		"test-drafts",
	);
	try {
		const [a, b] = await Promise.all([
			write("realm-a"),
			other.write(input("realm-b"), new Blob(["other"])),
		]);
		expect(await store.list(scope.recoveryKey)).toHaveLength(2);
		expect(await store.remove(a, "realm-b")).toBe(false);
		expect(await other.remove(b, "realm-a")).toBe(false);
		expect(await (await store.read(a, scope.recoveryKey)).text()).toBe("hello");
		expect(await (await other.read(b, scope.recoveryKey)).text()).toBe("other");
	} finally {
		await other.close();
	}
});
test("retained and reopened model lifetimes in one realm never overwrite each other's checkpoint", async () => {
	const old = await write();
	const reopened = await store.write(
		{ ...input(), modelLifetime: "model-lifetime-new", length: 8 },
		new Blob(["reopened"]),
	);
	expect(reopened.id).not.toBe(old.id);
	expect(await store.list(scope.recoveryKey)).toHaveLength(2);
	await store.removeSaved("realm-a", scope.resourceKey, 1, "model-lifetime-new");
	expect(await store.list(scope.recoveryKey)).toEqual([old]);
	expect(await (await store.read(old, scope.recoveryKey)).text()).toBe("hello");
});
test("revision deletion is generation CAS; late old cleanup preserves newer body", async () => {
	const old = await write(),
		next = await write("realm-a", 2, "newer");
	expect(await store.remove(old, "realm-a")).toBe(false);
	expect(await store.list(scope.recoveryKey)).toEqual([next]);
	expect(await store.remove(next, "realm-a")).toBe(true);
	expect(await store.remove(next, "realm-a")).toBe(false);
});
test("aborted checkpoint retains old complete generation and cannot resurrect after discard", async () => {
	const old = await write();
	const controller = new AbortController();
	const blob = new Blob(["newer"]);
	blob.slice = () => {
		controller.abort();
		return new Blob(["newer"]);
	};
	await expect(store.write(input("realm-a", 2), blob, controller.signal)).rejects.toThrow();
	expect(await store.list(scope.recoveryKey)).toEqual([old]);
	expect(await store.remove(old, "realm-a")).toBe(true);
	expect(await store.list(scope.recoveryKey)).toEqual([]);
});
test("a failed publish transaction leaves the old checkpoint fully readable", async () => {
	const old = await write();
	const body = new Blob(["newer"]);
	body.slice = () => {
		throw new DOMException("quota", "QuotaExceededError");
	};
	await expect(store.write(input("realm-a", 2), body)).rejects.toThrow("quota");
	expect(await (await store.read(old, scope.recoveryKey)).text()).toBe("hello");
});
test.each([
	"missing",
	"corrupt",
] as const)("%s chunks are rejected, not installed", async (mode) => {
	const row = await write();
	await mutate("test-drafts", (db) => {
		const tx = db.transaction("chunks", "readwrite");
		if (mode === "missing") tx.objectStore("chunks").delete([row.generation, 0]);
		else
			tx.objectStore("chunks").put({
				generation: row.generation,
				seq: 0,
				bytes: new TextEncoder().encode("wrong"),
			});
		return tx;
	});
	await expect(store.read(row, scope.recoveryKey)).rejects.toThrow("EDITOR_DRAFT_CORRUPT");
});
test("unavailable IndexedDB reports failure without synchronous constructor failure", async () => {
	const unavailable = new EditorDraftStore(() => {
		throw new Error("disabled");
	});
	await expect(unavailable.write(input(), new Blob(["hello"]))).rejects.toThrow("disabled");
	await expect(unavailable.list(scope.recoveryKey)).rejects.toThrow("disabled");
});
test("unknown schema, codecs and all incomplete raw-v2 format records are read-only", async () => {
	const row = await write();
	expect(draftEditable(row)).toBe(true);
	for (const changed of [
		{ schemaVersion: 2 },
		{ bodyCodec: "future-codec" },
		{ encoding: "unknown" },
		{ protocol: "raw-v2", rawDigest: "a", textDigest: "b" },
		{ operation: { status: "query-first", snapshotRevision: 1 } },
	])
		expect(draftEditable({ ...row, ...changed } as EditorDraftMetadata)).toBe(false);
});
test("unknown-operation write-ahead marker retains operation association without credentials", async () => {
	await write();
	await store.markOperation(
		"realm-a",
		scope.resourceKey,
		{
			status: "query-first",
			operationId: "op-before-apply",
			snapshotRevision: 1,
		},
		"model-lifetime-a",
	);
	const [row] = await store.list(scope.recoveryKey);
	expect(row.operation).toEqual({
		status: "query-first",
		operationId: "op-before-apply",
		snapshotRevision: 1,
	});
	expect(draftEditable(row)).toBe(false);
});
test("authorization owner mismatch prevents any body read", async () => {
	const row = await write();
	await expect(store.read(row, "client-path-or-jwt-hint")).rejects.toThrow("EDITOR_DRAFT_CORRUPT");
	expect(store.diagnostics.bodyReads).toBe(0);
});
test("newer DB schema is not guessed or destroyed", async () => {
	await new Promise<void>((resolve, reject) => {
		const r = factory.open("future", 2);
		r.onupgradeneeded = () => r.result.createObjectStore("future-format");
		r.onsuccess = () => {
			r.result.close();
			resolve();
		};
		r.onerror = () => reject(r.error);
	});
	const future = new EditorDraftStore(
		() => factory,
		EDITOR_DRAFT_LIMITS,
		() => now,
		"future",
	);
	await expect(future.list(scope.recoveryKey)).rejects.toThrow();
});
test("active bounded lease protects a seven-day-old draft, but cannot resurrect deleted generations", async () => {
	const row = await write();
	now += EDITOR_DRAFT_LIMITS.ttlMs;
	await store.protect(row, "realm-a");
	expect(await store.list(scope.recoveryKey)).toHaveLength(1);
	await write("other-realm");
	expect(await store.list(scope.recoveryKey)).toHaveLength(2);
	await store.remove(row, "realm-a");
	await store.protect(row, "realm-a");
	expect(await store.list(scope.recoveryKey)).toHaveLength(1);
	now += EDITOR_DRAFT_LIMITS.ttlMs;
	expect(await store.list(scope.recoveryKey)).toHaveLength(0);
});
test("obsolete interrupted chunks are reclaimed from bounded write manifests without reading bodies", async () => {
	await write();
	await mutate("test-drafts", (db) => {
		const tx = db.transaction(["writes", "chunks"], "readwrite");
		tx.objectStore("writes").put({
			id: "crashed-writer",
			generation: "incomplete",
			bytes: 5,
			revision: 1,
			expires: now - 1,
		});
		tx.objectStore("chunks").put({ generation: "incomplete", seq: 0, bytes: new Uint8Array(5) });
		return tx;
	});
	await write("new-writer");
	await mutate("test-drafts", (db) => {
		const tx = db.transaction(["writes", "chunks"], "readonly");
		const r = tx.objectStore("chunks").get(["incomplete", 0]);
		r.onsuccess = () => expect(r.result).toBeUndefined();
		const w = tx.objectStore("writes").getAll(undefined, 33);
		w.onsuccess = () => expect(w.result).toEqual([]);
		return tx;
	});
	expect(store.diagnostics.bodyReads).toBe(0);
});
test("schema-one opens persist checkpoints across connections, unknown record versions remain export-only", async () => {
	const row = await write();
	await store.close();
	const reopened = new EditorDraftStore(
		() => factory,
		EDITOR_DRAFT_LIMITS,
		() => now,
		"test-drafts",
	);
	try {
		expect(await reopened.list(scope.recoveryKey)).toEqual([row]);
		await mutate("test-drafts", (db) => {
			const tx = db.transaction("metadata", "readwrite");
			tx.objectStore("metadata").put({ ...row, schemaVersion: 99 });
			return tx;
		});
		const [unknown] = await reopened.list(scope.recoveryKey);
		expect(draftEditable(unknown)).toBe(false);
		expect(await (await reopened.read(unknown, scope.recoveryKey)).text()).toBe("hello");
	} finally {
		await reopened.close();
	}
});
test("runtime extra credentials are never projected into persisted metadata", async () => {
	const row = await store.write(
		{
			...input(),
			docId: "SECRET_DOC",
			token: "SECRET_JWT",
			confirmationToken: "SECRET_CONFIRM",
			scope: { ...scope, token: "SECRET_NESTED" },
		} as EditorDraftInput,
		new Blob(["hello"]),
	);
	expect(JSON.stringify(row)).not.toContain("SECRET");
});
test("single draft exceeding the transfer ceiling is rejected before IndexedDB body access", async () => {
	const limited = new EditorDraftStore(
		() => factory,
		{ ...EDITOR_DRAFT_LIMITS, entryBytes: 4 },
		() => now,
		"entry-limit",
	);
	await expect(limited.write(input(), new Blob(["hello"]))).rejects.toThrow("EDITOR_DRAFT_LIMIT");
	expect(limited.diagnostics.bodyReads).toBe(0);
	expect(limited.diagnostics.published).toBe(0);
});
test("an actual publication transaction abort keeps the old complete metadata and chunks", async () => {
	const old = await write();
	const original = FakeObjectStore.prototype.put;
	const fault = spyOn(FakeObjectStore.prototype, "put").mockImplementation(function (
		this: IDBObjectStore,
		...args
	) {
		const result = original.apply(this, args);
		if (this.name === "metadata" && args[0].revision === 2) this.transaction.abort();
		return result;
	});
	try {
		await expect(write("realm-a", 2, "newer")).rejects.toThrow();
	} finally {
		fault.mockRestore();
	}
	expect(await store.list(scope.recoveryKey)).toEqual([old]);
	expect(await (await store.read(old, scope.recoveryKey)).text()).toBe("hello");
});
test("save receipt fences a matching staged revision before its body can publish", async () => {
	const old = await write();
	let entered!: () => void, resume!: () => void;
	const paused = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const released = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const body = new Blob(["newer"]);
	body.slice = () =>
		({
			arrayBuffer: async () => {
				entered();
				await released;
				return new TextEncoder().encode("newer").buffer;
			},
		}) as Blob;
	const late = store.write(input("realm-a", 2), body);
	await paused;
	await store.removeSaved("realm-a", scope.resourceKey, 2, "model-lifetime-a");
	resume();
	await expect(late).rejects.toThrow("EDITOR_DRAFT_CANCELLED");
	expect(await store.list(scope.recoveryKey)).toEqual([old]);
});
test("same realm model lifetime changes prevent numeric revision reuse from deleting a different draft", async () => {
	const row = await write();
	await store.removeSaved("realm-a", scope.resourceKey, 1, "new-model-lifetime");
	expect(await store.list(scope.recoveryKey)).toEqual([row]);
});
