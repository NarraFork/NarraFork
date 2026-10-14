export const LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS = {
	bytes: 2 * 1024 * 1024,
	rows: 10_000,
	milliseconds: 1_000,
	workers: 2,
} as const;

export interface LegacySnapshotMembershipInput {
	databasePath: string;
	artifactId: string;
	manifestDigest: string;
	narratorId: string;
	sourceChapterId: string;
	workspacePath: string;
	artifactPath: string;
	shadowKey: string;
	sha: string;
	/** Trusted selected sources, never supplied by an HTTP client. */
	operationSelection?: { scopeId: string; fileKey: string; operationIds: readonly string[] };
}

type Row = Record<string, unknown>;
function object(value: unknown): value is Row {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Worker-only linear membership check. Neither availability nor membership is coverage. */
export function legacySnapshotManifestContains(raw: string, input: LegacySnapshotMembershipInput) {
	try {
		if (Buffer.byteLength(raw) > LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.bytes) return false;
		const value: unknown = JSON.parse(raw);
		if (!object(value) || value.version !== 1 || !object(value.references)) return false;
		let count = 0;
		const rows = (value: unknown): Row[] => {
			if (!Array.isArray(value)) throw new Error("Invalid retained references");
			count += value.length;
			if (count > LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.rows || !value.every(object))
				throw new Error("Retained references exceed budget");
			return value;
		};
		const chapters = rows(value.chapters);
		const assets = rows(value.assets);
		const entries = Object.entries(value.references);
		if (entries.length > 64) return false;
		const references = new Map(entries.map(([key, value]) => [key, rows(value)]));
		if (
			!assets.some(
				(asset) =>
					asset.kind === "shadow" &&
					asset.sourceChapterId === input.sourceChapterId &&
					asset.deviceId === "local" &&
					asset.workspacePath === input.workspacePath &&
					asset.artifactPath === input.artifactPath &&
					asset.shadowKey === input.shadowKey,
			)
		)
			return false;
		if (
			chapters.some(
				(chapter) =>
					chapter.id === input.sourceChapterId &&
					chapter.snapshot_shadow_key === input.shadowKey &&
					chapter.snapshot_commit_sha === input.sha,
			)
		)
			return true;
		if (
			(references.get("worktree_tree_snapshots") ?? []).some(
				(snapshot) =>
					snapshot.device_id === "local" &&
					snapshot.worktree_path === input.workspacePath &&
					snapshot.snapshot_commit_sha === input.sha,
			)
		)
			return true;
		// Shared/lazy history uses the original junction, not the message's owner narrator.
		const messageIds = new Set(
			(references.get("narrator_message_refs") ?? [])
				.filter((ref) => ref.narrator_id === input.narratorId && typeof ref.message_id === "string")
				.map((ref) => ref.message_id),
		);
		return (references.get("narrator_messages") ?? []).some(
			(message) => messageIds.has(message.id) && message.snapshot_commit_sha === input.sha,
		);
	} catch {
		return false;
	}
}

/** True proves that every selected source is absent from the complete original
 * operation set. False includes retained, malformed or over-budget provenance;
 * callers must keep the old physical bridge rather than infer modern authority. */
export function legacyManifestProvesModernOperations(
	raw: string,
	input: LegacySnapshotMembershipInput,
) {
	try {
		const selection = input.operationSelection;
		if (
			!selection ||
			selection.operationIds.length === 0 ||
			selection.operationIds.length > 256 ||
			!selection.operationIds.every(
				(id) => typeof id === "string" && id.length > 0 && id.length <= 128,
			) ||
			Buffer.byteLength(JSON.stringify(selection)) > 8192 ||
			Buffer.byteLength(raw) > LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.bytes
		)
			return false;
		const manifest: unknown = JSON.parse(raw);
		if (
			!object(manifest) ||
			manifest.version !== 1 ||
			!object(manifest.references) ||
			!Array.isArray(manifest.chapters) ||
			!manifest.chapters.some((row) => object(row) && row.id === input.sourceChapterId)
		)
			return false;
		let rows = manifest.chapters.length;
		const references = Object.entries(manifest.references);
		if (references.length > 64) return false;
		for (const [, value] of references) {
			if (!Array.isArray(value) || !value.every(object)) return false;
			rows += value.length;
			if (rows > LEGACY_SNAPSHOT_MEMBERSHIP_LIMITS.rows) return false;
		}
		const operations = manifest.references.file_change_operations;
		const scopes = manifest.references.file_change_scopes;
		if (
			!Array.isArray(operations) ||
			!Array.isArray(scopes) ||
			!scopes.some(
				(row) => row.id === selection.scopeId && row.canonical_root === input.workspacePath,
			)
		)
			return false;
		const originalIds = new Set(operations.map((row) => row.id));
		return selection.operationIds.every((id) => !originalIds.has(id));
	} catch {
		return false;
	}
}
