import { createHash } from "node:crypto";
import {
	remoteHistoryObjects as objects,
	remoteHistoryReceipts as receipts,
} from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type {
	RemoteHistoryBinding,
	RemoteHistoryObject,
	RemoteHistoryReceipt,
	RemoteHistoryRequest,
} from "@shared/remote-history-protocol";
import { and, eq, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import {
	assertRemoteHistoryBinding,
	assertRemoteHistoryObject,
	type RemoteHistoryJournal,
} from "./remote-history-service";

export type RemoteHistoryObjectRow = typeof objects.$inferSelect;
export type RemoteHistoryReceiptRow = typeof receipts.$inferSelect;
type MetadataDb = Pick<BunSQLiteDatabase, "select" | "insert" | "update">;

/** Async storage boundary, deliberately not a synchronous SQLite/PG compatibility shim.
 * Implementations must bound JSON reads before parsing and never clear/delete pending rows. */
export interface RemoteHistoryMetadataStore {
	putIntent(row: RemoteHistoryReceiptRow): Promise<RemoteHistoryReceiptRow>;
	putReceipt(row: RemoteHistoryReceiptRow): Promise<RemoteHistoryReceiptRow>;
	markUnknown(
		deviceId: string,
		binding: RemoteHistoryBinding,
		operationId: string,
		timestamp: string,
	): Promise<void>;
	putObject(row: RemoteHistoryObjectRow): Promise<RemoteHistoryObjectRow>;
	getReceipt(
		binding: RemoteHistoryBinding,
		operationId: string,
	): Promise<RemoteHistoryReceiptRow | null>;
	getObject(
		binding: RemoteHistoryBinding,
		objectId: string,
	): Promise<RemoteHistoryObjectRow | null>;
}

function receiptKey(binding: RemoteHistoryBinding, operationId: string) {
	return and(
		eq(receipts.sourceInstanceId, binding.sourceInstanceId),
		eq(receipts.scopeId, binding.scopeId),
		eq(receipts.operationId, operationId),
	);
}
function objectKey(binding: RemoteHistoryBinding, objectId: string) {
	return and(
		eq(objects.sourceInstanceId, binding.sourceInstanceId),
		eq(objects.scopeId, binding.scopeId),
		eq(objects.objectId, objectId),
	);
}

/** Indexed, bounded metadata CRUD only: no FS, scans, GC, recovery inference or IO transaction. */
export class SQLiteRemoteHistoryMetadataStore implements RemoteHistoryMetadataStore {
	constructor(private readonly database: MetadataDb) {}

	async getReceipt(binding: RemoteHistoryBinding, operationId: string) {
		const key = receiptKey(binding, operationId);
		const sizes = this.database
			.select({
				receipt: sql<number>`coalesce(length(cast(${receipts.receiptJson} as blob)),0)`,
				intent: sql<number>`coalesce(length(cast(${receipts.intentJson} as blob)),0)`,
			})
			.from(receipts)
			.where(key)
			.get();
		if (!sizes) return null;
		if (
			sizes.receipt > FILE_CHANGE_LIMITS.summaryBytes ||
			sizes.intent > FILE_CHANGE_LIMITS.summaryBytes
		)
			throw new Error("Remote journal metadata budget exceeded");
		return (
			this.database
				.select()
				.from(receipts)
				.where(
					and(
						key,
						sql`coalesce(length(cast(${receipts.receiptJson} as blob)),0) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
						sql`coalesce(length(cast(${receipts.intentJson} as blob)),0) <= ${FILE_CHANGE_LIMITS.summaryBytes}`,
					),
				)
				.get() ?? null
		);
	}

	async getObject(binding: RemoteHistoryBinding, objectId: string) {
		return this.database.select().from(objects).where(objectKey(binding, objectId)).get() ?? null;
	}

	async putIntent(row: RemoteHistoryReceiptRow) {
		this.database.insert(receipts).values(row).onConflictDoNothing().run();
		const stored = await this.getReceipt(rowBinding(row), row.operationId);
		if (!stored) throw new Error("Remote intent was not persisted");
		return stored;
	}

	async putReceipt(row: RemoteHistoryReceiptRow) {
		const rank = {
			intent: 0,
			applying: 1,
			recovery_required: 2,
			settled: 3,
			finalized: 4,
			compensated: 4,
			rejected: 4,
			unknown: -1,
		}[row.state];
		const applied =
			row.receiptJson?.effects.filter((effect) => effect.outcome === "applied").length ?? 0;
		// Terminal rows may only receive the identical terminal state. A stale response
		// cannot turn committed history into unknown, nor replace another device/root.
		this.database
			.insert(receipts)
			.values(row)
			.onConflictDoUpdate({
				target: [receipts.sourceInstanceId, receipts.scopeId, receipts.operationId],
				set: {
					state: row.state,
					receiptJson: row.receiptJson,
					serverCommitId: row.serverCommitId,
					updatedAt: row.updatedAt,
				},
				setWhere: and(
					eq(receipts.deviceId, row.deviceId),
					eq(receipts.workspaceInstanceId, row.workspaceInstanceId),
					eq(receipts.rootIdentity, row.rootIdentity),
					eq(receipts.fencingToken, row.fencingToken),
					eq(receipts.requestDigest, row.requestDigest),
					eq(receipts.kind, row.kind),
					sql`not (coalesce(json_extract(${receipts.receiptJson}, '$.capturePhase'),'') = 'warm' and ${row.receiptJson?.capturePhase ?? ""} = 'hot')`,
					sql`(${receipts.state} = 'unknown' or case ${receipts.state} when 'intent' then 0 when 'applying' then 1 when 'recovery_required' then 2 when 'settled' then 3 else 4 end <= ${rank})`,
					sql`(${receipts.receiptJson} is null or (select count(*) from json_each(${receipts.receiptJson}, '$.effects') where json_extract(value, '$.outcome') = 'applied') <= ${applied})`,
					sql`(${receipts.state} not in ('finalized','compensated','rejected') or ${receipts.state} = ${row.state})`,
					// A refusal is immutable evidence, not a terminal state interchangeable
					// with completed IO. Preserve its exact proof under stale responses.
					sql`(${receipts.state} != 'rejected' or ${receipts.receiptJson} = ${JSON.stringify(row.receiptJson)})`,
					sql`(${receipts.serverCommitId} is null or ${receipts.serverCommitId} = ${row.serverCommitId})`,
					sql`(${receipts.receiptJson} is null or json_extract(${receipts.receiptJson}, '$.payloadDigest') = ${row.receiptJson?.payloadDigest})`,
				),
			})
			.run();
		const stored = await this.getReceipt(rowBinding(row), row.operationId);
		if (!stored) throw new Error("Remote receipt was not persisted");
		return stored;
	}

	async markUnknown(
		deviceId: string,
		binding: RemoteHistoryBinding,
		operationId: string,
		timestamp: string,
	) {
		this.database
			.update(receipts)
			.set({ state: "unknown", updatedAt: timestamp })
			.where(
				and(
					receiptKey(binding, operationId),
					eq(receipts.deviceId, deviceId),
					eq(receipts.workspaceInstanceId, binding.workspaceInstanceId),
					eq(receipts.rootIdentity, binding.rootIdentity),
					eq(receipts.fencingToken, binding.fence),
					sql`${receipts.state} in ('intent','applying','unknown')`,
				),
			)
			.run();
	}

	async putObject(row: RemoteHistoryObjectRow) {
		this.database.insert(objects).values(row).onConflictDoNothing().run();
		const stored = await this.getObject(rowBinding(row), row.objectId);
		if (!stored) throw new Error("Remote object catalog was not persisted");
		return stored;
	}
}

// Device is not in the wire binding; namespace comparison at the factory/store
// caller supplies it explicitly. No lookup ever chooses a device by digest.
function rowBinding(row: RemoteHistoryReceiptRow | RemoteHistoryObjectRow): RemoteHistoryBinding {
	return {
		sourceInstanceId: row.sourceInstanceId,
		scopeId: row.scopeId,
		workspaceInstanceId: row.workspaceInstanceId,
		rootIdentity: row.rootIdentity,
		root: "",
		fence: "fencingToken" in row ? row.fencingToken : 0,
	};
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, value]) => value !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, value]) => [key, canonical(value)]),
		);
	return value;
}
function metadataJson(value: unknown): string {
	const json = JSON.stringify(canonical(value));
	if (Buffer.byteLength(json) > FILE_CHANGE_LIMITS.summaryBytes)
		throw new Error("Remote journal metadata budget exceeded");
	return json;
}
function assertRowNamespace(
	deviceId: string,
	binding: RemoteHistoryBinding,
	row: RemoteHistoryReceiptRow | RemoteHistoryObjectRow,
) {
	if (
		row.deviceId !== deviceId ||
		row.sourceInstanceId !== binding.sourceInstanceId ||
		row.workspaceInstanceId !== binding.workspaceInstanceId ||
		row.scopeId !== binding.scopeId ||
		row.rootIdentity !== binding.rootIdentity
	)
		throw new Error("Remote journal namespace conflict");
}

export interface PersistentRemoteHistoryJournal extends RemoteHistoryJournal {
	getIntent(
		operationId: string,
	): Promise<import("./remote-history-service").RemoteHistoryIntent | null>;
	getReceipt(operationId: string): Promise<RemoteHistoryReceipt | null>;
	getObject(objectId: string): Promise<RemoteHistoryObject | null>;
}

/** Production factory with an honestly async store seam. Default DB import is lazy:
 * importing/testing this module never opens the user's database. PG is refused
 * until a dedicated async store is installed through options.store. */
export function createPersistentRemoteHistoryJournal(
	deviceId: string,
	binding: RemoteHistoryBinding,
	options: { store?: RemoteHistoryMetadataStore; clock?: () => string } = {},
): PersistentRemoteHistoryJournal {
	const pinned = Object.freeze({ ...binding });
	let storePromise: Promise<RemoteHistoryMetadataStore> | undefined;
	const store = () =>
		(storePromise ??= options.store
			? Promise.resolve(options.store)
			: import("../db").then(({ db, postgresRuntime }) => {
					if (postgresRuntime)
						throw new Error(
							"unsupported_database: async PostgreSQL remote history journal not installed",
						);
					return new SQLiteRemoteHistoryMetadataStore(db);
				}));
	const clock = options.clock ?? (() => new Date().toISOString());
	const namespace = {
		deviceId,
		sourceInstanceId: pinned.sourceInstanceId,
		workspaceInstanceId: pinned.workspaceInstanceId,
		scopeId: pinned.scopeId,
		rootIdentity: pinned.rootIdentity,
	};
	return {
		async getIntent(operationId) {
			if (!operationId || operationId.length > 256)
				throw new Error("Invalid original remote operation ID");
			const row = await (await store()).getReceipt(pinned, operationId);
			if (!row) return null;
			assertRowNamespace(deviceId, pinned, row);
			if (row.kind !== "mutate" && row.kind !== "restore" && row.kind !== "compensate")
				throw new Error("Original remote intent is not a mutation");
			const request = row.intentJson;
			if (!request || !row.intentDigest) return null;
			metadataJson(request);
			assertRemoteHistoryBinding(pinned, request.binding);
			if (
				row.operationId !== operationId ||
				request.operationId !== operationId ||
				row.fencingToken !== pinned.fence ||
				row.requestDigest !== request.requestDigest ||
				row.intentDigest !==
					createHash("sha256")
						.update(metadataJson({ kind: row.kind, request }))
						.digest("hex")
			)
				throw new Error("Original remote intent provenance/digest conflict");
			return { request: structuredClone(request), kind: row.kind };
		},
		async putIntent(request, kind) {
			assertRemoteHistoryBinding(pinned, request.binding);
			if (
				!/^[a-f0-9]{64}$/.test(request.requestDigest) ||
				!request.operationId ||
				request.operationId.length > 256
			)
				throw new Error("Invalid remote intent identity");
			const metadata: RemoteHistoryRequest = {
				...request,
				changes: request.changes?.map(({ contentBase64: _bytes, ...change }) => change),
			};
			const encoded = metadataJson({ kind, request: metadata });
			const intentDigest = createHash("sha256").update(encoded).digest("hex");
			const timestamp = clock();
			const row = await (await store()).putIntent({
				id: generateId(),
				...namespace,
				operationId: request.operationId,
				requestDigest: request.requestDigest,
				fencingToken: pinned.fence,
				kind,
				state: "intent",
				intentDigest,
				intentJson: metadata,
				receiptJson: null,
				serverCommitId: null,
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			assertRowNamespace(deviceId, pinned, row);
			if (
				row.requestDigest !== request.requestDigest ||
				row.intentDigest !== intentDigest ||
				row.kind !== kind ||
				row.fencingToken !== pinned.fence
			)
				throw new Error("Remote intent digest conflict");
		},
		async putReceipt(receipt) {
			assertRemoteHistoryBinding(pinned, receipt.binding);
			metadataJson(receipt);
			if (
				!/^[a-f0-9]{64}$/.test(receipt.payloadDigest) ||
				!/^[a-f0-9]{64}$/.test(receipt.requestDigest)
			)
				throw new Error("Invalid remote receipt digest");
			const timestamp = clock();
			const row = await (await store()).putReceipt({
				id: generateId(),
				...namespace,
				operationId: receipt.operationId,
				requestDigest: receipt.requestDigest,
				fencingToken: pinned.fence,
				kind: receipt.kind,
				state: receipt.state,
				receiptJson: receipt,
				intentDigest: null,
				intentJson: null,
				serverCommitId: receipt.serverCommitId ?? null,
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			assertRowNamespace(deviceId, pinned, row);
			if (
				row.requestDigest !== receipt.requestDigest ||
				row.fencingToken !== pinned.fence ||
				row.kind !== receipt.kind ||
				(row.receiptJson && row.receiptJson.payloadDigest !== receipt.payloadDigest)
			)
				throw new Error("Remote receipt digest conflict");
			if (
				receipt.state === "rejected" &&
				(row.state !== "rejected" ||
					!row.receiptJson ||
					metadataJson(row.receiptJson) !== metadataJson(receipt))
			)
				throw new Error("Remote refusal proof was not durably recorded");
		},
		async markUnknown(target, operationId) {
			assertRemoteHistoryBinding(pinned, target);
			await (await store()).markUnknown(deviceId, pinned, operationId, clock());
		},
		async putObject(object) {
			assertRemoteHistoryObject(pinned, object);
			const row = await (await store()).putObject({
				id: generateId(),
				...namespace,
				objectId: object.objectId,
				kind: object.kind,
				algorithm: object.algorithm,
				digest: object.digest,
				sizeBytes: object.sizeBytes,
				originPath: object.path,
				placement: "remote",
				state: "ready",
				createdAt: clock(),
			});
			assertRowNamespace(deviceId, pinned, row);
			if (
				row.objectId !== object.objectId ||
				row.digest !== object.digest ||
				row.originPath !== object.path ||
				row.kind !== object.kind ||
				row.algorithm !== "sha256" ||
				row.sizeBytes !== object.sizeBytes ||
				row.placement !== "remote"
			)
				throw new Error("Remote object catalog conflict");
		},
		async getReceipt(operationId) {
			const row = await (await store()).getReceipt(pinned, operationId);
			if (!row) return null;
			assertRowNamespace(deviceId, pinned, row);
			if (row.fencingToken !== pinned.fence) throw new Error("Remote journal fence conflict");
			return row.receiptJson;
		},
		async getObject(objectId) {
			const row = await (await store()).getObject(pinned, objectId);
			if (!row) return null;
			assertRowNamespace(deviceId, pinned, row);
			if (row.state !== "ready" || row.placement !== "remote" || row.algorithm !== "sha256")
				throw new Error("Remote object unavailable");
			const object: RemoteHistoryObject = {
				sourceInstanceId: row.sourceInstanceId,
				workspaceInstanceId: row.workspaceInstanceId,
				scopeId: row.scopeId,
				objectId: row.objectId,
				algorithm: "sha256",
				digest: row.digest,
				sizeBytes: row.sizeBytes,
				kind: row.kind,
				path: row.originPath,
			};
			assertRemoteHistoryObject(pinned, object);
			return object;
		},
	};
}
