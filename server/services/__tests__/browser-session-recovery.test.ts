// Verifies browser-session recovery orchestration without a real Chrome: the browser lib and
// narrator-service are mocked so we can assert reconnect/restore flow and failure notification.
//
// Bun's mock.module is process-global, so we spread the real modules into every stub and re-point
// them back to the real implementations in afterAll to avoid leaking into later-loaded suites.

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BrowserSessionHandoff } from "../../lib/browser/session";

const realBrowser = { ...(await import("../../lib/browser")) };
const realHandoff = { ...(await import("../../lib/browser/handoff")) };
const realNarratorService = { ...(await import("../narrator-service")) };

// ── Controllable stubs ──────────────────────────────────────────────────────
let handoffToReturn: {
	capturedByPid: number;
	capturedAt: string;
	wsEndpoints: { headless?: string; headed?: string };
	sessions: BrowserSessionHandoff[];
} | null = null;
let consumeShouldThrow = false;
let handoffWriteShouldThrow = false;
let sessionCloseShouldThrow = false;
let snapshotsToPersist: BrowserSessionHandoff[] = [];
let endpointsToPersist: { headless?: string; headed?: string } = {};
const persistEvents: string[] = [];

let connectShouldThrow = false;
const connectCalls: boolean[] = [];
// contextId → restore outcome
let restoreOutcomes: Map<string, { ok: true } | { ok: false; reason: string }> = new Map();
const persistedMessages: Array<{ narratorId: string; text: string; blocks: unknown[] }> = [];

function session(overrides: Partial<BrowserSessionHandoff> = {}): BrowserSessionHandoff {
	return {
		sessionId: "s1",
		narratorId: "n1",
		url: "https://example.com",
		currentPageUrl: "https://example.com",
		contextId: "ctx-1",
		headless: true,
		ttlMs: 600_000,
		networkCaptureEnabled: false,
		...overrides,
	};
}

mock.module("../../lib/browser/handoff", () => ({
	...realHandoff,
	consumeBrowserHandoff: () => {
		if (consumeShouldThrow) throw new Error("read blew up");
		return handoffToReturn;
	},
	writeBrowserHandoff: () => {
		persistEvents.push("write");
		if (handoffWriteShouldThrow) throw new Error("write blew up");
	},
	removeBrowserHandoff: () => {
		persistEvents.push("remove");
	},
}));

mock.module("../../lib/browser", () => ({
	...realBrowser,
	snapshotSessionsForHandoff: () => snapshotsToPersist,
	getBrowserWsEndpoints: () => endpointsToPersist,
	setBrowserPreserveMode: (on: boolean) => {
		persistEvents.push(`preserve:${on}`);
	},
	closeAllSessions: async (options?: { preserve?: boolean }) => {
		persistEvents.push(`close:${Boolean(options?.preserve)}`);
		if (sessionCloseShouldThrow) throw new Error("close blew up");
	},
	connectBrowser: mock(async (headless: boolean) => {
		connectCalls.push(headless);
		if (connectShouldThrow) throw new Error("connect failed");
		return { __fakeBrowser: true, headless };
	}),
	restoreSessionFromHandoff: mock(
		async (_browser: unknown, handoff: BrowserSessionHandoff) =>
			restoreOutcomes.get(handoff.contextId) ?? { ok: true },
	),
}));

mock.module("../narrator-service", () => ({
	...realNarratorService,
	narratorService: {
		...realNarratorService.narratorService,
		persistSystemMessage: mock(async (narratorId: string, text: string, blocks: unknown[]) => {
			persistedMessages.push({ narratorId, text, blocks });
			return { id: "msg" };
		}),
	},
}));

const { persistBrowserSessionsForUpdate, restoreBrowserSessionsAfterUpdate } = await import(
	"../browser-session-recovery"
);

