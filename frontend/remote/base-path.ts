import { remoteRuntime } from "./runtime";

/** Router and peer business paths do not inherit the immutable static asset directory. */
export function getAppBase(): string {
	return "/";
}
export function getRouterBasepath(): string {
	return "";
}
export function getAssetBase(): string {
	return remoteRuntime().assetBase;
}
export function apiUrl(path = ""): string {
	const suffix = path.replace(/^\/+/, "").replace(/^api(?=\/|\?|$)\/?/, "");
	return `/api${suffix ? (suffix.startsWith("?") ? "" : "/") + suffix : ""}`;
}
export function assetUrl(path: string): string {
	const clean = path.replace(/^\/+/, "");
	if (clean.split("/").some((part) => part === ".." || part === ".") || /[\\?#]/.test(clean))
		throw new Error("REMOTE_STATIC_PATH_INVALID");
	return new URL(clean, remoteRuntime().assetBase).href;
}
export function stripBase(path: string): string {
	return path.replace(/^\/+/, "");
}
export function isApiUrl(path: string): boolean {
	return path.startsWith("/api/");
}
export function resolveServerUrl(path: string): string {
	return path;
}
export function resetAppBaseForTest(): void {}
