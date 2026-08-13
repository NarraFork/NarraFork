import type { PluginViewSurface } from "../../components/plugins/types";
import {
	ApiError,
	absorbRenewedToken,
	BASE,
	getToken,
	postFormDataWithProgress,
	readFetchError,
	request,
} from "./client";

/**
 * Plugin management API client (admin surface).
 *
 * Mirrors the bounded/sanitized payloads produced by `server/routes/plugins.ts`.
 * The server already strips large fields (raw stderr, manifests, package blobs)
 * from list responses; keep these types aligned with that contract and never
 * request unbounded payloads here.
 */

export type PluginDesiredState = "disabled" | "enabled" | "uninstalling";

export type PluginRuntimeState =
	| "inactive"
	| "starting"
	| "handshaking"
	| "activating"
	| "active"
	| "degraded"
	| "draining"
	| "deactivating"
	| "stopped"
	| "crashed"
	| "backoff"
	| "failed"
	| "quarantine";

export type PluginCompatibilityState = "unknown" | "compatible" | "incompatible";

export interface PluginDiagnostic {
	code: string;
	message: string;
	phase?: string;
}

export interface PluginContributionSummary {
	id?: string;
	fullId?: string;
	kind?: string;
	title?: string;
	/** Surfaces a view contribution may mount on; absent for other kinds. */
	surfaces?: PluginViewSurface[];
	topic?: string;
	entryPath?: string;
	stylePath?: string;
	/** Legacy aliases retained while older list consumers migrate. */
	entry?: string;
	style?: string;
	execution?: "server" | "ui";
	allowBackground?: boolean;
	hasSchema?: boolean;
}

export interface PluginPackageRef {
	version?: string;
	hash?: string;
}

export interface PluginGrantSummary {
	count?: number;
	capabilities?: string[];
	revision?: number;
	updatedAt?: string;
}

export interface PluginRuntimeDiagnostics {
	runtimeId?: string;
	generation?: number;
	inFlight?: number;
	lateMessages?: number;
	startedAt?: string;
	stoppedAt?: string;
	stderrSummary?: string;
}

/**
 * Bounded list item returned by `GET /api/plugins`.
 * Contains sanitized summaries only — no manifests, no raw stderr.
 */
export interface PluginSummary {
	pluginId: string;
	displayName?: string;
	description?: string;
	version?: string;
	hash?: string;
	status?: string;
	desiredState?: PluginDesiredState;
	runtimeState?: PluginRuntimeState;
	compatibility?: PluginCompatibilityState;
	packageCount?: number;
	diagnosticCount?: number;
	diagnostics?: PluginDiagnostic[];
	contributions?: PluginContributionSummary[];
	crashCount?: number;
	restartCount?: number;
	consecutiveFailures?: number;
	lastError?: PluginDiagnostic;
}

export interface PluginListResponse {
	generatedAt?: string;
	plugins: PluginSummary[];
	diagnostics?: PluginDiagnostic[];
}

/** Full sanitized detail returned by `GET /api/plugins/:pluginId`. */
export interface PluginDetail extends PluginSummary {
	isCurrent?: boolean;
	current?: PluginPackageRef | null;
	grants?: PluginGrantSummary;
	packages?: Array<PluginPackageRef & { status?: string; isCurrent?: boolean }>;
	runtime?: PluginRuntimeDiagnostics;
	generatedAt?: string;
}

export interface PluginStatusEnvelope extends PluginDetail {
	result?: unknown;
}

export interface PluginUiContributionItem {
	pluginId: string;
	contributionId: string;
	version: string;
	hash: string;
	title: string;
	entryPath?: string;
	stylePath?: string;
	scope?: "workspace" | "narrator" | "project" | "global";
	/** Surfaces this view may mount on. Absent means the server did not report any. */
	surfaces?: PluginViewSurface[];
	/** Legacy aliases accepted from older plugin backends. */
	entry?: string;
	style?: string;
	status?: "available" | "disabled";
}

export interface PluginUiHealth {
	metrics: Record<string, unknown>;
}

/**
 * A plugin-contributed theme returned by `GET /api/plugins/ui/themes`.
 *
 * `css` is the compiled, sanitized CSS the server built from whitelisted design
 * tokens; the host injects it into the document under a scoped
 * `[data-plugin-theme]` selector. Plugins never supply raw CSS, so this string
 * only ever contains Mantine CSS-variable overrides.
 */
export interface PluginThemeItem {
	pluginId: string;
	version: string;
	hash: string;
	themeId: string;
	title: string;
	colorScheme: "light" | "dark" | "both";
	css: string;
}

/** An available theme with the current user's per-user enabled flag. */
export interface PluginAvailableThemeItem extends PluginThemeItem {
	enabled: boolean;
}

const pluginPath = (pluginId: string) => `/plugins/${encodeURIComponent(pluginId)}`;

/** One provider's config as the admin API reports it. Secrets appear as a placeholder. */
export interface PluginProviderConfigView {
	providerInstanceId: string;
	providerTypeId: string;
	pluginId: string;
	contributionId: string;
	providerPrefix: string;
	displayName: string;
	/** JSON Schema, or a boolean for accept-all / reject-all. */
	configSchema: Record<string, unknown> | boolean | null;
	config: Record<string, unknown>;
	secretFields: string[];
	secretsSet: string[];
}

