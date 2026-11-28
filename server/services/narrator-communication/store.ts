import { COMMUNICATION_LIMITS, canonicalCommunicationPair } from "@shared/narrator-communication";
import { and, eq, or, sql } from "drizzle-orm";
import type { db } from "../../db";
import {
	narrators,
	narratorCommunicationNodes as nodes,
	narratorCommunicationPeers as peers,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";

export type CommunicationTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type CommunicationExecutor = Pick<
	CommunicationTx,
	"select" | "insert" | "update" | "delete" | "get" | "all"
>;

export function communicationConflict(message = "Communication changed; refresh and retry"): never {
	throw new AppError(message, 409, "COMMUNICATION_CONFLICT");
}
export function communicationDenied(): never {
	throw new AppError(
		"Communication target is unavailable or disconnected",
		403,
		"COMMUNICATION_DENIED",
	);
}

/** Insert-only: a stored explicit NULL is never interpreted as missing inheritance. */
export function ensureCommunicationNodeTx(
	tx: Pick<CommunicationExecutor, "insert">,
	id: string,
	parentId: string | null,
): void {
	if (id === parentId) communicationDenied();
	tx.insert(nodes)
		.values({
			narratorId: id,
			parentNarratorId: parentId,
			originalParentNarratorId: parentId,
			version: 1,
		})
		.onConflictDoNothing()
		.run();
}

/** Indexed, hard-bounded point reads. A missing row, loop or over-depth path denies. */
export function communicationRootTx(tx: Pick<CommunicationExecutor, "select">, id: string): string {
	const seen = new Set<string>();
	let current = id;
	for (let depth = 0; depth < COMMUNICATION_LIMITS.maxDepth; depth++) {
		if (seen.has(current)) communicationDenied();
		seen.add(current);
		const row = tx
			.select({ parent: nodes.parentNarratorId })
			.from(nodes)
			.where(eq(nodes.narratorId, current))
			.limit(1)
			.get();
		if (!row) communicationDenied();
		if (row.parent === null) return current;
		current = row.parent;
	}
	return communicationDenied();
}

export function communicationReachableTx(
	tx: Pick<CommunicationExecutor, "select">,
	source: string,
	target: string,
): boolean {
	if (source === target) return false;
	for (const id of [source, target]) {
		if (
			!tx
				.select({ id: nodes.narratorId })
				.from(nodes)
				.where(eq(nodes.narratorId, id))
				.limit(1)
				.get()
		)
			return false;
	}
	// Exact peer authorizes only these initialized endpoints, even when one forest is damaged.
	const [endpointLo, endpointHi] = canonicalCommunicationPair(source, target);
	const pair = { endpointLo, endpointHi };
	if (
		tx
			.select({ id: peers.id })
			.from(peers)
			.where(and(eq(peers.endpointLo, pair.endpointLo), eq(peers.endpointHi, pair.endpointHi)))
			.limit(1)
			.get()
	)
		return true;
	try {
		return communicationRootTx(tx, source) === communicationRootTx(tx, target);
	} catch {
		return false;
	}
}

export function assertCommunicationReachableTx(
	tx: Pick<CommunicationExecutor, "select">,
	source: string,
	target: string,
): void {
	if (!communicationReachableTx(tx, source, target)) communicationDenied();
}
export const assertReachableTx = assertCommunicationReachableTx;

/** Live connection admission is narrower than access for managing historical peers. */
export function assertLiveCommunicationEndpointTx(
	tx: Pick<CommunicationExecutor, "select">,
	id: string,
): void {
	const endpoint = tx
		.select({ status: narrators.status })
		.from(narrators)
		.where(eq(narrators.id, id))
		.limit(1)
		.get();
	if (!endpoint || endpoint.status === "archived") communicationDenied();
}

export function insertCommunicationPeerTx(
	tx: CommunicationExecutor,
	source: string,
	target: string,
	provenance: {
		userId: string;
		source: "admission" | "manual";
		admissionId?: string;
		messageId?: string;
		now?: string;
	},
): boolean {
	assertLiveCommunicationEndpointTx(tx, source);
	if (source === target) return false;
	assertLiveCommunicationEndpointTx(tx, target);
	// Invalid forests must not masquerade as same-group. Their exact peer can still be managed.
	if (communicationRootTx(tx, source) === communicationRootTx(tx, target)) return false;
	const [endpointLo, endpointHi] = canonicalCommunicationPair(source, target);
	const pair = { endpointLo, endpointHi };
	const inserted = tx
		.insert(peers)
		.values({
			// A reconnect receives a new relation ID, so stale disconnects cannot reach it.
			id: generateId(),
			...pair,
			createdBy: provenance.userId,
			source: provenance.source,
			admissionId: provenance.admissionId ?? null,
			messageId: provenance.messageId ?? null,
			createdAt: provenance.now ?? new Date().toISOString(),
		})
		.onConflictDoNothing()
		.returning({ id: peers.id })
		.get();
	return !!inserted;
}

export function splitCommunicationTx(
	tx: CommunicationExecutor,
	narratorId: string,
	version: number,
): boolean {
	const node = tx.select().from(nodes).where(eq(nodes.narratorId, narratorId)).limit(1).get();
	if (!node || node.version !== version) communicationConflict();
	if (node.parentNarratorId === null) return false;
	tx.update(nodes)
		.set({ parentNarratorId: null, version: sql`${nodes.version} + 1` })
		.where(and(eq(nodes.narratorId, narratorId), eq(nodes.version, version)))
		.run();
	return true;
}

export function restoreCommunicationTx(
	tx: CommunicationExecutor,
	narratorId: string,
	parentId: string,
	version: number,
): boolean {
	const node = tx.select().from(nodes).where(eq(nodes.narratorId, narratorId)).limit(1).get();
	if (!node || node.version !== version) communicationConflict();
	if (node.parentNarratorId === parentId) return false;
	if (
		node.parentNarratorId !== null ||
		narratorId === parentId ||
		node.originalParentNarratorId !== parentId
	)
		communicationConflict();
	// Walk the prospective parent's chain, checking both cycle and remaining depth.
	let current: string | null = parentId;
	const seen = new Set([narratorId]);
	let ancestors = 0;
	while (current !== null) {
		if (seen.has(current) || ++ancestors >= COMMUNICATION_LIMITS.maxDepth) communicationDenied();
		seen.add(current);
		const row = tx
			.select({ parent: nodes.parentNarratorId })
			.from(nodes)
			.where(eq(nodes.narratorId, current))
			.limit(1)
			.get();
		if (!row) communicationDenied();
		current = row.parent;
	}
	// Bound descendants too, so restoring a deep subtree cannot manufacture an over-depth forest.
	const [descendant] = tx.all<{
		depth: number;
		count: number;
	}>(sql`WITH RECURSIVE descendants(id, depth) AS (
		SELECT ${narratorId}, 1 UNION ALL SELECT n.narrator_id, d.depth + 1 FROM narrator_communication_nodes n JOIN descendants d ON n.parent_narrator_id = d.id WHERE d.depth <= ${COMMUNICATION_LIMITS.maxDepth}
	) SELECT MAX(depth) AS depth, COUNT(*) AS count FROM (SELECT depth FROM descendants LIMIT 4097) bounded`);
	// A very large subtree needs an asynchronous maintenance path, not a main-thread scan.
	if (
		!descendant ||
		descendant.count > 4096 ||
		descendant.depth + ancestors > COMMUNICATION_LIMITS.maxDepth
	)
		communicationDenied();
	tx.update(nodes)
		.set({ parentNarratorId: parentId, version: sql`${nodes.version} + 1` })
		.where(and(eq(nodes.narratorId, narratorId), eq(nodes.version, version)))
		.run();
	return true;
}

/** Direct children become roots; controller/result/ACL/historical-parent rows are untouched. */
export function detachCommunicationBeforeDeleteTx(
	tx: CommunicationExecutor,
	narratorId: string,
): void {
	tx.update(nodes)
		.set({ parentNarratorId: null, version: sql`${nodes.version} + 1` })
		.where(eq(nodes.parentNarratorId, narratorId))
		.run();
	tx.delete(peers)
		.where(or(eq(peers.endpointLo, narratorId), eq(peers.endpointHi, narratorId)))
		.run();
	tx.delete(nodes).where(eq(nodes.narratorId, narratorId)).run();
}
