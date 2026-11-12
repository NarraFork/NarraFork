import type {
	RemoteAccessGrant,
	RemoteAccessInvitation,
	RemoteAccessSettings,
	RemoteAccessStatus,
} from "@shared/remote-access/management";
import { request } from "./client";

/** Local administrator UI only; remote request policy must reject this whole namespace. */
export const remoteAccessApi = {
	status: (signal?: AbortSignal) =>
		request<RemoteAccessStatus>("/remote-access/status", { signal }),
	install: (signal?: AbortSignal) =>
		request<RemoteAccessStatus>("/remote-access/component/install", {
			method: "POST",
			body: "{}",
			signal,
		}),
	configure: (config: RemoteAccessSettings, signal?: AbortSignal) =>
		request<Record<string, unknown>>("/settings", {
			method: "PATCH",
			body: JSON.stringify({ remoteAccess: config }),
			signal,
		}),
	createInvitation: (signal?: AbortSignal) =>
		request<{ invitation: RemoteAccessInvitation }>("/remote-access/invitations", {
			method: "POST",
			body: "{}",
			signal,
		}),
	cancelInvitation: (id: string, signal?: AbortSignal) =>
		request<{ ok: true }>(`/remote-access/invitations/${encodeURIComponent(id)}`, {
			method: "DELETE",
			signal,
		}),
	grants: (signal?: AbortSignal) =>
		request<{ grants: RemoteAccessGrant[] }>("/remote-access/grants", { signal }),
	revokeGrant: (id: string, signal?: AbortSignal) =>
		request<{ ok: true }>(`/remote-access/grants/${encodeURIComponent(id)}`, {
			method: "DELETE",
			signal,
		}),
};
