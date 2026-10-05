import { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	assertFixtureId,
	boundedSnapshot,
	checkAbort,
	digest,
	FIXTURE_DETACH_LIMITS,
	type FixtureAuthority,
	type FixtureId,
	type NormalizedSnapshot,
	snapshotDigest,
} from "./contract";
import { detachedImage, planFixtureDetach } from "./planner";

export interface FixtureToken {
	kind: "fixture-detach-token";
	namespace: FixtureId;
	instance: FixtureId;
	actorId: FixtureId;
	narratorId: FixtureId;
	planDigest: string;
	snapshotDigest: string;
	authorityDigest: string;
	identityDigest: string;
	workspaceRevision: number;
	messageVersion: number;
	messageStructureVersion: number;
	ownerEpoch: number;
	runtimeGeneration: number;
	fence: number;
	leaseVersion: number;
	leaseId: FixtureId | null;
	backupId: FixtureId;
	backupDigest: string;
	expiresAt: number;
	nonce: string;
	signature: string;
}
/** Private-store recovery authority, deliberately not a reservation or a port-owned receipt. */
export interface FixtureRecoveryHold {
	readonly kind: "fixture-store-recovery-quarantine";
	readonly fixtureAuthority: FixtureAuthority;
	readonly id: FixtureId;
}
export interface FixtureBackup {
	format: "fixture-detach-whole-image/v1";
	id: FixtureId;
	complete: true;
	previousAbsent: boolean;
	before: NormalizedSnapshot;
	digest: string;
}
/** No path/database argument: the only constructible adapter is this fresh in-memory database. */
export class IsolatedFixtureDetachStore {
	readonly fixtureAuthority: FixtureAuthority;
	#db: Database;
	#key = randomBytes(32);
	#closed = false;
	#recoveryHold: FixtureRecoveryHold | undefined;
	constructor(initial: NormalizedSnapshot) {
		const payload = boundedSnapshot(initial);
		this.#db = new Database(":memory:");
		this.fixtureAuthority = Object.freeze({
			kind: "isolated-memory-fixture",
			namespace: initial.namespace,
			instance: initial.instance,
		});
		this.#db.exec(`CREATE TABLE fixture_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL, digest TEXT NOT NULL);
			CREATE TABLE fixture_backups (id TEXT PRIMARY KEY, payload TEXT NOT NULL, digest TEXT NOT NULL);
			CREATE TABLE fixture_tokens (nonce TEXT PRIMARY KEY, consumed INTEGER NOT NULL DEFAULT 0);`);
		this.#db.query("INSERT INTO fixture_state VALUES (1, ?, ?)").run(payload, digest(payload));
	}
	close(): void {
		if (!this.#closed) {
			this.#closed = true;
			this.#db.close();
		}
	}
	/** Every new fixture admission/preparation/CAS must pass this independent gate. */
	assertFixtureWorkAllowed(): void {
		if (this.#closed) throw new Error("FIXTURE_STORE_CLOSED");
		if (this.#recoveryHold) throw new Error("FIXTURE_RECOVERY_QUARANTINED");
	}
	/** Bounded singleton hold: only this store can mint it; no injected port receives its handle. */
	acquireFixtureRecoveryHold(): FixtureRecoveryHold {
		this.assertFixtureWorkAllowed();
		const hold: FixtureRecoveryHold = Object.freeze({
			kind: "fixture-store-recovery-quarantine",
			fixtureAuthority: this.fixtureAuthority,
			id: `fixture:quarantine:${randomBytes(12).toString("hex")}`,
		});
		this.#recoveryHold = hold;
		return hold;
	}
	hasFixtureRecoveryHold(hold?: FixtureRecoveryHold): boolean {
		return (
			!this.#closed &&
			this.#recoveryHold !== undefined &&
			(hold === undefined || hold === this.#recoveryHold)
		);
	}
	/** Only the exact unshared hold can be removed after proven synchronous cleanup. */
	releaseFixtureRecoveryHold(hold: FixtureRecoveryHold): void {
		if (!this.hasFixtureRecoveryHold(hold)) throw new Error("FIXTURE_QUARANTINE_AUTHORITY");
		this.#recoveryHold = undefined;
	}
	read(): NormalizedSnapshot {
		const row = this.#db
			.query("SELECT payload, digest FROM fixture_state WHERE singleton=1")
			.get() as { payload: string; digest: string };
		if (digest(row.payload) !== row.digest) throw new Error("FIXTURE_STORE_CORRUPT");
		const image = JSON.parse(row.payload) as NormalizedSnapshot;
		boundedSnapshot(image);
		return image;
	}
	#sign(token: Omit<FixtureToken, "signature">): string {
		return createHmac("sha256", this.#key).update(JSON.stringify(token)).digest("hex");
	}
	/** Explicit fixture-only preparation; dry run never calls this. */
	prepare(actorId: FixtureId, now = Date.now(), signal?: AbortSignal): FixtureToken {
		this.assertFixtureWorkAllowed();
		assertFixtureId(actorId);
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("FIXTURE_CLOCK_INVALID");
		const before = this.read();
		const plan = planFixtureDetach(before, signal);
		if (
			!plan.ready ||
			!plan.planDigest ||
			!plan.snapshotDigest ||
			actorId !== before.authority.actorId
		) {
			throw new Error("FIXTURE_NOT_READY");
		}
		const backupId: FixtureId = `fixture:backup:${randomBytes(12).toString("hex")}`;
		const nonce = randomBytes(16).toString("hex");
		const payload = boundedSnapshot(before, signal);
		const unsigned: Omit<FixtureToken, "signature"> = {
			kind: "fixture-detach-token",
			namespace: before.namespace,
			instance: before.instance,
			actorId,
			narratorId: before.narrator.id,
			planDigest: plan.planDigest,
			snapshotDigest: plan.snapshotDigest,
			authorityDigest: digest(JSON.stringify([before.acl, before.authority])),
			identityDigest: digest(JSON.stringify(before.identity)),
			workspaceRevision: before.narrator.workspaceRevision,
			messageVersion: before.narrator.messageVersion,
			messageStructureVersion: before.narrator.messageStructureVersion,
			ownerEpoch: before.runtime.ownerEpoch,
			runtimeGeneration: before.runtime.generation,
			fence: before.runtime.fence,
			leaseVersion: before.runtime.leaseVersion,
			leaseId: before.runtime.leaseId,
			backupId,
			backupDigest: digest(payload),
			expiresAt: now + FIXTURE_DETACH_LIMITS.tokenMilliseconds,
			nonce,
		};
		this.#db.transaction(() => {
			checkAbort(signal);
			this.#db
				.query("INSERT INTO fixture_backups VALUES (?, ?, ?)")
				.run(backupId, payload, digest(payload));
			this.#db.query("INSERT INTO fixture_tokens(nonce) VALUES (?)").run(nonce);
		})();
		return { ...unsigned, signature: this.#sign(unsigned) };
	}
	validate(
		token: FixtureToken,
		actorId: FixtureId,
		now = Date.now(),
		signal?: AbortSignal,
	): FixtureBackup {
		checkAbort(signal);
		assertFixtureId(actorId);
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("FIXTURE_CLOCK_INVALID");
		let fields = 0;
		for (const key in token) {
			const descriptor = Object.getOwnPropertyDescriptor(token, key);
			if (
				++fields > 26 ||
				!descriptor ||
				!("value" in descriptor) ||
				key.length > 64 ||
				(typeof descriptor.value !== "string" &&
					typeof descriptor.value !== "number" &&
					descriptor.value !== null) ||
				(typeof descriptor.value === "string" && Buffer.byteLength(descriptor.value) > 256) ||
				(typeof descriptor.value === "number" && !Number.isSafeInteger(descriptor.value))
			) {
				throw new Error("TOKEN_BUDGET");
			}
		}
		if (Buffer.byteLength(JSON.stringify(token)) > 4096) throw new Error("TOKEN_BUDGET");
		const { signature, ...unsigned } = token;
		const actual = Buffer.from(signature ?? "", "hex");
		const expected = Buffer.from(this.#sign(unsigned), "hex");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			throw new Error("TOKEN_SIGNATURE");
		if (
			token.kind !== "fixture-detach-token" ||
			token.namespace !== this.fixtureAuthority.namespace ||
			token.instance !== this.fixtureAuthority.instance ||
			token.actorId !== actorId ||
			token.expiresAt <= now
		)
			throw new Error("TOKEN_BINDING_OR_EXPIRY");
		const nonce = this.#db
			.query("SELECT consumed FROM fixture_tokens WHERE nonce=?")
			.get(token.nonce) as { consumed: number } | null;
		if (!nonce || nonce.consumed !== 0) throw new Error("TOKEN_REPLAYED");
		const current = this.read();
		const plan = planFixtureDetach(current, signal);
		if (
			!plan.ready ||
			current.authority.actorId !== actorId ||
			current.narrator.id !== token.narratorId ||
			plan.snapshotDigest !== token.snapshotDigest ||
			plan.planDigest !== token.planDigest ||
			digest(JSON.stringify([current.acl, current.authority])) !== token.authorityDigest ||
			digest(JSON.stringify(current.identity)) !== token.identityDigest
		)
			throw new Error("CURRENT_EVIDENCE_CHANGED");
		const row = this.#db
			.query("SELECT payload, digest FROM fixture_backups WHERE id=?")
			.get(token.backupId) as { payload: string; digest: string } | null;
		if (
			!row ||
			row.digest !== token.backupDigest ||
			digest(row.payload) !== row.digest ||
			row.digest !== token.snapshotDigest
		)
			throw new Error("BACKUP_INCOMPLETE");
		const before = JSON.parse(row.payload) as NormalizedSnapshot;
		boundedSnapshot(before, signal);
		return {
			format: "fixture-detach-whole-image/v1",
			id: token.backupId,
			complete: true,
			previousAbsent: before.resource.row === null,
			before,
			digest: row.digest,
		};
	}
	/** Synchronous SQLite transaction: assert/re-read/CAS/write/readback have no await gap. */
	commit(
		token: FixtureToken,
		actorId: FixtureId,
		after: NormalizedSnapshot,
		assertOwnedAndAdmission: () => void,
		now = Date.now(),
		signal?: AbortSignal,
	): void {
		this.assertFixtureWorkAllowed();
		this.#db.transaction(() => {
			assertOwnedAndAdmission();
			this.assertFixtureWorkAllowed();
			const backup = this.validate(token, actorId, now, signal);
			const payload = boundedSnapshot(after, signal);
			if (digest(payload) !== snapshotDigest(detachedImage(backup.before), signal)) {
				throw new Error("UNPLANNED_AFTERIMAGE");
			}
			const changed = this.#db
				.query("UPDATE fixture_state SET payload=?, digest=? WHERE singleton=1 AND digest=?")
				.run(payload, digest(payload), token.snapshotDigest);
			if (changed.changes !== 1) throw new Error("CAS_FAILED");
			const consumed = this.#db
				.query("UPDATE fixture_tokens SET consumed=1 WHERE nonce=? AND consumed=0")
				.run(token.nonce);
			if (consumed.changes !== 1) throw new Error("TOKEN_REPLAYED");
			assertOwnedAndAdmission();
			this.assertFixtureWorkAllowed();
			checkAbort(signal);
			if (snapshotDigest(this.read()) !== digest(payload)) throw new Error("READBACK_FAILED");
		})();
	}
	/** No historical replay: restore the whole image only if exact committed afterimage still exists. */
	compensate(
		backup: FixtureBackup,
		after: NormalizedSnapshot,
		assertOwnedAndAdmission: () => void,
	): void {
		this.#db.transaction(() => {
			assertOwnedAndAdmission();
			const persisted = this.#db
				.query("SELECT payload, digest FROM fixture_backups WHERE id=?")
				.get(backup.id) as { payload: string; digest: string } | null;
			if (
				!backup.complete ||
				!persisted ||
				persisted.digest !== backup.digest ||
				digest(persisted.payload) !== backup.digest ||
				snapshotDigest(backup.before) !== backup.digest ||
				backup.previousAbsent !== (backup.before.resource.row === null)
			)
				throw new Error("BACKUP_INCOMPLETE");
			if (snapshotDigest(after) !== snapshotDigest(detachedImage(backup.before))) {
				throw new Error("UNPLANNED_AFTERIMAGE");
			}
			const current = this.read();
			if (snapshotDigest(current) !== snapshotDigest(after))
				throw new Error("COMPENSATION_CONFLICT");
			const restored = structuredClone(backup.before);
			restored.narrator.workspaceRevision = after.narrator.workspaceRevision + 1;
			const context = JSON.parse(restored.narrator.workspaceContext);
			context.revision = restored.narrator.workspaceRevision;
			restored.narrator.workspaceContext = JSON.stringify(context);
			const payload = boundedSnapshot(restored);
			const result = this.#db
				.query("UPDATE fixture_state SET payload=?, digest=? WHERE singleton=1 AND digest=?")
				.run(payload, digest(payload), snapshotDigest(after));
			if (result.changes !== 1) throw new Error("COMPENSATION_CONFLICT");
			assertOwnedAndAdmission();
		})();
	}
	/** Explicit simulation of concurrent fixture writers, not a production adapter. */
	mutateFixture(body: (snapshot: NormalizedSnapshot) => void): void {
		const image = this.read();
		body(image);
		if (
			image.namespace !== this.fixtureAuthority.namespace ||
			image.instance !== this.fixtureAuthority.instance
		) {
			throw new Error("FIXTURE_NAMESPACE_IMMUTABLE");
		}
		const payload = boundedSnapshot(image);
		this.#db
			.query("UPDATE fixture_state SET payload=?, digest=? WHERE singleton=1")
			.run(payload, digest(payload));
	}
	/** A real SQLite write fault for the isolated executor's CAS/atomicity failure fixtures. */
	setFixtureWriteFailure(enabled: boolean): void {
		if (enabled)
			this.#db.exec(`CREATE TEMP TRIGGER fixture_fail_state_update BEFORE UPDATE ON fixture_state
			BEGIN SELECT RAISE(IGNORE); END;`);
		else this.#db.exec("DROP TRIGGER IF EXISTS fixture_fail_state_update");
	}
	removeFixtureBackup(id: FixtureId): void {
		assertFixtureId(id);
		this.#db.query("DELETE FROM fixture_backups WHERE id=?").run(id);
	}
}
