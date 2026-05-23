import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

type Platform = "windows" | "macos" | "linux";
export type GatewayPlatform =
	| "telegram"
	| "discord"
	| "slack"
	| "feishu"
	| "webhook"
	| "weixin"
	| "qqbot";

interface FeatureCapability {
	supported?: boolean;
	fallback?: boolean;
	code?: string;
	reason?: string;
	error?: string;
	message?: string;
	mode?: string;
}

export type ProviderCapabilityKey =
	| "openai"
	| "anthropic"
	| "nug"
	| "codex"
	| "cline";
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
type StorageDatabaseCleanupTarget = "archivedSessions" | "staleSessions" | "apiRequestDumps";

interface ProviderManagerParityCapability {
	tsCodexManagerEquivalent?: boolean;
	usageQueueParity?: string;
	usageQueueClearSupported?: boolean;
	snapshotPaginationParity?: string;
	reason?: string;
}

interface ProviderRuntimeCapability {
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

export interface RuntimeCapabilities {
	database?: {
		engine?: string;
		mainSchemaOwner?: string;
		goMainMigrations?: boolean;
		goEnsureColumns?: boolean;
		ftsRepair?: boolean;
		mode?: string;
		searchMode?: string;
		reason?: string;
	};
	frontend?: {
		staticHosted?: boolean;
		mode?: string;
		directory?: string;
	};
	releasePackaging?: {
		buildInfo?: string;
		frontend?: string;
		changelog?: string;
		singleFileEmbedded?: boolean;
	};
	nativeExtensions?: {
		defaultEnabled?: boolean;
		scope?: string;
		browserSessions?: {
			defaultEnabled?: boolean;
			storage?: string;
			cutover?: string;
			rollback?: string;
			reason?: string;
		};
		containerBrowserToolAutoEnable?: {
			defaultEnabled?: boolean;
			cutover?: string;
			rollback?: string;
			reason?: string;
		};
	};
	chapters?: {
		split?: FeatureCapability & {
			routes?: {
				splitAtCommit?: boolean;
			};
			partials?: {
				compressedAISummary?: FeatureCapability;
				containerAutostart?: FeatureCapability;
			};
		};
		containers?: FeatureCapability & {
			routes?: Partial<Record<ChapterContainerRoute, boolean>>;
			runtime?: {
				podmanCompose?: boolean;
				podmanComposeFallbackCommand?: boolean;
				boundedOutput?: boolean;
				syncStartRequest?: boolean;
				backgroundStart?: boolean;
				backgroundStartReason?: string;
				streamingLogs?: boolean;
				perChapterLock?: boolean;
			};
			ports?: {
				legacyHostPortAllocation?: boolean;
				portRelease?: boolean;
			};
			proxy?: {
				metadataSupported?: boolean;
				requiresPastaPasst?: boolean;
				overridePortsReset?: boolean;
				reverseProxyServer?: boolean;
				http?: boolean;
				websocket?: boolean;
				dynamicSettingsHook?: boolean;
			};
			lifecycle?: {
				manualControls?: boolean;
				autoStartOnFork?: boolean;
				pauseOnDormant?: boolean;
				unpauseOnWake?: boolean;
				removeOnDelete?: boolean;
				removeOnMergeCleanup?: boolean;
				deleteVolumes?: boolean;
			};
			narratorIntegration?: {
				statusChangedEvent?: boolean;
				containerReadyMessage?: boolean;
				browserToolAutoEnable?: boolean;
				browserToolAutoEnableReason?: string;
				defaultEnabled?: boolean;
				cutover?: string;
				rollback?: string;
			};
		};
	};
	narrator?: {
		wsEvents?: {
			p0?: FeatureCapability & { events?: string[] };
			p1?: FeatureCapability & { mode?: string; events?: string[] };
		};
		messageHistory?: FeatureCapability & {
			catchUp?: boolean;
			messageVersion?: boolean;
			childOrphans?: boolean;
			toolCalls?: boolean;
			compactMarkers?: boolean;
			structuredContent?: boolean;
		};
		browserSessions?: FeatureCapability & {
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
		};
		containerBrowserToolAutoEnable?: {
			defaultEnabled?: boolean;
			cutover?: string;
			rollback?: string;
			reason?: string;
		};
		planMode?: FeatureCapability & {
			api?: boolean;
			toolReflection?: boolean;
			previousModeRestore?: boolean;
		};
		retryRecovery?: FeatureCapability & {
			retry?: boolean;
			continue?: boolean;
			interrupt?: boolean;
			manualOverride?: boolean;
			rollback?: boolean;
			editAndRegenerate?: boolean;
		};
		permissions?: FeatureCapability & {
			modes?: string[];
			approveDeny?: boolean;
			updatedInput?: boolean;
			pauseResume?: string;
			reflections?: string[];
		};
		reviewTools?: FeatureCapability & {
			concludeReview?: boolean;
			feedbackInjection?: boolean;
			promote?: boolean;
			dismiss?: boolean;
			convertToSubagent?: boolean;
			staleMergeGuard?: boolean;
		};
		subagents?: FeatureCapability & {
			foreground?: boolean;
			background?: boolean;
			awaitAgent?: boolean;
			awaitBash?: boolean;
			awaitBashWaitForText?: boolean;
			awaitBashReason?: string;
			send?: boolean;
			teamStatus?: boolean;
			detachAttach?: boolean;
			detachUnblocksParent?: boolean;
			reattachBlocksParent?: boolean;
			reattachFallback?: boolean;
			reattachReason?: string;
			backgroundResultInjection?: boolean;
			staleRecovery?: boolean;
		};
		rollbackEditRegenerate?: FeatureCapability & {
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
		};
		compact?: FeatureCapability & {
			segmentCompact?: boolean;
			contextClear?: boolean;
			mode?: string;
			fallbackSummary?: boolean;
			fallbackReason?: string;
		};
		toolInventory?: {
			supported?: boolean;
			categories?: string[];
			supportedOptionalTools?: string[];
			unsupportedOptionalTools?: string[];
			reason?: string;
			webFetch?: FeatureCapability & {
				parity?: string;
				mode?: string;
				defaultMode?: string;
				supportedModes?: string[];
				unsupportedModes?: string[];
				protocols?: string[];
				policy?: string;
			};
			browser?: FeatureCapability & {
				parity?: string;
				runtime?: string;
				screenshotPreviewMode?: string;
				sharePreview?: boolean;
				imageContentBlock?: boolean;
				fileOutput?: boolean;
				traceFormat?: string;
				traceShare?: boolean;
				traceFileOutput?: boolean;
				traceShareUrl?: string;
			};
			mcpExternalTools?: FeatureCapability & {
				parity?: string;
				transport?: string;
				lifecycle?: string;
			};
		};
	};
	mcp?: {
		builtinProtocol?: FeatureCapability & {
			initialize?: boolean;
			toolsList?: boolean;
			toolsCall?: boolean;
		};
		serverSettingsStorage?: FeatureCapability & { storage?: string };
		externalServerManagement?: FeatureCapability & {
			storage?: string;
			permissions?: boolean;
			import?: boolean;
		};
		builtinTools?: FeatureCapability & {
			parity?: string;
			missing?: string[];
		};
		toolsList?: FeatureCapability & { source?: string };
		toolsCall?: FeatureCapability & { scope?: string };
		externalToolsInjection?: FeatureCapability & {
			parity?: string;
			transport?: string;
			lifecycle?: string;
		};
		externalAgentInjection?: FeatureCapability & {
			parity?: string;
			transport?: string;
			lifecycle?: string;
		};
		transports?: {
			stdio?: FeatureCapability;
			sse?: FeatureCapability;
			streamableHttp?: FeatureCapability;
		};
	};
	benchmark?: {
		containerExecution?: FeatureCapability & {
			runtime?: string;
			resourceLimits?: boolean;
			timeout?: boolean;
			outputLimitBytes?: number;
		};
	};
	content?: {
		projectRoutines?: FeatureCapability & { storage?: string };
		projectSkills?: FeatureCapability & { storage?: string };
	};
	fs?: {
		browse?: FeatureCapability;
		shortcuts?: FeatureCapability;
		mkdir?: FeatureCapability;
		preview?: FeatureCapability & {
			maxTextBytes?: number;
			maxBinaryBytes?: number;
		};
		reveal?: FeatureCapability;
	};
	providers?: Partial<Record<ProviderCapabilityKey, ProviderRuntimeCapability>>;
	terminal?: {
		supported?: boolean;
		reason?: string;
		directPty?: boolean;
		windowsPty?: boolean;
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
		maxSnapshotBytes?: number;
		multiClientResizeMode?: string;
		ws?: {
			subscribe?: boolean;
			create?: boolean;
			input?: boolean;
			resize?: boolean;
			kill?: boolean;
			rename?: boolean;
			scrollback?: boolean;
			bufferState?: boolean;
		};
		processTree?: {
			supported?: boolean;
			platform?: string;
		};
	};
	vnet?: {
		supported?: boolean;
		reason?: string;
		mode?: string;
		ws?: boolean;
		peerCleanup?: boolean;
		udpRendezvous?: boolean;
		udpRendezvousReason?: string;
	};
	update?: {
		selfUpdateAvailable?: boolean;
		manualOnly?: boolean;
		canAutoRestart?: boolean;
		download?: FeatureCapability & {
			sse?: boolean;
			sha512?: boolean;
			maxBytes?: number;
			trustMode?: string;
		};
		apply?: FeatureCapability & {
			handoff?: string;
		};
	};
	settings?: {
		storage?: FeatureCapability & { path?: string };
		patch?: FeatureCapability;
		validation?: {
			tsZodParity?: boolean;
			mode?: string;
			reason?: string;
		};
		secretMasking?: boolean;
		providerModelAugmentation?: boolean;
		tlsGeneration?: boolean;
		retryRules?: boolean;
	};
	gateway?: {
		persistentRuntimes?: boolean;
		mode?: string;
		reason?: string;
		supportedPlatforms?: GatewayPlatform[];
		unsupportedPlatforms?: Partial<Record<GatewayPlatform, string>>;
		webhook?: FeatureCapability;
		weixinQr?: FeatureCapability;
	};
	runtime?: {
		backend?: string;
		buildChannel?: string;
		scan?: FeatureCapability;
		cached?: FeatureCapability;
		cleanup?: Partial<
			Record<
				"terminals" | "containers" | "browsers" | "worktrees",
				{
					supported?: boolean;
					reason?: string;
					mode?: string;
				}
			>
		>;
	};
	uploads?: {
		serveNarratorImages?: FeatureCapability;
		serveAvatars?: FeatureCapability;
		cleanupPreservesMessageImageRefs?: FeatureCapability;
	};
	shares?: {
		create?: FeatureCapability;
		publicDownload?: FeatureCapability;
		preview?: FeatureCapability & { htmlMode?: string; reason?: string };
		ephemeralOnly?: FeatureCapability;
	};
	storage?: {
		scan?: FeatureCapability & { sse?: boolean; cache?: boolean };
		cached?: FeatureCapability & { cache?: boolean };
		database?: {
			preview?: boolean;
			cleanup?: boolean;
			cleanupTargets?: Partial<Record<StorageDatabaseCleanupTarget, FeatureCapability>>;
		};
		vacuum?: {
			supported?: boolean;
			reason?: string;
		};
		cleanup?: Partial<
			Record<
				"uploads" | "shares" | "worktrees" | "containers",
				{
					supported?: boolean;
					fallback?: boolean;
					reason?: string;
					mode?: string;
					alternative?: string;
					preservesMessageImageRefs?: boolean;
				}
			>
		>;
	};
}

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

export function useRuntimeCapabilities(): RuntimeCapabilities | undefined {
	const { data } = useHealthQuery();
	return data?.capabilities;
}

export function getDatabaseCapability(
	capabilities: RuntimeCapabilities | undefined,
): RuntimeCapabilities["database"] | undefined {
	return capabilities?.database;
}

export function useDatabaseCapability(): RuntimeCapabilities["database"] | undefined {
	return getDatabaseCapability(useRuntimeCapabilities());
}

type FileSystemFeatureCapability = {
	supported: boolean;
	reason?: string;
	maxTextBytes?: number;
	maxBinaryBytes?: number;
};

export function getFileSystemCapability(capabilities: RuntimeCapabilities | undefined): {
	browse: FileSystemFeatureCapability;
	shortcuts: FileSystemFeatureCapability;
	mkdir: FileSystemFeatureCapability;
	preview: FileSystemFeatureCapability;
	reveal: FileSystemFeatureCapability;
} {
	const fs = capabilities?.fs;
	return {
		browse: {
			supported: fs?.browse?.supported !== false,
			reason: fs?.browse?.reason,
		},
		shortcuts: {
			supported: fs?.shortcuts?.supported !== false,
			reason: fs?.shortcuts?.reason,
		},
		mkdir: {
			supported: fs?.mkdir?.supported !== false,
			reason: fs?.mkdir?.reason,
		},
		preview: {
			supported: fs?.preview?.supported !== false,
			reason: fs?.preview?.reason,
			maxTextBytes: fs?.preview?.maxTextBytes,
			maxBinaryBytes: fs?.preview?.maxBinaryBytes,
		},
		reveal: {
			supported: fs?.reveal?.supported !== false,
			reason: fs?.reveal?.reason,
		},
	};
}

export function useFileSystemCapability(): ReturnType<typeof getFileSystemCapability> {
	return getFileSystemCapability(useRuntimeCapabilities());
}

export function getTerminalCapability(capabilities: RuntimeCapabilities | undefined): {
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
} {
	const terminal = capabilities?.terminal;
	return {
		supported: terminal?.supported !== false,
		reason: terminal?.reason,
		dtachSupported: terminal?.dtachSupported,
		dtachAvailable: terminal?.dtachAvailable,
		detachedReattach: terminal?.detachedReattach,
		orphanRecovery: terminal?.orphanRecovery,
		scrollbackReplay: terminal?.scrollbackReplay,
		scrollbackReplayMode: terminal?.scrollbackReplayMode,
		bufferStateReplay: terminal?.bufferStateReplay,
		bufferStateMode: terminal?.bufferStateMode,
		xtermSerializedReplay: terminal?.xtermSerializedReplay,
		xtermSerializedReplayReason: terminal?.xtermSerializedReplayReason,
		multiClientResizeMode: terminal?.multiClientResizeMode,
		processTree: terminal?.processTree,
	};
}

export function useTerminalCapability(): ReturnType<typeof getTerminalCapability> {
	return getTerminalCapability(useRuntimeCapabilities());
}

export function getUpdateCapability(capabilities: RuntimeCapabilities | undefined): {
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
} {
	const update = capabilities?.update;
	const download = update?.download;
	const apply = update?.apply;
	const legacySelfUpdateAvailable = update?.selfUpdateAvailable !== false;
	return {
		selfUpdateAvailable: legacySelfUpdateAvailable,
		manualOnly: update?.manualOnly === true,
		canAutoRestart: update?.canAutoRestart !== false,
		download: {
			supported: download?.supported !== false,
			reason: download?.reason,
			sse: download?.sse !== false,
			sha512: download?.sha512 !== false,
			maxBytes: download?.maxBytes,
			trustMode: download?.trustMode,
		},
		apply: {
			supported: apply?.supported ?? legacySelfUpdateAvailable,
			reason: apply?.reason,
			handoff: apply?.handoff,
		},
	};
}

export function useUpdateCapability(): ReturnType<typeof getUpdateCapability> {
	return getUpdateCapability(useRuntimeCapabilities());
}

export function getGatewayCapability(capabilities: RuntimeCapabilities | undefined): {
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
} {
	const gateway = capabilities?.gateway;
	const persistentRuntimes = gateway?.persistentRuntimes !== false;
	const supportedPlatforms = gateway?.supportedPlatforms;
	const unsupportedPlatforms = gateway?.unsupportedPlatforms;
	const webhookSupported = gateway?.webhook?.supported !== false;
	const webhookReason =
		gateway?.webhook?.reason ??
		gateway?.webhook?.message ??
		gateway?.webhook?.error ??
		gateway?.webhook?.code;
	return {
		weixinQrSupported: gateway?.weixinQr?.supported !== false,
		weixinQrReason:
			gateway?.weixinQr?.reason ??
			gateway?.weixinQr?.message ??
			gateway?.weixinQr?.error ??
			gateway?.weixinQr?.code,
		webhookSupported,
		webhookReason,
		persistentRuntimes,
		supportedPlatforms,
		unsupportedPlatforms,
		isPlatformSupported: (platform) => {
			if (platform === "webhook" && !webhookSupported) return false;
			if (supportedPlatforms?.length) return supportedPlatforms.includes(platform);
			return persistentRuntimes || platform === "webhook";
		},
		platformUnsupportedReason: (platform) =>
			platform === "webhook"
				? (unsupportedPlatforms?.[platform] ?? webhookReason)
				: unsupportedPlatforms?.[platform],
		reason: gateway?.reason,
	};
}

export function useGatewayCapability(): ReturnType<typeof getGatewayCapability> {
	return getGatewayCapability(useRuntimeCapabilities());
}

export function getChapterContainersCapability(capabilities: RuntimeCapabilities | undefined): {
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
} {
	const containers = capabilities?.chapters?.containers;
	const supported = containers?.supported !== false;
	const routeSupported = (route: ChapterContainerRoute) =>
		supported && containers?.routes?.[route] !== false;
	return {
		supported,
		reason: containers?.reason,
		routes: {
			setup: routeSupported("setup"),
			podmanStatus: routeSupported("podmanStatus"),
			podmanInstall: routeSupported("podmanInstall"),
			composeInfo: routeSupported("composeInfo"),
			list: routeSupported("list"),
			start: routeSupported("start"),
			stop: routeSupported("stop"),
			pause: routeSupported("pause"),
			unpause: routeSupported("unpause"),
			logs: routeSupported("logs"),
			remove: routeSupported("remove"),
		},
		runtime: {
			podmanCompose: containers?.runtime?.podmanCompose,
			podmanComposeFallbackCommand: containers?.runtime?.podmanComposeFallbackCommand,
			boundedOutput: containers?.runtime?.boundedOutput,
			syncStartRequest: containers?.runtime?.syncStartRequest,
			backgroundStart: containers?.runtime?.backgroundStart,
			backgroundStartReason: containers?.runtime?.backgroundStartReason,
			streamingLogs: containers?.runtime?.streamingLogs,
			perChapterLock: containers?.runtime?.perChapterLock,
		},
	};
}

export function getChapterSplitCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	compressedAISummarySupported: boolean;
	compressedAISummaryFallback: boolean;
	compressedAISummaryMode?: string;
	compressedAISummaryReason?: string;
} {
	const split = capabilities?.chapters?.split;
	const compressedAISummary = split?.partials?.compressedAISummary;
	return {
		supported: split?.supported !== false && split?.routes?.splitAtCommit !== false,
		reason: split?.reason,
		compressedAISummarySupported: compressedAISummary?.supported !== false,
		compressedAISummaryFallback: compressedAISummary?.fallback === true,
		compressedAISummaryMode: compressedAISummary?.mode,
		compressedAISummaryReason: compressedAISummary?.reason,
	};
}

