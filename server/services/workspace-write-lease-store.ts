import { workspaceWriteLeases as leases } from "@server/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { WorkspaceWriteCoordinatorDb } from "./workspace-write-coordinator";

export type WorkspaceLeaseDb = Pick<
	WorkspaceWriteCoordinatorDb,
	"select" | "insert" | "update" | "delete"
>;
export type WorkspaceMutationManifest = Readonly<{ effectId?: string; operationId?: string }>;
export type WorkspaceLeaseRow = typeof leases.$inferSelect;
export const WORKSPACE_LEASE_LIMITS = Object.freeze({
	// 2,000 dispatches with real 64-byte hashes and 21-byte operation/effect IDs
	// need ~350 KiB. This is independent of the immutable physical range budget.
	manifestBytes: 512 * 1024,
	barrierInventoryBytes: 512 * 1024,
	retainedTerminal: 512,
	cleanupBatch: 16,
});

/** Read lengths before JSON bodies: a row-count LIMIT alone could decode 32 MiB per check.
 * null is an incomplete inventory and MUST fail closed, never mean no barriers. */
export function readWorkspaceLeaseBarriers(
	tx: WorkspaceLeaseDb,
	deviceId: string,
	status: "executing" | "quarantined",
	limit: number,
) {
	const inventory = tx
		.select({
			leaseId: leases.leaseId,
			bytes: sql<number>`length(cast(${leases.rangesJson} as blob))`,
		})
		.from(leases)
		.where(and(eq(leases.deviceId, deviceId), eq(leases.status, status)))
		.limit(limit + 1)
		.all();
	if (
		inventory.length > limit ||
		inventory.reduce((total, row) => total + row.bytes, 0) >
			WORKSPACE_LEASE_LIMITS.barrierInventoryBytes
	)
		return null;
	if (!inventory.length) return [];
	return tx
		.select({
			leaseId: leases.leaseId,
			ownerEpoch: leases.ownerEpoch,
			scopeId: leases.scopeId,
			deviceId: leases.deviceId,
			pathFlavor: leases.pathFlavor,
			rangesJson: leases.rangesJson,
		})
		.from(leases)
		.where(
			and(
				eq(leases.deviceId, deviceId),
				eq(leases.status, status),
				inArray(
					leases.leaseId,
					inventory.map((row) => row.leaseId),
				),
			),
		)
		.limit(limit)
		.all();
}

/** Append a bounded immutable dispatch identity BEFORE any IO. Settlement changes outcome only. */
export function appendWorkspaceMutation(
	tx: WorkspaceLeaseDb,
	leaseId: string,
	mutationId: string,
	manifest: WorkspaceMutationManifest = {},
	expectedIndex: number,
): void {
	for (const value of [manifest.effectId, manifest.operationId]) {
		if (
			value !== undefined &&
			(typeof value !== "string" ||
				!value ||
				value.includes("\0") ||
				Buffer.byteLength(value) > 256)
		)
			throw new Error("Invalid mutation manifest identity");
	}
	// Serialize only the new bounded item; never SELECT/parse/stringify the full
	// historical manifest in JS for every registration (quadratic allocation).
	const item = JSON.stringify({
		mutationId,
		effectId: manifest.effectId,
		operationId: manifest.operationId,
		outcome: "pending",
	});
	const next = sql`json_insert(${leases.mutationManifestJson}, '$.mutations[#]', json(${item}))`;
	const updated = tx
		.update(leases)
		.set({ mutationManifestJson: next, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(leases.leaseId, leaseId),
				eq(leases.status, "executing"),
				sql`json_extract(${leases.mutationManifestJson}, '$.version') = 1`,
				sql`json_array_length(${leases.mutationManifestJson}, '$.mutations') = ${expectedIndex}`,
				// Reserve four bytes per entry for pending -> not_applied growth.
				sql`length(cast(${leases.mutationManifestJson} as blob)) + ${Buffer.byteLength(item) + 1 + (expectedIndex + 1) * 4} <= ${WORKSPACE_LEASE_LIMITS.manifestBytes}`,
			),
		)
		.returning({ id: leases.leaseId })
		.get();
	if (!updated) throw new Error("Lease mutation manifest missing, changed or exceeds byte budget");
}

export function settleWorkspaceMutation(
	tx: WorkspaceLeaseDb,
	leaseId: string,
	mutationId: string,
	outcome: "applied" | "not_applied" | "unknown",
	index: number,
): void {
	if (!Number.isSafeInteger(index) || index < 0)
		throw new Error("Pending durable mutation index missing");
	const base = `$.mutations[${index}]`;
	const updated = tx
		.update(leases)
		.set({
			mutationManifestJson: sql`json_set(${leases.mutationManifestJson}, ${`${base}.outcome`}, ${outcome})`,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(leases.leaseId, leaseId),
				eq(leases.status, "executing"),
				sql`json_extract(${leases.mutationManifestJson}, '$.version') = 1`,
				sql`json_extract(${leases.mutationManifestJson}, ${`${base}.mutationId`}) = ${mutationId}`,
				sql`json_extract(${leases.mutationManifestJson}, ${`${base}.outcome`}) = 'pending'`,
			),
		)
		.returning({ id: leases.leaseId })
		.get();
	if (!updated) throw new Error("Pending durable mutation missing");
}

/** Index-bounded retention. Never delete executing/quarantined records or rely on age to unlock. */
export function pruneWorkspaceTerminalLeases(tx: WorkspaceLeaseDb): void {
	for (const status of ["settled", "recovered"] as const) {
		const expired = tx
			.select({ leaseId: leases.leaseId })
			.from(leases)
			.where(eq(leases.status, status))
			.orderBy(desc(leases.updatedAt), desc(leases.leaseId))
			.offset(WORKSPACE_LEASE_LIMITS.retainedTerminal)
			.limit(WORKSPACE_LEASE_LIMITS.cleanupBatch)
			.all();
		if (expired.length)
			tx.delete(leases)
				.where(
					and(
						eq(leases.status, status),
						inArray(
							leases.leaseId,
							expired.map((row) => row.leaseId),
						),
					),
				)
				.run();
	}
}

/** Shared minimal SQLite fixture schema; production DDL is generated from schema.ts. */
export const WORKSPACE_WRITE_LEASE_TEST_DDL = `
CREATE TABLE workspace_write_leases (
 lease_id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES file_change_scopes(id),
 device_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, execution_class TEXT NOT NULL DEFAULT 'unknown', runtime_epoch TEXT NOT NULL,
 runtime_generation INTEGER NOT NULL, fencing_token INTEGER NOT NULL, scope_revision INTEGER NOT NULL,
 path_flavor TEXT NOT NULL, status TEXT NOT NULL, ranges_json TEXT NOT NULL,
 mutation_manifest_json TEXT NOT NULL, execution_ended_at TEXT, termination_evidence_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_workspace_lease_device_status ON workspace_write_leases(device_id,status,lease_id);
CREATE INDEX idx_workspace_lease_scope ON workspace_write_leases(scope_id,status,lease_id);
CREATE INDEX idx_workspace_lease_cleanup ON workspace_write_leases(status,updated_at,lease_id);
`;
