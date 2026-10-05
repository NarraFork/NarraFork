import { Database } from "bun:sqlite";
import { parentPort } from "node:worker_threads";
import { openDatabase } from "@server/db/connection";
import type {
	NarratorBackupPlan,
	NarratorBackupProfile,
	NarratorRestoreMapping,
	NarratorRestorePreview,
	NarratorRestoreResult,
} from "@shared/narrator-backup";
import { SQL } from "bun";
import { authorizeBackupSource, type BackupAccessOptions } from "./access";
import {
	hashBackupFile,
	NarratorBackupArtifactWriter,
	readNarratorBackupArtifact,
} from "./artifact";
import { backupAttestationKey, signBackupPayload, verifyBackupPayload } from "./attestation";
import {
	BACKUP_TABLES,
	type BackupActor,
	type BackupManifest,
	type BackupTable,
	mappingBlockers,
	STATE_EXCLUSIONS,
	TREE_EXCLUSIONS,
} from "./contract";
import {
	type BackupSqlConnection,
	SqlNarratorBackupMainStore,
	validateRestoreTarget,
} from "./main-store";
import { type BackupObjectSource, collectBackupObjects } from "./objects";
import { postgresBackupConnection } from "./postgres-main-store";
import { sqliteBackupConnection } from "./sqlite-main-store";
import { collectBackupState } from "./state";

export interface BackupWorkerConfig extends BackupAccessOptions {
	backend: "sqlite" | "postgres";
	databasePath: string;
	postgresUrl?: string;
	sourceInstanceId: string;
	/** Application-private persistent key directory, configured only by the server. */
	proofDirectory?: string;
	objectSource: Omit<BackupObjectSource, "fileBlobDigests">;
}
export interface BackupWorkerRequest {
	action: "plan" | "export" | "preview" | "restore" | "download" | "upload";
	config: BackupWorkerConfig;
	actor: BackupActor;
	profile?: NarratorBackupProfile;
	narratorIds?: string[];
	artifactId?: string;
	artifactPath?: string;
	stagingPath?: string;
	expectedDigest?: string;
	mapping?: NarratorRestoreMapping;
	cancellation: SharedArrayBuffer;
	deadline: number;
}
export type BackupWorkerResult =
	| NarratorBackupPlan
	| NarratorRestorePreview
	| NarratorRestoreResult
	| { digest: string; narratorIds: string[]; verifiedSameInstance?: boolean };