export function useChapterSplitCapability(): ReturnType<typeof getChapterSplitCapability> {
	return getChapterSplitCapability(useRuntimeCapabilities());
}

export function useChapterContainersCapability(): ReturnType<
	typeof getChapterContainersCapability
> {
	return getChapterContainersCapability(useRuntimeCapabilities());
}

export function getNarratorBrowserSessionsCapability(
	capabilities: RuntimeCapabilities | undefined,
): {
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
} {
	const browserSessions = capabilities?.narrator?.browserSessions;
	return {
		supported: browserSessions?.supported !== false,
		reason: browserSessions?.reason,
		defaultEnabled: browserSessions?.defaultEnabled,
		runtime: browserSessions?.runtime,
		storage: browserSessions?.storage,
		cutover: browserSessions?.cutover,
		rollback: browserSessions?.rollback,
		narratorBound: browserSessions?.narratorBound,
		lifecycleEvents: browserSessions?.lifecycleEvents,
		artifactPersistence: browserSessions?.artifactPersistence,
		resourceLimits: browserSessions?.resourceLimits,
		requiresChrome: browserSessions?.requiresChrome,
	};
}

export function useNarratorBrowserSessionsCapability(): ReturnType<
	typeof getNarratorBrowserSessionsCapability
> {
	return getNarratorBrowserSessionsCapability(useRuntimeCapabilities());
}

