import { authApi } from "./auth";
import { chaptersApi } from "./chapters";
import { chatApi } from "./chat";
import { apiBase } from "./client";
import { devicesApi } from "./devices";
import { gitApi } from "./git";
import { grammarsApi } from "./grammars";
import { integrationsApi } from "./integrations";
import { knowledgeApi } from "./knowledge";
import { miscApi } from "./misc";
import { modelCardsApi } from "./model-cards";
import { narratorsApi } from "./narrators";
import { notificationsApi } from "./notifications";
import { oauthAppsApi } from "./oauth-apps";
import { oauthGrantsApi } from "./oauth-grants";
import { pluginsApi } from "./plugins";
import { projectsApi } from "./projects";
import { scheduledTasksApi } from "./scheduled-tasks";
import { settingsApi } from "./settings";
import { specApi } from "./spec";
import { systemLifecycleApi } from "./system-lifecycle";
import { terminalsApi } from "./terminals";
import { tokendanceApi } from "./tokendance";
import { traitLayersApi } from "./trait-layers";
import { workspaceContextApi } from "./workspace-context";

export function getAvatarUrl(userId: string, avatarImageId: string): string {
	return `${apiBase()}/uploads/avatars/${userId}/${avatarImageId}`;
}

export const api = {
	...authApi,
	...projectsApi,
	...chaptersApi,
	...chatApi,
	...narratorsApi,
	...notificationsApi,
	...terminalsApi,
	...settingsApi,
	...gitApi,
	...workspaceContextApi,
	...grammarsApi,
	...integrationsApi,
	...miscApi,
	...modelCardsApi,
	...knowledgeApi,
	...specApi,
	...systemLifecycleApi,
	...devicesApi,
	...traitLayersApi,
	...tokendanceApi,
	...oauthAppsApi,
	...oauthGrantsApi,
	...scheduledTasksApi,
	...pluginsApi,
};

export {
	type AdminAuthConfig,
	type AdminOidcProvider,
	type AdminWebauthnConfig,
	type CreatedRegistrationCode,
	isMfaChallenge,
	isPasskeySupported,
	type LoginResult,
	type LoginSession,
	type MfaChallenge,
	type MfaStatus,
	type PasskeySummary,
	type RegistrationCode,
	type SsoIdentity,
	type SsoProvider,
	type TotpSetupResult,
} from "./auth";
export {
	ApiError,
	absorbRenewedToken,
	authorizedFetch,
	clearToken,
	clearTokenOnSessionFailure,
	getToken,
	isAbortError,
	readFetchError,
	readFetchErrorMessage,
	setToken,
} from "./client";
export type { GrammarListResponse, GrammarStatus, GrammarTier } from "./grammars";
export type {
	IntegrationAttentionItem,
	IntegrationAttentionSeverity,
	IntegrationDeviceSummary,
	IntegrationExternalResourceSummary,
	IntegrationOAuthClientSummary,
	IntegrationPluginSummary,
	IntegrationSummary,
} from "./integrations";
export type {
	BulkKnowledgeGrantInput,
	CreateEntryInput,
	CreateEntryLinkInput,
	UpdateCollectionAclInput,
	UpdateEntryAclInput,
} from "./knowledge";
export type {
	FindingSeverity,
	KnowledgeBulkGrantResponse,
	KnowledgeBulkGrantResult,
	KnowledgeCollection,
	KnowledgeCollectionAcl,
	KnowledgeDeletePersonalEntryResult,
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
	KnowledgeOpenSubmission,
	KnowledgePersonalEntry,
	KnowledgePersonalEntrySummary,
	KnowledgeRebaseStrategy,
	KnowledgeReviewInboxCount,
	KnowledgeReviewResult,
	KnowledgeReviewScope,
	KnowledgeRevision,
	KnowledgeSearchResult,
	KnowledgeSubmission,
	KnowledgeSubmissionDetail,
	KnowledgeSubmissionStatus,
	KnowledgeTag,
	KnowledgeTagType,
	KnowledgeTransferOwnerResult,
	KnowledgeUserAcl,
	KnowledgeVerdict,
	KnowledgeWithdrawResult,
} from "./knowledge-types";
export type { WorkspaceDetail } from "./misc";
export { isWorkspaceLayoutConflict, WORKSPACE_LAYOUT_CONFLICT_CODE } from "./misc";
export type {
	NotificationKind,
	NotificationLink,
	NotificationListItem,
	NotificationListPage,
	NotificationPersistentStatus,
	NotificationSourceState,
	NotificationUnreadCounts,
} from "./notifications";
export { notificationsApi } from "./notifications";
export type {
	CreateOAuthAppInput,
	OAuthApp,
	OAuthAppImportResult,
	OAuthAppManifest,
	UpdateOAuthAppInput,
} from "./oauth-apps";
export type {
	ListOAuthGrantsParams,
	OAuthGrant,
	OAuthGrantClient,
	OAuthGrantPage,
} from "./oauth-grants";
export { OAUTH_GRANTS_MAX_LIMIT, oauthGrantsApi } from "./oauth-grants";
export type {
	PluginApiErrorCode,
	PluginCompatibilityState,
	PluginContributionSummary,
	PluginDesiredState,
	PluginDetail,
	PluginDiagnostic,
	PluginGrantSummary,
	PluginListResponse,
	PluginPackageRef,
	PluginRuntimeDiagnostics,
	PluginRuntimeState,
	PluginStatusEnvelope,
	PluginSummary,
	PluginUiContributionItem,
	PluginUiHealth,
} from "./plugins";
export { normalizePluginList } from "./plugins";
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
	CodexUsageWindowType,
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
	DatabaseStorageReadFailures,
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
	LicenseEntryKind,
	LicenseManifestResponse,
	LicenseProblem,
	LicenseSummary,
	LicenseTextSource,
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
	StorageCategoryResult,
	StorageScanJobState,
	StorageScanJobStatus,
	StorageScanResult,
	SubagentActivityCatchUp,
	SubagentActivitySummary,
	SubagentToolCallHeader,
	SubagentToolCallTiming,
	SubagentToolInputSummary,
	ToolCallRecord,
	ToolUseContentBlock,
	TreeMessage,
	WhitelistCmd,
	WhitelistDir,
	WorkspaceBarrier,
	WorkspaceBarrierObservation,
	WorkspaceBarrierObservationResult,
	WorkspaceBarrierRecoveryResult,
	WorkspaceBarrierVerdict,
} from "./types";
