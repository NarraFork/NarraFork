import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

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
	| "cline"
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
		batchMerge?: FeatureCapability & {
			routes?: {
				start?: boolean;
				session?: boolean;
			};
			response?: {
				mergeSessionId?: boolean;
				targetChapterId?: boolean;
				createdTarget?: boolean;
				status?: boolean;
			};
			events?: string[];
			decisionWs?: boolean;
			staleSessionCleanup?: boolean;
			createdTargetRollback?: boolean;
			frontendCompletionMode?: string;
		};
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
		delete?: FeatureCapability & {
			feature?: string;
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

export function useRuntimeEnvironment(): RuntimeEnvironmentInfo | undefined {
	const { data } = useHealthQuery();
	return data?.runtimeEnvironment;
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		browse: {
			supported: assumeLegacyTSBackend ? true : fs?.browse?.supported === true,
			reason: fs?.browse?.reason,
		},
		shortcuts: {
			supported: assumeLegacyTSBackend ? true : fs?.shortcuts?.supported === true,
			reason: fs?.shortcuts?.reason,
		},
		mkdir: {
			supported: assumeLegacyTSBackend ? true : fs?.mkdir?.supported === true,
			reason: fs?.mkdir?.reason,
		},
		preview: {
			supported: assumeLegacyTSBackend ? true : fs?.preview?.supported === true,
			reason: fs?.preview?.reason,
			maxTextBytes: fs?.preview?.maxTextBytes,
			maxBinaryBytes: fs?.preview?.maxBinaryBytes,
		},
		reveal: {
			supported: assumeLegacyTSBackend ? true : fs?.reveal?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : terminal?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	const manualOnly = update?.manualOnly === true;
	const selfUpdateAvailable = assumeLegacyTSBackend
		? true
		: update?.selfUpdateAvailable === true && !manualOnly;
	const canAutoRestart = assumeLegacyTSBackend
		? true
		: update?.canAutoRestart === true && !manualOnly;
	const downloadSupported = assumeLegacyTSBackend ? true : download?.supported === true;
	return {
		selfUpdateAvailable,
		manualOnly,
		canAutoRestart,
		download: {
			supported: downloadSupported,
			reason: download?.reason,
			sse: assumeLegacyTSBackend ? true : downloadSupported && download?.sse === true,
			sha512: assumeLegacyTSBackend ? true : downloadSupported && download?.sha512 === true,
			maxBytes: download?.maxBytes,
			trustMode: download?.trustMode,
		},
		apply: {
			supported: assumeLegacyTSBackend ? true : apply?.supported === true && !manualOnly,
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
	const assumeLegacyTSBackend = !capabilities;
	const persistentRuntimes = assumeLegacyTSBackend ? true : gateway?.persistentRuntimes === true;
	const supportedPlatforms = gateway?.supportedPlatforms;
	const unsupportedPlatforms = gateway?.unsupportedPlatforms;
	const webhookSupported = assumeLegacyTSBackend ? true : gateway?.webhook?.supported === true;
	const weixinQrSupported = assumeLegacyTSBackend ? true : gateway?.weixinQr?.supported === true;
	const webhookReason =
		gateway?.webhook?.reason ??
		gateway?.webhook?.message ??
		gateway?.webhook?.error ??
		gateway?.webhook?.code;
	const weixinQrReason =
		gateway?.weixinQr?.reason ??
		gateway?.weixinQr?.message ??
		gateway?.weixinQr?.error ??
		gateway?.weixinQr?.code;
	return {
		weixinQrSupported,
		weixinQrReason,
		webhookSupported,
		webhookReason,
		persistentRuntimes,
		supportedPlatforms,
		unsupportedPlatforms,
		isPlatformSupported: (platform) => {
			if (platform === "webhook" && !webhookSupported) return false;
			if (platform === "weixin" && !weixinQrSupported) return false;
			if (supportedPlatforms?.length) return supportedPlatforms.includes(platform);
			return persistentRuntimes || platform === "webhook";
		},
		platformUnsupportedReason: (platform) => {
			if (platform === "webhook") return unsupportedPlatforms?.[platform] ?? webhookReason;
			if (platform === "weixin") return unsupportedPlatforms?.[platform] ?? weixinQrReason;
			return unsupportedPlatforms?.[platform];
		},
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
} {
	const containers = capabilities?.chapters?.containers;
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : containers?.supported === true;
	const routeSupported = (route: ChapterContainerRoute) =>
		assumeLegacyTSBackend ? true : supported && containers?.routes?.[route] === true;
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
		ports: {
			legacyHostPortAllocation: containers?.ports?.legacyHostPortAllocation,
			portRelease: containers?.ports?.portRelease,
		},
		proxy: {
			metadataSupported: containers?.proxy?.metadataSupported,
			requiresPastaPasst: containers?.proxy?.requiresPastaPasst,
			overridePortsReset: containers?.proxy?.overridePortsReset,
			reverseProxyServer: containers?.proxy?.reverseProxyServer,
			http: containers?.proxy?.http,
			websocket: containers?.proxy?.websocket,
			dynamicSettingsHook: containers?.proxy?.dynamicSettingsHook,
		},
	};
}

export function getChapterBatchMergeCapability(capabilities: RuntimeCapabilities | undefined): {
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
} {
	const batchMerge = capabilities?.chapters?.batchMerge;
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : batchMerge?.supported === true;
	return {
		supported,
		reason: batchMerge?.reason,
		mode: batchMerge?.mode,
		startRouteSupported: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.routes?.start === true,
		sessionRouteSupported: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.routes?.session === true,
		mergeSessionIdResponse: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.response?.mergeSessionId === true,
		targetChapterIdResponse: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.response?.targetChapterId === true,
		createdTargetResponse: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.response?.createdTarget === true,
		statusResponse: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.response?.status === true,
		decisionWs: assumeLegacyTSBackend ? true : supported && batchMerge?.decisionWs === true,
		staleSessionCleanup: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.staleSessionCleanup === true,
		createdTargetRollback: assumeLegacyTSBackend
			? true
			: supported && batchMerge?.createdTargetRollback === true,
		frontendCompletionMode: batchMerge?.frontendCompletionMode,
		events: batchMerge?.events ?? [],
	};
}

export function useChapterBatchMergeCapability(): ReturnType<
	typeof getChapterBatchMergeCapability
> {
	return getChapterBatchMergeCapability(useRuntimeCapabilities());
}

export function getChapterSplitCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	mode?: string;
	compressedAISummarySupported: boolean;
	compressedAISummaryFallback: boolean;
	compressedAISummaryMode?: string;
	compressedAISummaryReason?: string;
} {
	const split = capabilities?.chapters?.split;
	const compressedAISummary = split?.partials?.compressedAISummary;
	return {
		supported: split?.supported === true && split.routes?.splitAtCommit === true,
		reason: split?.reason,
		mode: split?.mode,
		compressedAISummarySupported: compressedAISummary?.supported === true,
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
	const { data } = useHealthQuery();
	const environment = data?.runtimeEnvironment;
	if (environment && !environment.containerSupport) {
		const reason =
			environment.containerUnsupportedReason ??
			"Local container management is unavailable in this runtime.";
		return {
			supported: false,
			reason,
			routes: {
				setup: false,
				podmanStatus: false,
				podmanInstall: false,
				composeInfo: false,
				list: false,
				start: false,
				stop: false,
				pause: false,
				unpause: false,
				logs: false,
				remove: false,
			},
			runtime: {},
			ports: {},
			proxy: {},
		};
	}
	return getChapterContainersCapability(data?.capabilities);
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
	const narrator = capabilities?.narrator;
	const browserSessions = narrator?.browserSessions;
	const assumeLegacyTSBackend = !narrator;
	return {
		supported: assumeLegacyTSBackend ? true : browserSessions?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : planMode?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : compact?.supported === true,
		reason: compact?.reason,
		mode: compact?.mode,
		fallbackSummary: compact?.fallbackSummary,
		fallbackReason: compact?.fallbackReason,
	};
}

export function useNarratorCompactCapability(): ReturnType<typeof getNarratorCompactCapability> {
	return getNarratorCompactCapability(useRuntimeCapabilities());
}

export function getNarratorDeleteCapability(capabilities: RuntimeCapabilities | undefined): {
	supported: boolean;
	reason?: string;
	code?: string;
	feature?: string;
} {
	const narrator = capabilities?.narrator;
	const deleteCapability = narrator?.delete;
	const assumeLegacyTSBackend = !narrator;
	return {
		supported: assumeLegacyTSBackend ? true : deleteCapability?.supported === true,
		reason: deleteCapability?.reason,
		code: deleteCapability?.code,
		feature: deleteCapability?.feature,
	};
}

export function useNarratorDeleteCapability(): ReturnType<typeof getNarratorDeleteCapability> {
	return getNarratorDeleteCapability(useRuntimeCapabilities());
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
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : retryRecovery?.supported === true;
	return {
		supported,
		reason: retryRecovery?.reason,
		retry: assumeLegacyTSBackend
			? retryRecovery?.retry
			: supported && retryRecovery?.retry === true,
		continue: assumeLegacyTSBackend
			? retryRecovery?.continue
			: supported && retryRecovery?.continue === true,
		interrupt: assumeLegacyTSBackend
			? retryRecovery?.interrupt
			: supported && retryRecovery?.interrupt === true,
		manualOverride: assumeLegacyTSBackend
			? retryRecovery?.manualOverride
			: supported && retryRecovery?.manualOverride === true,
		rollback: assumeLegacyTSBackend
			? retryRecovery?.rollback
			: supported && retryRecovery?.rollback === true,
		editAndRegenerate: assumeLegacyTSBackend
			? retryRecovery?.editAndRegenerate
			: supported && retryRecovery?.editAndRegenerate === true,
	};
}

export function useNarratorRetryRecoveryCapability(): ReturnType<
	typeof getNarratorRetryRecoveryCapability
> {
	return getNarratorRetryRecoveryCapability(useRuntimeCapabilities());
}

export function getNarratorRollbackEditRegenerateCapability(
	capabilities: RuntimeCapabilities | undefined,
): {
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
} {
	const narrator = capabilities?.narrator;
	const capability = narrator?.rollbackEditRegenerate;
	const assumeLegacyTSBackend = !narrator;
	return {
		supported: assumeLegacyTSBackend ? true : capability?.supported === true,
		reason: capability?.reason,
		rollback: capability?.rollback,
		editAndRegenerate: capability?.editAndRegenerate,
		copyOnWrite: capability?.copyOnWrite,
		messageRefTruncation: capability?.messageRefTruncation,
		fileStateRebuild: capability?.fileStateRebuild,
		toolCallInvalidation: capability?.toolCallInvalidation,
		agentRerun: capability?.agentRerun,
		optionalFileRevert: capability?.optionalFileRevert,
		optionalAgentRerun: capability?.optionalAgentRerun,
		wsEvents: capability?.wsEvents,
	};
}

export function useNarratorRollbackEditRegenerateCapability(): ReturnType<
	typeof getNarratorRollbackEditRegenerateCapability
> {
	return getNarratorRollbackEditRegenerateCapability(useRuntimeCapabilities());
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
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : permissions?.supported === true;
	return {
		supported,
		reason: permissions?.reason,
		modes: Array.isArray(permissions?.modes)
			? permissions.modes
			: assumeLegacyTSBackend
				? DEFAULT_NARRATOR_PERMISSION_MODES
				: [],
		approveDeny: assumeLegacyTSBackend
			? permissions?.approveDeny !== false
			: supported && permissions?.approveDeny === true,
		updatedInput: assumeLegacyTSBackend
			? permissions?.updatedInput !== false
			: supported && permissions?.updatedInput === true,
		pauseResume: permissions?.pauseResume,
		reflections: Array.isArray(permissions?.reflections)
			? permissions.reflections
			: assumeLegacyTSBackend
				? DEFAULT_NARRATOR_PERMISSION_REFLECTIONS
				: [],
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
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : reviewTools?.supported === true;
	return {
		supported,
		reason: reviewTools?.reason,
		concludeReview: assumeLegacyTSBackend
			? reviewTools?.concludeReview !== false
			: supported && reviewTools?.concludeReview === true,
		feedbackInjection: assumeLegacyTSBackend
			? reviewTools?.feedbackInjection !== false
			: supported && reviewTools?.feedbackInjection === true,
		promote: assumeLegacyTSBackend
			? reviewTools?.promote !== false
			: supported && reviewTools?.promote === true,
		dismiss: assumeLegacyTSBackend
			? reviewTools?.dismiss !== false
			: supported && reviewTools?.dismiss === true,
		convertToSubagent: assumeLegacyTSBackend
			? reviewTools?.convertToSubagent !== false
			: supported && reviewTools?.convertToSubagent === true,
		staleMergeGuard: assumeLegacyTSBackend
			? reviewTools?.staleMergeGuard !== false
			: supported && reviewTools?.staleMergeGuard === true,
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
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : subagents?.supported === true;
	return {
		supported,
		reason: subagents?.reason,
		foreground: assumeLegacyTSBackend
			? subagents?.foreground !== false
			: supported && subagents?.foreground === true,
		background: assumeLegacyTSBackend
			? subagents?.background !== false
			: supported && subagents?.background === true,
		awaitAgent: assumeLegacyTSBackend
			? subagents?.awaitAgent !== false
			: supported && subagents?.awaitAgent === true,
		awaitBash: assumeLegacyTSBackend
			? subagents?.awaitBash !== false
			: supported && subagents?.awaitBash === true,
		awaitBashWaitForText: assumeLegacyTSBackend
			? subagents?.awaitBashWaitForText !== false
			: supported && subagents?.awaitBashWaitForText === true,
		awaitBashReason: subagents?.awaitBashReason,
		send: assumeLegacyTSBackend ? subagents?.send !== false : supported && subagents?.send === true,
		teamStatus: assumeLegacyTSBackend
			? subagents?.teamStatus !== false
			: supported && subagents?.teamStatus === true,
		detachAttach: assumeLegacyTSBackend
			? subagents?.detachAttach !== false
			: supported && subagents?.detachAttach === true,
		detachUnblocksParent: assumeLegacyTSBackend
			? subagents?.detachUnblocksParent !== false
			: supported && subagents?.detachUnblocksParent === true,
		reattachBlocksParent: assumeLegacyTSBackend
			? subagents?.reattachBlocksParent !== false
			: supported && subagents?.reattachBlocksParent === true,
		reattachFallback: subagents?.reattachFallback === true,
		reattachReason: subagents?.reattachReason,
		backgroundResultInjection: assumeLegacyTSBackend
			? subagents?.backgroundResultInjection !== false
			: supported && subagents?.backgroundResultInjection === true,
		staleRecovery: assumeLegacyTSBackend
			? subagents?.staleRecovery !== false
			: supported && subagents?.staleRecovery === true,
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
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : inventory?.supported === true;
	const webFetchSupported = assumeLegacyTSBackend
		? webFetch?.supported !== false
		: supported && webFetch?.supported === true;
	const browserSupported = assumeLegacyTSBackend
		? browser?.supported !== false
		: supported && browser?.supported === true;
	return {
		supported,
		supportedOptionalTools: inventory?.supportedOptionalTools ?? [],
		unsupportedOptionalTools: inventory?.unsupportedOptionalTools ?? [],
		reason: inventory?.reason,
		webFetch: {
			supported: webFetchSupported,
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
			supported: browserSupported,
			reason: browser?.reason,
			parity: browser?.parity,
			runtime: browser?.runtime,
			screenshotPreviewMode: browser?.screenshotPreviewMode,
			sharePreview: assumeLegacyTSBackend
				? browser?.sharePreview !== false
				: browserSupported && browser?.sharePreview === true,
			imageContentBlock: assumeLegacyTSBackend
				? browser?.imageContentBlock !== false
				: browserSupported && browser?.imageContentBlock === true,
			fileOutput: assumeLegacyTSBackend
				? browser?.fileOutput !== false
				: browserSupported && browser?.fileOutput === true,
			traceFormat: browser?.traceFormat,
			traceShare: assumeLegacyTSBackend
				? browser?.traceShare !== false
				: browserSupported && browser?.traceShare === true,
			traceFileOutput: assumeLegacyTSBackend
				? browser?.traceFileOutput !== false
				: browserSupported && browser?.traceFileOutput === true,
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
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend ? true : vnet?.supported === true;
	return {
		supported,
		reason: vnet?.reason,
		mode: vnet?.mode,
		ws: assumeLegacyTSBackend ? true : supported && vnet?.ws === true,
		peerCleanup: assumeLegacyTSBackend ? true : supported && vnet?.peerCleanup === true,
		udpRendezvous: supported && vnet?.udpRendezvous === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : builtinTools?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		builtinProtocol: {
			supported: assumeLegacyTSBackend ? true : mcp?.builtinProtocol?.supported === true,
			reason: mcp?.builtinProtocol?.reason,
			initialize: mcp?.builtinProtocol?.initialize,
			toolsList: mcp?.builtinProtocol?.toolsList,
			toolsCall: mcp?.builtinProtocol?.toolsCall,
		},
		toolsList: {
			supported: assumeLegacyTSBackend ? true : mcp?.toolsList?.supported === true,
			reason: mcp?.toolsList?.reason,
			source: mcp?.toolsList?.source,
		},
		toolsCall: {
			supported: assumeLegacyTSBackend ? true : mcp?.toolsCall?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : externalTools?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : externalAgent?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : storage?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : management?.supported === true,
		reason: management?.reason,
		storage: management?.storage,
		permissions: assumeLegacyTSBackend ? true : management?.permissions === true,
		import: assumeLegacyTSBackend ? true : management?.import === true,
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
	const mcp = capabilities?.mcp;
	const transports = mcp?.transports;
	const assumeLegacyTSBackend = !capabilities;
	return {
		stdio: {
			supported: assumeLegacyTSBackend ? true : transports?.stdio?.supported === true,
			reason: transports?.stdio?.reason,
		},
		sse: {
			supported: assumeLegacyTSBackend ? true : transports?.sse?.supported === true,
			reason: transports?.sse?.reason,
		},
		streamableHttp: {
			supported: assumeLegacyTSBackend ? true : transports?.streamableHttp?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		projectRoutines: {
			supported: assumeLegacyTSBackend ? true : content?.projectRoutines?.supported === true,
			reason: content?.projectRoutines?.reason,
			storage: content?.projectRoutines?.storage,
		},
		projectSkills: {
			supported: assumeLegacyTSBackend ? true : content?.projectSkills?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		serveNarratorImages: {
			supported: assumeLegacyTSBackend ? true : uploads?.serveNarratorImages?.supported === true,
			reason: uploads?.serveNarratorImages?.reason,
		},
		serveAvatars: {
			supported: assumeLegacyTSBackend ? true : uploads?.serveAvatars?.supported === true,
			reason: uploads?.serveAvatars?.reason,
		},
		cleanupPreservesMessageImageRefs: {
			supported: assumeLegacyTSBackend
				? true
				: uploads?.cleanupPreservesMessageImageRefs?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		createSupported: assumeLegacyTSBackend ? true : shares?.create?.supported === true,
		publicDownloadSupported: assumeLegacyTSBackend
			? true
			: shares?.publicDownload?.supported === true,
		previewSupported: assumeLegacyTSBackend ? true : shares?.preview?.supported === true,
		previewHtmlMode: shares?.preview?.htmlMode,
		previewReason: shares?.preview?.reason,
		ephemeralOnlySupported: assumeLegacyTSBackend
			? true
			: shares?.ephemeralOnly?.supported === true,
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
	const providerRuntime = getProviderRuntimeCapability(capabilities, provider);
	const routes = providerRuntime?.routes;
	const assumeLegacyTSBackend = !capabilities;
	const supported = assumeLegacyTSBackend
		? true
		: routes?.supported !== false && routes?.[route] === true;
	const routeReason = routes?.[`${route}Reason`];
	return {
		supported,
		reason: supported ? undefined : typeof routeReason === "string" ? routeReason : routes?.reason,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : models?.refreshSupported === true,
		reason: models?.reason,
	};
}

export function getProviderQuotaCapability(
	capabilities: RuntimeCapabilities | undefined,
	provider: ProviderCapabilityKey,
): { supported: boolean; reason?: string } {
	const quota = capabilities?.providers?.[provider]?.quota;
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : quota?.supported === true,
		reason: quota?.reason,
	};
}

export function getProviderAgentModeCapability(
	capabilities: RuntimeCapabilities | undefined,
	provider: ProviderCapabilityKey,
): { supported: boolean; reason?: string } {
	const agentMode = capabilities?.providers?.[provider]?.agentMode;
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : agentMode?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	return {
		storageSupported: assumeLegacyTSBackend ? true : settings?.storage?.supported === true,
		storagePath: settings?.storage?.path,
		patchSupported: assumeLegacyTSBackend ? true : settings?.patch?.supported === true,
		secretMasking: assumeLegacyTSBackend ? true : settings?.secretMasking === true,
		providerModelAugmentation: assumeLegacyTSBackend
			? true
			: settings?.providerModelAugmentation === true,
		tlsGeneration: assumeLegacyTSBackend ? true : settings?.tlsGeneration === true,
		retryRules: assumeLegacyTSBackend ? true : settings?.retryRules === true,
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
	const benchmark = capabilities?.benchmark;
	const containerExecution = benchmark?.containerExecution;
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : containerExecution?.supported === true,
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
	const assumeLegacyTSBackend = !capabilities;
	const cleanupCapability = (target: RuntimeCleanupTarget): RuntimeCleanupCapability => ({
		supported: assumeLegacyTSBackend ? true : cleanup?.[target]?.supported === true,
		reason: cleanup?.[target]?.reason,
		mode: cleanup?.[target]?.mode,
	});
	return {
		backend: runtime?.backend,
		buildChannel: runtime?.buildChannel,
		scanSupported: assumeLegacyTSBackend ? true : runtime?.scan?.supported === true,
		scanReason: runtime?.scan?.reason,
		cachedSupported: assumeLegacyTSBackend ? true : runtime?.cached?.supported === true,
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

export type StorageHealthQueryStatus = "loading" | "error" | "success";
export type StorageCapabilityHealthState = "loading" | "error" | "legacy" | "capabilities";

export type StorageCapability = {
	scanSupported: boolean;
	scanReason?: string;
	cachedSupported: boolean;
	cachedReason?: string;
	vacuumSupported: boolean;
	vacuumReason?: string;
	cleanup: Record<StorageCleanupTarget, StorageCleanupRuntimeCapability>;
};

export function getStorageCapability(
	capabilities: RuntimeCapabilities | undefined,
): StorageCapability {
	const storage = capabilities?.storage;
	const scan = storage?.scan;
	const cached = storage?.cached;
	const vacuum = storage?.vacuum;
	const cleanup = storage?.cleanup;
	const assumeLegacyTSBackend = !capabilities;
	const cleanupCapability = (target: StorageCleanupTarget): StorageCleanupRuntimeCapability => ({
		supported: assumeLegacyTSBackend ? true : cleanup?.[target]?.supported === true,
		reason: cleanup?.[target]?.reason,
		mode: cleanup?.[target]?.mode,
		alternative: cleanup?.[target]?.alternative,
		preservesMessageImageRefs: cleanup?.[target]?.preservesMessageImageRefs,
	});
	return {
		scanSupported: assumeLegacyTSBackend ? true : scan?.supported === true,
		scanReason: scan?.reason,
		cachedSupported: assumeLegacyTSBackend ? true : cached?.supported === true,
		cachedReason: cached?.reason,
		// VACUUM is an intentional, service-pausing maintenance window rather than an
		// ordinary request-path CRUD operation. The route is requireAdmin-protected and
		// the UI requires explicit confirmation, so keep it visible for the legacy TS
		// backend whose health payload has no capability metadata. Other backends must
		// explicitly advertise support and fail closed when they do not.
		vacuumSupported: assumeLegacyTSBackend ? true : vacuum?.supported === true,
		vacuumReason: vacuum?.reason,
		cleanup: {
			uploads: cleanupCapability("uploads"),
			shares: cleanupCapability("shares"),
			worktrees: cleanupCapability("worktrees"),
			containers: cleanupCapability("containers"),
		},
	};
}

/**
 * Resolve storage capabilities only after the health request has succeeded.
 * An absent capability payload is the legacy TypeScript backend; an absent payload
 * during loading/error is unknown and must not enable destructive or expensive actions.
 */
export function getStorageCapabilityForHealth(health: {
	status: StorageHealthQueryStatus;
	capabilities?: RuntimeCapabilities;
}): StorageCapability & {
	healthState: StorageCapabilityHealthState;
	healthReady: boolean;
} {
	const healthState: StorageCapabilityHealthState =
		health.status === "loading"
			? "loading"
			: health.status === "error"
				? "error"
				: health.capabilities
					? "capabilities"
					: "legacy";
	const capability =
		health.status === "success"
			? getStorageCapability(health.capabilities)
			: getStorageCapability({ storage: {} });
	return {
		...capability,
		healthState,
		healthReady: health.status === "success",
	};
}

export function useStorageCapability(): StorageCapability & {
	healthState: StorageCapabilityHealthState;
	healthReady: boolean;
	healthError: Error | null;
	healthFetching: boolean;
	refetchHealth: () => Promise<unknown>;
} {
	const health = useHealthQuery();
	const status: StorageHealthQueryStatus = health.isError
		? "error"
		: health.status === "pending"
			? "loading"
			: "success";
	return {
		...getStorageCapabilityForHealth({
			status,
			capabilities: health.data?.capabilities,
		}),
		healthError: health.error,
		healthFetching: health.isFetching,
		refetchHealth: health.refetch,
	};
}

export function getStorageDatabasePreviewCapability(
	capabilities: RuntimeCapabilities | undefined,
): {
	supported: boolean;
} {
	const database = capabilities?.storage?.database;
	const assumeLegacyTSBackend = !capabilities;
	return {
		supported: assumeLegacyTSBackend ? true : database?.preview === true,
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
	const assumeLegacyTSBackend = !capabilities;
	const targetCapability = (
		target: StorageDatabaseCleanupTarget,
	): StorageDatabaseCleanupCapability => {
		const capability = database?.cleanupTargets?.[target];
		const cleanupSupported = assumeLegacyTSBackend
			? database?.cleanup !== false && capability?.supported !== false
			: database?.cleanup === true && capability?.supported === true;
		return {
			supported: cleanupSupported,
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
