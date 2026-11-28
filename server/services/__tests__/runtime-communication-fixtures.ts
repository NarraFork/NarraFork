import { aclGrants } from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	type CommunicationExecutor,
	ensureCommunicationNodeTx,
	insertCommunicationPeerTx,
} from "../narrator-communication/store";

export { ensureCommunicationNodeTx };

/** A persisted write grant doesn't become the recipient's own execution identity. */
export function grantFixtureNarratorWrite(
	tx: Pick<CommunicationExecutor, "insert">,
	narratorId: string,
	userId: string,
): void {
	tx.insert(aclGrants)
		.values({
			id: generateId(),
			scopeType: "narrator",
			scopeId: narratorId,
			principalType: "user",
			principalId: userId,
			capability: "write",
			createdAt: new Date().toISOString(),
		})
		.run();
}

/** Seed an explicit contact between existing nodes, never infer it from delivery/control. */
export function seedFixtureCommunicationPeer(
	tx: CommunicationExecutor,
	sourceId: string,
	targetId: string,
	userId: string,
): void {
	if (!insertCommunicationPeerTx(tx, sourceId, targetId, { userId, source: "manual" })) {
		throw new Error("Expected to insert a peer between two distinct fixture groups");
	}
}
