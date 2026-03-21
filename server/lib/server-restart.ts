import { logger } from "./logger";

/**
 * Server restart callback registry.
 * Decouples settings routes from server/index.ts to avoid circular imports.
 *
 * server/index.ts registers the actual restart implementation on startup.
 * server/routes/settings.ts calls `scheduleServerRestart()` when host/port changes.
 */

type RestartFn = (newHost: string, newPort: number) => void;

let _restartFn: RestartFn | null = null;

/** Called by server/index.ts to register the restart implementation. */
export function registerServerRestart(fn: RestartFn): void {
	_restartFn = fn;
}

/**
 * Schedule a server restart with new host/port after a short delay.
 * The delay allows the current HTTP response to be flushed before the server stops.
 */
export function scheduleServerRestart(newHost: string, newPort: number): void {
	if (!_restartFn) {
		logger.error("Server restart requested but no restart handler registered");
		return;
	}
	const fn = _restartFn;
	setTimeout(() => {
		try {
			fn(newHost, newPort);
		} catch (err) {
			logger.error("Server restart failed", { error: String(err) });
		}
	}, 200);
}
