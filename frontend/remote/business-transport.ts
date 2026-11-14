import type { BusinessTransport } from "@shared/remote-access/business-transport";
import { resolveRemoteRequestRule } from "@shared/remote-access/request-policy";
import { isRemoteSessionAuthenticated, remoteRuntime } from "./runtime";

/** No native HTTP/XHR/WS implementation is imported by this build target. */
export const businessTransport: BusinessTransport = {
	request(path, options) {
		assertAllowed(path, options?.method ?? "GET");
		return remoteRuntime().transport.request(requireBusinessPath(path), options);
	},
	upload(path, body, options) {
		assertAllowed(path, "POST");
		return remoteRuntime().transport.upload(requireBusinessPath(path), body, options);
	},
	openSocket(path, credential) {
		if (path !== "/ws/narrator") throw new Error("REMOTE_SOCKET_UNSUPPORTED");
		const params = new URLSearchParams(credential);
		const token = params.get("token");
		if (!token || params.size !== 1) throw new Error("REMOTE_SOCKET_CREDENTIAL_INVALID");
		return remoteRuntime().transport.openSocket(path, token);
	},
};
function assertAllowed(path: string, method: string): void {
	if (
		!resolveRemoteRequestRule(
			method.toUpperCase(),
			path,
			isRemoteSessionAuthenticated() ? "ready" : "paired",
		)
	) {
		throw new Error("REMOTE_REQUEST_UNSUPPORTED");
	}
}
export function requireBusinessPath(path: string): string {
	if (
		!path.startsWith("/api/") ||
		path.includes("\\") ||
		path.includes("#") ||
		/%(?:2f|5c|2e|00)/i.test(path) ||
		path
			.split("?")[0]
			?.split("/")
			.some((part) => part === "." || part === "..")
	) {
		throw new Error("REMOTE_BUSINESS_PATH_INVALID");
	}
	return path;
}
