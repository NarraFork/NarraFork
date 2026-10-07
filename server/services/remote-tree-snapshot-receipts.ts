import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type { RemoteHistoryBinding, RemoteHistoryReceipt } from "@shared/remote-history-protocol";
import { and, eq, sql } from "drizzle-orm";
import type { db as applicationDb } from "../db";
import { narratorToolCalls, remoteTreeCaptures } from "../db/schema";
import type { ToolCallBinding } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { assertRemoteHistoryBinding, assertRemoteHistoryObject } from "./remote-history-service";

export type RemoteTreeCaptureRecord = typeof remoteTreeCaptures.$inferSelect;
export interface RemoteTreeBoundary {
	narratorId: string;
	toolUseId: string;
	toolName: string;
	binding: ToolCallBinding;
	edge: "before" | "after";
	deviceId: string;
	contextKey: string;
	workspaceRevision: number;
	originProjectId?: string | null;
	originContextVersion?: 1;
	actorSubjectKey: string;
	historyBinding: RemoteHistoryBinding;
	operationId: string;
	requestDigest: string;
}
export interface RemoteTreeReceiptStore {
	validate(
		boundary: Pick<RemoteTreeBoundary, "narratorId" | "toolUseId" | "toolName" | "binding">,
	): Promise<void>;
	begin(boundary: RemoteTreeBoundary): Promise<RemoteTreeCaptureRecord>;
	finish(
		boundary: RemoteTreeBoundary,
		receipt: RemoteHistoryReceipt,
		phase: "hot" | "warm",
	): Promise<void>;
	unavailable(boundary: RemoteTreeBoundary, state: "unknown" | "failed"): Promise<void>;
}

function key(boundary: RemoteTreeBoundary) {
	return and(
		eq(remoteTreeCaptures.sourceInstanceId, boundary.historyBinding.sourceInstanceId),
		eq(remoteTreeCaptures.scopeId, boundary.historyBinding.scopeId),
		eq(remoteTreeCaptures.remoteOperationId, boundary.operationId),
	);
}
function assertIdentity(boundary: RemoteTreeBoundary, row: RemoteTreeCaptureRecord) {
	if (
		row.narratorId !== boundary.narratorId ||
		row.toolCallId !== boundary.binding.toolCallId ||
		row.attempt !== boundary.binding.attempt ||
		row.edge !== boundary.edge ||
		row.deviceId !== boundary.deviceId ||
		row.actorSubjectKey !== boundary.actorSubjectKey ||
		row.contextKey !== boundary.contextKey ||
		row.workspaceRevision !== boundary.workspaceRevision ||
		row.originProjectId !== (boundary.originProjectId ?? null) ||
		row.originContextVersion !== (boundary.originContextVersion ?? null) ||
		row.sourceInstanceId !== boundary.historyBinding.sourceInstanceId ||
		row.workspaceInstanceId !== boundary.historyBinding.workspaceInstanceId ||
		row.scopeId !== boundary.historyBinding.scopeId ||
		row.rootIdentity !== boundary.historyBinding.rootIdentity ||
		row.requestDigest !== boundary.requestDigest
	)
		throw new Error("Remote snapshot receipt identity collision");
}
export function validateRemoteTreeReceipt(
	boundary: RemoteTreeBoundary,
	receipt: RemoteHistoryReceipt,
): void {
	assertRemoteHistoryBinding(boundary.historyBinding, receipt.binding);
	if (
		receipt.operationId !== boundary.operationId ||
		receipt.requestDigest !== boundary.requestDigest ||
		receipt.kind !== "capture" ||
		receipt.captureKind !== "whole_directory" ||
		receipt.effects.length !== 0 ||
		!["complete", "partial"].includes(receipt.coverage ?? "") ||
		receipt.temporalConsistency !== "concurrent_observation"
	)
		throw new Error("Remote snapshot is not a source-qualified whole-directory observation");
	if (
		(receipt.captureAttempts?.length ?? 0) > 2 ||
		Buffer.byteLength(JSON.stringify(receipt)) > FILE_CHANGE_LIMITS.summaryBytes
	)
		throw new Error("Remote snapshot metadata budget exceeded");
	if (receipt.tree) {
		assertRemoteHistoryObject(boundary.historyBinding, receipt.tree);
		if (receipt.tree.kind !== "tree" || receipt.tree.path !== "")
			throw new Error("Remote snapshot descriptor is not a directory tree");
	}
	for (const attempt of receipt.captureAttempts ?? [])
		if (attempt.tree) assertRemoteHistoryObject(boundary.historyBinding, attempt.tree);
	if (receipt.coverage === "complete" && (!receipt.tree || receipt.state !== "settled"))
		throw new Error("Complete remote snapshot lacks a settled tree descriptor");
}