/** Pure entrypoint also used by isolated fixtures. No application db imports/startup/migrations. */
export async function runBackupWorker(
	request: BackupWorkerRequest,
	dependencies: {
		readonlySourceStore?: BackupSqlConnection;
		beforeSourceFence?: () => Promise<void>;
	} = {},
): Promise<BackupWorkerResult> {
	const cancellation = new Int32Array(request.cancellation);
	const controller = new AbortController();
	const check = () => {
		if (Atomics.load(cancellation, 0) === 1 || Date.now() >= request.deadline) {
			controller.abort();
			throw new Error("Backup cancelled or deadline exceeded");
		}
	};
	check();
	const polling = setInterval(() => {
		if (Atomics.load(cancellation, 0) === 1 || Date.now() >= request.deadline) controller.abort();
	}, 25);
	const { config, actor } = request;
	let sqlite: Database | undefined;
	let authorizationSqlite: Database | undefined;
	let postgres: SQL | undefined;
	let authorizationPostgres: SQL | undefined;
	let connection: BackupSqlConnection;
	try {
		if (config.backend === "postgres") {
			if (!config.postgresUrl) throw new Error("PostgreSQL backup connection unavailable");
			postgres = new SQL(config.postgresUrl, { max: 1, connectionTimeout: 10, idleTimeout: 10 });
			connection = postgresBackupConnection(postgres);
		} else {
			sqlite =
				request.action === "restore"
					? openDatabase(config.databasePath)
					: new Database(config.databasePath, { readonly: true });
			sqlite.run("PRAGMA busy_timeout=250");
			connection = sqliteBackupConnection(sqlite);
		}
		// Authorization never shares the frozen export transaction: a revoked grant
		// must be observed even while the state/object snapshot is still open.
		let sourceAccess = dependencies.readonlySourceStore;
		if (!sourceAccess) {
			if (config.backend === "postgres") {
				if (!config.postgresUrl) throw new Error("PostgreSQL backup connection unavailable");
				authorizationPostgres = new SQL(config.postgresUrl, {
					max: 1,
					connectionTimeout: 10,
					idleTimeout: 10,
				});
				sourceAccess = postgresBackupConnection(authorizationPostgres);
			} else {
				authorizationSqlite = new Database(config.databasePath, { readonly: true });
				authorizationSqlite.run("PRAGMA busy_timeout=250");
				sourceAccess = sqliteBackupConnection(authorizationSqlite);
			}
		}
		const sourceFence = async (
			state: Parameters<typeof authorizeBackupSource>[1],
			wholeTree: boolean,
			projectIds: readonly string[] = [],
		) => {
			await dependencies.beforeSourceFence?.();
			await authorizeBackupSource(sourceAccess, state, actor, config, check, wholeTree, projectIds);
		};
		const store = new SqlNarratorBackupMainStore(connection);
		const user = (
			await connection.query("SELECT id,role FROM users WHERE id=$1 LIMIT 1", [actor.userId])
		)[0];
		if (!user) throw new Error("Backup actor no longer exists");
		const freshActor = { userId: actor.userId, isAdmin: actor.isAdmin && user.role === "admin" };
		if (request.action === "plan" || request.action === "export") {
			if (!request.narratorIds?.length || !request.profile)
				throw new Error("Missing backup selection");
			const profile = request.profile;
			const exclusions = profile === "conversation-tree-v1" ? TREE_EXCLUSIONS : STATE_EXCLUSIONS;
			return await store.snapshot(async () => {
				const state = await collectBackupState(store, request.narratorIds ?? [], freshActor, check);
				const narratorIds = (state.rows.narrators ?? []).map((r) => String(r.id));
				await sourceFence(state, profile === "conversation-tree-v1");
				if (request.action === "plan")
					return { narratorIds, profile, exclusions, productionDiskRestoreAllowed: false };
				if (!request.stagingPath || !request.artifactPath)
					throw new Error("Missing private artifact destination");
				const manifest: BackupManifest = {
					format: "narrafork-narrator-backup-v1",
					profile,
					sourceInstanceId: config.sourceInstanceId,
					actorUserId: actor.userId,
					narratorIds,
					projectIds: await store.sourceProjectIds(state),
					columns: {},
					objects: [],
					roots: [],
					exclusions,
					createdAt: new Date().toISOString(),
					productionDiskRestoreAllowed: false,
					manualActivationRequired: true,
				};
				for (const table of Object.keys(BACKUP_TABLES) as BackupTable[])
					manifest.columns[table] = await store.columns(table);
				const writer = new NarratorBackupArtifactWriter(request.stagingPath);
				try {
					writer.putState(state);
					if (profile === "conversation-tree-v1")
						await collectBackupObjects(
							state,
							manifest,
							{
								...config.objectSource,
								async fileBlobDigests(operationId) {
									// Frozen operation belongs to an authorized selected tool call. Its effects
									// remain archive dependencies only; no receipt is inserted into the target.
									return store.readFileBlobDigests(operationId);
								},
							},
							(object, bytes) => writer.putObject(object, bytes),
							controller.signal,
							check,
						);
					if (config.proofDirectory) {
						const key = await backupAttestationKey(config.proofDirectory, true, check);
						if (!key) throw new Error("Backup proof key unavailable");
						manifest.attestation = {
							algorithm: "hmac-sha256-v1",
							signature: signBackupPayload(key, manifest, state, check),
						};
					}
					const digest = await writer.publish(manifest, request.artifactPath, check, () =>
						sourceFence(state, profile === "conversation-tree-v1", manifest.projectIds),
					);
					return { digest, narratorIds };
				} catch (error) {
					await writer.discard();
					throw error;
				}
			});
		}
		if (!request.artifactPath) throw new Error("Missing owned artifact");
		const digest = await hashBackupFile(request.artifactPath, check);
		const { manifest, state } = readNarratorBackupArtifact(request.artifactPath, check);
		const persistentProof = config.proofDirectory
			? verifyBackupPayload(
					await backupAttestationKey(config.proofDirectory, false, check),
					manifest,
					state,
					check,
				)
			: false;
		// Unsigned legacy files retain ONLY an existing server-held exact-byte proof.
		// A signed file never falls back after key loss, rotation or proof tampering.
		const sourceProof =
			persistentProof || (!manifest.attestation && request.expectedDigest === digest);
		const verifiedSameInstance =
			sourceProof &&
			(!request.expectedDigest || request.expectedDigest === digest) &&
			manifest.sourceInstanceId === config.sourceInstanceId &&
			manifest.actorUserId === actor.userId;
		if (request.action === "upload")
			return { digest, narratorIds: manifest.narratorIds, verifiedSameInstance };
		if (request.action === "download") {
			if (request.expectedDigest && !verifiedSameInstance)
				throw new Error("Backup artifact authenticity mismatch");
			if (verifiedSameInstance)
				await sourceFence(state, manifest.profile === "conversation-tree-v1", manifest.projectIds);
			return { digest, narratorIds: manifest.narratorIds };
		}
		const blockers: string[] = [];
		if (!verifiedSameInstance)
			blockers.push(
				...mappingBlockers(state, request.mapping),
				...manifest.projectIds
					.filter((id) => !request.mapping?.projects?.[id])
					.map((id) => `mapping-required:projects:${id}`),
				"cross-instance-apply-unsupported",
				"artifact-not-attested-for-this-actor",
			);
		else {
			if (
				request.mapping &&
				Object.values(request.mapping).some((mapping) => Object.keys(mapping).length)
			)
				blockers.push("same-instance-mapping-not-supported");
			try {
				await validateRestoreTarget(connection, state, freshActor, check);
			} catch (error) {
				blockers.push(error instanceof Error ? error.message : "Target restore validation failed");
			}
		}
		if (request.action === "preview")
			return {
				artifactId: request.artifactId ?? "",
				profile: manifest.profile,
				narratorIds: manifest.narratorIds,
				verifiedSameInstance,
				sameInstanceStateRestoreAllowed: verifiedSameInstance && !blockers.length,
				crossInstanceApplySupported: false,
				productionDiskRestoreAllowed: false,
				blockers,
				exclusions: manifest.exclusions,
				manualActivationRequired: true,
			};
		if (!verifiedSameInstance || blockers.length) throw new Error("State restore is blocked");
		// Hash and ownership are checked again on actual apply, not a cached preview verdict.
		await store.restore(state, freshActor, check);
		return {
			narratorIds: manifest.narratorIds,
			status: "archived",
			manualActivationRequired: true,
			productionDiskRestoreAllowed: false,
		};
	} finally {
		clearInterval(polling);
		sqlite?.close();
		authorizationSqlite?.close();
		await postgres?.close();
		await authorizationPostgres?.close();
	}
}
const port = parentPort;
if (port) port.postMessage({ ready: "private-archive-worker-v1" });
if (port)
	port.once("message", async (request: BackupWorkerRequest) => {
		try {
			port.postMessage({ value: await runBackupWorker(request) });
		} catch {
			port.postMessage({ error: "Backup validation or operation failed" });
		}
	});
