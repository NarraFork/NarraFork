import {
	COMMUNICATION_LIMITS,
	type CommunicationMutation,
	type CommunicationMutationResult,
} from "@shared/narrator-communication";
import { eq } from "drizzle-orm";
import { activeDatabaseBackend, db, postgresRuntime } from "../../db";
import {
	narratorCommunicationNodes as nodes,
	narratorCommunicationPeers as peers,
} from "../../db/schema";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors";
import { eventBus } from "../../lib/event-bus";
import type { NarratorPrincipal } from "../narrator-acl";
import {
	assertCommunicationAccessTx,
	assertCommunicationSendAuthorizedTx,
	currentCommunicationPrincipalTx,
} from "./access";
import {
	assertCommunicationSendAuthorizedPg,
	assertUserCommunicationAdmissionPg,
	withCommunicationPgTransaction,
} from "./postgres";
import {
	type CommunicationExecutor,
	insertCommunicationPeerTx,
	restoreCommunicationTx,
	splitCommunicationTx,
} from "./store";

export function publishCommunicationChanged(narratorIds: readonly string[], teamId?: string): void {
	if (!narratorIds.length) return;
	eventBus.emit({
		type: "narrator:communication_changed",
		narratorIds: [...new Set(narratorIds)],
		...(teamId ? { teamId } : {}),
	});
}
export interface PreparedUserConnections {
	sourceNarratorId: string;
	userId: string;
	targetNarratorIds: string[];
}
export async function prepareUserCommunicationAdmission(
	input: PreparedUserConnections,
): Promise<PreparedUserConnections> {
	const targetNarratorIds = [...new Set(input.targetNarratorIds)];
	if (targetNarratorIds.length > COMMUNICATION_LIMITS.maxReferences)
		throw new ValidationError("Too many narrator references");
	const prepared = {
		...input,
		targetNarratorIds: targetNarratorIds.filter((id) => id !== input.sourceNarratorId),
	};
	if (activeDatabaseBackend === "postgres") {
		if (!postgresRuntime || postgresRuntime.closed)
			throw new AppError("Communication unavailable", 503, "COMMUNICATION_UNAVAILABLE");
		await withCommunicationPgTransaction(postgresRuntime.client.db, (tx) =>
			assertUserCommunicationAdmissionPg(tx, prepared),
		);
		return prepared;
	}
	db.transaction((tx) => {
		const principal = currentCommunicationPrincipalTx(tx, input.userId);
		assertCommunicationAccessTx(tx, input.sourceNarratorId, principal, "write");
		for (const id of prepared.targetNarratorIds)
			assertCommunicationAccessTx(tx, id, principal, "write");
	});
	return prepared;
}
export const prepareUserConnections = prepareUserCommunicationAdmission;

/** The caller invokes this only for a newly accepted receipt, inside that admission transaction. */
export function commitUserCommunicationAdmissionTx(
	tx: CommunicationExecutor,
	prepared: PreparedUserConnections,
	provenance: { admissionId: string; messageId?: string; now?: string },
): string[] {
	const principal = currentCommunicationPrincipalTx(tx, prepared.userId);
	assertCommunicationAccessTx(tx, prepared.sourceNarratorId, principal, "write");
	const dirty: string[] = [];
	for (const id of prepared.targetNarratorIds) {
		assertCommunicationAccessTx(tx, id, principal, "write");
		if (
			insertCommunicationPeerTx(tx, prepared.sourceNarratorId, id, {
				userId: principal.userId,
				source: "admission",
				...provenance,
			})
		)
			dirty.push(prepared.sourceNarratorId, id);
	}
	return [...new Set(dirty)];
}
export const commitUserConnections = commitUserCommunicationAdmissionTx;
async function assertCommunicationEndpointAuthorized(
	source: string,
	target: string,
	allowArchivedForFailure: boolean,
): Promise<void> {
	if (activeDatabaseBackend === "postgres") {
		if (!postgresRuntime || postgresRuntime.closed)
			throw new AppError("Communication unavailable", 503, "COMMUNICATION_UNAVAILABLE");
		await withCommunicationPgTransaction(postgresRuntime.client.db, (tx) =>
			assertCommunicationSendAuthorizedPg(tx, source, target, allowArchivedForFailure),
		);
		return;
	}
	db.transaction((tx) => {
		const authorized = assertCommunicationSendAuthorizedTx(
			tx,
			source,
			target,
			allowArchivedForFailure,
		);
		return authorized;
	});
}

export function assertCommunicationSendAuthorized(source: string, target: string): Promise<void> {
	return assertCommunicationEndpointAuthorized(source, target, false);
}

/** An exact archived ID may be reported as a per-target failure, never enqueued. */
export function assertArchivedCommunicationTargetVisible(
	source: string,
	target: string,
): Promise<void> {
	return assertCommunicationEndpointAuthorized(source, target, true);
}

export async function mutateCommunication(
	narratorId: string,
	principal: NarratorPrincipal,
	mutation: CommunicationMutation,
): Promise<CommunicationMutationResult> {
	let ids: string[] = [narratorId];
	const changed = db.transaction((tx) => {
		const current = currentCommunicationPrincipalTx(tx, principal.userId);
		if (mutation.kind === "disconnect") {
			const peer = tx
				.select({ endpointLo: peers.endpointLo, endpointHi: peers.endpointHi })
				.from(peers)
				.where(eq(peers.id, mutation.peerId))
				.limit(1)
				.get();
			if (!peer || (peer.endpointLo !== narratorId && peer.endpointHi !== narratorId))
				throw new NotFoundError("Communication peer", mutation.peerId);
			// Either endpoint's writer may unilaterally revoke its contact. The other endpoint is not disclosed.
			assertCommunicationAccessTx(tx, narratorId, current, "write");
			ids = [peer.endpointLo, peer.endpointHi];
			tx.delete(peers).where(eq(peers.id, mutation.peerId)).run();
			return true;
		}
		assertCommunicationAccessTx(tx, narratorId, current, "write");
		if (mutation.kind === "connect") {
			assertCommunicationAccessTx(tx, mutation.targetNarratorId, current, "write");
			ids.push(mutation.targetNarratorId);
			return insertCommunicationPeerTx(tx, narratorId, mutation.targetNarratorId, {
				userId: current.userId,
				source: "manual",
			});
		}
		if (mutation.kind === "split") return splitCommunicationTx(tx, narratorId, mutation.version);
		const node = tx.select().from(nodes).where(eq(nodes.narratorId, narratorId)).limit(1).get();
		if (!node?.originalParentNarratorId)
			throw new AppError(
				"No original communication parent remains",
				409,
				"COMMUNICATION_NO_PARENT",
			);
		assertCommunicationAccessTx(tx, node.originalParentNarratorId, current, "write");
		ids.push(node.originalParentNarratorId);
		return restoreCommunicationTx(tx, narratorId, node.originalParentNarratorId, mutation.version);
	});
	if (changed) publishCommunicationChanged(ids);
	return { changed };
}
