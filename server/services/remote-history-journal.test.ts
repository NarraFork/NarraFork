import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type {
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryReceipt,
	RemoteHistoryRequest,
} from "@shared/remote-history-protocol";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	createPersistentRemoteHistoryJournal,
	SQLiteRemoteHistoryMetadataStore,
} from "./remote-history-journal";
import { remoteHistoryObjectId } from "./remote-history-service";

const open: Database[] = [];
afterEach(() => {
	for (const db of open.splice(0)) db.close();
});
const binding: RemoteHistoryBinding = {
	sourceInstanceId: "source",
	workspaceInstanceId: "workspace",
	scopeId: "scope",
	root: "/selected/repo",
	rootIdentity: "physical-root",
	fence: 1,
};
const digest = "a".repeat(64);
const request: RemoteHistoryRequest = {
	binding,
	operationId: "op",
	requestDigest: digest,
	changes: [{ path: "file.txt", expected: { kind: "absent" }, desired: { kind: "absent" } }],
};
function receipt(state: RemoteHistoryReceipt["state"] = "settled"): RemoteHistoryReceipt {
	return {
		binding,
		operationId: "op",
		requestDigest: digest,
		payloadDigest: "b".repeat(64),
		kind: "mutate",
		state,
		effects: [],
		startedAt: "2026-01-01T00:00:00Z",
		...(state === "finalized" ? { serverCommitId: "commit" } : {}),
	};
}
function fixture() {
	const native = new Database(":memory:");
	open.push(native);
	// Test-only, in-memory DDL. Never runs migrations or opens the production DB.
	native.exec(`CREATE TABLE remote_history_receipts (
		id TEXT PRIMARY KEY, source_instance_id TEXT NOT NULL, scope_id TEXT NOT NULL,
		device_id TEXT NOT NULL, workspace_instance_id TEXT NOT NULL, root_identity TEXT NOT NULL,
		operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, intent_digest TEXT, intent_json TEXT,
		fencing_token INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, receipt_json TEXT,
		server_commit_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		UNIQUE(source_instance_id,scope_id,operation_id));
		CREATE TABLE remote_history_objects (
		id TEXT PRIMARY KEY, source_instance_id TEXT NOT NULL, scope_id TEXT NOT NULL,
		device_id TEXT NOT NULL, workspace_instance_id TEXT NOT NULL, root_identity TEXT NOT NULL,
		object_id TEXT NOT NULL, kind TEXT NOT NULL, origin_path TEXT NOT NULL,
		algorithm TEXT NOT NULL, digest TEXT NOT NULL, size_bytes INTEGER NOT NULL,
		placement TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
		UNIQUE(source_instance_id,scope_id,object_id,kind));`);
	const store = new SQLiteRemoteHistoryMetadataStore(drizzle(native));
	return {
		native,
		store,
		journal: createPersistentRemoteHistoryJournal("remote", binding, { store }),
	};
}

