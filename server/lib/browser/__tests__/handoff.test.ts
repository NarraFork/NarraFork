import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import {
	_internal,
	consumeBrowserHandoff,
	removeBrowserHandoff,
	writeBrowserHandoff,
} from "../handoff";
import type { BrowserSessionHandoff } from "../session";

function sampleSession(overrides: Partial<BrowserSessionHandoff> = {}): BrowserSessionHandoff {
	return {
		sessionId: "sess-1",
		narratorId: "narr-1",
		url: "https://example.com/start",
		currentPageUrl: "https://example.com/page",
		contextId: "ctx-abc",
		headless: true,
		ttlMs: 600_000,
		networkCaptureEnabled: false,
		...overrides,
	};
}

describe("browser handoff persistence", () => {
	afterEach(() => {
		removeBrowserHandoff();
	});

	test("round-trips written data and deletes the file on read", () => {
		writeBrowserHandoff({
			wsEndpoints: { headless: "ws://127.0.0.1:1234/devtools/browser/abc" },
			sessions: [sampleSession()],
		});
		expect(existsSync(_internal.HANDOFF_PATH)).toBe(true);

		const consumed = consumeBrowserHandoff();
		expect(consumed).not.toBeNull();
		expect(consumed?.sessions).toHaveLength(1);
		expect(consumed?.sessions[0]).toMatchObject({ sessionId: "sess-1", contextId: "ctx-abc" });
		expect(consumed?.wsEndpoints.headless).toBe("ws://127.0.0.1:1234/devtools/browser/abc");

		// Read-once: the file must be gone after consumption.
		expect(existsSync(_internal.HANDOFF_PATH)).toBe(false);
	});

	test("preserves bounded interruption IDs and rejects malformed markers", () => {
		writeBrowserHandoff({
			wsEndpoints: {},
			sessions: [
				sampleSession({ sessionId: "legacy" }),
				sampleSession({ sessionId: "interrupted", interruptedProfileId: "safe_ID-1" }),
				sampleSession({ sessionId: "unsafe", interruptedProfileId: "../private" }),
				sampleSession({ sessionId: "oversize", interruptedProfileId: "x".repeat(65) }),
			],
		});
		const consumed = consumeBrowserHandoff();
		expect(consumed?.sessions.map((session) => session.sessionId)).toEqual([
			"legacy",
			"interrupted",
		]);
		expect(consumed?.sessions[1]?.interruptedProfileId).toBe("safe_ID-1");
	});

	test("writes CDP endpoints with private filesystem permissions", () => {
		writeBrowserHandoff({
			wsEndpoints: { headless: "ws://127.0.0.1:1234/devtools/browser/private" },
			sessions: [sampleSession()],
		});
		if (process.platform !== "win32") {
			expect(statSync(_internal.UPDATE_DIR).mode & 0o777).toBe(0o700);
			expect(statSync(_internal.HANDOFF_PATH).mode & 0o777).toBe(0o600);
		}
	});

	test("returns null and deletes the file when absent, corrupt, or stale", () => {
		// Absent
		expect(consumeBrowserHandoff()).toBeNull();

		// Corrupt JSON
		writeFileSync(_internal.HANDOFF_PATH, "{ not json");
		expect(consumeBrowserHandoff()).toBeNull();
		expect(existsSync(_internal.HANDOFF_PATH)).toBe(false);

		// Stale (older than max age)
		const staleAt = new Date(Date.now() - _internal.HANDOFF_MAX_AGE_MS - 1000).toISOString();
		writeFileSync(
			_internal.HANDOFF_PATH,
			JSON.stringify({
				capturedByPid: 1,
				capturedAt: staleAt,
				wsEndpoints: { headless: "ws://x" },
				sessions: [sampleSession()],
			}),
		);
		expect(consumeBrowserHandoff()).toBeNull();
		expect(existsSync(_internal.HANDOFF_PATH)).toBe(false);
	});

	test("drops malformed session entries but keeps valid ones", () => {
		writeFileSync(
			_internal.HANDOFF_PATH,
			JSON.stringify({
				capturedByPid: 1,
				capturedAt: new Date().toISOString(),
				wsEndpoints: { headed: "ws://y" },
				sessions: [
					sampleSession({ sessionId: "ok" }),
					{ sessionId: "bad", narratorId: 123 }, // invalid shape
				],
			}),
		);
		const consumed = consumeBrowserHandoff();
		expect(consumed?.sessions).toHaveLength(1);
		expect(consumed?.sessions[0].sessionId).toBe("ok");
		expect(consumed?.wsEndpoints.headed).toBe("ws://y");
	});
});
