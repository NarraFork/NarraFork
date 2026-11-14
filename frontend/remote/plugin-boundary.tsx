import { RemoteUnsupported } from "@frontend/components/narrator/RemoteUnsupported";
import type { ReactNode } from "react";

/** Build-only replacements. No plugin registry/cache/iframe/runtime is imported. */
export function PluginContributionPicker() {
	return null;
}
export function PluginContributionOptions() {
	return null;
}
export function usePluginUiSurface() {
	return null;
}
export function PluginUiSurfaceProvider({ children }: { children: ReactNode }) {
	return children;
}
export function resolvePluginUiOwnerNarratorId() {
	return undefined;
}
export function resolveCanonicalPluginUiSessionContext() {
	return undefined;
}
export function buildPluginDockPanelParams(): never {
	throw new Error("REMOTE_PLUGIN_UNSUPPORTED");
}
export function buildPluginDockPanelOpenRequest(): never {
	throw new Error("REMOTE_PLUGIN_UNSUPPORTED");
}
export function nextPluginPanelInstanceId(): never {
	throw new Error("REMOTE_PLUGIN_UNSUPPORTED");
}
export const GenUICard = RemoteUnsupported;
export const NarratorProjectSettingsModal = RemoteUnsupported;
export const OutlinePlanDiffModal = RemoteUnsupported;
export const MonacoEditor = RemoteUnsupported;
export const SaveDumpModal = RemoteUnsupported;
export const OpenInOutline = RemoteUnsupported;
export const OutlineDigestInbox = RemoteUnsupported;
export const DirectoryPicker = RemoteUnsupported;
export const DirectoryBrowserModal = RemoteUnsupported;
export const DirectoryBrowser = RemoteUnsupported;
export function loadMonaco(): Promise<never> {
	return Promise.reject(new Error("REMOTE_EDITOR_UNSUPPORTED"));
}