export function getNarratorContainerBrowserToolAutoEnableCapability(
	capabilities: RuntimeCapabilities | undefined,
):
	| {
			defaultEnabled?: boolean;
			cutover?: string;
			rollback?: string;
			reason?: string;
	  }
	| undefined {
	return capabilities?.narrator?.containerBrowserToolAutoEnable;
}

export function useNarratorContainerBrowserToolAutoEnableCapability(): ReturnType<
	typeof getNarratorContainerBrowserToolAutoEnableCapability
> {
	return getNarratorContainerBrowserToolAutoEnableCapability(useRuntimeCapabilities());
}

export function getNarratorPlanModeCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	api?: boolean;
	toolReflection?: boolean;
	previousModeRestore?: boolean;
} {
	const planMode = capabilities?.narrator?.planMode;
	return {
		supported: planMode?.supported !== false,
		reason: planMode?.reason,
		api: planMode?.api,
		toolReflection: planMode?.toolReflection,
		previousModeRestore: planMode?.previousModeRestore,
	};
}

export function useNarratorPlanModeCapability(): ReturnType<typeof getNarratorPlanModeCapability> {
	return getNarratorPlanModeCapability(useRuntimeCapabilities());
}

export function getNarratorCompactCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	mode?: string;
	fallbackSummary?: boolean;
	fallbackReason?: string;
} {
	const compact = capabilities?.narrator?.compact;
	return {
		supported: compact?.supported !== false,
		reason: compact?.reason,
		mode: compact?.mode,
		fallbackSummary: compact?.fallbackSummary,
		fallbackReason: compact?.fallbackReason,
	};
}

