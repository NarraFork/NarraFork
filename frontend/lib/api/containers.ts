import { request } from "./client";

/** Host-level container tooling: detection and installation. Nothing here is per-session. */
export const containersApi = {
	getContainerSetup: (refresh?: boolean) =>
		request<{
			podman: { ok: boolean; version?: string };
			podmanCompose: { ok: boolean; version?: string };
			composeProvider: { ok: boolean; provider?: string };
			passt: { ok: boolean; version?: string };
			rootlessNetwork: { ok: boolean; backend?: string };
			allReady: boolean;
			supported?: boolean;
			fallback?: boolean;
			reason?: string;
			error?: string;
			message?: string;
			code?: string;
		}>(`/containers/setup${refresh ? "?refresh=true" : ""}`),
	getPodmanStatus: () =>
		request<{
			installed: boolean;
			version?: string;
			platform: string;
			supported: boolean;
			fallback?: boolean;
			reason?: string;
			error?: string;
			message?: string;
			code?: string;
		}>("/containers/podman/status"),
	installPodman: () =>
		request<{ ok: boolean; installed?: boolean; version?: string; code?: string; error?: string }>(
			"/containers/podman/install",
			{ method: "POST" },
		),
};
