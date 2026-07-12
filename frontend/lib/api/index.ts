import { authApi } from "./auth";
import { chaptersApi } from "./chapters";
import { chatGroupsApi } from "./chat-groups";
import { BASE } from "./client";
import { devicesApi } from "./devices";
import { gitApi } from "./git";
import { knowledgeApi } from "./knowledge";
import { miscApi } from "./misc";
import { narratorsApi } from "./narrators";
import { projectsApi } from "./projects";
import { scheduledTasksApi } from "./scheduled-tasks";
import { settingsApi } from "./settings";
import { specApi } from "./spec";
import { terminalsApi } from "./terminals";

export function getAvatarUrl(userId: string, avatarImageId: string): string {
	return `${BASE}/uploads/avatars/${userId}/${avatarImageId}`;
}

export const api = {
	...authApi,
	...projectsApi,
	...chaptersApi,
	...narratorsApi,
	...terminalsApi,
	...settingsApi,
	...gitApi,
	...miscApi,
	...chatGroupsApi,
	...knowledgeApi,
	...specApi,
	...devicesApi,
	...scheduledTasksApi,
};

export {
	type AdminAuthConfig,
	type AdminOidcProvider,
	type AdminWebauthnConfig,
	isMfaChallenge,
	isPasskeySupported,
	type LoginResult,
	type LoginSession,
	type MfaChallenge,
	type MfaStatus,
	type PasskeySummary,
	type SsoIdentity,
	type SsoProvider,
	type TotpSetupResult,
} from "./auth";
export type { ChatGroup, ChatGroupMember, ChatGroupMessage, ChatGroupSummary } from "./chat-groups";
export {
	ApiError,
	clearToken,
	getToken,
	isAbortError,
	readFetchError,
	readFetchErrorMessage,
	setToken,
} from "./client";
export type {
	CreateEntryInput,
	CreateEntryLinkInput,
	UpdateEntryAclInput,
} from "./knowledge";
export type {
	FindingSeverity,
	KnowledgeCollection,
	KnowledgeDraft,
	KnowledgeDraftDiff,
	KnowledgeDraftStatus,
	KnowledgeEntry,
	KnowledgeEntryLink,
	KnowledgeFinding,
	KnowledgeFormat,
	KnowledgeGrant,
	KnowledgeGrantType,
	KnowledgeGraph,
	KnowledgeGraphEdge,
	KnowledgeGraphNode,
	KnowledgeLevel,
	KnowledgeLinkDirection,
	KnowledgeLinkEndpoint,
	KnowledgeLinkType,
	KnowledgePersonalEntry,
	KnowledgeReviewResult,
	KnowledgeRevision,
	KnowledgeSearchResult,
	KnowledgeSubmission,
	KnowledgeSubmissionDetail,
	KnowledgeSubmissionStatus,
	KnowledgeTag,
	KnowledgeTagType,
	KnowledgeUserAcl,
	KnowledgeVerdict,
} from "./knowledge-types";
export type {
	ScheduledTask,
	ScheduledTaskInput,
	ScheduledTaskLastStatus,
	ScheduledTaskLocale,
	ScheduledTaskNarratorMode,
	ScheduledTaskRun,
	ScheduledTaskRunContext,
	ScheduledTaskRunsPage,
} from "./scheduled-tasks";
export {
	scanStorageStream,
} from "./streams";
export type {
	ApiEntity,
	BaseContentBlock,
	BlacklistCmd,
	BlacklistDir,
	BufferCreator,
	BufferMessageSummary,
	ChangelogEntry,
	ChunkManifest,
	ChunkManifestEntry,
	ChunkManifestTuple,
	ChunkRangeResult,
	CodexCredentialEntry,
	CodexUsageData,
	CodexUsageWindow,
	ContentBlock,
	CustomSubagentData,
	DatabaseCleanupApiRequestSample,
	DatabaseCleanupBlockedItem,
	DatabaseCleanupBlockedReasonCode,
	DatabaseCleanupCandidateSummary,
	DatabaseCleanupExecutionResult,
	DatabaseCleanupNarratorSample,
	DatabaseCleanupPreviewCounts,
	DatabaseCleanupPreviewResult,
	DatabaseCleanupTarget,
	DatabaseCleanupWarningCode,
	DatabaseStorageBreakdown,
	DatabaseStorageCategoryKey,
	DatabaseStorageCategorySummary,
	DatabaseStorageTableSummary,
	DatabaseTableKind,
	DatabaseVacuumResult,
	HookApiRecord,
	LearningAction,
	LearningCategory,
	LearningDoc,
	LearningDocSummary,
	LearningIndexResponse,
	LearningSearchResponse,
	LearningSection,
	MessageLocationResult,
	PaginatedNarrators,
	PublicCodexPlanTier,
	PublicCodexQuotaOverview,
	PublicCodexQuotaSegment,
	PublicCodexQuotaTrendPoint,
	RuntimeScanResult,
	SearchFallback,
	SearchMetadata,
	SearchResponse,
	SideCarRecord,
	StorageCategoryResult,
	StorageScanResult,
	SubagentChildrenResult,
	ToolCallRecord,
	ToolUseContentBlock,
	TreeMessage,
	WhitelistCmd,
	WhitelistDir,
} from "./types";