describe("persistent remote intent/catalog", () => {
	test("same request survives factory restart; digest conflict preserves original intent", async () => {
		const f = fixture();
		await f.journal.putIntent(request, "mutate");
		const reopened = createPersistentRemoteHistoryJournal("remote", binding, { store: f.store });
		await reopened.putIntent({ ...request, binding: { ...binding } }, "mutate");
		await expect(
			reopened.putIntent(
				{
					...request,
					changes: [
						{
							...request.changes?.[0],
							path: "other.txt",
							expected: { kind: "absent" },
							desired: { kind: "absent" },
						},
					],
				},
				"mutate",
			),
		).rejects.toThrow("digest conflict");
		expect(f.native.query("SELECT count(*) as count FROM remote_history_receipts").get()).toEqual({
			count: 1,
		});
	});

	test("private original intent reader pins source, row kind, fence and payload metadata", async () => {
		const f = fixture();
		await f.journal.putIntent(request, "restore");
		await f.journal.markUnknown(binding, request.operationId);
		const reopened = createPersistentRemoteHistoryJournal("remote", binding, { store: f.store });
		expect(await reopened.getIntent(request.operationId)).toEqual({ kind: "restore", request });
		expect(await reopened.getIntent("foreign-op")).toBeNull();
		const foreign = createPersistentRemoteHistoryJournal("foreign-device", binding, {
			store: f.store,
		});
		await expect(foreign.getIntent(request.operationId)).rejects.toThrow("namespace");
		const fresh = createPersistentRemoteHistoryJournal(
			"remote",
			{ ...binding, fence: binding.fence + 1 },
			{ store: f.store },
		);
		await expect(fresh.getIntent(request.operationId)).rejects.toThrow();
		f.native
			.query("UPDATE remote_history_receipts SET intent_json = ?")
			.run(JSON.stringify({ ...request, requestDigest: "c".repeat(64) }));
		await expect(reopened.getIntent(request.operationId)).rejects.toThrow("digest conflict");
		expect(f.native.query("SELECT state FROM remote_history_receipts").get()).toEqual({
			state: "unknown",
		});
	});

	test("inline evidence never lands in intent JSON", async () => {
		const f = fixture();
		await f.journal.putIntent(
			{
				...request,
				changes: [
					{
						path: "file.txt",
						expected: { kind: "absent" },
						desired: { kind: "absent" },
						contentBase64: "secret-inline-file-body",
					},
				],
			},
			"mutate",
		);
		const row = f.native.query("SELECT intent_json FROM remote_history_receipts").get() as {
			intent_json: string;
		};
		expect(row.intent_json).not.toContain("secret-inline");
		expect(row.intent_json).not.toContain("contentBase64");
	});

	test("unknown intent is retained, receipt does not erase server intent digest", async () => {
		const f = fixture();
		await f.journal.putIntent(request, "mutate");
		await f.journal.markUnknown(binding, "op");
		expect(f.native.query("SELECT state FROM remote_history_receipts").get()).toEqual({
			state: "unknown",
		});
		await f.journal.putReceipt(receipt());
		await f.journal.putIntent(request, "mutate");
		expect((await f.journal.getReceipt("op"))?.state).toBe("settled");
	});

	test("terminal receipt cannot be downgraded by lost or late response", async () => {
		const f = fixture();
		await f.journal.putIntent(request, "mutate");
		await f.journal.putReceipt(receipt("finalized"));
		await f.journal.markUnknown(binding, "op");
		await f.journal.putReceipt(receipt("settled"));
		expect((await f.journal.getReceipt("op"))?.state).toBe("finalized");
		await expect(
			f.journal.putReceipt({ ...receipt("finalized"), payloadDigest: "c".repeat(64) }),
		).rejects.toThrow("digest conflict");
	});

	test("no-dispatch refusal stays terminal and retains original intent across restart", async () => {
		const f = fixture();
		await f.journal.putIntent(request, "mutate");
		const rejected: RemoteHistoryReceipt = {
			...receipt("rejected"),
			reason: "unsupported_cross_filesystem",
			finishedAt: "2026-01-01T00:00:01Z",
			effects: [
				{
					path: "file.txt",
					before: { kind: "absent" },
					intended: { kind: "absent" },
					outcome: "pending",
				},
			],
		};
		await f.journal.putReceipt(rejected);
		await f.journal.markUnknown(binding, "op");
		for (const late of ["intent", "applying", "settled", "finalized", "compensated"] as const) {
			await f.journal.putReceipt(receipt(late));
			expect(await f.journal.getReceipt("op")).toEqual(rejected);
		}
		const reopened = createPersistentRemoteHistoryJournal("remote", binding, { store: f.store });
		await reopened.putIntent(request, "mutate");
		await reopened.putReceipt(rejected);
		expect(await reopened.getReceipt("op")).toEqual(rejected);
		const row = f.native
			.query("SELECT state,intent_json,server_commit_id FROM remote_history_receipts")
			.get() as {
			state: string;
			intent_json: string;
			server_commit_id: string | null;
		};
		expect(row.state).toBe("rejected");
		expect(JSON.parse(row.intent_json)).toEqual(request);
		expect(row.server_commit_id).toBeNull();
		await expect(reopened.putReceipt({ ...rejected, reason: "different proof" })).rejects.toThrow(
			"not durably recorded",
		);
		expect(await reopened.getReceipt("op")).toEqual(rejected);
	});

	test("a CAS-preserved prior terminal cannot masquerade as durable refusal proof", async () => {
		const f = fixture();
		await f.journal.putIntent(request, "mutate");
		await f.journal.putReceipt(receipt("finalized"));
		await expect(
			f.journal.putReceipt({
				...receipt("rejected"),
				reason: "unsupported_cross_filesystem",
				finishedAt: "2026-01-01T00:00:01Z",
			}),
		).rejects.toThrow("not durably recorded");
		expect((await f.journal.getReceipt("op"))?.state).toBe("finalized");
	});

	test("source-qualified remote placement never becomes a host blob", async () => {
		const f = fixture();
		const object: RemoteHistoryObject = {
			sourceInstanceId: binding.sourceInstanceId,
			workspaceInstanceId: binding.workspaceInstanceId,
			scopeId: binding.scopeId,
			objectId: remoteHistoryObjectId(binding.scopeId, "blob", digest, "file.txt"),
			algorithm: "sha256",
			digest,
			sizeBytes: 3,
			kind: "blob",
			path: "file.txt",
		};
		await f.journal.putObject(object);
		expect(await f.journal.getObject(object.objectId)).toEqual(object);
		const row = f.native.query("SELECT placement, origin_path FROM remote_history_objects").get();
		expect(row).toEqual({ placement: "remote", origin_path: "file.txt" });
		const other = createPersistentRemoteHistoryJournal("other-device", binding, { store: f.store });
		await expect(other.getObject(object.objectId)).rejects.toThrow("namespace conflict");
	});

	test("large JSON is refused before ORM parsing and pending row is not deleted", async () => {
		const f = fixture();
		await f.journal.putIntent(request, "mutate");
		f.native
			.query("UPDATE remote_history_receipts SET receipt_json = ?")
			.run(JSON.stringify({ body: "a".repeat(300000) }));
		await expect(f.journal.getReceipt("op")).rejects.toThrow("budget exceeded");
		expect(f.native.query("SELECT count(*) as count FROM remote_history_receipts").get()).toEqual({
			count: 1,
		});
	});
});
