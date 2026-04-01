// Browser session management for the Browser tool.
// Each narrator can hold multiple named sessions with automatic TTL cleanup.

import type { BrowserContext, Page } from "playwright-core";
import { generateShortId } from "../id";
import { logger } from "../logger";
import { createContext } from "./pool";

/** Default session TTL: 10 minutes of inactivity. */
const SESSION_TTL_MS = 10 * 60 * 1000;
/** Cleanup check interval. */
const CLEANUP_INTERVAL_MS = 60 * 1000;

export interface BrowserSession {
	id: string;
	context: BrowserContext;
	/** The currently active page. */
	page: Page;
	/** URL the session was launched with. */
	url: string;
	/** Last activity timestamp (ms). */
	lastActivity: number;
}

/**
 * narratorId → Map<sessionId, BrowserSession>
 */
const sessions = new Map<string, Map<string, BrowserSession>>();

/** Start periodic cleanup of expired sessions. */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
	if (cleanupTimer) return;
	cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [narratorId, map] of sessions) {
			for (const [sessionId, session] of map) {
				if (now - session.lastActivity > SESSION_TTL_MS) {
					logger.info("Browser session expired", { narratorId, sessionId });
					void session.context.close().catch(() => {});
					map.delete(sessionId);
				}
			}
			if (map.size === 0) sessions.delete(narratorId);
		}
		if (sessions.size === 0 && cleanupTimer) {
			clearInterval(cleanupTimer);
			cleanupTimer = null;
		}
	}, CLEANUP_INTERVAL_MS);
	// Don't keep the process alive just for cleanup
	if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
		cleanupTimer.unref();
	}
}

/** Touch a session to reset its TTL. */
export function touchSession(session: BrowserSession): void {
	session.lastActivity = Date.now();
}

/** Create a new browser session for a narrator. */
export async function createSession(narratorId: string, url: string): Promise<BrowserSession> {
	const context = await createContext();
	const page = await context.newPage();

	await page.goto(url, { waitUntil: "domcontentloaded" });

	const sessionId = generateShortId();
	const session: BrowserSession = {
		id: sessionId,
		context,
		page,
		url,
		lastActivity: Date.now(),
	};

	let map = sessions.get(narratorId);
	if (!map) {
		map = new Map();
		sessions.set(narratorId, map);
	}
	map.set(sessionId, session);

	ensureCleanupTimer();
	logger.info("Browser session created", { narratorId, sessionId, url });
	return session;
}

/** Get an existing session. Returns undefined if not found or expired. */
export function getSession(narratorId: string, sessionId: string): BrowserSession | undefined {
	const map = sessions.get(narratorId);
	if (!map) return undefined;
	const session = map.get(sessionId);
	if (!session) return undefined;

	// Check if context is still alive
	try {
		// Accessing pages will throw if context is closed
		session.context.pages();
	} catch {
		map.delete(sessionId);
		if (map.size === 0) sessions.delete(narratorId);
		return undefined;
	}

	return session;
}

/** Close a specific session. */
export async function closeSession(narratorId: string, sessionId: string): Promise<boolean> {
	const map = sessions.get(narratorId);
	if (!map) return false;
	const session = map.get(sessionId);
	if (!session) return false;

	await session.context.close().catch(() => {});
	map.delete(sessionId);
	if (map.size === 0) sessions.delete(narratorId);

	logger.info("Browser session closed", { narratorId, sessionId });
	return true;
}

/** Close all sessions for a narrator (called when narrator ends). */
export async function cleanupNarrator(narratorId: string): Promise<void> {
	const map = sessions.get(narratorId);
	if (!map) return;

	const promises: Promise<void>[] = [];
	for (const session of map.values()) {
		promises.push(session.context.close().catch(() => {}));
	}
	await Promise.all(promises);

	sessions.delete(narratorId);
	logger.info("All browser sessions cleaned up", {
		narratorId,
		count: promises.length,
	});
}

/** List active sessions for a narrator. */
export function listSessions(
	narratorId: string,
): Array<{ id: string; url: string; lastActivity: number }> {
	const map = sessions.get(narratorId);
	if (!map) return [];
	return Array.from(map.values()).map((s) => ({
		id: s.id,
		url: s.page.url(),
		lastActivity: s.lastActivity,
	}));
}