export function useNarratorCompactCapability(): ReturnType<typeof getNarratorCompactCapability> {
	return getNarratorCompactCapability(useRuntimeCapabilities());
}

export function getNarratorRetryRecoveryCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	retry?: boolean;
	continue?: boolean;
	interrupt?: boolean;
	manualOverride?: boolean;
	rollback?: boolean;
	editAndRegenerate?: boolean;
} {
	const retryRecovery = capabilities?.narrator?.retryRecovery;
	return {
		supported: retryRecovery?.supported !== false,
		reason: retryRecovery?.reason,
		retry: retryRecovery?.retry,
		continue: retryRecovery?.continue,
		interrupt: retryRecovery?.interrupt,
		manualOverride: retryRecovery?.manualOverride,
		rollback: retryRecovery?.rollback,
		editAndRegenerate: retryRecovery?.editAndRegenerate,
	};
}

export function useNarratorRetryRecoveryCapability(): ReturnType<
	typeof getNarratorRetryRecoveryCapability
> {
	return getNarratorRetryRecoveryCapability(useRuntimeCapabilities());
}

const DEFAULT_NARRATOR_PERMISSION_MODES = [
	"default",
	"acceptEdits",
	"bypassPermissions",
	"readOnly",
	"dontAsk",
];
const DEFAULT_NARRATOR_PERMISSION_REFLECTIONS = ["danger", "plan", "goal"];

export function getNarratorPermissionsCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	modes: string[];
	approveDeny: boolean;
	updatedInput: boolean;
	pauseResume?: string;
	reflections: string[];
} {
	const permissions = capabilities?.narrator?.permissions;
	return {
		supported: permissions?.supported !== false,
		reason: permissions?.reason,
		modes: Array.isArray(permissions?.modes)
			? permissions.modes
			: DEFAULT_NARRATOR_PERMISSION_MODES,
		approveDeny: permissions?.approveDeny !== false,
		updatedInput: permissions?.updatedInput !== false,
		pauseResume: permissions?.pauseResume,
		reflections: Array.isArray(permissions?.reflections)
			? permissions.reflections
			: DEFAULT_NARRATOR_PERMISSION_REFLECTIONS,
	};
}

export function useNarratorPermissionsCapability(): ReturnType<
	typeof getNarratorPermissionsCapability
