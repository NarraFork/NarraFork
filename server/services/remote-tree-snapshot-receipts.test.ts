import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { RemoteHistoryBinding, RemoteHistoryReceipt } from "@shared/remote-history-protocol";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narratorMessages, narrators, narratorToolCalls, remoteTreeCaptures } from "../db/schema";
import { generateId } from "../lib/id";
import { remoteHistoryObjectId } from "./remote-history-service";
import {
	DatabaseRemoteTreeReceiptStore,
	type RemoteTreeBoundary,
} from "./remote-tree-snapshot-receipts";

const cleanup: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
	const narratorId = generateId();
	cleanup.push(narratorId);
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = `provider-${generateId()}`;
	const timestamp = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: narratorId, cwd: "/server-decoy", createdAt: timestamp, updatedAt: timestamp });
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: timestamp,
	});
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId,
		messageId,
		toolUseId,
		toolName: "Bash",
		inputJson: {},
		status: "running",
		executionIdentityVersion: 1,
		executionAttempt: 2,
		executionOriginToolCallId: toolCallId,
		createdAt: timestamp,
	});
	const native: RemoteHistoryBinding = {
		sourceInstanceId: `native-${narratorId}`,
		workspaceInstanceId: "real-workspace",
		scopeId: "real-scope",
		root: "/remote-root",
		rootIdentity: "inode:root",
		fence: 8,
	};
	const boundary: RemoteTreeBoundary = {
		narratorId,
		toolUseId,
		toolName: "Bash",
		binding: { toolCallId, attempt: 2 },
		edge: "before",
		deviceId: "remote-device",
		contextKey: "frozen-context",
		workspaceRevision: 5,
		actorSubjectKey: "user:actual-actor",
		historyBinding: native,
		operationId: `capture_${toolCallId}`,
		requestDigest: hash("same-real-intent"),
	};
	function receipt(
		phase: "hot" | "warm",
		coverage: "complete" | "partial" = "complete",
	): RemoteHistoryReceipt {
		const digest = hash(`${boundary.operationId}:${phase}`);
		return {
			binding: native,
			operationId: boundary.operationId,
			requestDigest: boundary.requestDigest,
			payloadDigest: hash(boundary.requestDigest),
			kind: "capture",
			state: "settled",
			effects: [],
			captureKind: "whole_directory",
			capturePhase: phase,
			coverage,
			temporalConsistency: "concurrent_observation",
			consistency: "stable_double_scan",
			policyDigest: hash("policy"),
			tree: {
				kind: "tree",
				path: "",
				algorithm: "sha256",
				digest,
				sizeBytes: 42,
				objectId: remoteHistoryObjectId(native.scopeId, "tree", digest, ""),
				sourceInstanceId: native.sourceInstanceId,
				workspaceInstanceId: native.workspaceInstanceId,
				scopeId: native.scopeId,
			},
			captureAttempts:
				phase === "warm" ? [{ phase: "hot", coverage: "partial", reason: "capture_deadline" }] : [],
			startedAt: timestamp,
			finishedAt: timestamp,
		};
	}
	return {
		store: new DatabaseRemoteTreeReceiptStore(db),
		boundary,
		receipt,
		narratorId,
		messageId,
		toolCallId,
	};
}
afterEach(async () => {
	for (const id of cleanup.splice(0)) {
		await db.delete(remoteTreeCaptures).where(eq(remoteTreeCaptures.narratorId, id));
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, id));
		await db.delete(narrators).where(eq(narrators.id, id));
	}
});

describe("source-qualified remote snapshot metadata persistence", () => {
	test("real SQLite persists exact actor/attempt/native descriptors without filling host hashes", async () => {
		const f = await fixture();
		await f.store.begin(f.boundary);
		await f.store.finish(f.boundary, f.receipt("hot"), "hot");
		const row = await db.query.remoteTreeCaptures.findFirst({
			where: eq(remoteTreeCaptures.toolCallId, f.toolCallId),
		});
		expect(row).toMatchObject({
			deviceId: "remote-device",
			sourceInstanceId: f.boundary.historyBinding.sourceInstanceId,
			attempt: 2,
			edge: "before",
			actorSubjectKey: "user:actual-actor",
			state: "complete",
			contextKey: "frozen-context",
			workspaceRevision: 5,
		});
		expect(row?.descriptorJson?.objectId).toBe(f.receipt("hot").tree?.objectId);
		expect(row?.receiptMetadataJson?.temporalConsistency).toBe("concurrent_observation");
		const tool = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, f.toolCallId),
		});
		expect(tool?.treeHashBefore).toBeNull();
		expect(tool?.treeHashAfter).toBeNull();
		expect(tool?.ownedPathsJson).toBeNull();
		expect(tool?.fileChangeOperationId).toBeNull();
	});

	test("late hot responses cannot overwrite warm metadata and historical attempts stay distinct", async () => {
		const f = await fixture();
		await f.store.begin(f.boundary);
		await f.store.finish(f.boundary, f.receipt("hot", "partial"), "hot");
		await db
			.update(narratorToolCalls)
			.set({ executionAttempt: 3 })
			.where(eq(narratorToolCalls.id, f.toolCallId));
		await f.store.finish(f.boundary, f.receipt("warm"), "warm");
		await f.store.finish(f.boundary, f.receipt("hot", "partial"), "hot");
		const row = await db.query.remoteTreeCaptures.findFirst({
			where: eq(remoteTreeCaptures.toolCallId, f.toolCallId),
		});
		expect(row?.attempt).toBe(2);
		expect(row?.receiptMetadataJson?.capturePhase).toBe("warm");
		expect(row?.state).toBe("complete");
		await expect(f.store.begin(f.boundary)).rejects.toThrow("stale");
	});

	test("provider ID reuse, cloned source rows and namespace collisions cannot borrow evidence", async () => {
		const f = await fixture();
		await expect(
			f.store.begin({ ...f.boundary, binding: { ...f.boundary.binding, attempt: 1 } }),
		).rejects.toThrow("stale");
		await f.store.begin(f.boundary);
		await expect(f.store.begin({ ...f.boundary, actorSubjectKey: "user:other" })).rejects.toThrow(
			"identity collision",
		);
		await expect(
			f.store.finish(
				f.boundary,
				{
					...f.receipt("hot"),
					binding: { ...f.boundary.historyBinding, sourceInstanceId: "replacement" },
				},
				"hot",
			),
		).rejects.toThrow("mismatch");
	});

	test("sparse receipts and large effect payloads never become complete whole-directory metadata", async () => {
		const f = await fixture();
		await f.store.begin(f.boundary);
		await expect(
			f.store.finish(f.boundary, { ...f.receipt("hot"), captureKind: undefined }, "hot"),
		).rejects.toThrow("whole-directory");
		await f.store.unavailable(f.boundary, "unknown");
		const row = await db.query.remoteTreeCaptures.findFirst({
			where: eq(remoteTreeCaptures.toolCallId, f.toolCallId),
		});
		expect(row?.state).toBe("unknown");
		expect(row?.descriptorJson).toBeNull();
	});
});
