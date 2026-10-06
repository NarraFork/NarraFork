import { AUTO_LAN_HOST } from "../../../shared/server-host";
import { logger } from "../logger";
import { getLanAddresses } from "./lan-addresses";

/** Resolve on startup/rebind without replacing the persisted automatic mode. */
export function resolveListenHost(
	configuredHost: string,
	getAddresses: () => string[] = getLanAddresses,
): string {
	if (configuredHost !== AUTO_LAN_HOST) return configuredHost;
	try {
		const host = getAddresses()[0];
		if (host) return host;
		logger.warn("No LAN address available; falling back to localhost");
	} catch (error) {
		logger.warn("LAN address detection failed; falling back to localhost", {
			error: String(error),
		});
	}
	return "localhost";
}

/** Retry automatic LAN binding locally once; explicit hosts retain their existing behavior. */
export function listenWithLanFallback<T>(
	configuredHost: string,
	resolvedHost: string,
	listen: (host: string) => T,
): T {
	try {
		return listen(resolvedHost);
	} catch (error) {
		if (configuredHost !== AUTO_LAN_HOST || resolvedHost === "localhost") throw error;
		logger.warn("Automatic LAN listener failed; falling back to localhost", {
			host: resolvedHost,
			error: String(error),
		});
		return listen("localhost");
	}
}
