/**
 * The tab's live page sessions per socket: shared per page, kept a little after the last editor,
 * and never more than the server takes. A page that needs a slot takes one from a session whose
 * editors are gone (a hidden panel's), and is refused here only when every session is on screen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import type { LiveTransport } from "./live-client";
import {
	acquireLiveSession,
	liveSessionsOn,
	releaseLiveSession,
	retainLiveSession,
	type SharedLiveSession,
	setLiveSessionGraceForTests,
} from "./live-sessions";

const LIMIT = OUTLINE_LIVE_LIMITS.sessionsPerSocket;

/** A socket that is down: clients wait offline (they would join on reconnect). */
function offlineTransport(): LiveTransport & { sent: number } {
	const handles = new Set<number>();
	return {
		sent: 0,
		connected: false,
		send() {
			this.sent++;
			return false;
		},
		onFrame: () => () => {},
		onConnectionChange: () => () => {},
		allocateHandle() {
			for (let h = 1; h < 256; h++) {
				if (!handles.has(h)) {
					handles.add(h);
					return h;
				}
			}
			return null;
		},
		releaseHandle(handle: number) {
			handles.delete(handle);
		},
	};
}

function held(transport: LiveTransport, pageId: string): SharedLiveSession {
	const shared = acquireLiveSession(transport, pageId, "edit");
	if (!shared) throw new Error(`no session for ${pageId}`);
	retainLiveSession(shared);
	return shared;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => setLiveSessionGraceForTests(null));

describe("live page sessions of a tab", () => {
	test("one session per page and mode, shared by its editors", () => {
		const transport = offlineTransport();
		const a = held(transport, "p1");
		expect(acquireLiveSession(transport, "p1", "edit")).toBe(a);
		expect(acquireLiveSession(transport, "p1", "view")).not.toBe(a);
	});

	test("every session on screen: the next page is refused here, nothing is sent", () => {
		const transport = offlineTransport();
		for (let i = 0; i < LIMIT; i++) held(transport, `p${i}`);
		expect(acquireLiveSession(transport, "one-more", "edit")).toBeNull();
		expect(liveSessionsOn(transport)).toHaveLength(LIMIT);
		expect(liveSessionsOn(transport).some((s) => s.pageId === "one-more")).toBe(false);
	});

	test("a hidden panel's session gives its slot to a new page, oldest release first", async () => {
		const transport = offlineTransport();
		const sessions = Array.from({ length: LIMIT }, (_, i) => held(transport, `p${i}`));
		releaseLiveSession(sessions[3] as SharedLiveSession);
		await sleep(2);
		releaseLiveSession(sessions[1] as SharedLiveSession);
		const next = acquireLiveSession(transport, "new", "edit");
		expect(next).not.toBeNull();
		const pages = liveSessionsOn(transport).map((s) => s.pageId);
		expect(pages).toHaveLength(LIMIT);
		expect(pages).not.toContain("p3");
		expect(pages).toContain("p1");
		// The other released one goes for the page after.
		expect(acquireLiveSession(transport, "newer", "edit")).not.toBeNull();
		expect(liveSessionsOn(transport).map((s) => s.pageId)).not.toContain("p1");
	});

	test("more pages shown one after another than the limit: none is refused", () => {
		const transport = offlineTransport();
		let shown: SharedLiveSession | null = null;
		for (let i = 0; i < LIMIT * 3; i++) {
			// The previous panel is hidden (its editor unmounts) as the next one is shown.
			if (shown) releaseLiveSession(shown);
			shown = acquireLiveSession(transport, `page-${i}`, "edit");
			expect(shown).not.toBeNull();
			retainLiveSession(shown as SharedLiveSession);
			expect(liveSessionsOn(transport).length).toBeLessThanOrEqual(LIMIT);
		}
	});

	test("a session made by a render that has not mounted yet keeps its slot", () => {
		const transport = offlineTransport();
		for (let i = 0; i < LIMIT - 1; i++) held(transport, `p${i}`);
		// Rendered, not yet held (its editor's effect has not run).
		expect(acquireLiveSession(transport, "rendering", "edit")).not.toBeNull();
		expect(acquireLiveSession(transport, "another", "edit")).toBeNull();
		expect(liveSessionsOn(transport).map((s) => s.pageId)).toContain("rendering");
	});

	test("a released session is dropped after the grace period, a held one is not", async () => {
		setLiveSessionGraceForTests(10);
		const transport = offlineTransport();
		const hidden = held(transport, "hidden");
		held(transport, "shown");
		releaseLiveSession(hidden);
		await sleep(40);
		expect(liveSessionsOn(transport).map((s) => s.pageId)).toEqual(["shown"]);
		// Shown again within the grace period: the same session, nothing dropped.
		const again = held(transport, "back");
		releaseLiveSession(again);
		expect(acquireLiveSession(transport, "back", "edit")).toBe(again);
	});
});
