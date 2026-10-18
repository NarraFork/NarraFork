import { expect, spyOn, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { EditorRawSeal } from "@shared/editor-document";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { EDITOR_ATTEMPT_MAX_CHUNKS, EditorAttemptSpool } from "./editor-attempt-spool";

globalThis.IDBKeyRange = IDBKeyRange;
const seal = (bytes: Uint8Array): EditorRawSeal => ({
	protocol: "raw-v2",
	hashKind: "raw-sha256",
	bytes: bytes.length,
	rawDigest: bytesToHex(sha256(bytes)),
	textDigest: "0".repeat(64),
	formatDigest: "0".repeat(64),
	textLength: bytes.length,
	newlines: 0,
});
test("IDB chunks stay immutable across retries; sequential checkpoint adapter does not join body", async () => {
	const spool = await EditorAttemptSpool.create(17, "model-A", new IDBFactory());
	try {
		await spool.append(Uint8Array.of(1, 2));
		await spool.append(Uint8Array.of(3, 4, 5));
		spool.finish(seal(Uint8Array.of(1, 2, 3, 4, 5)));
		expect(spool.storage).toBe("indexeddb");
		expect(await spool.read(0)).toEqual(await spool.read(0));
		const body = spool.body();
		expect(new Uint8Array(await body.slice(0, 3).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
		expect(new Uint8Array(await body.slice(3, 5).arrayBuffer())).toEqual(Uint8Array.of(4, 5));
		await expect(spool.append(Uint8Array.of(9))).rejects.toThrow("EDITOR_ATTEMPT_LIMIT");
	} finally {
		await spool.dispose();
	}
});
test("mid-attempt quota migrates only the IDB prefix into the one RAM slot", async () => {
	const factory = new IDBFactory(),
		spool = await EditorAttemptSpool.create(8, "lifetime", factory);
	await spool.append(Uint8Array.of(1, 2));
	const original = IDBObjectStore.prototype.add;
	const fault = spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
		this: IDBObjectStore,
		value,
		key,
	) {
		if (this.name === "chunks") throw new DOMException("quota", "QuotaExceededError");
		return original.call(this, value, key);
	});
	try {
		await spool.append(Uint8Array.of(3));
	} finally {
		fault.mockRestore();
	}
	try {
		expect(spool.storage).toBe("memory");
		expect(spool.revision).toBe(8);
		expect((await spool.read(0)).data).toEqual(Uint8Array.of(1, 2));
		expect((await spool.read(1)).offset).toBe(2);
		await expect(
			EditorAttemptSpool.create(9, "other", null as unknown as IDBFactory),
		).rejects.toThrow("EDITOR_ATTEMPT_MEMORY_BUSY");
		const other = await EditorAttemptSpool.create(9, "other", factory);
		expect(other.storage).toBe("indexeddb");
		await other.dispose();
	} finally {
		await spool.dispose();
	}
	const next = await EditorAttemptSpool.create(10, "new", null as unknown as IDBFactory);
	expect(next.storage).toBe("memory");
	await next.dispose();
});
test("RAM output is bounded at 20MiB and disposal cannot release another attempt's slot", async () => {
	const spool = await EditorAttemptSpool.create(1, "life", null as unknown as IDBFactory);
	try {
		for (let i = 0; i < 80; i++) await spool.append(new Uint8Array(256 * 1024));
		await expect(spool.append(Uint8Array.of(1))).rejects.toThrow("EDITOR_ATTEMPT_LIMIT");
	} finally {
		await spool.dispose();
	}
	const newer = await EditorAttemptSpool.create(2, "new", null as unknown as IDBFactory);
	await spool.dispose();
	await expect(
		EditorAttemptSpool.create(3, "third", null as unknown as IDBFactory),
	).rejects.toThrow("EDITOR_ATTEMPT_MEMORY_BUSY");
	await newer.dispose();
});
test("tiny fragments cannot create unbounded RAM or IDB chunk metadata", async () => {
	const spool = await EditorAttemptSpool.create(1, "fragmented", null);
	try {
		for (let i = 0; i < EDITOR_ATTEMPT_MAX_CHUNKS; i++) await spool.append(Uint8Array.of(1));
		expect(spool.chunkCount).toBe(320);
		await expect(spool.append(Uint8Array.of(1))).rejects.toThrow("EDITOR_ATTEMPT_LIMIT");
		expect(spool.chunkCount).toBe(320);
	} finally {
		await spool.dispose();
	}
});
test("IDB admission has finite total reserved bytes instead of unlimited in-flight manifests", async () => {
	const factory = new IDBFactory(),
		spools: EditorAttemptSpool[] = [];
	try {
		for (let i = 0; i < 7; i++) spools.push(await EditorAttemptSpool.create(i, "life", factory));
		expect(spools.filter((s) => s.storage === "memory")).toHaveLength(1);
		await expect(EditorAttemptSpool.create(8, "full", factory)).rejects.toThrow(
			"EDITOR_ATTEMPT_MEMORY_BUSY",
		);
	} finally {
		for (const spool of spools) await spool.dispose();
	}
});
