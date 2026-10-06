import { createHash } from "node:crypto";

/** A separate fixture protocol, deliberately not an extension of the dry-run-only shared plan. */
export const FIXTURE_DETACH_LIMITS = {
	rows: 512,
	pages: 64,
	bytes: 512 * 1024,
	outputBytes: 512 * 1024,
	nodes: 24000,
	depth: 20,
	milliseconds: 1000,
	tokenMilliseconds: 30_000,
	/** Independent wall-clock bound for the entire post-CAS fixture effect phase. */
	effectMilliseconds: 1000,
	/** Also bound injected reservation/admission waiters, including admission completion. */
	preparationMilliseconds: 1000,
} as const;
export type FixtureId = `fixture:${string}`;
export type Cell = string | number | boolean | null | { blobBase64: string };
export type FullRow = Record<string, Cell>;
export interface ClosureObject {
	id: FixtureId;
	kind: "history" | "lazy" | "ref" | "tool" | "spec" | "provenance" | "blob" | "tree";
	row: FullRow;
	/** Exact bytes, not parsed/re-serialized JSON. */
	rawBase64: string;
	byteDigest: string;
	dependencies: FixtureId[];
	available: boolean;
}
export interface PhysicalIdentity {
	deviceId: FixtureId;
	path: FixtureId;
	cwd: FixtureId;
	worktree: FixtureId;
	repositoryKey: FixtureId;
	cwdRepositoryKey: FixtureId;
	directoryIdentity: FixtureId;
	symlinkIdentity: FixtureId;
	shadowKey: FixtureId;
	treeBoundaryPath: FixtureId;
	local: boolean;
	known: boolean;
}
export interface NormalizedSnapshot {
	format: "local-session-detach-fixture/v1";
	namespace: FixtureId;
	instance: FixtureId;
	schema: string;
	collection: {
		complete: boolean;
		currentSnapshot: boolean;
		pages: number;
		missingObjects: FixtureId[];
		truncated: boolean;
	};
	/** Full rows, including every unknown business field and raw JSON/BLOB cells. */
	narrator: FullRow & {
		id: FixtureId;
		chapterId: FixtureId | null;
		contextProjectId: FixtureId | null;
		cwd: FixtureId;
		defaultDeviceId: FixtureId | null;
		workspaceContext: string;
		workspaceRevision: number;
		messageVersion: number;
		messageStructureVersion: number;
		type: "primary";
	};
	chapter: FullRow & {
		id: FixtureId;
		projectId: FixtureId;
		state: string;
		role: string;
		snapshotShadowKey: FixtureId;
	};
	identity: PhysicalIdentity;
	acl: {
		rootId: FixtureId;
		projectId: FixtureId;
		ownerUserId: FixtureId;
		ownerExists: boolean;
		ownerNarratorIds: FixtureId[];
		shared: boolean;
		source: "local" | "oauth" | "unknown";
		permissionLineage: FullRow[];
		readOnly: boolean;
		denyRulesKnown: boolean;
		lineageComplete: boolean;
	};
	/** Current trusted fixture-store evidence, never a request DTO's isAdmin flag. */
	authority: {
		actorId: FixtureId;
		exists: boolean;
		canDetach: boolean;
		admin: boolean;
		revision: number;
		/** Digest of the current actor policy evidence, independent of any request DTO. */
		policyFingerprint: string;
	};
	runtime: {
		ownerEpoch: number;
		generation: number;
		fence: number;
		leaseVersion: number;
		leaseId: FixtureId | null;
		leases: FixtureId[];
		quarantined: boolean;
		paused: boolean;
		state: "idle" | "running" | "unknown";
		queues: FixtureId[];
		activeChildren: FixtureId[];
		waitingPermissions: FixtureId[];
		observationsComplete: boolean;
	};
	resource: {
		id: FixtureId;
		/** null is proven absence; never collapse a missing/unread row into null. */
		row: FullRow | null;
		claims: FullRow[];
		uses: FullRow[];
		evidenceComplete: boolean;
		dependencies: Array<{ id: FixtureId; kind: "terminal" | "container" | "port" | "volume" }>;
	};
	closure: {
		complete: boolean;
		historicalPathsKnown: boolean;
		rootIds: FixtureId[];
		objects: ClosureObject[];
	};
	/** Other affected rows with explicit existence; includes raw spec/provenance metadata. */
	beforeRows: Array<{ table: FixtureId; id: FixtureId; row: FullRow | null }>;
}
export interface FixtureAuthority {
	readonly kind: "isolated-memory-fixture";
	readonly namespace: FixtureId;
	readonly instance: FixtureId;
}
export interface FixtureScope {
	fixtureAuthority: FixtureAuthority;
	narratorId: FixtureId;
	identity: PhysicalIdentity;
}
export interface FixtureReservation {
	fixtureAuthority: FixtureAuthority;
	id: FixtureId;
	owned(): boolean;
	/** Synchronous completion only: executor checks undefined at runtime, including JS/async inputs. */
	release(): void;
	/** Synchronous completion only; a returned promise is uncertain, never proof of protection. */
	retainProtection(): void;
}
export type FixtureEffectStage = "install" | "verify" | "publish";
export interface FixtureEffectContext {
	/** Cooperatively abort ongoing work; ignoring this signal never disables the hard deadline. */
	signal: AbortSignal;
	/** performance.now() coordinate, shared across the complete effect phase, never reset per stage. */
	deadlineAt: number;
	stage: FixtureEffectStage;
}
export type FixturePreparationStage = "reserve" | "admission";
export interface FixturePreparationContext {
	signal: AbortSignal;
	deadlineAt: number;
	stage: FixturePreparationStage;
}
export interface FixturePorts {
	fixtureAuthority: FixtureAuthority;
	reserve(
		scope: FixtureScope,
		signal?: AbortSignal,
		preparation?: FixturePreparationContext,
	): Promise<FixtureReservation>;
	/** Await and return the sole body's result, holding its barrier through readback/publication. */
	withAdmission<T>(
		scope: FixtureScope,
		body: () => Promise<T>,
		preparation?: FixturePreparationContext,
	): Promise<T>;
	assertAdmission(scope: FixtureScope): void;
	installRuntime(
		scope: FixtureScope,
		after: NormalizedSnapshot,
		effect: FixtureEffectContext,
	): Promise<void>;
	verifyRuntime(
		scope: FixtureScope,
		after: NormalizedSnapshot,
		effect: FixtureEffectContext,
	): Promise<void>;
	publish(
		scope: FixtureScope,
		after: NormalizedSnapshot,
		effect: FixtureEffectContext,
	): Promise<void>;
	/** Synchronous completion only; unknown async completion cannot prove the runtime is paused. */
	pause(scope: FixtureScope): void;
}
export function assertFixtureId(value: unknown): asserts value is FixtureId {
	if (typeof value !== "string" || !/^fixture:[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(value)) {
		throw new Error("FIXTURE_ID_REQUIRED");
	}
}
export function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("ABORTED");
}
type FieldCheck = (value: unknown) => void;
/** Validate every declared field, not only the entries a caller happens to provide. */
export function assertSnapshotShape(snapshot: unknown): asserts snapshot is NormalizedSnapshot {
	const record: FieldCheck = (value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("SNAPSHOT_RECORD_REQUIRED");
	};
	const text: FieldCheck = (value) => {
		if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
			throw new Error("SNAPSHOT_TEXT_REQUIRED");
	};
	const bytesText: FieldCheck = (value) => {
		if (typeof value !== "string") throw new Error("SNAPSHOT_STRING_REQUIRED");
	};
	const bool: FieldCheck = (value) => {
		if (typeof value !== "boolean") throw new Error("SNAPSHOT_BOOLEAN_REQUIRED");
	};
	const version: FieldCheck = (value) => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			throw new Error("SNAPSHOT_VERSION");
	};
	const fingerprint: FieldCheck = (value) => {
		if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
			throw new Error("SNAPSHOT_FINGERPRINT_REQUIRED");
	};
	const nullable =
		(check: FieldCheck): FieldCheck =>
		(value) => {
			if (value !== null) check(value);
		};
	const array =
		(check: FieldCheck): FieldCheck =>
		(value) => {
			if (!Array.isArray(value)) throw new Error("SNAPSHOT_ARRAY_REQUIRED");
			for (const entry of value) check(entry);
		};
	const fields =
		(checks: Record<string, FieldCheck>, path: string): FieldCheck =>
		(value) => {
			record(value);
			for (const [key, check] of Object.entries(checks)) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) {
					throw new Error(`SNAPSHOT_REQUIRED_FIELD:${path}.${key}`);
				}
				check(descriptor.value);
			}
		};
	fields(
		{
			format: text,
			namespace: assertFixtureId,
			instance: assertFixtureId,
			schema: text,
			collection: fields(
				{
					complete: bool,
					currentSnapshot: bool,
					pages: version,
					missingObjects: array(assertFixtureId),
					truncated: bool,
				},
				"collection",
			),
			narrator: fields(
				{
					id: assertFixtureId,
					chapterId: nullable(assertFixtureId),
					contextProjectId: nullable(assertFixtureId),
					cwd: assertFixtureId,
					defaultDeviceId: nullable(assertFixtureId),
					workspaceContext: text,
					workspaceRevision: version,
					messageVersion: version,
					messageStructureVersion: version,
					type: text,
				},
				"narrator",
			),
			chapter: fields(
				{
					id: assertFixtureId,
					projectId: assertFixtureId,
					state: text,
					role: text,
					snapshotShadowKey: assertFixtureId,
				},
				"chapter",
			),
			identity: fields(
				{
					deviceId: assertFixtureId,
					path: assertFixtureId,
					cwd: assertFixtureId,
					worktree: assertFixtureId,
					repositoryKey: assertFixtureId,
					cwdRepositoryKey: assertFixtureId,
					directoryIdentity: assertFixtureId,
					symlinkIdentity: assertFixtureId,
					shadowKey: assertFixtureId,
					treeBoundaryPath: assertFixtureId,
					local: bool,
					known: bool,
				},
				"identity",
			),
			acl: fields(
				{
					rootId: assertFixtureId,
					projectId: assertFixtureId,
					ownerUserId: assertFixtureId,
					ownerExists: bool,
					ownerNarratorIds: array(assertFixtureId),
					shared: bool,
					source: text,
					permissionLineage: array(record),
					readOnly: bool,
					denyRulesKnown: bool,
					lineageComplete: bool,
				},
				"acl",
			),
			authority: fields(
				{
					actorId: assertFixtureId,
					exists: bool,
					canDetach: bool,
					admin: bool,
					revision: version,
					policyFingerprint: fingerprint,
				},
				"authority",
			),
			runtime: fields(
				{
					ownerEpoch: version,
					generation: version,
					fence: version,
					leaseVersion: version,
					leaseId: nullable(assertFixtureId),
					leases: array(assertFixtureId),
					quarantined: bool,
					paused: bool,
					state: text,
					queues: array(assertFixtureId),
					activeChildren: array(assertFixtureId),
					waitingPermissions: array(assertFixtureId),
					observationsComplete: bool,
				},
				"runtime",
			),
			resource: fields(
				{
					id: assertFixtureId,
					row: nullable(record),
					claims: array(record),
					uses: array(record),
					evidenceComplete: bool,
					dependencies: array(fields({ id: assertFixtureId, kind: text }, "resource.dependency")),
				},
				"resource",
			),
			closure: fields(
				{
					complete: bool,
					historicalPathsKnown: bool,
					rootIds: array(assertFixtureId),
					objects: array(
						fields(
							{
								id: assertFixtureId,
								kind: text,
								row: record,
								rawBase64: bytesText,
								byteDigest: fingerprint,
								dependencies: array(assertFixtureId),
								available: bool,
							},
							"closure.object",
						),
					),
				},
				"closure",
			),
			beforeRows: array(
				fields(
					{ table: assertFixtureId, id: assertFixtureId, row: nullable(record) },
					"beforeRows.row",
				),
			),
		},
		"snapshot",
	)(snapshot);
}
/** Check bounds BEFORE serialization/hash/clone; no full-database collector exists here. */
export function boundedSnapshot(snapshot: NormalizedSnapshot, signal?: AbortSignal): string {
	const started = performance.now();
	let nodes = 0;
	let bytes = 0;
	const ancestors = new Set<object>();
	// Serialize only verified own data, never the caller's object (JSON invokes inherited toJSON).
	// Hidden plain data is validated but remains outside canonical JSON; symbols are not this protocol.
	function visit(value: unknown, depth: number): unknown {
		checkAbort(signal);
		if (++nodes > FIXTURE_DETACH_LIMITS.nodes || depth > FIXTURE_DETACH_LIMITS.depth) {
			throw new Error("SNAPSHOT_NODE_BUDGET");
		}
		if (performance.now() - started > FIXTURE_DETACH_LIMITS.milliseconds) {
			throw new Error("SNAPSHOT_TIME_BUDGET");
		}
		if (typeof value === "string") bytes += Buffer.byteLength(value);
		else if (value === null || typeof value === "boolean") bytes += 5;
		else if (typeof value === "number" && Number.isFinite(value)) bytes += 24;
		else if (typeof value === "object" && value !== null) {
			if (Array.isArray(value) && value.length > FIXTURE_DETACH_LIMITS.nodes) {
				throw new Error("SNAPSHOT_NODE_BUDGET");
			}
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
				throw new Error("SNAPSHOT_NON_JSON_VALUE");
			}
			for (
				let inherited = prototype;
				inherited !== null;
				inherited = Object.getPrototypeOf(inherited)
			) {
				const hook = Object.getOwnPropertyDescriptor(inherited, "toJSON");
				if (hook && (!("value" in hook) || typeof hook.value === "function")) {
					throw new Error("SNAPSHOT_SERIALIZATION_HOOK");
				}
			}
			if (ancestors.has(value)) throw new Error("SNAPSHOT_CYCLE");
			ancestors.add(value);
			const keys = Reflect.ownKeys(value);
			if (keys.length > FIXTURE_DETACH_LIMITS.nodes) throw new Error("SNAPSHOT_NODE_BUDGET");
			const safe: object = Array.isArray(value) ? [] : Object.create(null);
			// Even a hook on a built-in prototype cannot run during stringify of this copy.
			Object.setPrototypeOf(safe, null);
			for (const key of keys) {
				if (typeof key !== "string") throw new Error("SNAPSHOT_NON_JSON_KEY");
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (!descriptor || !("value" in descriptor)) throw new Error("SNAPSHOT_ACCESSOR");
				bytes += Buffer.byteLength(key) + 4;
				const checked = visit(descriptor.value, depth + 1);
				if (descriptor.enumerable || Array.isArray(value)) {
					Object.defineProperty(safe, key, { value: checked, enumerable: descriptor.enumerable });
				}
			}
			if (Array.isArray(value)) {
				// Holes could consult inherited getters during validation/iteration.
				for (let index = 0; index < value.length; index++) {
					if (!Object.hasOwn(value, index)) throw new Error("SNAPSHOT_ARRAY_HOLE");
				}
			}
			ancestors.delete(value);
			if (bytes > FIXTURE_DETACH_LIMITS.bytes) throw new Error("SNAPSHOT_BYTE_BUDGET");
			return safe;
		} else throw new Error("SNAPSHOT_NON_JSON_VALUE");
		if (bytes > FIXTURE_DETACH_LIMITS.bytes) throw new Error("SNAPSHOT_BYTE_BUDGET");
		return value;
	}
	const safeSnapshot = visit(snapshot, 0);
	assertSnapshotShape(snapshot);
	if (snapshot.format !== "local-session-detach-fixture/v1") throw new Error("FIXTURE_FORMAT");
	const booleans: unknown[] = [
		snapshot.collection.complete,
		snapshot.collection.currentSnapshot,
		snapshot.collection.truncated,
		snapshot.identity.local,
		snapshot.identity.known,
		snapshot.acl.ownerExists,
		snapshot.acl.shared,
		snapshot.acl.readOnly,
		snapshot.acl.denyRulesKnown,
		snapshot.acl.lineageComplete,
		snapshot.authority.exists,
		snapshot.authority.canDetach,
		snapshot.authority.admin,
		snapshot.runtime.quarantined,
		snapshot.runtime.paused,
		snapshot.runtime.observationsComplete,
		snapshot.resource.evidenceComplete,
		snapshot.closure.complete,
		snapshot.closure.historicalPathsKnown,
		...snapshot.closure.objects.map((o) => o.available),
	];
	if (booleans.some((value) => typeof value !== "boolean"))
		throw new Error("SNAPSHOT_BOOLEAN_REQUIRED");
	const ids: unknown[] = [
		snapshot.namespace,
		snapshot.instance,
		snapshot.narrator.id,
		snapshot.narrator.chapterId,
		snapshot.narrator.contextProjectId,
		snapshot.narrator.cwd,
		snapshot.narrator.defaultDeviceId,
		snapshot.chapter.id,
		snapshot.chapter.projectId,
		snapshot.chapter.snapshotShadowKey,
		snapshot.acl.rootId,
		snapshot.acl.projectId,
		snapshot.acl.ownerUserId,
		snapshot.authority.actorId,
		snapshot.resource.id,
		snapshot.runtime.leaseId,
		...snapshot.acl.ownerNarratorIds,
		...snapshot.runtime.leases,
		...snapshot.runtime.queues,
		...snapshot.runtime.activeChildren,
		...snapshot.runtime.waitingPermissions,
		...snapshot.collection.missingObjects,
		...snapshot.closure.rootIds,
	];
	for (const [key, value] of Object.entries(snapshot.identity)) {
		if (key !== "local" && key !== "known") ids.push(value);
	}
	for (const object of snapshot.closure.objects) ids.push(object.id, ...object.dependencies);
	for (const row of snapshot.beforeRows) ids.push(row.table, row.id);
	for (const dep of snapshot.resource.dependencies) ids.push(dep.id);
	for (const value of ids) if (value !== null) assertFixtureId(value);
	for (const version of [
		snapshot.narrator.workspaceRevision,
		snapshot.narrator.messageVersion,
		snapshot.narrator.messageStructureVersion,
		snapshot.runtime.ownerEpoch,
		snapshot.runtime.generation,
		snapshot.runtime.fence,
		snapshot.runtime.leaseVersion,
		snapshot.authority.revision,
	]) {
		if (!Number.isSafeInteger(version) || version < 0) throw new Error("SNAPSHOT_VERSION");
	}
	const rows =
		snapshot.closure.objects.length +
		snapshot.beforeRows.length +
		snapshot.acl.permissionLineage.length +
		snapshot.resource.claims.length +
		snapshot.resource.uses.length +
		3;
	if (
		rows > FIXTURE_DETACH_LIMITS.rows ||
		!Number.isSafeInteger(snapshot.collection.pages) ||
		snapshot.collection.pages < 1 ||
		snapshot.collection.pages > FIXTURE_DETACH_LIMITS.pages
	) {
		throw new Error("SNAPSHOT_ROW_PAGE_BUDGET");
	}
	const fullRows = [
		snapshot.narrator,
		snapshot.chapter,
		...snapshot.beforeRows.map((r) => r.row),
		...snapshot.closure.objects.map((o) => o.row),
		...snapshot.acl.permissionLineage,
		...snapshot.resource.claims,
		...snapshot.resource.uses,
		snapshot.resource.row,
	];
	for (const row of fullRows) {
		if (row === null) continue;
		for (const [key, value] of Object.entries(row)) {
			if ((key === "id" || key.endsWith("Id") || key.endsWith("From")) && value !== null) {
				assertFixtureId(value);
			}
			if (typeof value === "object" && value !== null) {
				if (
					Object.keys(value).length !== 1 ||
					typeof value.blobBase64 !== "string" ||
					Buffer.from(value.blobBase64, "base64").toString("base64") !== value.blobBase64
				) {
					throw new Error("SNAPSHOT_BLOB_INVALID");
				}
			}
		}
	}
	const serialized = JSON.stringify(safeSnapshot);
	if (performance.now() - started > FIXTURE_DETACH_LIMITS.milliseconds) {
		throw new Error("SNAPSHOT_TIME_BUDGET");
	}
	if (Buffer.byteLength(serialized) > FIXTURE_DETACH_LIMITS.outputBytes) {
		throw new Error("SNAPSHOT_OUTPUT_BUDGET");
	}
	checkAbort(signal);
	return serialized;
}
export function digest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}
export function snapshotDigest(snapshot: NormalizedSnapshot, signal?: AbortSignal): string {
	return digest(boundedSnapshot(snapshot, signal));
}
