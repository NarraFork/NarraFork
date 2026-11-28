import type {
	ProviderSettingsContribution,
	ProviderSettingsTargetKind,
} from "@shared/provider-settings";
import type {
	ProviderSettingsConfigView,
	ProviderSettingsSave,
	ProviderSettingsValues,
} from "@shared/provider-settings-values";
import { request } from "./client";

export interface ProviderSettingsTarget {
	kind: ProviderSettingsTargetKind;
	id: string;
}

/** Public projections omit declarations, targets and secret metadata. */
export interface ProviderSettingsExtensionView {
	pluginId: string;
	contributionId: string;
	title?: string;
	declaration?: ProviderSettingsContribution;
	target?: {
		kind: ProviderSettingsTargetKind;
		id: string;
		name: string;
		disabled: boolean;
		available: boolean;
	};
	pluginState?: "disabled" | "enabled" | "uninstalling";
	compatible?: boolean;
	config?:
		| ProviderSettingsConfigView
		| {
				revision: number;
				status: ProviderSettingsConfigView["status"];
				values: ProviderSettingsValues;
		  };
	unavailable?: boolean;
}

export interface ProviderSettingsListResponse {
	extensions: ProviderSettingsExtensionView[];
}

export interface ProviderSettingsActionResponse {
	text: string;
}

export interface ProviderSettingsRebindInput {
	expectedRevision: number;
	schemaFingerprint: string;
	expectedBindingRevision: string;
	source?: { targetId: string; expectedRevision: number };
}

const MAX_RESPONSE_BYTES = 256 * 1024;

function targetQuery(target: ProviderSettingsTarget): string {
	return `kind=${encodeURIComponent(target.kind)}&id=${encodeURIComponent(target.id)}`;
}

function contributionPath(pluginId: string, contributionId: string, suffix = ""): string {
	return `/provider-settings/${encodeURIComponent(pluginId)}/${encodeURIComponent(contributionId)}${suffix}`;
}

export const providerSettingsApi = {
	list: (target: ProviderSettingsTarget, options?: { signal?: AbortSignal }) =>
		request<ProviderSettingsListResponse>(`/provider-settings?${targetQuery(target)}`, {
			signal: options?.signal,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		}),
	save: (
		target: ProviderSettingsTarget,
		pluginId: string,
		contributionId: string,
		input: ProviderSettingsSave,
	) =>
		request<ProviderSettingsConfigView>(
			`${contributionPath(pluginId, contributionId)}?${targetQuery(target)}`,
			{ method: "PUT", body: JSON.stringify(input), maxResponseBytes: MAX_RESPONSE_BYTES },
		),
	remove: (
		target: ProviderSettingsTarget,
		pluginId: string,
		contributionId: string,
		expectedRevision: number,
	) =>
		request<{ ok: true }>(`${contributionPath(pluginId, contributionId)}?${targetQuery(target)}`, {
			method: "DELETE",
			body: JSON.stringify({ expectedRevision }),
			maxResponseBytes: 4 * 1024,
		}),
	action: (target: ProviderSettingsTarget, pluginId: string, contributionId: string) =>
		request<ProviderSettingsActionResponse>(
			`${contributionPath(pluginId, contributionId, "/action")}?${targetQuery(target)}`,
			{ method: "POST", body: "{}", maxResponseBytes: 64 * 1024 },
		),
	retained: (
		target: ProviderSettingsTarget,
		pluginId: string,
		contributionId: string,
		cursor?: string,
	) =>
		request<{
			items: Array<{ targetId: string; revision: number; updatedAt: string }>;
			nextCursor: string | null;
		}>(
			`${contributionPath(pluginId, contributionId, "/retained")}?${targetQuery(target)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			{ maxResponseBytes: 32 * 1024 },
		),
	rebind: (
		target: ProviderSettingsTarget,
		pluginId: string,
		contributionId: string,
		input: ProviderSettingsRebindInput,
	) =>
		request<ProviderSettingsConfigView>(
			`${contributionPath(pluginId, contributionId, "/rebind")}?${targetQuery(target)}`,
			{ method: "POST", body: JSON.stringify(input), maxResponseBytes: MAX_RESPONSE_BYTES },
		),
};

export const providerSettingsKeys = {
	list: (target: ProviderSettingsTarget) => ["provider-settings", target.kind, target.id] as const,
};
