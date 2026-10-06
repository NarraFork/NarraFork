import type { InstallScriptInput, InstallScriptResult } from "../../lib/api/devices";
import { isLoopbackServerBaseUrl } from "../../lib/device-install-url";

/** Invalid URLs need correction; loopback URLs need explicit same-host confirmation. */
export function installUrlProblem(value: string): "invalid" | "loopback" | null {
	try {
		const url = new URL(value.trim());
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return "invalid";
		return isLoopbackServerBaseUrl(value) ? "loopback" : null;
	} catch {
		return "invalid";
	}
}

/** One dialog's bounded cache. Expired entries stay visible until explicitly refreshed. */
export class InstallCommandCache {
	private entries = new Map<string, Promise<InstallScriptResult>>();
	key(deviceId: string, input: InstallScriptInput, version: string): string {
		return JSON.stringify([deviceId, version, input]);
	}
	remove(key: string) {
		this.entries.delete(key);
	}
	get(key: string, create: () => Promise<InstallScriptResult>, refresh = false) {
		if (refresh) this.entries.delete(key);
		let entry = this.entries.get(key);
		if (!entry) {
			const oldest = this.entries.keys().next().value;
			if (this.entries.size >= 32 && oldest) this.entries.delete(oldest);
			entry = create();
			this.entries.set(key, entry);
		}
		return entry;
	}
}

export function installCommandExpired(result: InstallScriptResult, now = Date.now()): boolean {
	return !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= now;
}