> {
	return getNarratorPermissionsCapability(useRuntimeCapabilities());
}

export function getNarratorReviewToolsCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	concludeReview: boolean;
	feedbackInjection: boolean;
	promote: boolean;
	dismiss: boolean;
	convertToSubagent: boolean;
	staleMergeGuard: boolean;
} {
	const reviewTools = capabilities?.narrator?.reviewTools;
	return {
		supported: reviewTools?.supported !== false,
		reason: reviewTools?.reason,
		concludeReview: reviewTools?.concludeReview !== false,
		feedbackInjection: reviewTools?.feedbackInjection !== false,
		promote: reviewTools?.promote !== false,
		dismiss: reviewTools?.dismiss !== false,
		convertToSubagent: reviewTools?.convertToSubagent !== false,
		staleMergeGuard: reviewTools?.staleMergeGuard !== false,
	};
}

export function useNarratorReviewToolsCapability(): ReturnType<
	typeof getNarratorReviewToolsCapability
> {
	return getNarratorReviewToolsCapability(useRuntimeCapabilities());
}

export function getNarratorSubagentsCapability(capabilities: RuntimeCapabilities | undefined): {
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
} {
	const subagents = capabilities?.narrator?.subagents;
	return {
		supported: subagents?.supported !== false,
		reason: subagents?.reason,
		foreground: subagents?.foreground !== false,
		background: subagents?.background !== false,
		awaitAgent: subagents?.awaitAgent !== false,
		awaitBash: subagents?.awaitBash !== false,
		awaitBashWaitForText: subagents?.awaitBashWaitForText !== false,
		awaitBashReason: subagents?.awaitBashReason,
		send: subagents?.send !== false,
		teamStatus: subagents?.teamStatus !== false,
		detachAttach: subagents?.detachAttach !== false,
		detachUnblocksParent: subagents?.detachUnblocksParent !== false,
		reattachBlocksParent: subagents?.reattachBlocksParent !== false,
		reattachFallback: subagents?.reattachFallback === true,
		reattachReason: subagents?.reattachReason,
		backgroundResultInjection: subagents?.backgroundResultInjection !== false,
		staleRecovery: subagents?.staleRecovery !== false,
	};
}

export function useNarratorSubagentsCapability(): ReturnType<
	typeof getNarratorSubagentsCapability
> {
	return getNarratorSubagentsCapability(useRuntimeCapabilities());
}

export function getNarratorToolInventoryCapability(capabilities: RuntimeCapabilities | undefined): {
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
} {
	const inventory = capabilities?.narrator?.toolInventory;
	const webFetch = inventory?.webFetch;
	const browser = inventory?.browser;
	return {
		supported: inventory?.supported !== false,
		supportedOptionalTools: inventory?.supportedOptionalTools ?? [],
		unsupportedOptionalTools: inventory?.unsupportedOptionalTools ?? [],
		reason: inventory?.reason,
		webFetch: {
			supported: webFetch?.supported !== false,
			reason: webFetch?.reason,
			parity: webFetch?.parity,
			mode: webFetch?.mode,
			defaultMode: webFetch?.defaultMode,
			supportedModes: webFetch?.supportedModes ?? [],
			unsupportedModes: webFetch?.unsupportedModes ?? [],
			protocols: webFetch?.protocols ?? [],
			policy: webFetch?.policy,
		},
		browser: {
			supported: browser?.supported !== false,
			reason: browser?.reason,
			parity: browser?.parity,
			runtime: browser?.runtime,
			screenshotPreviewMode: browser?.screenshotPreviewMode,
			sharePreview: browser?.sharePreview !== false,
			imageContentBlock: browser?.imageContentBlock !== false,
			fileOutput: browser?.fileOutput !== false,
			traceFormat: browser?.traceFormat,
			traceShare: browser?.traceShare !== false,
			traceFileOutput: browser?.traceFileOutput !== false,
			traceShareUrl: browser?.traceShareUrl,
		},
	};
}

export function useNarratorToolInventoryCapability(): ReturnType<
	typeof getNarratorToolInventoryCapability
> {
	return getNarratorToolInventoryCapability(useRuntimeCapabilities());
}

export function getVNetCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	mode?: string;
	ws: boolean;
	peerCleanup: boolean;
	udpRendezvous: boolean;
	udpRendezvousReason?: string;
} {
	const vnet = capabilities?.vnet;
	return {
		supported: vnet?.supported !== false,
		reason: vnet?.reason,
		mode: vnet?.mode,
		ws: vnet?.ws !== false,
		peerCleanup: vnet?.peerCleanup !== false,
		udpRendezvous: vnet?.udpRendezvous === true,
		udpRendezvousReason: vnet?.udpRendezvousReason,
	};
}

export function useVNetCapability(): ReturnType<typeof getVNetCapability> {
	return getVNetCapability(useRuntimeCapabilities());
}

export function getMcpBuiltinToolsCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	parity?: string;
	missing: string[];
} {
	const builtinTools = capabilities?.mcp?.builtinTools;
	return {
		supported: builtinTools?.supported !== false,
		reason: builtinTools?.reason,
		parity: builtinTools?.parity,
		missing: Array.isArray(builtinTools?.missing) ? builtinTools.missing : [],
	};
}

export function useMcpBuiltinToolsCapability(): ReturnType<typeof getMcpBuiltinToolsCapability> {
	return getMcpBuiltinToolsCapability(useRuntimeCapabilities());
}

export function getMcpProtocolCapability(capabilities: RuntimeCapabilities | undefined): {
	builtinProtocol: {
		supported: boolean;
		reason?: string;
		initialize?: boolean;
		toolsList?: boolean;
		toolsCall?: boolean;
	};
	toolsList: { supported: boolean; reason?: string; source?: string };
	toolsCall: { supported: boolean; reason?: string; scope?: string };
} {
	const mcp = capabilities?.mcp;
	return {
		builtinProtocol: {
			supported: mcp?.builtinProtocol?.supported !== false,
			reason: mcp?.builtinProtocol?.reason,
			initialize: mcp?.builtinProtocol?.initialize,
			toolsList: mcp?.builtinProtocol?.toolsList,
			toolsCall: mcp?.builtinProtocol?.toolsCall,
		},
		toolsList: {
			supported: mcp?.toolsList?.supported !== false,
			reason: mcp?.toolsList?.reason,
			source: mcp?.toolsList?.source,
		},
		toolsCall: {
			supported: mcp?.toolsCall?.supported !== false,
			reason: mcp?.toolsCall?.reason,
			scope: mcp?.toolsCall?.scope,
		},
	};
}