describe("browser session update recovery", () => {
	beforeEach(() => {
		handoffToReturn = null;
		consumeShouldThrow = false;
		handoffWriteShouldThrow = false;
		sessionCloseShouldThrow = false;
		snapshotsToPersist = [];
		endpointsToPersist = {};
		persistEvents.length = 0;
		connectShouldThrow = false;
		connectCalls.length = 0;
		restoreOutcomes = new Map();
		persistedMessages.length = 0;
	});

	afterEach(() => {
		persistedMessages.length = 0;
	});

	afterAll(() => {
		mock.module("../../lib/browser/handoff", () => realHandoff);
		mock.module("../../lib/browser", () => realBrowser);
		mock.module("../narrator-service", () => realNarratorService);
		mock.restore();
	});

	test("writes the handoff before enabling preserve mode and clearing sessions", async () => {
		snapshotsToPersist = [session()];
		endpointsToPersist = { headless: "ws://headless" };

		await persistBrowserSessionsForUpdate();

		expect(persistEvents).toEqual(["write", "preserve:true", "close:true"]);
	});

	test("does not enable preserve mode when the handoff write fails", async () => {
		snapshotsToPersist = [session()];
		endpointsToPersist = { headless: "ws://headless" };
		handoffWriteShouldThrow = true;

		await expect(persistBrowserSessionsForUpdate()).rejects.toThrow("write blew up");
		expect(persistEvents).toEqual(["write"]);
	});

	test("rolls back preserve mode and removes the handoff when session clearing fails", async () => {
		snapshotsToPersist = [session()];
		endpointsToPersist = { headless: "ws://headless" };
		sessionCloseShouldThrow = true;

		await expect(persistBrowserSessionsForUpdate()).rejects.toThrow("close blew up");
		expect(persistEvents).toEqual([
			"write",
			"preserve:true",
			"close:true",
			"preserve:false",
			"remove",
		]);
	});

	test("no-op when there is no handoff", async () => {
		handoffToReturn = null;
		await restoreBrowserSessionsAfterUpdate();
		expect(connectCalls).toHaveLength(0);
		expect(persistedMessages).toHaveLength(0);
	});

	test("restores sessions and notifies nobody on full success", async () => {
		handoffToReturn = {
			capturedByPid: 1,
			capturedAt: new Date().toISOString(),
			wsEndpoints: { headless: "ws://headless" },
			sessions: [session({ sessionId: "s1", contextId: "ctx-1" })],
		};
		await restoreBrowserSessionsAfterUpdate();
		expect(connectCalls).toEqual([true]);
		expect(persistedMessages).toHaveLength(0);
	});

	test("notifies the owning narrator when a session cannot be restored", async () => {
		restoreOutcomes.set("ctx-missing", { ok: false, reason: "context_missing" });
		handoffToReturn = {
			capturedByPid: 1,
			capturedAt: new Date().toISOString(),
			wsEndpoints: { headless: "ws://headless" },
			sessions: [session({ sessionId: "s-lost", contextId: "ctx-missing", narratorId: "n-lost" })],
		};
		await restoreBrowserSessionsAfterUpdate();
		expect(persistedMessages).toHaveLength(1);
		expect(persistedMessages[0].narratorId).toBe("n-lost");
		expect(persistedMessages[0].text).toContain("s-lost");
	});

	test("reconnect failure marks all sessions in that mode as lost and notifies once per narrator", async () => {
		connectShouldThrow = true;
		handoffToReturn = {
			capturedByPid: 1,
			capturedAt: new Date().toISOString(),
			wsEndpoints: { headless: "ws://headless" },
			sessions: [
				session({ sessionId: "a", contextId: "c-a", narratorId: "n1" }),
				session({ sessionId: "b", contextId: "c-b", narratorId: "n1" }),
			],
		};
		await restoreBrowserSessionsAfterUpdate();
		// Both sessions belong to n1 → a single aggregated notification.
		expect(persistedMessages).toHaveLength(1);
		expect(persistedMessages[0].narratorId).toBe("n1");
		expect(persistedMessages[0].text).toContain("a");
		expect(persistedMessages[0].text).toContain("b");
	});

	test("does not throw when consuming the handoff fails", async () => {
		consumeShouldThrow = true;
		await expect(restoreBrowserSessionsAfterUpdate()).resolves.toBeUndefined();
		expect(persistedMessages).toHaveLength(0);
	});
});
