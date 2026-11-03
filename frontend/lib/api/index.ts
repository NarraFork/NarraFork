import { authApi } from "./auth";
import { chatApi } from "./chat";
import { apiBase } from "./client";
import { commandCodeApi } from "./commandcode";
import { containersApi } from "./containers";
import { devicesApi } from "./devices";
import { gitApi } from "./git";
import { grammarsApi } from "./grammars";
import { integrationsApi } from "./integrations";
import { knowledgeApi } from "./knowledge";
import { miscApi } from "./misc";
import { narratorsApi } from "./narrators";
import { notificationsApi } from "./notifications";
import { oauthAppsApi } from "./oauth-apps";
import { oauthGrantsApi } from "./oauth-grants";
import { outlineApi } from "./outline";
import { pluginsApi } from "./plugins";
import { projectsApi } from "./projects";
import { providerImportApi } from "./provider-import";
import { scheduledTasksApi } from "./scheduled-tasks";
import { sessionInterchangeApi } from "./session-interchange";
import { settingsApi } from "./settings";
import { specApi } from "./spec";
import { storageTransferApi } from "./storage-transfer";
import { systemLifecycleApi } from "./system-lifecycle";
import { terminalsApi } from "./terminals";
import { tokendanceApi } from "./tokendance";
import { traitLayersApi } from "./trait-layers";
import { workspaceContextApi } from "./workspace-context";

export function getAvatarUrl(userId: string, avatarImageId: string): string {
	return `${apiBase()}/uploads/avatars/${userId}/${avatarImageId}`;
}

/**
 * URL of an image in a narrator's upload store, fetched with the session token.
 *
 * `contextNarratorId` is the narrator the image is shown in. When it is not the owner
 * (a fork showing its source's image), the server is told which history to check, so a
 * reader of the fork needs no access to the source session. Same contract as the media
 * route's `referencingNarratorId`.
 */
export function getUploadedImageUrl(
	uploadNarratorId: string,
	imageId: string,
	contextNarratorId?: string | null,
): string {
	const url = `${apiBase()}/uploads/${encodeURIComponent(uploadNarratorId)}/${encodeURIComponent(imageId)}`;
	return contextNarratorId && contextNarratorId !== uploadNarratorId
		? `${url}?referencingNarratorId=${encodeURIComponent(contextNarratorId)}`
		: url;
}

export const api = {
	...authApi,
	...projectsApi,
	...containersApi,
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
	...knowledgeApi,
	...specApi,
	...systemLifecycleApi,
	...devicesApi,
	...traitLayersApi,
	...tokendanceApi,
	...oauthAppsApi,
	...oauthGrantsApi,
	...outlineApi,
	...scheduledTasksApi,
	...pluginsApi,
	...sessionInterchangeApi,
	...commandCodeApi,
	...storageTransferApi,
	...providerImportApi,
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
	authorizedFetch,
	clearToken,
	clearTokenOnSessionFailure,
	endSession,
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
	KnowledgeCollectionListItem,
	KnowledgeCollectionViewerCaps,
	KnowledgeDeletePersonalEntryResult,
	KnowledgeDraft,
	KnowledgeDraftDiff,
	KnowledgeDraftStatus,
	KnowledgeEntry,
	KnowledgeEntryDetail,
	KnowledgeEntryLink,
	KnowledgeEntryListItem,
	KnowledgeEntryPage,
	KnowledgeEntrySort,
	KnowledgeEntryStatus,
	KnowledgeEntryViewerCaps,
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
	KnowledgePersonalEntryDetail,
	KnowledgePersonalEntrySummary,
	KnowledgePersonalEntryViewerCaps,
	KnowledgePersonalSubmitBlocker,
	KnowledgeRebaseStrategy,
	KnowledgeReviewInboxCount,
	KnowledgeReviewResult,
	KnowledgeReviewScope,
	KnowledgeRevision,
	KnowledgeSearchResult,
	KnowledgeSubmission,
	KnowledgeSubmissionDetail,
	KnowledgeSubmissionHistoryItem,
	KnowledgeSubmissionListItem,
	KnowledgeSubmissionOutcome,
	KnowledgeSubmissionStatus,
	KnowledgeSubmissionViewerCaps,
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
	BlockBackfillStatus,
	BlockJobState,
	BlockProjectionBlock,
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
	EntitySearchResult,
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
	PromptLibraryEntryData,
	PromptLibraryInputData,
	PublicCodexPlanTier,
	PublicCodexQuotaOverview,
	PublicCodexQuotaSegment,
	PublicCodexQuotaTrendPoint,
	RuntimeScanResult,
	SearchRequest,
	SearchSectionName,
	SearchSectionPage,
	SearchSectionsResponse,
	SessionHitsResponse,
	SessionSearchHit,
	SessionSearchResult,
	StorageCategoryJobState,
	StorageCategoryKey,
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
} from "./types";
