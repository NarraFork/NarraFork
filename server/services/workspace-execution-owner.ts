import { workspaceExecutionOwners, workspaceWriteLeases } from "@server/db/schema";
import {
	getInstanceMaintenanceAuthority,
	registerInstanceLockProcessIdentity,
} from "@server/lib/instance-lock";
import {
	isWorkspaceProcessIdentity,
	observeWorkspaceProcess,
	type WorkspaceProcessIdentity,
	type WorkspaceProcessObservation,
	workspaceProcessEndReason,
} from "@server/lib/workspace-process-identity";
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export type WorkspaceExecutionOwnerDb = Pick<BunSQLiteDatabase, "select" | "insert">;
export type WorkspaceOwnerRegistration = typeof workspaceExecutionOwners.$inferSelect;
declare const ownerEndedBrand: unique symbol;
export type WorkspaceOwnerEndedEvidence = Readonly<{
	[ownerEndedBrand]: true;
	ownerEpoch: string;
	identity: WorkspaceProcessIdentity;
	reason: "pid_absent" | "pid_reused" | "boot_changed";
	observedAt: string;
}>;

type OwnerDependencies = {
	pid: number;
	observe(pid: number): Promise<WorkspaceProcessObservation>;
	now(): string;
	registerLockIdentity?(identity: WorkspaceProcessIdentity): Promise<void>;
};
type OwnerState = {
	registrations: WeakMap<object, { epoch: string; promise: Promise<void> }>;
	proofs: WeakSet<object>;
};

function createOwnerAuthority(deps: OwnerDependencies, state: OwnerState) {
	function getWorkspaceOwnerRegistration(
		db: Pick<WorkspaceExecutionOwnerDb, "select">,
		ownerEpoch: string,
	): WorkspaceOwnerRegistration | undefined {
		return db
			.select()
			.from(workspaceExecutionOwners)
			.where(eq(workspaceExecutionOwners.ownerEpoch, ownerEpoch))
			.get();
	}

	/** Once, at startup before admissions; never probe on Edit/Write admission. */
	function initializeWorkspaceExecutionOwner(
		db: WorkspaceExecutionOwnerDb,
		ownerEpoch: string,
	): Promise<void> {
		if (!ownerEpoch) return Promise.reject(new Error("Workspace owner epoch is required"));
		// Drizzle wrappers are recreated by --hot; the underlying SQLite connection is pinned.
		const client = (db as WorkspaceExecutionOwnerDb & { $client?: object }).$client;
		const cacheKey =
			client && (typeof client === "object" || typeof client === "function") ? client : db;
		const existing = state.registrations.get(cacheKey);
		if (existing) {
			if (existing.epoch !== ownerEpoch)
				return Promise.reject(new Error("Workspace owner epoch already initialized"));
			return existing.promise;
		}
		// Install the promise before observation; concurrent calls and --hot reuse exactly one probe.
		const promise = Promise.resolve().then(async () => {
			if (
				getWorkspaceOwnerRegistration(db, ownerEpoch) ||
				db
					.select({ id: workspaceWriteLeases.leaseId })
					.from(workspaceWriteLeases)
					.where(eq(workspaceWriteLeases.ownerEpoch, ownerEpoch))
					.limit(1)
					.get()
			) {
				throw new Error("Refusing to register a historical workspace owner epoch");
			}
			const observation = await deps.observe(deps.pid).catch(() => ({ kind: "unknown" }) as const);
			const identity =
				observation.kind === "present" &&
				observation.identity.pid === deps.pid &&
				isWorkspaceProcessIdentity(observation.identity)
					? observation.identity
					: null;
			const row = db
				.insert(workspaceExecutionOwners)
				.values({
					ownerEpoch,
					identityJson: identity,
					createdAt: deps.now(),
				})
				.onConflictDoNothing()
				.returning({ epoch: workspaceExecutionOwners.ownerEpoch })
				.get();
			if (!row) throw new Error("Workspace owner epoch registration collided");
			if (identity) await deps.registerLockIdentity?.(identity);
		});
		state.registrations.set(cacheKey, { epoch: ownerEpoch, promise });
		return promise;
	}

	async function proveWorkspaceOwnerEnded(
		db: Pick<WorkspaceExecutionOwnerDb, "select">,
		ownerEpoch: string,
	): Promise<WorkspaceOwnerEndedEvidence | null> {
		const row = getWorkspaceOwnerRegistration(db, ownerEpoch);
		if (!row || !isWorkspaceProcessIdentity(row.identityJson)) return null;
		const identity = row.identityJson;
		const observed = await deps.observe(identity.pid).catch(() => ({ kind: "unknown" }) as const);
		const reason = workspaceProcessEndReason(identity, observed);
		if (!reason) return null;
		const proof = Object.freeze({
			ownerEpoch,
			identity: Object.freeze({ ...identity, domain: Object.freeze({ ...identity.domain }) }),
			reason,
			observedAt: deps.now(),
		}) as WorkspaceOwnerEndedEvidence;
		state.proofs.add(proof);
		return proof;
	}

	function assertWorkspaceOwnerEndedEvidence(proof: unknown, expectedOwnerEpoch: string): void {
		if (
			!proof ||
			typeof proof !== "object" ||
			!state.proofs.has(proof) ||
			(proof as WorkspaceOwnerEndedEvidence).ownerEpoch !== expectedOwnerEpoch
		) {
			throw new Error("Workspace owner end requires an authentic matching OS observation proof");
		}
	}

	return {
		initializeWorkspaceExecutionOwner,
		getWorkspaceOwnerRegistration,
		proveWorkspaceOwnerEnded,
		assertWorkspaceOwnerEndedEvidence,
	};
}

// Both registration promises and proof capabilities survive hot reload, but never serialization.
const STATE = Symbol.for("narrafork.workspaceExecutionOwner.v1");
const globals = globalThis as unknown as Record<symbol, OwnerState | undefined>;
const state = globals[STATE] ?? { registrations: new WeakMap(), proofs: new WeakSet() };
globals[STATE] = state;
const authority = createOwnerAuthority(
	{
		pid: process.pid,
		observe: observeWorkspaceProcess,
		now: () => new Date().toISOString(),
		registerLockIdentity: registerInstanceLockProcessIdentity,
	},
	state,
);
export const {
	initializeWorkspaceExecutionOwner,
	getWorkspaceOwnerRegistration,
	proveWorkspaceOwnerEnded,
	assertWorkspaceOwnerEndedEvidence,
} = authority;

export function getWorkspaceMaintenanceAuthority(): Readonly<{ allowed: boolean; reason: string }> {
	return getInstanceMaintenanceAuthority();
}

export function assertWorkspaceMaintenanceAuthority(): void {
	const authority = getWorkspaceMaintenanceAuthority();
	if (!authority.allowed)
		throw new Error(
			`Workspace maintenance requires exclusive instance authority: ${authority.reason}`,
		);
}

/** Tests get an isolated proof issuer, which cannot mint production-accepted capabilities. */
export const __testing = {
	createAuthority(
		deps: OwnerDependencies,
		state: OwnerState = { registrations: new WeakMap(), proofs: new WeakSet() },
	) {
		return { ...createOwnerAuthority(deps, state), state };
	},
};
