import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Server platform and feature availability.
 *
 * This file used to host a `RuntimeCapabilities` negotiation layer: a 429-line interface
 * describing what a backend supports, 43 `get*Capability` getters that read it, and 42
 * matching hooks. It was built so a second, non-TypeScript backend could advertise a
 * narrower feature set and the UI would fail closed against it.
 *
 * That backend never existed. `/api/health` has never sent a `capabilities` block, so
 * `capabilities` was always `undefined`, every getter always took its `!capabilities`
 * branch, and all 43 results were constants. The negotiation had exactly one possible
 * outcome, which also made it unable to *start* negotiating: handing health a partial
 * capabilities object would have flipped every other getter's absent-payload fallback
 * off at once and turned 30+ working features unsupported.
 *
 * The inert structure was not free. `getChapterSplitCapability` deliberately failed closed
 * while `POST /chapters/:id/split` was missing, which was correct at the time; once the
 * route landed the fail-closed default kept the feature permanently unreachable, because
 * no payload ever arrived to say otherwise. Split was the bug that got noticed. The
 * compressed-summary warning in `ChapterSplitModal` was another: `compressedAISummary`
 * had no absent-payload fallback, so it read `false` and the modal told users this
 * backend cannot generate an AI summary for compressed splits, while `narrator-service`
 * generates one via `narratorContext.generateContextSummary`.
 *
 * So the getters are gone and what they returned is stated directly. Hook names and
 * return shapes are unchanged, so call sites still read `.supported` / `.reason` and can
 * keep rendering their unsupported states — those branches are simply unreachable now.
 *
 * Adding a real capability means adding a real signal: have `/api/health` report the
 * specific thing, read it here, and gate on it. Do not reintroduce a blanket
 * "absent payload means legacy backend" fallback; that is what made the previous
 * structure both inert and impossible to switch on.
 */

type Platform = "windows" | "macos" | "linux";

export interface RuntimeEnvironmentInfo {
	android: boolean;
	proot: boolean;
	termux: boolean;
	containerSupport: boolean;
	containerUnsupportedReason?: string;
}

export type GatewayPlatform =
	| "telegram"
	| "discord"
	| "slack"
	| "feishu"
	| "webhook"
	| "weixin"
	| "qqbot";

export type ProviderCapabilityKey =
	| "openai"
	| "anthropic"
	| "nug"
	| "codex"
	| "gemini";

type ChapterContainerRoute =
	| "setup"
	| "podmanStatus"
	| "podmanInstall"
	| "composeInfo"
	| "list"
	| "start"
	| "stop"
	| "pause"
	| "unpause"
	| "logs"
	| "remove";
type ChapterContainerRoutes = Record<ChapterContainerRoute, boolean>;

interface FeatureCapability {
	supported?: boolean;
	fallback?: boolean;
	code?: string;
	reason?: string;
	error?: string;
	message?: string;
	mode?: string;
}

/**
 * Shapes for the capabilities that have no signal at all and so resolve to `undefined`.
 * They are kept as types (rather than dropping to `never`) because consumers optional-chain
 * into them and render the fields when present.
 */
export interface ProviderManagerParityCapability {
	tsCodexManagerEquivalent?: boolean;
	usageQueueParity?: string;
	usageQueueClearSupported?: boolean;
	snapshotPaginationParity?: string;
	reason?: string;
}

export interface ProviderRuntimeCapability {
	auth?: FeatureCapability;
	models?: {
		supported?: boolean;
		refreshSupported?: boolean;
		reason?: string;
	};
	quota?: FeatureCapability;
	agentMode?: FeatureCapability;
	routes?: FeatureCapability & { [key: string]: boolean | string | undefined };
	agentRuntime?: FeatureCapability & { [key: string]: boolean | string | undefined };
	pluginBridge?: FeatureCapability & { requiresBun?: boolean };
	mcp?: {
		listToolsRoute?: boolean;
		searchRoute?: boolean;
		agentInjection?: boolean;
	};
	managerParity?: ProviderManagerParityCapability;
}

export interface DatabaseCapability {
	engine?: string;
	mainSchemaOwner?: string;
	ftsRepair?: boolean;
	mode?: string;
	searchMode?: string;
	reason?: string;
}

export interface ContainerBrowserToolAutoEnableCapability {
	defaultEnabled?: boolean;
	cutover?: string;
	rollback?: string;
	reason?: string;
}