export function getMcpExternalToolsCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	parity?: string;
	transport?: string;
	lifecycle?: string;
} {
	const externalTools = capabilities?.mcp?.externalToolsInjection;
	return {
		supported: externalTools?.supported !== false,
		reason: externalTools?.reason,
		parity: externalTools?.parity,
		transport: externalTools?.transport,
		lifecycle: externalTools?.lifecycle,
	};
}

export function useMcpExternalToolsCapability(): ReturnType<typeof getMcpExternalToolsCapability> {
	return getMcpExternalToolsCapability(useRuntimeCapabilities());
}

export function getMcpExternalAgentCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	parity?: string;
	transport?: string;
	lifecycle?: string;
} {
	const externalAgent = capabilities?.mcp?.externalAgentInjection;
	return {
		supported: externalAgent?.supported !== false,
		reason: externalAgent?.reason,
		parity: externalAgent?.parity,
		transport: externalAgent?.transport,
		lifecycle: externalAgent?.lifecycle,
	};
}

export function useMcpExternalAgentCapability(): ReturnType<typeof getMcpExternalAgentCapability> {
	return getMcpExternalAgentCapability(useRuntimeCapabilities());
}

export function getMcpServerSettingsStorageCapability(
	capabilities: RuntimeCapabilities | undefined,
): {
	supported: boolean;
	reason?: string;
} {
	const storage = capabilities?.mcp?.serverSettingsStorage;
	return {
		supported: storage?.supported !== false,
		reason: storage?.reason,
	};
}

export function useMcpServerSettingsStorageCapability(): ReturnType<
	typeof getMcpServerSettingsStorageCapability
> {
	return getMcpServerSettingsStorageCapability(useRuntimeCapabilities());
}

export function getMcpExternalServerManagementCapability(
	capabilities: RuntimeCapabilities | undefined,
): {
	supported: boolean;
	reason?: string;
	storage?: string;
	permissions: boolean;
	import: boolean;
} {
	const management = capabilities?.mcp?.externalServerManagement;
	return {
		supported: management?.supported !== false,
		reason: management?.reason,
		storage: management?.storage,
		permissions: management?.permissions !== false,
		import: management?.import !== false,
	};
}

export function useMcpExternalServerManagementCapability(): ReturnType<
	typeof getMcpExternalServerManagementCapability
> {
	return getMcpExternalServerManagementCapability(useRuntimeCapabilities());
}

export function getMcpTransportsCapability(capabilities: RuntimeCapabilities | undefined): {
	stdio: { supported: boolean; reason?: string };
	sse: { supported: boolean; reason?: string };
	streamableHttp: { supported: boolean; reason?: string };
} {
	const transports = capabilities?.mcp?.transports;
	return {
		stdio: {
			supported: transports?.stdio?.supported !== false,
			reason: transports?.stdio?.reason,
		},
		sse: {
			supported: transports?.sse?.supported !== false,
			reason: transports?.sse?.reason,
		},
		streamableHttp: {
			supported: transports?.streamableHttp?.supported !== false,
			reason: transports?.streamableHttp?.reason,
		},
	};
}

export function useMcpTransportsCapability(): ReturnType<typeof getMcpTransportsCapability> {
	return getMcpTransportsCapability(useRuntimeCapabilities());
}

export function getContentCapability(capabilities: RuntimeCapabilities | undefined): {
	projectRoutines: { supported: boolean; reason?: string; storage?: string };
	projectSkills: { supported: boolean; reason?: string; storage?: string };
} {
	const content = capabilities?.content;
	return {
		projectRoutines: {
			supported: content?.projectRoutines?.supported !== false,
			reason: content?.projectRoutines?.reason,
			storage: content?.projectRoutines?.storage,
		},
		projectSkills: {
			supported: content?.projectSkills?.supported !== false,
			reason: content?.projectSkills?.reason,
			storage: content?.projectSkills?.storage,
		},
	};
}

export function useContentCapability(): ReturnType<typeof getContentCapability> {
	return getContentCapability(useRuntimeCapabilities());
}

export function getUploadCapability(capabilities: RuntimeCapabilities | undefined): {
	serveNarratorImages: { supported: boolean; reason?: string };
	serveAvatars: { supported: boolean; reason?: string };
	cleanupPreservesMessageImageRefs: { supported: boolean; reason?: string };
} {
	const uploads = capabilities?.uploads;
	return {
		serveNarratorImages: {
			supported: uploads?.serveNarratorImages?.supported !== false,
			reason: uploads?.serveNarratorImages?.reason,
		},
		serveAvatars: {
			supported: uploads?.serveAvatars?.supported !== false,
			reason: uploads?.serveAvatars?.reason,
		},
		cleanupPreservesMessageImageRefs: {
			supported: uploads?.cleanupPreservesMessageImageRefs?.supported !== false,
			reason: uploads?.cleanupPreservesMessageImageRefs?.reason,
		},
	};
}

export function useUploadCapability(): ReturnType<typeof getUploadCapability> {
	return getUploadCapability(useRuntimeCapabilities());
}

export function getShareCapability(capabilities: RuntimeCapabilities | undefined): {
	createSupported: boolean;
	publicDownloadSupported: boolean;
	previewSupported: boolean;
	previewHtmlMode?: string;
	previewReason?: string;
	ephemeralOnlySupported: boolean;
	ephemeralOnlyFallback: boolean;
	ephemeralOnlyReason?: string;
} {
	const shares = capabilities?.shares;
	return {
		createSupported: shares?.create?.supported !== false,
		publicDownloadSupported: shares?.publicDownload?.supported !== false,
		previewSupported: shares?.preview?.supported !== false,
		previewHtmlMode: shares?.preview?.htmlMode,
		previewReason: shares?.preview?.reason,
		ephemeralOnlySupported: shares?.ephemeralOnly?.supported !== false,
		ephemeralOnlyFallback: shares?.ephemeralOnly?.fallback === true,
		ephemeralOnlyReason: shares?.ephemeralOnly?.reason,
	};
}

