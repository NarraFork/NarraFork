import { request } from "./client";

/**
 * Plugin management API client (admin surface).
 *
 * Mirrors the bounded/sanitized payloads produced by `server/routes/plugins.ts`.
 * The server already strips large fields (raw stderr, manifests, package blobs)
 * from list responses; keep these types aligned with that contract and never
 * request unbounded payloads here.
 */

export type PluginTrustTier = "T0" | "T1" | "T2" | "T3";

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
	trustTier?: PluginTrustTier;
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
	/** Legacy aliases accepted from older plugin backends. */
	entry?: string;
	style?: string;
	status?: "available" | "disabled";
}

export interface PluginUiHealth {
	metrics: Record<string, unknown>;
}

const pluginPath = (pluginId: string) => `/plugins/${encodeURIComponent(pluginId)}`;

export const pluginsApi = {
	list: () => request<PluginListResponse | PluginSummary[]>("/plugins"),
	get: (pluginId: string) => request<PluginDetail>(pluginPath(pluginId)),
	getDiagnostics: (pluginId: string) =>
		request<PluginDetail>(`${pluginPath(pluginId)}/diagnostics`),
	install: (path: string) =>
		request<PluginDetail>("/plugins/install", { method: "POST", body: JSON.stringify({ path }) }),
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
	listUiContributions: () => request<PluginUiContributionItem[]>("/plugins/ui/contributions"),
	getUiHealth: () => request<PluginUiHealth>("/plugins/ui/health"),
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
