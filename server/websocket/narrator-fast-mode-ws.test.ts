import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { getTestDb } from "../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../db")) };
mock.module("../db", () => ({ db, sqlite }));
const { eventBus } = await import("../lib/event-bus");
const { handleNarratorWS } = await import("./narrator-ws");
type Socket = Parameters<typeof handleNarratorWS.open>[0];
const opened: Socket[] = [];
function open(userId?: string, share = false, subscribedNarrators = new Set<string>()) {
	const sent: Record<string, unknown>[] = [];
	const ws = {
		data: {
			channel: "narrator",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			userId,
			subscribedNarrators,
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
			...(share
				? {
						publicShare: {
							shareId: "share",
							tokenHash: "token-hash",
							narratorId: "shared",
							roomId: "room",
							guestName: "guest",
						},
					}
				: {}),
		},
		send(payload: string) {
			sent.push(JSON.parse(payload));
		},
		close() {},
	} as unknown as Socket;
	handleNarratorWS.open(ws);
	opened.push(ws);
	return { ws, sent };
}
afterEach(() => {
	for (const ws of opened.splice(0)) handleNarratorWS.close(ws);
});
afterAll(() => mock.module("../db", () => realDbModule));

describe("fast-mode WS invalidation bridge", () => {
	test("an import refreshes authenticated viewers without exposing imported IDs", () => {
		const child = open("viewer", false, new Set(["child-only"]));
		const anonymous = open(undefined, true);
		eventBus.emit({ type: "narrator:imported" });
		expect(child.sent).toEqual([{ type: "fast_mode_changed" }]);
		expect(anonymous.sent).toEqual([]);
	});
	test("a configuration edit wakes child-only and unrelated authenticated clients without leaking IDs or values", () => {
		const child = open("viewer", false, new Set(["child-only"]));
		const other = open("other-user");
		eventBus.emit({ type: "narrator:fast_mode_changed", narratorId: "private-primary" });
		expect(child.sent).toEqual([{ type: "fast_mode_changed" }]);
		expect(other.sent).toEqual([{ type: "fast_mode_changed" }]);
	});
	test("a user default edit broadcasts a marker globally and adds preference refresh only for that user's connections", () => {
		const owner = open("execution-user");
		const ownerOtherTab = open("execution-user");
		const otherViewer = open("different-viewer", false, new Set(["child-only"]));
		eventBus.emit({ type: "user:fast_mode_default_changed", userId: "execution-user" });
		for (const target of [owner, ownerOtherTab]) {
			expect(target.sent).toEqual([
				{ type: "fast_mode_changed" },
				{ type: "fast_mode_changed", refreshPreferences: true },
			]);
		}
		expect(otherViewer.sent).toEqual([{ type: "fast_mode_changed" }]);
	});
	test("anonymous share connections receive neither global nor targeted hints", () => {
		const anonymous = open(undefined, true);
		// A share grant stays outside the authenticated user index even if an ID is present.
		const shareWithUserId = open("execution-user", true);
		const authenticated = open("execution-user");
		eventBus.emit({ type: "narrator:fast_mode_changed", narratorId: "shared" });
		eventBus.emit({ type: "user:fast_mode_default_changed", userId: "execution-user" });
		expect(anonymous.sent).toEqual([]);
		expect(shareWithUserId.sent).toEqual([]);
		expect(authenticated.sent).toEqual([
			{ type: "fast_mode_changed" },
			{ type: "fast_mode_changed" },
			{ type: "fast_mode_changed", refreshPreferences: true },
		]);
	});
	test("execution principal changes refresh primary and child-only viewers without exposing identity", () => {
		const primary = open("viewer", false, new Set(["root"]));
		const child = open("different-viewer", false, new Set(["child-only"]));
		const anonymous = open(undefined, true);
		eventBus.emit({ type: "narrator:execution_principal_changed", narratorId: "root" });
		expect(primary.sent).toEqual([{ type: "fast_mode_changed" }]);
		expect(child.sent).toEqual([{ type: "fast_mode_changed" }]);
		expect(anonymous.sent).toEqual([]);
	});
});
