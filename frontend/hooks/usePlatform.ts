import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

type Platform = "windows" | "macos" | "linux";

interface FeatureCapability {
	supported?: boolean;
	fallback?: boolean;
	code?: string;
	reason?: string;
	mode?: string;
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
}

export interface RuntimeCapabilities {
	database?: {
		mainSchemaOwner?: string;
		goMainMigrations?: boolean;
		goEnsureColumns?: boolean;
		ftsRepair?: boolean;
		mode?: string;
		reason?: string;
	};
	chapters?: {
		split?: FeatureCapability;
	};
	narrator?: {
		browserSessions?: FeatureCapability;
		rollbackEditRegenerate?: FeatureCapability;
	};
	mcp?: {
		serverSettingsStorage?: FeatureCapability & { storage?: string };
		externalToolsInjection?: FeatureCapability;
	};
	benchmark?: {
		containerExecution?: FeatureCapability;
	};
	content?: {
		projectRoutines?: FeatureCapability & { storage?: string };
		projectSkills?: FeatureCapability & { storage?: string };
	};
	fs?: {
		reveal?: FeatureCapability;
	};
	providers?: Partial<Record<ProviderCapabilityKey, ProviderRuntimeCapability>>;
	terminal?: {
		supported?: boolean;
		reason?: string;
	};
	vnet?: {
		supported?: boolean;
		reason?: string;
	};
	update?: {
		selfUpdateAvailable?: boolean;
		manualOnly?: boolean;
		canAutoRestart?: boolean;
	};
	gateway?: {
		persistentRuntimes?: boolean;
		mode?: string;
		reason?: string;
		webhook?: {
			supported?: boolean;
			fallback?: boolean;
		};
		weixinQr?: {
			supported?: boolean;
			fallback?: boolean;
			code?: string;
			reason?: string;
		};
	};
	storage?: {
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

export function useTerminalCapability(): { supported: boolean; reason?: string } {
	const capabilities = useRuntimeCapabilities();
	const terminal = capabilities?.terminal;
	return {
		supported: terminal?.supported !== false,
		reason: terminal?.reason,
	};
}

export function useUpdateCapability(): {
	selfUpdateAvailable: boolean;
	manualOnly: boolean;
	canAutoRestart: boolean;
} {
	const capabilities = useRuntimeCapabilities();
	const update = capabilities?.update;
	return {
		selfUpdateAvailable: update?.selfUpdateAvailable !== false,
		manualOnly: update?.manualOnly === true,
		canAutoRestart: update?.canAutoRestart !== false,
	};
}

export function useGatewayCapability(): {
	weixinQrSupported: boolean;
	weixinQrReason?: string;
	persistentRuntimes: boolean;
	reason?: string;
} {
	const capabilities = useRuntimeCapabilities();
	const gateway = capabilities?.gateway;
	return {
		weixinQrSupported: gateway?.weixinQr?.supported !== false,
		weixinQrReason: gateway?.weixinQr?.reason,
		persistentRuntimes: gateway?.persistentRuntimes !== false,
		reason: gateway?.reason,
	};
}

export function useChapterSplitCapability(): { supported: boolean; reason?: string } {
	const capabilities = useRuntimeCapabilities();
	const split = capabilities?.chapters?.split;
	return {
		supported: split?.supported !== false,
		reason: split?.reason,
	};
}

export function useVNetCapability(): { supported: boolean; reason?: string } {
	const capabilities = useRuntimeCapabilities();
	const vnet = capabilities?.vnet;
	return {
		supported: vnet?.supported !== false,
		reason: vnet?.reason,
	};
}

export function useMcpExternalToolsCapability(): { supported: boolean; reason?: string } {
	const capabilities = useRuntimeCapabilities();
	const externalTools = capabilities?.mcp?.externalToolsInjection;
	return {
		supported: externalTools?.supported !== false,
		reason: externalTools?.reason,
	};
}

export function useMcpServerSettingsStorageCapability(): { supported: boolean; reason?: string } {
	const capabilities = useRuntimeCapabilities();
	const storage = capabilities?.mcp?.serverSettingsStorage;
	return {
		supported: storage?.supported !== false,
		reason: storage?.reason,
	};
}

export function useFsRevealCapability(): { supported: boolean; reason?: string } {
	const capabilities = useRuntimeCapabilities();
	const reveal = capabilities?.fs?.reveal;
	return {
		supported: reveal?.supported !== false,
		reason: reveal?.reason,
	};
}

export function useProviderRuntimeCapability(
	provider: ProviderCapabilityKey,
): ProviderRuntimeCapability | undefined {
	const capabilities = useRuntimeCapabilities();
	return capabilities?.providers?.[provider];
}

export function useBenchmarkContainerExecutionCapability(): {
	supported: boolean;
	reason?: string;
} {
	const capabilities = useRuntimeCapabilities();
	const containerExecution = capabilities?.benchmark?.containerExecution;
	return {
		supported: containerExecution?.supported !== false,
		reason: containerExecution?.reason,
	};
}

export function useStorageCapability(): {
	vacuumSupported: boolean;
	vacuumReason?: string;
	cleanup: Record<
		"uploads" | "shares" | "worktrees" | "containers",
		{ supported: boolean; reason?: string }
	>;
} {
	const capabilities = useRuntimeCapabilities();
	const vacuum = capabilities?.storage?.vacuum;
	const cleanup = capabilities?.storage?.cleanup;
	return {
		// Safe default: TS/older backends without an explicit capability should keep the
		// dangerous VACUUM entry disabled rather than exposing a misleading action.
		vacuumSupported: vacuum?.supported === true,
		vacuumReason: vacuum?.reason,
		cleanup: {
			uploads: {
				supported: cleanup?.uploads?.supported !== false,
				reason: cleanup?.uploads?.reason,
			},
			shares: {
				supported: cleanup?.shares?.supported !== false,
				reason: cleanup?.shares?.reason,
			},
			worktrees: {
				supported: cleanup?.worktrees?.supported !== false,
				reason: cleanup?.worktrees?.reason,
			},
			containers: {
				supported: cleanup?.containers?.supported !== false,
				reason: cleanup?.containers?.reason,
			},
		},
	};
}