/**
 * Every capability below is supported unless a live signal says otherwise, so most of
 * these resolve to a frozen constant. `SUPPORTED` is the shared shape for the common
 * `{ supported, reason? }` case; `reason` stays optional in the types because consumers
 * render it when a capability is unsupported.
 */
const SUPPORTED: { supported: boolean; reason?: string } = Object.freeze({ supported: true });

function useHealthQuery() {
	return useQuery({
		queryKey: ["health"],
		queryFn: () => api.health(),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * Returns the server platform ("windows" | "macos" | "linux").
 * Cached for the lifetime of the app — the platform never changes.
 */
export function usePlatform(): Platform {
	const { data } = useHealthQuery();
	return data?.platform ?? "linux";
}

export function useRuntimeEnvironment(): RuntimeEnvironmentInfo | undefined {
	const { data } = useHealthQuery();
	return data?.runtimeEnvironment;
}

// === database ===

/**
 * Descriptive database metadata (engine, schema owner, FTS repair support). Health does
 * not report it, so this is `undefined`; `StorageSection` renders its compatibility panel
 * only when present.
 */
export function useDatabaseCapability(): DatabaseCapability | undefined {
	return undefined;
}

// === filesystem ===

type FileSystemFeatureCapability = {
	supported: boolean;
	reason?: string;
	maxTextBytes?: number;
	maxBinaryBytes?: number;
};

const FILE_SYSTEM_CAPABILITY: {
	browse: FileSystemFeatureCapability;
	shortcuts: FileSystemFeatureCapability;
	mkdir: FileSystemFeatureCapability;
	preview: FileSystemFeatureCapability;
	reveal: FileSystemFeatureCapability;
} = Object.freeze({
	browse: SUPPORTED,
	shortcuts: SUPPORTED,
	mkdir: SUPPORTED,
	preview: SUPPORTED,
	reveal: SUPPORTED,
});

export function useFileSystemCapability(): typeof FILE_SYSTEM_CAPABILITY {
	return FILE_SYSTEM_CAPABILITY;
}

export function useFsRevealCapability(): FileSystemFeatureCapability {
	return FILE_SYSTEM_CAPABILITY.reveal;
}

// === terminal ===

const TERMINAL_CAPABILITY: {
	supported: boolean;
	reason?: string;
	dtachSupported?: boolean;
	dtachAvailable?: boolean;
	detachedReattach?: boolean;
	orphanRecovery?: boolean;
	scrollbackReplay?: boolean;
	scrollbackReplayMode?: string;
	bufferStateReplay?: boolean;
	bufferStateMode?: string;
	xtermSerializedReplay?: boolean;
	xtermSerializedReplayReason?: string;
	multiClientResizeMode?: string;
	processTree?: { supported?: boolean; platform?: string };
} = Object.freeze({ supported: true });

export function useTerminalCapability(): typeof TERMINAL_CAPABILITY {
	return TERMINAL_CAPABILITY;
}

// === update ===

const UPDATE_CAPABILITY: {
	selfUpdateAvailable: boolean;
	manualOnly: boolean;
	canAutoRestart: boolean;
	download: {
		supported: boolean;
		reason?: string;
		sse: boolean;
		sha512: boolean;
		maxBytes?: number;
		trustMode?: string;
	};
	apply: {
		supported: boolean;
		reason?: string;
		handoff?: string;
	};
} = Object.freeze({
	selfUpdateAvailable: true,
	manualOnly: false,
	canAutoRestart: true,
	download: Object.freeze({ supported: true, sse: true, sha512: true }),
	apply: SUPPORTED,
});

export function useUpdateCapability(): typeof UPDATE_CAPABILITY {
	return UPDATE_CAPABILITY;
}

// === gateway ===

const GATEWAY_CAPABILITY: {
	weixinQrSupported: boolean;
	weixinQrReason?: string;
	webhookSupported: boolean;
	webhookReason?: string;
	persistentRuntimes: boolean;
	supportedPlatforms?: GatewayPlatform[];
	unsupportedPlatforms?: Partial<Record<GatewayPlatform, string>>;
	isPlatformSupported: (platform: GatewayPlatform) => boolean;
	platformUnsupportedReason: (platform: GatewayPlatform) => string | undefined;
	reason?: string;
} = Object.freeze({
	weixinQrSupported: true,
	webhookSupported: true,
	persistentRuntimes: true,
	isPlatformSupported: () => true,
	platformUnsupportedReason: () => undefined,
});

export function useGatewayCapability(): typeof GATEWAY_CAPABILITY {
	return GATEWAY_CAPABILITY;
}

// === chapters: containers ===

type ChapterContainersCapability = {
	supported: boolean;
	reason?: string;
	routes: ChapterContainerRoutes;
	runtime: {
		podmanCompose?: boolean;
		podmanComposeFallbackCommand?: boolean;
		boundedOutput?: boolean;
		syncStartRequest?: boolean;
		backgroundStart?: boolean;
		backgroundStartReason?: string;
		streamingLogs?: boolean;
		perChapterLock?: boolean;
	};
	ports: {
		legacyHostPortAllocation?: boolean;
		portRelease?: boolean;
	};
	proxy: {
		metadataSupported?: boolean;
		requiresPastaPasst?: boolean;
		overridePortsReset?: boolean;
		reverseProxyServer?: boolean;
		http?: boolean;
		websocket?: boolean;
		dynamicSettingsHook?: boolean;
	};
};

function chapterContainerRoutes(supported: boolean): ChapterContainerRoutes {
	return {
		setup: supported,
		podmanStatus: supported,
		podmanInstall: supported,
		composeInfo: supported,
		list: supported,
		start: supported,
		stop: supported,
		pause: supported,
		unpause: supported,
		logs: supported,
		remove: supported,
	};
}

const CHAPTER_CONTAINERS_SUPPORTED: ChapterContainersCapability = Object.freeze({
	supported: true,
	routes: Object.freeze(chapterContainerRoutes(true)),
	runtime: Object.freeze({}),
	ports: Object.freeze({}),
	proxy: Object.freeze({}),
});

/**
 * The one capability with a real runtime signal behind it: Android/proot/Termux hosts
 * report `containerSupport: false` in `runtimeEnvironment`, and there is no local Podman
 * to talk to there.
 */
export function useChapterContainersCapability(): ChapterContainersCapability {
	const { data } = useHealthQuery();
	const environment = data?.runtimeEnvironment;
	if (environment && !environment.containerSupport) {
		return {
			supported: false,
			reason:
				environment.containerUnsupportedReason ??
				"Local container management is unavailable in this runtime.",
			routes: chapterContainerRoutes(false),
			runtime: {},
			ports: {},
			proxy: {},
		};
	}
	return CHAPTER_CONTAINERS_SUPPORTED;
}

// === chapters: batch merge ===

const CHAPTER_BATCH_MERGE_CAPABILITY: {
	supported: boolean;
	reason?: string;
	mode?: string;
	startRouteSupported: boolean;
	sessionRouteSupported: boolean;
	mergeSessionIdResponse: boolean;
	targetChapterIdResponse: boolean;
	createdTargetResponse: boolean;
	statusResponse: boolean;
	decisionWs: boolean;
	staleSessionCleanup: boolean;
	createdTargetRollback: boolean;
	frontendCompletionMode?: string;
	events: string[];
} = Object.freeze({
	supported: true,
	startRouteSupported: true,
	sessionRouteSupported: true,
	mergeSessionIdResponse: true,
	targetChapterIdResponse: true,
	createdTargetResponse: true,
	statusResponse: true,
	decisionWs: true,
	staleSessionCleanup: true,
	createdTargetRollback: true,
	events: [] as string[],
});

export function useChapterBatchMergeCapability(): typeof CHAPTER_BATCH_MERGE_CAPABILITY {
	return CHAPTER_BATCH_MERGE_CAPABILITY;
}

// === chapters: split ===

/**
 * `compressedAISummarySupported` is true because compressed splits do get an AI summary:
 * `chapter-split` passes `inheritMode` through to `chapterFork.fork`, and
 * `narrator-service` calls `narratorContext.generateContextSummary` for the compressed
 * mode. The old getter had no fallback for this field so it read `false`, which made
 * `ChapterSplitModal` warn about a fallback that was not in use.
 */
const CHAPTER_SPLIT_CAPABILITY: {
	supported: boolean;
	reason?: string;
	mode?: string;
	compressedAISummarySupported: boolean;
	compressedAISummaryFallback: boolean;
	compressedAISummaryMode?: string;
	compressedAISummaryReason?: string;
} = Object.freeze({
	supported: true,
	compressedAISummarySupported: true,
	compressedAISummaryFallback: false,
});

export function useChapterSplitCapability(): typeof CHAPTER_SPLIT_CAPABILITY {
	return CHAPTER_SPLIT_CAPABILITY;
}

// === narrator ===

const NARRATOR_BROWSER_SESSIONS_CAPABILITY: {
	supported: boolean;
	reason?: string;
	defaultEnabled?: boolean;
	runtime?: string;
	storage?: string;
	cutover?: string;
	rollback?: string;
	narratorBound?: boolean;
	lifecycleEvents?: boolean;
	artifactPersistence?: boolean;
	resourceLimits?: boolean;
	requiresChrome?: boolean;
} = Object.freeze({ supported: true });

export function useNarratorBrowserSessionsCapability(): typeof NARRATOR_BROWSER_SESSIONS_CAPABILITY {
	return NARRATOR_BROWSER_SESSIONS_CAPABILITY;
}

/**
 * Overrides for auto-enabling the browser tool in containers. Health does not report any,
 * so this is `undefined` and `NarratorDetailsPanel` keeps its default behaviour.
 */
export function useNarratorContainerBrowserToolAutoEnableCapability():
	| ContainerBrowserToolAutoEnableCapability
	| undefined {
	return undefined;
}

const NARRATOR_PLAN_MODE_CAPABILITY: {
	supported: boolean;
	reason?: string;
	api?: boolean;
	toolReflection?: boolean;
	previousModeRestore?: boolean;
} = Object.freeze({ supported: true });

export function useNarratorPlanModeCapability(): typeof NARRATOR_PLAN_MODE_CAPABILITY {
	return NARRATOR_PLAN_MODE_CAPABILITY;
}

const NARRATOR_COMPACT_CAPABILITY: {
	supported: boolean;
	reason?: string;
	mode?: string;
	fallbackSummary?: boolean;
	fallbackReason?: string;
} = Object.freeze({ supported: true });

export function useNarratorCompactCapability(): typeof NARRATOR_COMPACT_CAPABILITY {
	return NARRATOR_COMPACT_CAPABILITY;
}

const NARRATOR_DELETE_CAPABILITY: {
	supported: boolean;
	reason?: string;
	code?: string;
	feature?: string;
} = Object.freeze({ supported: true });

export function useNarratorDeleteCapability(): typeof NARRATOR_DELETE_CAPABILITY {
	return NARRATOR_DELETE_CAPABILITY;
}

const NARRATOR_RETRY_RECOVERY_CAPABILITY: {
	supported: boolean;
	reason?: string;
	retry?: boolean;
	continue?: boolean;
	interrupt?: boolean;
	manualOverride?: boolean;
	rollback?: boolean;
	editAndRegenerate?: boolean;
} = Object.freeze({
	supported: true,
	retry: true,
	continue: true,
	interrupt: true,
	manualOverride: true,
	rollback: true,
	editAndRegenerate: true,
});

export function useNarratorRetryRecoveryCapability(): typeof NARRATOR_RETRY_RECOVERY_CAPABILITY {
	return NARRATOR_RETRY_RECOVERY_CAPABILITY;
}

const NARRATOR_ROLLBACK_EDIT_REGENERATE_CAPABILITY: {
	supported: boolean;
	reason?: string;
	rollback?: boolean;
	editAndRegenerate?: boolean;
	copyOnWrite?: boolean;
	messageRefTruncation?: boolean;
	fileStateRebuild?: boolean;
	toolCallInvalidation?: boolean;
	agentRerun?: boolean;
	optionalFileRevert?: boolean;
	optionalAgentRerun?: boolean;
	wsEvents?: boolean;
} = Object.freeze({ supported: true });

export function useNarratorRollbackEditRegenerateCapability(): typeof NARRATOR_ROLLBACK_EDIT_REGENERATE_CAPABILITY {
	return NARRATOR_ROLLBACK_EDIT_REGENERATE_CAPABILITY;
}

const NARRATOR_PERMISSIONS_CAPABILITY: {
	supported: boolean;
	reason?: string;
	modes: string[];
	approveDeny: boolean;
	updatedInput: boolean;
	pauseResume?: string;
	reflections: string[];
} = Object.freeze({
	supported: true,
	modes: ["default", "acceptEdits", "bypassPermissions", "readOnly", "dontAsk"] as string[],
	approveDeny: true,
	updatedInput: true,
	reflections: ["danger", "plan", "goal"] as string[],
});

export function useNarratorPermissionsCapability(): typeof NARRATOR_PERMISSIONS_CAPABILITY {
	return NARRATOR_PERMISSIONS_CAPABILITY;
}

const NARRATOR_REVIEW_TOOLS_CAPABILITY: {
	supported: boolean;
	reason?: string;
	concludeReview: boolean;
	feedbackInjection: boolean;
	promote: boolean;
	dismiss: boolean;
	convertToSubagent: boolean;
	staleMergeGuard: boolean;
} = Object.freeze({
	supported: true,
	concludeReview: true,
	feedbackInjection: true,
	promote: true,
	dismiss: true,
	convertToSubagent: true,
	staleMergeGuard: true,
});

export function useNarratorReviewToolsCapability(): typeof NARRATOR_REVIEW_TOOLS_CAPABILITY {
	return NARRATOR_REVIEW_TOOLS_CAPABILITY;
}

/**
 * `reattachFallback` is false: reattaching a detached subagent blocks the parent for real
 * rather than degrading to a substitute path.
 */
const NARRATOR_SUBAGENTS_CAPABILITY: {
	supported: boolean;
	reason?: string;
	foreground: boolean;
	background: boolean;
	awaitAgent: boolean;
	awaitBash: boolean;
	awaitBashWaitForText: boolean;
	awaitBashReason?: string;
	send: boolean;
	teamStatus: boolean;
	detachAttach: boolean;
	detachUnblocksParent: boolean;
	reattachBlocksParent: boolean;
	reattachFallback: boolean;
	reattachReason?: string;
	backgroundResultInjection: boolean;
	staleRecovery: boolean;
} = Object.freeze({
	supported: true,
	foreground: true,
	background: true,
	awaitAgent: true,
	awaitBash: true,
	awaitBashWaitForText: true,
	send: true,
	teamStatus: true,
	detachAttach: true,
	detachUnblocksParent: true,
	reattachBlocksParent: true,
	reattachFallback: false,
	backgroundResultInjection: true,
	staleRecovery: true,
});

export function useNarratorSubagentsCapability(): typeof NARRATOR_SUBAGENTS_CAPABILITY {
	return NARRATOR_SUBAGENTS_CAPABILITY;
}

/**
 * The optional-tool and web-fetch mode lists were only ever populated from a capabilities
 * payload, so they stay empty: consumers treat empty as "nothing to single out" rather
 * than "nothing supported".
 */
const NARRATOR_TOOL_INVENTORY_CAPABILITY: {
	supported: boolean;
	supportedOptionalTools: string[];
	unsupportedOptionalTools: string[];
	reason?: string;
	webFetch: {
		supported: boolean;
		reason?: string;
		parity?: string;
		mode?: string;
		defaultMode?: string;
		supportedModes: string[];
		unsupportedModes: string[];
		protocols: string[];
		policy?: string;
	};
	browser: {
		supported: boolean;
		reason?: string;
		parity?: string;
		runtime?: string;
		screenshotPreviewMode?: string;
		sharePreview: boolean;
		imageContentBlock: boolean;
		fileOutput: boolean;
		traceFormat?: string;
		traceShare: boolean;
		traceFileOutput: boolean;
		traceShareUrl?: string;
	};
} = Object.freeze({
	supported: true,
	supportedOptionalTools: [] as string[],
	unsupportedOptionalTools: [] as string[],
	webFetch: Object.freeze({
		supported: true,
		supportedModes: [] as string[],
		unsupportedModes: [] as string[],
		protocols: [] as string[],
	}),
	browser: Object.freeze({
		supported: true,
		sharePreview: true,
		imageContentBlock: true,
		fileOutput: true,
		traceShare: true,
		traceFileOutput: true,
	}),
});

export function useNarratorToolInventoryCapability(): typeof NARRATOR_TOOL_INVENTORY_CAPABILITY {
	return NARRATOR_TOOL_INVENTORY_CAPABILITY;
}

// === vnet ===

/**
 * `udpRendezvous` is false: peer discovery runs over the WebSocket path, with no UDP
 * rendezvous server in the picture.
 */
const VNET_CAPABILITY: {
	supported: boolean;
	reason?: string;
	mode?: string;
	ws: boolean;
	peerCleanup: boolean;
	udpRendezvous: boolean;
	udpRendezvousReason?: string;
} = Object.freeze({
	supported: true,
	ws: true,
	peerCleanup: true,
	udpRendezvous: false,
});

export function useVNetCapability(): typeof VNET_CAPABILITY {
	return VNET_CAPABILITY;
}

// === mcp ===

const MCP_BUILTIN_TOOLS_CAPABILITY: {
	supported: boolean;
	reason?: string;
	parity?: string;
	missing: string[];
} = Object.freeze({ supported: true, missing: [] as string[] });

export function useMcpBuiltinToolsCapability(): typeof MCP_BUILTIN_TOOLS_CAPABILITY {
	return MCP_BUILTIN_TOOLS_CAPABILITY;
}

const MCP_PROTOCOL_CAPABILITY: {
	builtinProtocol: {
		supported: boolean;
		reason?: string;
		initialize?: boolean;
		toolsList?: boolean;
		toolsCall?: boolean;
	};
	toolsList: { supported: boolean; reason?: string; source?: string };
	toolsCall: { supported: boolean; reason?: string; scope?: string };
} = Object.freeze({
	builtinProtocol: SUPPORTED,
	toolsList: SUPPORTED,
	toolsCall: SUPPORTED,
});

export function useMcpProtocolCapability(): typeof MCP_PROTOCOL_CAPABILITY {
	return MCP_PROTOCOL_CAPABILITY;
}

const MCP_EXTERNAL_TOOLS_CAPABILITY: {
	supported: boolean;
	reason?: string;
	parity?: string;
	transport?: string;
	lifecycle?: string;
} = Object.freeze({ supported: true });

export function useMcpExternalToolsCapability(): typeof MCP_EXTERNAL_TOOLS_CAPABILITY {
	return MCP_EXTERNAL_TOOLS_CAPABILITY;
}

export function useMcpExternalAgentCapability(): typeof MCP_EXTERNAL_TOOLS_CAPABILITY {
	return MCP_EXTERNAL_TOOLS_CAPABILITY;
}

export function useMcpServerSettingsStorageCapability(): { supported: boolean; reason?: string } {
	return SUPPORTED;
}

const MCP_EXTERNAL_SERVER_MANAGEMENT_CAPABILITY: {
	supported: boolean;
	reason?: string;
	permissions: boolean;
	import: boolean;
} = Object.freeze({ supported: true, permissions: true, import: true });

export function useMcpExternalServerManagementCapability(): typeof MCP_EXTERNAL_SERVER_MANAGEMENT_CAPABILITY {
	return MCP_EXTERNAL_SERVER_MANAGEMENT_CAPABILITY;
}

const MCP_TRANSPORTS_CAPABILITY: {
	stdio: { supported: boolean; reason?: string };
	sse: { supported: boolean; reason?: string };
	streamableHttp: { supported: boolean; reason?: string };
} = Object.freeze({ stdio: SUPPORTED, sse: SUPPORTED, streamableHttp: SUPPORTED });

export function useMcpTransportsCapability(): typeof MCP_TRANSPORTS_CAPABILITY {
	return MCP_TRANSPORTS_CAPABILITY;
}

// === content, uploads, shares ===

const CONTENT_CAPABILITY: {
	projectRoutines: { supported: boolean; reason?: string; storage?: string };
	projectSkills: { supported: boolean; reason?: string; storage?: string };
} = Object.freeze({ projectRoutines: SUPPORTED, projectSkills: SUPPORTED });

export function useContentCapability(): typeof CONTENT_CAPABILITY {
	return CONTENT_CAPABILITY;
}

const UPLOAD_CAPABILITY: {
	serveNarratorImages: { supported: boolean; reason?: string };
	serveAvatars: { supported: boolean; reason?: string };
	cleanupPreservesMessageImageRefs: { supported: boolean; reason?: string };
} = Object.freeze({
	serveNarratorImages: SUPPORTED,
	serveAvatars: SUPPORTED,
	cleanupPreservesMessageImageRefs: SUPPORTED,
});

export function useUploadCapability(): typeof UPLOAD_CAPABILITY {
	return UPLOAD_CAPABILITY;
}

const SHARE_CAPABILITY: {
	createSupported: boolean;
	publicDownloadSupported: boolean;
	previewSupported: boolean;
	previewHtmlMode?: string;
	previewReason?: string;
	ephemeralOnlySupported: boolean;
	ephemeralOnlyFallback: boolean;
	ephemeralOnlyReason?: string;
} = Object.freeze({
	createSupported: true,
	publicDownloadSupported: true,
	previewSupported: true,
	ephemeralOnlySupported: true,
	ephemeralOnlyFallback: false,
});

export function useShareCapability(): typeof SHARE_CAPABILITY {
	return SHARE_CAPABILITY;
}

// === providers ===

/**
 * Per-provider runtime detail (auth/route/agent metadata) was only ever read from a
 * capabilities payload, so there is nothing to report. Provider sections fall back to
 * their own live probes and settings state.
 */
export function useProviderRuntimeCapability(
	_provider: ProviderCapabilityKey,
): ProviderRuntimeCapability | undefined {
	return undefined;
}

export function useProviderRouteCapability(
	_provider: ProviderCapabilityKey,
	_route: string,
): { supported: boolean; reason?: string } {
	return SUPPORTED;
}

export function useCodexManagerParityCapability(): ProviderManagerParityCapability | undefined {
	return undefined;
}

export function useProviderModelRefreshCapability(_provider: ProviderCapabilityKey): {
	supported: boolean;
	reason?: string;
} {
	return SUPPORTED;
}

export function useProviderQuotaCapability(_provider: ProviderCapabilityKey): {
	supported: boolean;
	reason?: string;
} {
	return SUPPORTED;
}

export function useProviderAgentModeCapability(_provider: ProviderCapabilityKey): {
	supported: boolean;
	reason?: string;
} {
	return SUPPORTED;
}

// === settings ===

/**
 * `looseValidation` is false: settings go through the Zod schemas in
 * `server/lib/validators`, not a loose JSON-with-normalization path.
 */
const SETTINGS_VALIDATION_CAPABILITY: {
	tsZodParity: boolean;
	looseValidation: boolean;
	mode?: string;
	reason?: string;
} = Object.freeze({ tsZodParity: true, looseValidation: false });

export function useSettingsValidationCapability(): typeof SETTINGS_VALIDATION_CAPABILITY {
	return SETTINGS_VALIDATION_CAPABILITY;
}

const SETTINGS_FEATURE_CAPABILITY: {
	storageSupported: boolean;
	storagePath?: string;
	patchSupported: boolean;
	secretMasking: boolean;
	providerModelAugmentation: boolean;
	tlsGeneration: boolean;
	retryRules: boolean;
} = Object.freeze({
	storageSupported: true,
	patchSupported: true,
	secretMasking: true,
	providerModelAugmentation: true,
	tlsGeneration: true,
	retryRules: true,
});

export function useSettingsFeatureCapability(): typeof SETTINGS_FEATURE_CAPABILITY {
	return SETTINGS_FEATURE_CAPABILITY;
}

// === benchmark ===

export function useBenchmarkContainerExecutionCapability(): {
	supported: boolean;
	reason?: string;
} {
	return SUPPORTED;
}

// === runtime maintenance ===

type RuntimeCleanupTarget = "terminals" | "containers" | "browsers" | "worktrees";

type RuntimeCleanupCapability = {
	supported: boolean;
	reason?: string;
	mode?: string;
};

const RUNTIME_MAINTENANCE_CAPABILITY: {
	backend?: string;
	buildChannel?: string;
	scanSupported: boolean;
	scanReason?: string;
	cachedSupported: boolean;
	cachedReason?: string;
	cleanup: Record<RuntimeCleanupTarget, RuntimeCleanupCapability>;
} = Object.freeze({
	scanSupported: true,
	cachedSupported: true,
	cleanup: Object.freeze({
		terminals: SUPPORTED,
		containers: SUPPORTED,
		browsers: SUPPORTED,
		worktrees: SUPPORTED,
	}),
});

export function useRuntimeMaintenanceCapability(): typeof RUNTIME_MAINTENANCE_CAPABILITY {
	return RUNTIME_MAINTENANCE_CAPABILITY;
}

// === storage ===

type StorageCleanupTarget = "uploads" | "chatAttachments" | "shares" | "worktrees" | "containers";

type StorageCleanupRuntimeCapability = {
	supported: boolean;
	reason?: string;
	mode?: string;
	alternative?: string;
	preservesMessageImageRefs?: boolean;
};

/**
 * Load state of the health request itself. This is a genuine distinction — `StorageSection`
 * shows a loader, an error with a retry, or the controls — unlike the old
 * `StorageCapabilityHealthState`, which additionally split success into "legacy" (no
 * capability payload) and "capabilities" (payload present). Only the former ever occurred.
 */
export type StorageHealthState = "loading" | "error" | "ready";

export type StorageCapability = {
	scanSupported: boolean;
	scanReason?: string;
	cachedSupported: boolean;
	cachedReason?: string;
	vacuumSupported: boolean;
	vacuumReason?: string;
	cleanup: Record<StorageCleanupTarget, StorageCleanupRuntimeCapability>;
};

/**
 * Storage scan and VACUUM are expensive and service-pausing, so the UI still waits for
 * `/api/health` to answer before enabling them — `healthReady` is a real load-state gate,
 * not a capability check. VACUUM additionally stays behind `requireAdmin` and an explicit
 * confirmation in `StorageSection`.
 */
const STORAGE_CAPABILITY: StorageCapability = Object.freeze({
	scanSupported: true,
	cachedSupported: true,
	vacuumSupported: true,
	cleanup: Object.freeze({
		uploads: SUPPORTED,
		chatAttachments: SUPPORTED,
		shares: SUPPORTED,
		worktrees: SUPPORTED,
		containers: SUPPORTED,
	}),
});

export function useStorageCapability(): StorageCapability & {
	healthState: StorageHealthState;
	healthReady: boolean;
	healthError: Error | null;
	healthFetching: boolean;
	refetchHealth: () => Promise<unknown>;
} {
	const health = useHealthQuery();
	const healthState: StorageHealthState = health.isError
		? "error"
		: health.status === "pending"
			? "loading"
			: "ready";
	return {
		...STORAGE_CAPABILITY,
		healthState,
		healthReady: healthState === "ready",
		healthError: health.error,
		healthFetching: health.isFetching,
		refetchHealth: health.refetch,
	};
}

export function useStorageDatabasePreviewCapability(): { supported: boolean; reason?: string } {
	return SUPPORTED;
}

type StorageDatabaseCleanupTarget =
	| "archivedSessions"
	| "staleSessions"
	| "apiRequestDumps"
	| "toolCallPayloads";

type StorageDatabaseCleanupCapability = {
	supported: boolean;
	reason?: string;
	code?: string;
	fallback?: boolean;
};

const STORAGE_DATABASE_CLEANUP_CAPABILITIES: Record<
	StorageDatabaseCleanupTarget,
	StorageDatabaseCleanupCapability
> = Object.freeze({
	archivedSessions: SUPPORTED,
	staleSessions: SUPPORTED,
	apiRequestDumps: SUPPORTED,
	toolCallPayloads: SUPPORTED,
});

export function useStorageDatabaseCleanupCapabilities(): typeof STORAGE_DATABASE_CLEANUP_CAPABILITIES {
	return STORAGE_DATABASE_CLEANUP_CAPABILITIES;
}

type StorageCleanupOperationCapability = StorageCleanupRuntimeCapability & {
	route: "storage" | "runtime";
	runtimeTarget?: RuntimeCleanupTarget;
};

/**
 * Every target is served by the storage route. The runtime-route branch existed to send
 * worktree cleanup elsewhere when storage cleanup reported itself unsupported, which the
 * storage capability never did.
 */
const STORAGE_CLEANUP_OPERATION_CAPABILITIES: Record<
	StorageCleanupTarget,
	StorageCleanupOperationCapability
> = Object.freeze({
	uploads: Object.freeze({ supported: true, route: "storage" }),
	chatAttachments: Object.freeze({ supported: true, route: "storage" }),
	shares: Object.freeze({ supported: true, route: "storage" }),
	containers: Object.freeze({ supported: true, route: "storage" }),
	worktrees: Object.freeze({ supported: true, route: "storage" }),
});

export function useStorageCleanupOperationCapabilities(): typeof STORAGE_CLEANUP_OPERATION_CAPABILITIES {
	return STORAGE_CLEANUP_OPERATION_CAPABILITIES;
}