/** Indexed bounded metadata only. Never writes legacy host treeHash or FileChangeEffects. */
export class DatabaseRemoteTreeReceiptStore implements RemoteTreeReceiptStore {
	constructor(private readonly db: Pick<typeof applicationDb, "select" | "insert" | "update">) {}
	async validate(
		boundary: Pick<RemoteTreeBoundary, "narratorId" | "toolUseId" | "toolName" | "binding">,
	): Promise<void> {
		if (
			!boundary.binding.toolCallId ||
			!Number.isSafeInteger(boundary.binding.attempt) ||
			boundary.binding.attempt < 1
		)
			throw new Error("Remote capture requires a persisted tool attempt");
		const row = this.db
			.select({
				id: narratorToolCalls.id,
				narratorId: narratorToolCalls.narratorId,
				toolUseId: narratorToolCalls.toolUseId,
				name: narratorToolCalls.toolName,
				attempt: narratorToolCalls.executionAttempt,
				origin: narratorToolCalls.executionOriginToolCallId,
				version: narratorToolCalls.executionIdentityVersion,
				checkpoint: narratorToolCalls.isFileHistoryCheckpoint,
			})
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, boundary.binding.toolCallId))
			.limit(1)
			.get();
		if (
			!row ||
			row.narratorId !== boundary.narratorId ||
			row.toolUseId !== boundary.toolUseId ||
			row.name !== boundary.toolName ||
			row.attempt !== boundary.binding.attempt ||
			row.version < 1 ||
			row.checkpoint ||
			(row.origin && row.origin !== row.id)
		)
			throw new Error("Remote capture tool binding is stale, foreign or a history clone");
	}
	async begin(boundary: RemoteTreeBoundary): Promise<RemoteTreeCaptureRecord> {
		await this.validate(boundary);
		const timestamp = new Date().toISOString();
		this.db
			.insert(remoteTreeCaptures)
			.values({
				id: generateId(),
				narratorId: boundary.narratorId,
				toolCallId: boundary.binding.toolCallId,
				attempt: boundary.binding.attempt,
				edge: boundary.edge,
				deviceId: boundary.deviceId,
				contextKey: boundary.contextKey,
				workspaceRevision: boundary.workspaceRevision,
				originProjectId: boundary.originProjectId ?? null,
				originContextVersion: boundary.originContextVersion ?? null,
				sourceInstanceId: boundary.historyBinding.sourceInstanceId,
				workspaceInstanceId: boundary.historyBinding.workspaceInstanceId,
				scopeId: boundary.historyBinding.scopeId,
				rootIdentity: boundary.historyBinding.rootIdentity,
				remoteOperationId: boundary.operationId,
				requestDigest: boundary.requestDigest,
				actorSubjectKey: boundary.actorSubjectKey,
				state: "pending",
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.onConflictDoNothing()
			.run();
		const row = this.read(boundary);
		if (!row) throw new Error("Remote snapshot metadata was not persisted");
		assertIdentity(boundary, row);
		return row;
	}
	async finish(
		boundary: RemoteTreeBoundary,
		receipt: RemoteHistoryReceipt,
		phase: "hot" | "warm",
	): Promise<void> {
		validateRemoteTreeReceipt(boundary, receipt);
		const current = this.read(boundary);
		if (!current) throw new Error("Remote snapshot metadata is absent");
		assertIdentity(boundary, current);
		// A late hot response cannot overwrite a durable warm attempt.
		if (current.receiptMetadataJson?.capturePhase === "warm" && phase === "hot") return;
		this.db
			.update(remoteTreeCaptures)
			.set({
				state: receipt.coverage === "complete" ? "complete" : "partial",
				descriptorJson: receipt.tree ?? null,
				receiptMetadataJson: receipt,
				updatedAt: new Date().toISOString(),
			})
			.where(and(key(boundary), eq(remoteTreeCaptures.id, current.id)))
			.run();
	}
	async unavailable(boundary: RemoteTreeBoundary, state: "unknown" | "failed"): Promise<void> {
		// Do not replace a real captured candidate or erase an unresolved writer barrier.
		this.db
			.update(remoteTreeCaptures)
			.set({ state, updatedAt: new Date().toISOString() })
			.where(and(key(boundary), eq(remoteTreeCaptures.state, "pending")))
			.run();
	}
	private read(boundary: RemoteTreeBoundary): RemoteTreeCaptureRecord | null {
		return (
			this.db
				.select()
				.from(remoteTreeCaptures)
				.where(
					and(
						key(boundary),
						sql`coalesce(length(cast(${remoteTreeCaptures.receiptMetadataJson} as blob)),0) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
						sql`coalesce(length(cast(${remoteTreeCaptures.descriptorJson} as blob)),0) <= 4096`,
					),
				)
				.limit(1)
				.get() ?? null
		);
	}
}

let production: Promise<RemoteTreeReceiptStore> | undefined;
export function getRemoteTreeReceiptStore(): Promise<RemoteTreeReceiptStore> {
	production ??= import("../db").then(({ db, postgresRuntime }) => {
		if (postgresRuntime)
			throw new Error("Remote snapshot PostgreSQL metadata adapter is unavailable");
		return new DatabaseRemoteTreeReceiptStore(db);
	});
	return production;
}