export interface PluginProviderConfigListResponse {
	pluginId: string;
	providers: PluginProviderConfigView[];
}

export interface PluginProviderConfigUpdateResponse {
	pluginId: string;
	provider: PluginProviderConfigView | null;
}

export const pluginsApi = {
	list: () => request<PluginListResponse | PluginSummary[]>("/plugins"),
	get: (pluginId: string) => request<PluginDetail>(pluginPath(pluginId)),
	getDiagnostics: (pluginId: string) =>
		request<PluginDetail>(`${pluginPath(pluginId)}/diagnostics`),
	install: (path: string) =>
		request<PluginDetail>("/plugins/install", { method: "POST", body: JSON.stringify({ path }) }),
	/**
	 * Install a plugin by uploading the package bytes (multipart). Uses an
	 * XHR-backed upload so the UI can show real progress. The server installs
	 * from the bytes directly (no intermediate on-disk copy) and enforces the
	 * same tier gate as the path-based install.
	 */
	installUpload: async (
		file: File,
		options?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
	): Promise<PluginDetail> => {
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		const formData = new FormData();
		formData.append("archive", file);
		const res = await postFormDataWithProgress(`${BASE}/plugins/install`, formData, {
			headers,
			onProgress: options?.onProgress,
			signal: options?.signal,
		});
		// XHR upload cannot go through authorizedFetch, so absorb explicitly.
		absorbRenewedToken(res, token);
		if (!res.ok) {
			const { message, data } = await readFetchError(res, `Upload failed (${res.status})`);
			throw new ApiError(message, res.status, data);
		}
		return (await res.json()) as PluginDetail;
	},
	enable: (pluginId: string) =>
		request<PluginStatusEnvelope>(`${pluginPath(pluginId)}/enable`, { method: "POST" }),
	disable: (pluginId: string) =>
		request<PluginStatusEnvelope>(`${pluginPath(pluginId)}/disable`, { method: "POST" }),
	activate: (pluginId: string) =>
		request<PluginStatusEnvelope>(`${pluginPath(pluginId)}/activate`, { method: "POST" }),
	retry: (pluginId: string) =>
		request<PluginStatusEnvelope>(`${pluginPath(pluginId)}/retry`, { method: "POST" }),
	uninstall: (pluginId: string) =>
		request<PluginStatusEnvelope>(`${pluginPath(pluginId)}/uninstall`, { method: "POST" }),
	/** Installable package files already present under the server import roots. */
	listInstallSources: () =>
		request<Array<{ name: string; path: string; size: number }>>("/plugins/install/sources"),
	listUiContributions: () => request<PluginUiContributionItem[]>("/plugins/ui/contributions"),
	/** Compiled CSS for themes the current user has enabled. */
	listThemes: () => request<PluginThemeItem[]>("/plugins/ui/themes"),
	/** All available theme-only themes with the current user's enabled flag. */
	listAvailableThemes: () => request<PluginAvailableThemeItem[]>("/plugins/ui/themes/available"),
	/** Enable or disable a theme for the current user. */
	setThemeEnabled: (pluginId: string, themeId: string, enabled: boolean) =>
		request<{ pluginId: string; themeId: string; enabled: boolean }>(
			`/plugins/ui/themes/${encodeURIComponent(pluginId)}/${encodeURIComponent(themeId)}`,
			{ method: "PUT", body: JSON.stringify({ enabled }) },
		),
	getUiHealth: () => request<PluginUiHealth>("/plugins/ui/health"),
	/** Provider config for a plugin. Admin-only; secret values are never returned. */
	listProviderConfig: (pluginId: string) =>
		request<PluginProviderConfigListResponse>(`${pluginPath(pluginId)}/providers/config`),
	updateProviderConfig: (
		pluginId: string,
		providerInstanceId: string,
		config: Record<string, unknown>,
	) =>
		request<PluginProviderConfigUpdateResponse>(`${pluginPath(pluginId)}/providers/config`, {
			method: "PUT",
			body: JSON.stringify({ providerInstanceId, config }),
		}),
	updateProviderPrefix: (pluginId: string, providerInstanceId: string, providerPrefix: string) =>
		request<PluginProviderConfigUpdateResponse>(`${pluginPath(pluginId)}/providers/prefix`, {
			method: "PUT",
			body: JSON.stringify({ providerInstanceId, providerPrefix }),
		}),
};

/** Normalize the list payload (server may return a bare array or an envelope). */
export function normalizePluginList(
	payload: PluginListResponse | PluginSummary[],
): PluginSummary[] {
	return Array.isArray(payload) ? payload : (payload.plugins ?? []);
}

/** Error codes surfaced by the plugin management API that have localized UI. */
export const PLUGIN_API_ERROR_CODES = [
	"PLUGINS_DISABLED",
	"PLUGIN_OPERATION_FAILED",
	"PLUGIN_NOT_FOUND",
	"PLUGIN_RETRY_REQUIRES_RESTART",
	"NOT_FOUND",
	"VALIDATION_ERROR",
] as const;

export type PluginApiErrorCode = (typeof PLUGIN_API_ERROR_CODES)[number];
