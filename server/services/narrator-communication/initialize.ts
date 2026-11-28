import { sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { decodeCommunicationJson, originalCommunicationDelegator } from "./access";
import { communicationRead } from "./reader";
import { publishCommunicationChanged } from "./service";
import { type CommunicationExecutor, ensureCommunicationNodeTx } from "./store";

type Birth = {
	id: string;
	type: string;
	variant: string;
	parentNarratorId: string | null;
	runtimeRegistrationJson: unknown;
};
function validatedLegacyParent(tx: CommunicationExecutor, row: Birth): string | null {
	const parent = originalCommunicationDelegator(row);
	if (!parent) return null;
	const seen = new Set([row.id]);
	let current: string | null = parent;
	while (current !== null) {
		if (seen.has(current) || seen.size >= 16)
			throw new Error("Invalid legacy communication ancestry");
		seen.add(current);
		const [stored]: Array<{ parent: string | null } | undefined> = tx.all<{
			parent: string | null;
		}>(
			sql`SELECT parent_narrator_id AS parent FROM narrator_communication_nodes WHERE narrator_id = ${current} LIMIT 1`,
		);
		if (stored) {
			current = stored.parent;
			continue;
		}
		const [ancestor] = tx.all<Birth>(
			sql`SELECT id, type, variant, parent_narrator_id AS parentNarratorId, runtime_registration_json AS runtimeRegistrationJson FROM narrators WHERE id = ${current} LIMIT 1`,
		);
		if (!ancestor) throw new Error("Missing legacy communication ancestor");
		ancestor.runtimeRegistrationJson = decodeCommunicationJson(ancestor.runtimeRegistrationJson);
		current = originalCommunicationDelegator(ancestor);
	}
	return parent;
}
export function ensureLegacyCommunicationNodeTx(tx: CommunicationExecutor, row: Birth): void {
	let parent: string | null = null;
	try {
		row.runtimeRegistrationJson = decodeCommunicationJson(row.runtimeRegistrationJson);
		parent = validatedLegacyParent(tx, row);
	} catch (error) {
		logger.warn("Legacy communication node initialized as independent root", {
			narratorId: row.id,
			error: String(error),
		});
	}
	ensureCommunicationNodeTx(tx, row.id, parent);
}
/** Must run AFTER legacy delegation registration materialization. Insert-only, never resurrects NULL. */
export async function initializeCommunicationNodes(ids?: readonly string[]): Promise<number> {
	let after = "";
	let written = 0;
	const selected = ids ? new Set(ids) : null;
	// Background pages use the read Worker; only bounded indexed ancestry/writes run in the transaction.
	for (;;) {
		const rows = await communicationRead(
			`SELECT n.id FROM narrators n LEFT JOIN narrator_communication_nodes c ON c.narrator_id = n.id WHERE c.narrator_id IS NULL AND n.id > ? ORDER BY n.id LIMIT 100`,
			[after],
			{ operation: "communication-initialize" },
		);
		if (!rows.length) break;
		const dirty: string[] = [];
		for (const candidate of rows) {
			if (selected && !selected.has(String(candidate.id))) continue;
			db.transaction((tx) => {
				const [row] = tx.all<Birth>(
					sql`SELECT id, type, variant, parent_narrator_id AS parentNarratorId, runtime_registration_json AS runtimeRegistrationJson FROM narrators WHERE id = ${String(candidate.id)} LIMIT 1`,
				);
				if (
					!row ||
					tx.get(
						sql`SELECT narrator_id FROM narrator_communication_nodes WHERE narrator_id = ${row.id}`,
					)
				)
					return;
				let parent: string | null = null;
				try {
					row.runtimeRegistrationJson = decodeCommunicationJson(row.runtimeRegistrationJson);
					parent = validatedLegacyParent(tx, row);
				} catch (error) {
					logger.warn("Legacy communication node initialized as independent root", {
						narratorId: row.id,
						error: String(error),
					});
				}
				ensureCommunicationNodeTx(tx, row.id, parent);
				dirty.push(row.id);
				written++;
			});
		}
		publishCommunicationChanged(dirty);
		after = String(rows[rows.length - 1].id);
		if (rows.length < 100) break;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return written;
}
