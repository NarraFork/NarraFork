import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testEnvironment } from "../../tests/preload";
import { EditorDocumentService } from "./editor-document-service";
import {
	EDITOR_OPERATION_STORE_LIMITS,
	type EditorDurableOperation,
	EditorRemoteOperationStore,
	editorReceiptStorageSupported,
} from "./editor-remote-operation-store";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(testEnvironment.isolatedHome, "native-receipt-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const digest = "a".repeat(64);
function record(id: string): EditorDurableOperation {
	return {
		version: 1,
		createdAt: Date.now(),
		userId: "user",
		narratorId: "narrator",
		deviceId: "local",
		operationId: id,
		hostOperationId: `host-${id}`,
		leaseId: `lease-${id}`,
		effectId: `effect-${id}`,
		saved: { hash: digest, bytes: 1, snapshotRevision: 1, hashKind: "raw-sha256" },
		requestDigest: digest,
		namespace: "owner-source-device",
		resourceKey: "resource",
		root: "/fixture",
		identity: {
			deviceId: "local",
			pathFlavor: "posix",
			canonicalPath: "/fixture/file",
			workspaceIdentity: "root",
			runtimeEpoch: "epoch",
			runtimeGeneration: 1,
			fencingToken: 1,
		},
		rawDigest: digest,
		bytes: 1,
	};
}
const committed = (operationId: string) => ({
	operationId,
	outcome: "committed" as const,
	rawDigest: digest,
	totalBytes: 1,
});

test("terminal takeover is a private durable file readable after cold store construction", async () => {
	const store = new EditorRemoteOperationStore(root);
	await store.put(record("op"));
	await store.markSettled("op", committed("op"));
	const cold = new EditorRemoteOperationStore(root);
	expect((await cold.get("op"))?.receipt).toEqual(committed("op"));
	expect(await readdir(root)).toEqual(["op.json.settled"]);
	await expect(cold.markSettled("op", committed("different"))).rejects.toThrow("unmatched");
});

test("pressure releases transferred terminal proof, never pending/unknown sole proof", async () => {
	const limits = { ...EDITOR_OPERATION_STORE_LIMITS, records: 2 };
	const store = new EditorRemoteOperationStore(root, limits);
	await store.put(record("pending"));
	await store.put(record("saved"));
	await expect(store.put(record("third"))).rejects.toThrow("capacity");
	await store.markSettled("saved", committed("saved"));
	// Pressure can expire a terminal before its 10 minute cache TTL, not a pending intent.
	await store.put(record("third"));
	expect(await store.get("saved")).toBeNull();
	expect((await store.get("pending"))?.operationId).toBe("pending");
	const cold = new EditorRemoteOperationStore(root, limits);
	await expect(cold.put(record("fourth"))).rejects.toThrow("capacity");
	expect(await readdir(root)).toEqual(expect.arrayContaining(["pending.json", "third.json"]));
});

test("expired unknown remains on disk and cannot become proven-not-executed", async () => {
	const store = new EditorRemoteOperationStore(root, {
		...EDITOR_OPERATION_STORE_LIMITS,
		ttlMs: 1,
	});
	await store.put({ ...record("unknown"), createdAt: Date.now() - 100 });
	await expect(store.get("unknown")).rejects.toThrow("expired");
	expect(await readdir(root)).toContain("unknown.json");
});

test("private metadata limits and owner mode checks fail closed", async () => {
	const store = new EditorRemoteOperationStore(root);
	await expect(
		store.put({ ...record("large"), resourceKey: "A".repeat(20 * 1024) }),
	).rejects.toThrow("budget");
	await writeFile(join(root, "large.json"), " ".repeat(20 * 1024));
	await expect(store.get("large")).rejects.toThrow("Unsafe");
	await rm(join(root, "large.json"));
	await chmod(root, 0o755);
	await expect(store.put(record("unsafe"))).rejects.toThrow("not private");
});

test("unsupported Host receipt durability is read-only before any v1/raw dispatch", async () => {
	expect(editorReceiptStorageSupported("win32")).toBe(false);
	expect(editorReceiptStorageSupported("win32", true)).toBe(true);
	const target = join(root, "target.txt");
	await writeFile(target, "before");
	let writes = 0;
	const execute = async () => {
		writes++;
		throw new Error("must not dispatch");
	};
	const service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute,
		writerAvailable: () => editorReceiptStorageSupported("win32"),
		writerUnavailableReason: () => "host_receipt_storage_unavailable",
		rawWriter: {
			execute,
			queryOperation: async (_actor, operationId) => ({ operationId, status: "uncertain" }),
		},
	});
	const actor = {
		userId: "owner",
		narratorId: "narrator",
		authorize: async () => ({
			cwd: root,
			canonicalPath: target,
			lexicalPath: target,
			projectId: null,
			outsideRoots: false,
		}),
	};
	try {
		const raw = await service.create(actor, { path: target, origin: "legacy", protocol: "raw-v2" });
		expect(raw.capabilities).toMatchObject({
			stage: false,
			durableApply: false,
			durableQuery: false,
			writeUnavailableReason: "host_receipt_storage_unavailable",
		});
		if (raw.protocol !== "raw-v2") throw new Error("Raw fixture expected");
		await expect(
			service.createUpload(actor, raw.docId, {
				protocol: "raw-v2",
				hashKind: "raw-sha256",
				baseHash: raw.baseHash,
				encoding: raw.encoding,
				bom: raw.bom,
				snapshotRevision: 1,
			}),
		).rejects.toThrow("staging is unavailable");
		const v1 = await service.create(actor, { path: target, origin: "legacy" });
		expect(v1.capabilities?.v1Save).toBe(false);
		await expect(
			service.createUpload(actor, v1.docId, {
				baseHash: v1.baseHash,
				encoding: v1.encoding,
				snapshotRevision: 1,
			}),
		).rejects.toThrow("helper unavailable");
		expect(writes).toBe(0);
		expect(await readFile(target, "utf8")).toBe("before");
	} finally {
		await service.dispose();
	}
});