export function useShareCapability(): ReturnType<typeof getShareCapability> {
	return getShareCapability(useRuntimeCapabilities());
}

export function useFsRevealCapability(): ReturnType<typeof getFileSystemCapability>["reveal"] {
	return getFileSystemCapability(useRuntimeCapabilities()).reveal;
}

export function getProviderRuntimeCapability(
	capabilities: RuntimeCapabilities | undefined,
	provider: ProviderCapabilityKey,
): ProviderRuntimeCapability | undefined {
	return capabilities?.providers?.[provider];
}

export function useProviderRuntimeCapability(
	provider: ProviderCapabilityKey,
): ProviderRuntimeCapability | undefined {
	return getProviderRuntimeCapability(useRuntimeCapabilities(), provider);
}

export function getProviderRouteCapability(
	capabilities: RuntimeCapabilities | undefined,
	provider: ProviderCapabilityKey,
	route: string,
): { supported: boolean; reason?: string } {
	const routes = getProviderRuntimeCapability(capabilities, provider)?.routes;
	const supported = routes?.supported !== false && routes?.[route] !== false;
	return {
		supported,
		reason: supported ? undefined : routes?.reason,
	};
}

export function useProviderRouteCapability(
	provider: ProviderCapabilityKey,
	route: string,
): { supported: boolean; reason?: string } {
	return getProviderRouteCapability(useRuntimeCapabilities(), provider, route);
}

export function getCodexManagerParityCapability(
	capabilities: RuntimeCapabilities | undefined,
): ProviderManagerParityCapability | undefined {
	return getProviderRuntimeCapability(capabilities, "codex")?.managerParity;
}

export function useCodexManagerParityCapability(): ProviderManagerParityCapability | undefined {
	return getCodexManagerParityCapability(useRuntimeCapabilities());
}

export function getProviderModelRefreshCapability(
	capabilities: RuntimeCapabilities | undefined,
	provider: ProviderCapabilityKey,
): { supported: boolean; reason?: string } {
	const models = capabilities?.providers?.[provider]?.models;
	return {
		supported: models?.refreshSupported !== false,
		reason: models?.reason,
	};
}

export function getProviderQuotaCapability(
	capabilities: RuntimeCapabilities | undefined,
	provider: ProviderCapabilityKey,
): { supported: boolean; reason?: string } {
	const quota = capabilities?.providers?.[provider]?.quota;
	return {
		supported: quota?.supported !== false,
		reason: quota?.reason,
	};
}

export function getProviderAgentModeCapability(
	capabilities: RuntimeCapabilities | undefined,
	provider: ProviderCapabilityKey,
): { supported: boolean; reason?: string } {
	const agentMode = capabilities?.providers?.[provider]?.agentMode;
	return {
		supported: agentMode?.supported !== false,
		reason: agentMode?.reason,
	};
}

export function useProviderModelRefreshCapability(provider: ProviderCapabilityKey): {
	supported: boolean;
	reason?: string;
} {
	return getProviderModelRefreshCapability(useRuntimeCapabilities(), provider);
}

export function useProviderQuotaCapability(provider: ProviderCapabilityKey): {
	supported: boolean;
	reason?: string;
} {
	return getProviderQuotaCapability(useRuntimeCapabilities(), provider);
}

export function useProviderAgentModeCapability(provider: ProviderCapabilityKey): {
	supported: boolean;
	reason?: string;
} {
	return getProviderAgentModeCapability(useRuntimeCapabilities(), provider);
}

export function getSettingsValidationCapability(capabilities: RuntimeCapabilities | undefined): {
	tsZodParity: boolean;
	looseValidation: boolean;
	mode?: string;
	reason?: string;
} {
	const validation = capabilities?.settings?.validation;
	return {
		tsZodParity: validation?.tsZodParity !== false,
		looseValidation:
			validation?.mode === "loose-json-with-normalization" || validation?.tsZodParity === false,
		mode: validation?.mode,
		reason: validation?.reason,
	};
}

export function useSettingsValidationCapability(): ReturnType<
	typeof getSettingsValidationCapability
> {
	return getSettingsValidationCapability(useRuntimeCapabilities());
}

export function getSettingsFeatureCapability(capabilities: RuntimeCapabilities | undefined): {
	storageSupported: boolean;
	storagePath?: string;
	patchSupported: boolean;
	secretMasking: boolean;
	providerModelAugmentation: boolean;
	tlsGeneration: boolean;
	retryRules: boolean;
} {
	const settings = capabilities?.settings;
	return {
		storageSupported: settings?.storage?.supported !== false,
		storagePath: settings?.storage?.path,
		patchSupported: settings?.patch?.supported !== false,
		secretMasking: settings?.secretMasking !== false,
		providerModelAugmentation: settings?.providerModelAugmentation !== false,
		tlsGeneration: settings?.tlsGeneration !== false,
		retryRules: settings?.retryRules !== false,
	};
}

export function useSettingsFeatureCapability(): ReturnType<typeof getSettingsFeatureCapability> {
	return getSettingsFeatureCapability(useRuntimeCapabilities());
}

export function getBenchmarkContainerExecutionCapability(
	capabilities: RuntimeCapabilities | undefined,
): {
	supported: boolean;
	reason?: string;
} {
	const containerExecution = capabilities?.benchmark?.containerExecution;
	return {
		supported: containerExecution?.supported !== false,
		reason: containerExecution?.reason,
	};
}

export function useBenchmarkContainerExecutionCapability(): ReturnType<
	typeof getBenchmarkContainerExecutionCapability
> {
	return getBenchmarkContainerExecutionCapability(useRuntimeCapabilities());
}

type RuntimeCleanupTarget = "terminals" | "containers" | "browsers" | "worktrees";

type RuntimeCleanupCapability = {
	supported: boolean;
	reason?: string;
	mode?: string;
};

