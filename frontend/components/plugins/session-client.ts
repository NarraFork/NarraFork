import { z } from "zod";
import { BASE, request } from "../../lib/api/client";
import type { JsonValue, PluginDockPanelParams, UiRpcRequest } from "./protocol";
import { uiRpcResponseSchema } from "./protocol";
import type { PluginUiContribution } from "./types";

const hashPattern = /^[a-f0-9]{64}$/;
const sessionCreateResponseSchema = z.object({
	session: z.object({
		sessionId: z.string().min(1).max(256),
		connectNonce: z.string().min(20).max(128),
	}),
	sessionToken: z.string().min(20).max(512),
});

export type PluginUiApiRequest = <T>(
	path: string,
	options?: RequestInit & { signal?: AbortSignal },
) => Promise<T>;

export interface MaterializedPluginUiSession {
	backendSessionId: string;
	sessionToken: string;
	nonce: string;
	contribution: PluginUiContribution;
}

function surfaceScope(params: PluginDockPanelParams): "workspace" | "narrator" | "global" {
	switch (params.binding.kind) {
		case "focus-current-narrator":
			return "narrator";
		case "workspace":
			return "workspace";
		case "workspace-narrator":
			return "narrator";
		case "global":
			return "global";
	}
}

function surface(params: PluginDockPanelParams): "workspace" | "director" | "focus" | "settings" {
	switch (params.binding.kind) {
		case "focus-current-narrator":
			return "focus";
		case "workspace":
		case "workspace-narrator":
			return "workspace";
		case "global":
			return "settings";
	}
}

function invocationScope(params: PluginDockPanelParams): Record<string, string> {
	switch (params.binding.kind) {
		case "workspace":
			return { workspaceId: params.binding.workspaceId };
		case "workspace-narrator":
			return {
				workspaceId: params.binding.workspaceId,
				narratorId: params.binding.ownerNarratorId,
			};
		case "focus-current-narrator":
		case "global":
			return {};
	}
}

function validateAssetPath(value: string | undefined, label: string): string {
	const path = value?.trim();
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`Plugin UI ${label} path is unavailable`);
	}
	return path;
}

function encodeAssetPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function assetUrl(
	params: PluginDockPanelParams,
	contribution: PluginUiContribution,
	hash: string,
	sessionId: string,
	sessionToken: string,
	path: string,
): string {
	return `${BASE}/plugins/ui/${encodeURIComponent(params.pluginId)}/${encodeURIComponent(contribution.version)}/${hash}/asset/${encodeURIComponent(sessionId)}/${encodeAssetPath(path)}?sessionToken=${encodeURIComponent(sessionToken)}`;
}

export async function createPluginUiBackendSession(
	params: PluginDockPanelParams,
	contribution: PluginUiContribution,
	signal?: AbortSignal,
	apiRequest: PluginUiApiRequest = request,
): Promise<MaterializedPluginUiSession> {
	if (
		params.pluginId !== contribution.pluginId ||
		params.contributionId !== contribution.contributionId
	) {
		throw new Error("Plugin UI contribution identity mismatch");
	}
	const hash = contribution.packageHash ?? contribution.contentHash;
	if (!hash || !hashPattern.test(hash)) throw new Error("Plugin UI package hash is unavailable");
	const entryPath = validateAssetPath(contribution.entryPath, "entry");
	const stylePath = contribution.stylePath
		? validateAssetPath(contribution.stylePath, "style")
		: undefined;
	const raw = await apiRequest<unknown>("/plugins/ui/sessions", {
		method: "POST",
		body: JSON.stringify({
			pluginId: params.pluginId,
			version: contribution.version,
			hash,
			contributionId: params.contributionId,
			panelInstanceId: params.panelInstanceId,
			surface: surface(params),
			surfaceScope: surfaceScope(params),
			scope: invocationScope(params),
		}),
		signal,
	});
	const parsed = sessionCreateResponseSchema.safeParse(raw);
	if (!parsed.success) throw new Error("Plugin UI session response is invalid");
	const { session, sessionToken } = parsed.data;
	return {
		backendSessionId: session.sessionId,
		sessionToken,
		nonce: session.connectNonce,
		contribution: {
			...contribution,
			entryUrl: assetUrl(params, contribution, hash, session.sessionId, sessionToken, entryPath),
			...(stylePath
				? {
						styleUrl: assetUrl(
							params,
							contribution,
							hash,
							session.sessionId,
							sessionToken,
							stylePath,
						),
					}
				: { styleUrl: undefined }),
			status: "available",
			unavailableReason: undefined,
		},
	};
}

export interface PluginUiBackendRequestInput {
	sessionId: string;
	sessionToken: string;
	request: UiRpcRequest;
	signal?: AbortSignal;
}

export async function requestPluginUiBackend(
	input: PluginUiBackendRequestInput,
	apiRequest: PluginUiApiRequest = request,
): Promise<JsonValue> {
	const raw = await apiRequest<unknown>(
		`/plugins/ui/sessions/${encodeURIComponent(input.sessionId)}/request`,
		{
			method: "POST",
			headers: { "X-NarraFork-Plugin-Session": input.sessionToken },
			body: JSON.stringify(input.request),
			signal: input.signal,
		},
	);
	const parsed = uiRpcResponseSchema.safeParse(raw);
	if (!parsed.success)
		throw Object.assign(new Error("Plugin UI host response is invalid"), {
			code: "INTERNAL_ERROR",
		});
	if ("error" in parsed.data)
		throw Object.assign(new Error(parsed.data.error.message), parsed.data.error);
	return parsed.data.result;
}

export async function revokePluginUiBackendSession(
	sessionId: string,
	apiRequest: PluginUiApiRequest = request,
): Promise<void> {
	await apiRequest(`/plugins/ui/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}
