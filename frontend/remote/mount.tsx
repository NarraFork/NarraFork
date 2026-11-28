import "@frontend/lib/legacy-browser-polyfills";
import { clearCurrentUserCache } from "@frontend/lib/current-user-cache";
import type { RemoteFrontendMountOptions } from "@shared/remote-access/business-transport";
import { authenticateRemoteSession, clearRemoteRuntime, initializeRemoteRuntime } from "./runtime";

/** This module has no eager business imports: transport precedes all query modules. */
export async function mount(options: RemoteFrontendMountOptions): Promise<() => void> {
	initializeRemoteRuntime(options);
	try {
		const token = localStorage.getItem("narrafork_token");
		if (token) {
			try {
				await authenticateRemoteSession(token);
			} catch {
				localStorage.removeItem("narrafork_token");
				clearCurrentUserCache();
			}
		}
		const { mountApplication } = await import("./application");
		const dispose = await mountApplication(options.root);
		return () => {
			dispose();
			clearRemoteRuntime();
		};
	} catch (error) {
		clearRemoteRuntime();
		throw error;
	}
}
