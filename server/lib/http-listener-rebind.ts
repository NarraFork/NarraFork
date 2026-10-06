import { logger } from "./logger";

/** Detach synchronously; never await Bun's potentially stuck websocket drain promise. */
export function rebindHttpListener<T extends { stop(force: boolean): unknown }>(
	previous: T,
	bind: () => T,
	rollback: () => T,
	preserveResponse: boolean,
): T {
	const stop = (force: boolean) => {
		void Promise.resolve(previous.stop(force)).catch((error) => {
			logger.warn("Retired HTTP listener stop reported an error", { error: String(error) });
		});
	};
	stop(!preserveResponse);
	try {
		return bind();
	} catch (error) {
		logger.error("HTTP rebind failed, restoring previous listener", { error: String(error) });
		try {
			return rollback();
		} catch (rollbackError) {
			logger.error("HTTP listener rollback failed — no listener is bound", {
				error: String(rollbackError),
			});
			throw rollbackError;
		}
	} finally {
		if (preserveResponse) {
			// The API returns only after binding/rollback completes, on the still-live old connection.
			// Retire that captured listener, not the replacement held by main's mutable _server.
			const timer = setTimeout(() => stop(true), 200);
			timer.unref();
		}
	}
}
