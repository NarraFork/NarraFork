// Gated integration test: exercises the real snapshot → disconnect → reconnect → restore round-trip
// against a live Chrome. Skips automatically when Chrome is not available (e.g. CI without Chrome).

import { afterAll, describe, expect, test } from "bun:test";
import {
	closeAllSessions,
	closeBrowser,
	connectBrowser,
	createSession,
	getBrowserWsEndpoints,
	getSession,
	restoreSessionFromHandoff,
	setBrowserPreserveMode,
	snapshotSessionsForHandoff,
} from "../index";

let browserChecked = false;
let browserOk = false;

async function canLaunchBrowser(): Promise<boolean> {
	if (browserChecked) return browserOk;
	browserChecked = true;
	try {
		const { getBrowser } = await import("../pool");
		const browser = await getBrowser();
		browserOk = browser.connected;
	} catch {
		browserOk = false;
	}
	return browserOk;
}

function dataUrl(body: string): string {
	return `data:text/html,${encodeURIComponent(body)}`;
}

afterAll(async () => {
	setBrowserPreserveMode(false);
	await closeAllSessions().catch(() => {});
	await closeBrowser().catch(() => {});
});

describe("browser session handoff (integration)", () => {
	test("preserves a session's page state across disconnect + reconnect", async () => {
		if (!(await canLaunchBrowser())) {
			console.log("Skipping: Chrome not available");
			return;
		}

		const narratorId = `test-handoff-${crypto.randomUUID()}`;
		const session = await createSession(
			narratorId,
			dataUrl("<html><body><h1 id='marker'>original</h1></body></html>"),
			true,
		);

		// Mutate page state so we can prove it survived (not just a re-navigation).
		await session.page.evaluate(() => {
			(globalThis as unknown as { __handoffMarker?: string }).__handoffMarker = "survived";
		});

		// 1. Snapshot + capture endpoint.
		const snapshots = snapshotSessionsForHandoff();
		expect(snapshots.length).toBeGreaterThanOrEqual(1);
		const snap = snapshots.find((s) => s.sessionId === session.id);
		expect(snap).toBeDefined();
		if (!snap) return;

		const endpoints = getBrowserWsEndpoints();
		expect(endpoints.headless).toBeString();
		if (!endpoints.headless) return;

		// 2. Simulate handoff: preserve mode + clear registry WITHOUT closing the context.
		setBrowserPreserveMode(true);
		await closeAllSessions({ preserve: true });
		expect(getSession(narratorId, session.id)).toBeUndefined();

		// 3. Reconnect to the same Chrome and rebuild the session.
		const browser = await connectBrowser(true, endpoints.headless);
		const result = await restoreSessionFromHandoff(browser, snap);
		expect(result.ok).toBe(true);

		// 4. The restored session must expose the same page with preserved JS state.
		const restored = getSession(narratorId, session.id);
		expect(restored).toBeDefined();
		if (!restored) return;
		const marker = await restored.page.evaluate(
			() => (globalThis as unknown as { __handoffMarker?: string }).__handoffMarker,
		);
		expect(marker).toBe("survived");

		// Cleanup: leave preserve mode so the context is actually torn down.
		setBrowserPreserveMode(false);
		await closeAllSessions();
	}, 60_000);
});
