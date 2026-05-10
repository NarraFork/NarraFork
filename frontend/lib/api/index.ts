import { authApi } from "./auth";
import { chaptersApi } from "./chapters";
import { BASE } from "./client";
import { gitApi } from "./git";
import { miscApi } from "./misc";
import { narratorsApi } from "./narrators";
import { projectsApi } from "./projects";
import { settingsApi } from "./settings";
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
};

export { ApiError, clearToken, getToken, setToken } from "./client";
export type {
	ApiEntity,
	BaseContentBlock,
	BlacklistCmd,
	BlacklistDir,
	BufferCreator,
	BufferMessageSummary,
	ChangelogEntry,
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
	MessagesAroundOptions,
	NarratorGoal,
	NarratorGoalStatus,
	PaginatedMessages,
	PaginatedNarrators,
	PublicCodexPlanTier,
	PublicCodexQuotaOverview,
	PublicCodexQuotaSegment,
	PublicCodexQuotaTrendPoint,
	RuntimeScanResult,
	SideCarRecord,
	StorageCategoryResult,
	StorageScanResult,
	ToolCallRecord,
	ToolUseContentBlock,
	TreeMessage,
	WhitelistCmd,
	WhitelistDir,
} from "./types";