export function getRuntimeMaintenanceCapability(capabilities: RuntimeCapabilities | undefined): {
	backend?: string;
	buildChannel?: string;
	scanSupported: boolean;
	scanReason?: string;
	cachedSupported: boolean;
	cachedReason?: string;
	cleanup: Record<RuntimeCleanupTarget, RuntimeCleanupCapability>;
} {
	const runtime = capabilities?.runtime;
	const cleanup = runtime?.cleanup;
	const cleanupCapability = (target: RuntimeCleanupTarget): RuntimeCleanupCapability => ({
		supported: cleanup?.[target]?.supported !== false,
		reason: cleanup?.[target]?.reason,
		mode: cleanup?.[target]?.mode,
	});
	return {
		backend: runtime?.backend,
		buildChannel: runtime?.buildChannel,
		scanSupported: runtime?.scan?.supported !== false,
		scanReason: runtime?.scan?.reason,
		cachedSupported: runtime?.cached?.supported !== false,
		cachedReason: runtime?.cached?.reason,
		cleanup: {
			terminals: cleanupCapability("terminals"),
			containers: cleanupCapability("containers"),
			browsers: cleanupCapability("browsers"),
			worktrees: cleanupCapability("worktrees"),
		},
	};
}

export function useRuntimeMaintenanceCapability(): ReturnType<
	typeof getRuntimeMaintenanceCapability
> {
	return getRuntimeMaintenanceCapability(useRuntimeCapabilities());
}

type StorageCleanupTarget = "uploads" | "shares" | "worktrees" | "containers";

type StorageCleanupRuntimeCapability = {
	supported: boolean;
	reason?: string;
	mode?: string;
	alternative?: string;
	preservesMessageImageRefs?: boolean;
};

export function getStorageCapability(capabilities: RuntimeCapabilities | undefined): {
	scanSupported: boolean;
	scanReason?: string;
	cachedSupported: boolean;
	cachedReason?: string;
	vacuumSupported: boolean;
	vacuumReason?: string;
	cleanup: Record<StorageCleanupTarget, StorageCleanupRuntimeCapability>;
} {
	const scan = capabilities?.storage?.scan;
	const cached = capabilities?.storage?.cached;
	const vacuum = capabilities?.storage?.vacuum;
	const cleanup = capabilities?.storage?.cleanup;
	const cleanupCapability = (target: StorageCleanupTarget): StorageCleanupRuntimeCapability => ({
		supported: cleanup?.[target]?.supported !== false,
		reason: cleanup?.[target]?.reason,
		mode: cleanup?.[target]?.mode,
		alternative: cleanup?.[target]?.alternative,
		preservesMessageImageRefs: cleanup?.[target]?.preservesMessageImageRefs,
	});
	return {
		scanSupported: scan?.supported !== false,
		scanReason: scan?.reason,
		cachedSupported: cached?.supported !== false,
		cachedReason: cached?.reason,
		// Safe default: TS/older backends without an explicit capability should keep the
		// dangerous VACUUM entry disabled rather than exposing a misleading action.
		vacuumSupported: vacuum?.supported === true,
		vacuumReason: vacuum?.reason,
		cleanup: {
			uploads: cleanupCapability("uploads"),
			shares: cleanupCapability("shares"),
			worktrees: cleanupCapability("worktrees"),
			containers: cleanupCapability("containers"),
		},
	};
}

export function useStorageCapability(): ReturnType<typeof getStorageCapability> {
	return getStorageCapability(useRuntimeCapabilities());
}

export function getStorageDatabasePreviewCapability(
	capabilities: RuntimeCapabilities | undefined,
): {
	supported: boolean;
} {
	const database = capabilities?.storage?.database;
	return {
		supported: database?.preview !== false,
	};
}

export function useStorageDatabasePreviewCapability(): ReturnType<
	typeof getStorageDatabasePreviewCapability
> {
	return getStorageDatabasePreviewCapability(useRuntimeCapabilities());
}

type StorageDatabaseCleanupCapability = {
	supported: boolean;
	reason?: string;
	code?: string;
	fallback?: boolean;
};

export function getStorageDatabaseCleanupCapabilities(
	capabilities: RuntimeCapabilities | undefined,
): Record<StorageDatabaseCleanupTarget, StorageDatabaseCleanupCapability> {
	const database = capabilities?.storage?.database;
	const targetCapability = (
		target: StorageDatabaseCleanupTarget,
	): StorageDatabaseCleanupCapability => {
		const capability = database?.cleanupTargets?.[target];
		return {
			supported: database?.cleanup !== false && capability?.supported !== false,
			reason: capability?.reason,
			code: capability?.code,
			fallback: capability?.fallback,
		};
	};
	return {
		archivedSessions: targetCapability("archivedSessions"),
		staleSessions: targetCapability("staleSessions"),
		apiRequestDumps: targetCapability("apiRequestDumps"),
	};
}

export function useStorageDatabaseCleanupCapabilities(): ReturnType<
	typeof getStorageDatabaseCleanupCapabilities
> {
	return getStorageDatabaseCleanupCapabilities(useRuntimeCapabilities());
}

type StorageCleanupOperationCapability = StorageCleanupRuntimeCapability & {
	route: "storage" | "runtime";
	runtimeTarget?: RuntimeCleanupTarget;
};

export function getStorageCleanupOperationCapabilities(
	capabilities: RuntimeCapabilities | undefined,
): Record<StorageCleanupTarget, StorageCleanupOperationCapability> {
	const storageCleanup = getStorageCapability(capabilities).cleanup;
	const runtimeCleanup = getRuntimeMaintenanceCapability(capabilities).cleanup;
	const storageRoute = (target: StorageCleanupTarget): StorageCleanupOperationCapability => ({
		...storageCleanup[target],
		route: "storage",
	});
	return {
		uploads: storageRoute("uploads"),
		shares: storageRoute("shares"),
		containers: storageRoute("containers"),
		worktrees:
			storageCleanup.worktrees.supported === false && runtimeCleanup.worktrees.supported
				? {
						...runtimeCleanup.worktrees,
						route: "runtime",
						runtimeTarget: "worktrees",
					}
				: storageRoute("worktrees"),
	};
}

export function useStorageCleanupOperationCapabilities(): ReturnType<
	typeof getStorageCleanupOperationCapabilities
> {
	return getStorageCleanupOperationCapabilities(useRuntimeCapabilities());
}
