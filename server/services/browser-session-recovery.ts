// Orchestrates browser-session persistence across a seamless-update restart.
//
// Outgoing process (only when shutting down for `replacement_started`):
//   persistBrowserSessionsForUpdate() snapshots sessions, records each Chrome instance's CDP
//   endpoint, flips the pool into preserve-on-close mode, writes the handoff file, and clears the
//   in-memory session registry WITHOUT closing the underlying contexts.
//
// Replacement process (at startup):
//   restoreBrowserSessionsAfterUpdate() reads the handoff (read-once), reconnects to each preserved
//   Chrome via wsEndpoint, rebuilds every session from its contextId, and notifies the owning
//   narrator for any session that could not be restored.

import { DEFAULT_LOCALE } from "@shared/i18n-locales";
import {
	closeAllSessions,
	connectBrowser,
	getBrowserWsEndpoints,
	restoreSessionFromHandoff,
	setBrowserPreserveMode,
	snapshotSessionsForHandoff,
} from "../lib/browser";
import { consumeBrowserHandoff, writeBrowserHandoff } from "../lib/browser/handoff";
import { logger } from "../lib/logger";
import { getToolMessageWithParams } from "../lib/prompt-i18n";

/**
 * Capture and persist all active browser sessions so a replacement (post-update) process can
 * reconnect to the same Chrome. Safe no-op when there are no sessions. Must only be called on the
 * seamless-update shutdown path — a normal shutdown closes the browser as usual.
 */
export async function persistBrowserSessionsForUpdate(): Promise<void> {
	const snapshots = snapshotSessionsForHandoff();
	if (snapshots.length === 0) {
		logger.debug("No browser sessions to persist for update handoff");
		return;
	}

	const wsEndpoints = getBrowserWsEndpoints();

	// Only keep sessions whose Chrome instance still exposes a reconnectable endpoint. A session
	// in a headless mode with no endpoint cannot be reconnected, so drop it (its narrator will be
	// notified by the replacement process only for sessions we actually recorded — dropped ones
	// simply won't reappear, which is acceptable because the browser is already gone).
	const restorable = snapshots.filter((s) =>
		s.headless ? Boolean(wsEndpoints.headless) : Boolean(wsEndpoints.headed),
	);
	const droppedCount = snapshots.length - restorable.length;
	if (droppedCount > 0) {
		logger.warn("Some browser sessions cannot be preserved (no reconnectable endpoint)", {
			droppedCount,
		});
	}
	if (restorable.length === 0) {
		logger.warn("No browser sessions have a reconnectable endpoint; skipping handoff");
		return;
	}

	// From here on, closeBrowser() must disconnect (not kill) so Chrome survives for the replacement.
	setBrowserPreserveMode(true);
	writeBrowserHandoff({ wsEndpoints, sessions: restorable });
	// Clear the in-memory registry but keep the contexts alive for reconnection.
	await closeAllSessions({ preserve: true });

	logger.info("Browser sessions persisted for update handoff", {
		sessionCount: restorable.length,
		hasHeadless: Boolean(wsEndpoints.headless),
		hasHeaded: Boolean(wsEndpoints.headed),
	});
}

/**
 * Reconnect to preserved Chrome instances and rebuild sessions from the handoff file. Notifies the
 * owning narrator for any session that cannot be restored. Never throws — browser recovery must
 * not affect narrator continuation recovery or server startup.
 */
export async function restoreBrowserSessionsAfterUpdate(): Promise<void> {
	let handoff: ReturnType<typeof consumeBrowserHandoff>;
	try {
		handoff = consumeBrowserHandoff();
	} catch (error) {
		logger.error("Failed to consume browser handoff", {
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	if (!handoff) return;

	logger.info("Restoring browser sessions after update", {
		sessionCount: handoff.sessions.length,
	});

	// Reconnect once per headless mode; a failed connect fails every session in that group.
	const browsersByMode = new Map<boolean, Awaited<ReturnType<typeof connectBrowser>> | null>();
	async function getModeBrowser(headless: boolean) {
		if (browsersByMode.has(headless)) return browsersByMode.get(headless) ?? null;
		const endpoint = headless ? handoff?.wsEndpoints.headless : handoff?.wsEndpoints.headed;
		if (!endpoint) {
			browsersByMode.set(headless, null);
			return null;
		}
		try {
			const browser = await connectBrowser(headless, endpoint);
			browsersByMode.set(headless, browser);
			return browser;
		} catch (error) {
			logger.error("Failed to reconnect to preserved Chrome instance", {
				headless,
				error: error instanceof Error ? error.message : String(error),
			});
			browsersByMode.set(headless, null);
			return null;
		}
	}

	let restoredCount = 0;
	// narratorId → list of failed { sessionId, reason }
	const failuresByNarrator = new Map<string, Array<{ sessionId: string; reason: string }>>();
	function recordFailure(narratorId: string, sessionId: string, reason: string) {
		const list = failuresByNarrator.get(narratorId) ?? [];
		list.push({ sessionId, reason });
		failuresByNarrator.set(narratorId, list);
	}

	for (const session of handoff.sessions) {
		const browser = await getModeBrowser(session.headless);
		if (!browser) {
			recordFailure(session.narratorId, session.sessionId, "reconnect_failed");
			continue;
		}
		try {
			const result = await restoreSessionFromHandoff(browser, session);
			if (result.ok) restoredCount++;
			else recordFailure(session.narratorId, session.sessionId, result.reason);
		} catch (error) {
			logger.warn("Failed to restore a browser session", {
				narratorId: session.narratorId,
				sessionId: session.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			recordFailure(session.narratorId, session.sessionId, "restore_error");
		}
	}

	logger.info("Browser session recovery finished", {
		restoredCount,
		failedNarrators: failuresByNarrator.size,
	});

	await notifyFailedNarrators(failuresByNarrator);
}

async function notifyFailedNarrators(
	failuresByNarrator: Map<string, Array<{ sessionId: string; reason: string }>>,
): Promise<void> {
	if (failuresByNarrator.size === 0) return;
	// Lazy import to avoid pulling the narrator graph into the browser/update path eagerly.
	const { narratorService } = await import("./narrator-service");

	for (const [narratorId, failures] of failuresByNarrator) {
		try {
			// Narrators do not persist a per-session locale; this diagnostic notice defaults to
			// the system default locale.
			const ids = failures.map((f) => f.sessionId).join(", ");
			const reason = [...new Set(failures.map((f) => f.reason))].join(", ");
			const text = getToolMessageWithParams("browserSessionLostAfterUpdate", DEFAULT_LOCALE, {
				ids,
				reason,
			});
			await narratorService.persistSystemMessage(narratorId, text, [
				{
					type: "browser_session_lost",
					sessionIds: failures.map((f) => f.sessionId),
					reasons: failures.map((f) => f.reason),
				},
			]);
		} catch (error) {
			logger.warn("Failed to notify narrator of lost browser sessions", {
				narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
