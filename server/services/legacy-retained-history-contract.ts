import type {
	LegacyLinkedWorktreeEvidence,
	LegacyLinkedWorktreeInput,
} from "./legacy-linked-worktree-identity";
import type {
	LegacyRootHistoryGuard,
	LegacyRootHistoryInput,
} from "./legacy-root-history-contract";

export type LegacyRetainedRow = Record<string, string | number | null>;
export interface LegacyRetainedNarratorOrigin {
	narratorId: string;
	sourceChapterId: string | null;
	deviceId: "local";
	workspacePath: string;
	/** Original DB value, before a root's implicit cwd is materialized. */
	persistedCwd?: string | null;
	workspaceRevision: number;
	/** Exact persisted JSON, not a reconstructed current context. */
	workspaceContext: string | null;
}
export interface LegacyRetainedWorkspaceBinding {
	sourceChapterId: string;
	workspacePath: string;
	deviceId: "local";
	kind: "root" | "linked";
	shadowKey: string;
	shadowDirectory: string;
	linked?: {
		input: Omit<LegacyLinkedWorktreeInput, "signal">;
		evidence: LegacyLinkedWorktreeEvidence;
	};
}
export interface LegacyRetainedWorkspace {
	workspacePath: string;
	kind: "root" | "linked";
	sourceChapterIds: string[];
	shadowKey: string;
	shadowDirectory: string;
	commonDirectoryPath: string;
	gitAdminDirectoryPath: string;
	gitfilePath: string | null;
	branch: string;
	headCommitSha: string;
	identityDigest: string;
	gitIdentity: { digest: string; entries: LegacyRetainedRow[] };
	linkedEvidence?: LegacyLinkedWorktreeEvidence;
}
export interface LegacyRetainedHistoryOrigin {
	table: string;
	id: string;
	deviceId: "local";
	workspacePath: string;
	sourceChapterIds: string[];
	evidence:
		| "root_only"
		| "execution_cwd"
		| "scope"
		| "file_path"
		| "snapshot_membership"
		| "chapter";
}
export interface LegacyRetainedHistoryInput extends LegacyRootHistoryInput {
	mainCheckoutRoot: string;
	/** Complete trusted source inventory. Linked members require a fresh worker-native probe. */
	workspaceBindings?: LegacyRetainedWorkspaceBinding[];
	narratorOrigins?: LegacyRetainedNarratorOrigin[];
	/** Trusted resolver's original physical directories; never a public DTO. */
	ignoredArchiveDirectories?: Array<{ sourceChapterId: string; artifactPath: string }>;
}
export interface LegacyRetainedAsset {
	sourceChapterId: string;
	kind: "shadow" | "ignored_archive";
	deviceId: "local";
	workspacePath: string;
	artifactPath: string;
	shadowKey?: string;
	identity: { dev: string; ino: string; digest: string; entries: LegacyRetainedRow[] };
}
export interface LegacyRetainedHistoryManifest {
	version: 1;
	projectId: string;
	mainCheckoutRoot: string;
	ownerUserId: string | null;
	databaseIdentity: { path: string; dev: string; ino: string; birthtimeNs: string } | null;
	/** Original scalar metadata, including graph/Git/shadow pointers. No layout bodies. */
	chapters: LegacyRetainedRow[];
	/** Exact old UI strings, archived once; never parsed or installed as narrator layout. */
	rawLayouts: Array<{
		sourceChapterId: string;
		dockLayoutJson: string | null;
		detachedPanelsJson: string | null;
	}>;
	narratorOrigins: LegacyRetainedNarratorOrigin[];
	workspaces: LegacyRetainedWorkspace[];
	historyOrigins: LegacyRetainedHistoryOrigin[];
	/** Small references only. Original message/tool/patch/file/blob bodies remain in place. */
	references: Record<string, LegacyRetainedRow[]>;
	assets: LegacyRetainedAsset[];
	gitIdentity: { digest: string; entries: LegacyRetainedRow[] } | null;
	/** Related narrators not being adopted; their history must NOT be deleted/released. */
	externalNarratorIds: string[];
	/** Retention completeness is NOT snapshot/replay coverage. These remain unknown. */
	legacyUnknownEvidence: Array<{ table: string; id: string; coverage: string | null }>;
}
export interface LegacyRetainedHistoryResult {
	status: "retained" | "unknown";
	digest: string;
	guards: LegacyRootHistoryGuard[];
	complete: boolean;
	reason?: string;
	manifest: LegacyRetainedHistoryManifest;
}
export const LEGACY_RETAINED_HISTORY_LIMITS = {
	inputs: 128,
	rows: 10_000,
	bytes: 2 * 1024 * 1024,
	metadataBytes: 64 * 1024,
	rawLayoutColumnBytes: 512 * 1024,
	filesystemEntries: 1024,
	filesystemBytes: 8 * 1024 * 1024,
	gitMetadataBytes: 2 * 1024 * 1024,
	milliseconds: 3_000,
	page: 64,
	gitOutputBytes: 128 * 1024,
} as const;
export function emptyLegacyRetainedManifest(
	input: LegacyRetainedHistoryInput,
): LegacyRetainedHistoryManifest {
	return {
		version: 1,
		projectId: input.projectId,
		mainCheckoutRoot: input.mainCheckoutRoot,
		ownerUserId: null,
		databaseIdentity: null,
		chapters: [],
		rawLayouts: [],
		narratorOrigins: [],
		workspaces: [],
		historyOrigins: [],
		references: {},
		assets: [],
		gitIdentity: null,
		externalNarratorIds: [],
		legacyUnknownEvidence: [],
	};
}
