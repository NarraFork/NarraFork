import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import {
	LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS,
	type LegacySnapshotMembershipInput,
	legacyManifestProvesModernOperations,
	legacySnapshotManifestContains,
} from "./legacy-retained-snapshot-membership-contract";

if (!parentPort) throw new Error("Snapshot membership requires worker context");
const input = workerData as LegacySnapshotMembershipInput;
let database: Database | undefined;
let allowed = false;
try {
	database = new Database(input.databasePath, { readonly: true, strict: true });
	database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
	// Every receipt lookup is a PK join, bounded before retrieval. Original tool/file
	// bodies are never read and the manifest never crosses onto the HTTP thread.
	if (input.operationSelection) {
		const row = database
			.query<{ manifest_json: string }, [string, string, string, number]>(`
			SELECT m.manifest_json FROM legacy_narrator_workspace_adoptions a
			JOIN legacy_retained_history_manifests m ON m.migration_project_id=a.migration_project_id
			WHERE a.narrator_id=? AND a.proof_mode='retained' AND a.history_digest=?
			AND m.manifest_digest=? AND length(CAST(m.manifest_json AS BLOB))<=? LIMIT 1
		`)
			.get(
				input.narratorId,
				input.manifestDigest,
				input.manifestDigest,
				LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.bytes,
			);
		if (row && legacyManifestProvesModernOperations(row.manifest_json, input)) {
			const query = database.query<{ ok: number }, [string, string, string]>(`
				SELECT 1 AS ok FROM file_change_operations o
				JOIN file_change_effects e ON e.operation_id=o.id
				WHERE o.id=? AND o.coverage='complete' AND o.settlement='settled'
				AND e.scope_id=? AND e.file_key=? AND e.phase='apply'
				AND e.settlement='settled' AND e.outcome IN ('changed','no_change') LIMIT 1
			`);
			allowed = input.operationSelection.operationIds.every(
				(id) =>
					!!query.get(
						id,
						input.operationSelection?.scopeId ?? "",
						input.operationSelection?.fileKey ?? "",
					),
			);
		}
	} else {
		const row = database
			.query<
				{ manifest_json: string },
				[string, string, string, string, string, string, string, string, number]
			>(`
			SELECT m.manifest_json FROM legacy_migration_artifact_claims c
			JOIN legacy_retained_history_manifests m ON m.migration_project_id=c.migration_project_id
			WHERE c.id=? AND c.state='claimed' AND c.kind='shadow' AND c.device_id='local'
			AND c.manifest_digest=? AND m.manifest_digest=c.manifest_digest
			AND c.narrator_id=? AND c.source_chapter_id=? AND c.workspace_path=?
			AND c.artifact_path=? AND c.shadow_key=?
			AND m.manifest_digest=? AND length(CAST(m.manifest_json AS BLOB))<=? LIMIT 1
		`)
			.get(
				input.artifactId,
				input.manifestDigest,
				input.narratorId,
				input.sourceChapterId,
				input.workspacePath,
				input.artifactPath,
				input.shadowKey,
				input.manifestDigest,
				LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.bytes,
			);
		if (row) allowed = legacySnapshotManifestContains(row.manifest_json, input);
	}
} finally {
	database?.close();
}
parentPort.postMessage(allowed);
parentPort.close();
