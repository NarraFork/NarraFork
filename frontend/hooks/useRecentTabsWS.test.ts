import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NarratorListWSEvent } from "./useNarratorWS";
import {
	acceptRecentTabsStatusVersion,
	dispatchRecentTabsListStateSnapshot,
	recentTabsStatusNotification,
	useRecentTabsWS,
} from "./useRecentTabsWS";

describe("RecentTabs list-domain versions", () => {
	test("rejects older revisions, accepts equal revisions and resets with the server epoch", () => {
		const versions = new Map<string, { statusEpoch: string; statusRevision: number }>();
		const frame = (revision: number, epoch = "server-a") => ({
			statusEpoch: epoch,
			statusRevision: revision,
		});
		expect(acceptRecentTabsStatusVersion(versions, "n1", frame(5))).toBe(true);
		expect(acceptRecentTabsStatusVersion(versions, "n1", frame(4))).toBe(false);
		expect(acceptRecentTabsStatusVersion(versions, "n1", frame(5))).toBe(true);
		expect(acceptRecentTabsStatusVersion(versions, "n1", frame(6))).toBe(true);
		expect(acceptRecentTabsStatusVersion(versions, "n1", frame(3))).toBe(false);
		expect(acceptRecentTabsStatusVersion(versions, "n2", frame(1))).toBe(true);
		expect(acceptRecentTabsStatusVersion(versions, "n1", frame(1, "server-b"))).toBe(true);
	});

	test("legacy or malformed versions cannot poison the version watermark", () => {
		const versions = new Map<string, { statusEpoch: string; statusRevision: number }>();
		const version = { statusEpoch: "server-a", statusRevision: 5 };
		acceptRecentTabsStatusVersion(versions, "n1", version);
		for (const data of [
			{},
			{ statusEpoch: "", statusRevision: 100 },
			{ statusEpoch: "server-a", statusRevision: Infinity },
			{ statusEpoch: "server-a", statusRevision: -1 },
			{ statusEpoch: "server-a", statusRevision: 2.5 },
		]) {
			expect(acceptRecentTabsStatusVersion(versions, "n1", data)).toBe(true);
			expect(versions.get("n1")).toEqual(version);
		}
	});
});

describe("RecentTabs notification intent", () => {
	test("only same-epoch, same-turn idle/unread can notify and preserves the done's authoritative mute flag", () => {
		const current = {
			status: "idle",
			substatus: ["unread"],
			turnStartedAt: "turn-1",
			statusEpoch: "server-a",
		};
		const done = { ...current, backgroundWorkActive: true };
		expect(recentTabsStatusNotification(current, done)).toMatchObject({
			notificationOnly: true,
			backgroundWorkActive: true,
			turnStartedAt: "turn-1",
		});
		expect(
			recentTabsStatusNotification(current, { ...done, backgroundWorkActive: false }),
		).toMatchObject({ backgroundWorkActive: false });
		for (const latest of [
			undefined,
			{ ...current, status: "working" },
			{ ...current, turnStartedAt: "turn-2" },
			{ ...current, substatus: [] },
			{ ...current, statusEpoch: "server-b" },
			{ ...current, turnStartedAt: undefined },
		])
			expect(recentTabsStatusNotification(latest, done)).toBeNull();
		for (const data of [
			{ ...done, turnStartedAt: undefined },
			{ ...done, statusEpoch: undefined },
			{ ...done, status: "working" },
			{ ...done, substatus: [] },
		])
			expect(recentTabsStatusNotification(current, data)).toBeNull();
	});
});

describe("RecentTabs mounted WS status ordering", () => {
	let root: Root;
	let client: QueryClient;
	let ids: string[];
	let updates: Array<{ narratorId: string; event: NarratorListWSEvent }>;
	let onFrame: (data: Record<string, unknown>) => void;
	let onConnection: (connected: boolean, reconnect: boolean) => void;
	let reconnects: number;
	let managerStale: (id: string, data: Record<string, unknown>) => boolean;
	const restores: Array<() => void> = [];
	const globals = new Map<string, PropertyDescriptor | undefined>();
	function Harness() {
		useRecentTabsWS(
			ids,
			(narratorId, event) => updates.push({ narratorId, event }),
			undefined,
			() => {
				reconnects++;
			},
		);
		return null;
	}
	const render = () =>
		act(async () =>
			root.render(createElement(QueryClientProvider, { client }, createElement(Harness))),
		);
	const emit = (data: Record<string, unknown>) => act(async () => onFrame(data));
	const snapshot = (revision: number, extra: Record<string, unknown> = {}) => ({
		type: "list_state_snapshot",
		items: [
			{
				narratorId: "n1",
				state: {
					status: "waiting",
					substatus: ["snapshot"],
					statusEpoch: "server-a",
					statusRevision: revision,
					...extra,
				},
			},
		],
	});
	const full = (revision: number, extra: Record<string, unknown> = {}) => ({
		type: "status_change",
		narratorId: "n1",
		status: "working",
		substatus: ["live"],
		statusEpoch: "server-a",
		statusRevision: revision,
		...extra,
	});
	const statuses = () => updates.filter(({ event }) => event.type === "status");

	beforeEach(() => {
		const { window } = parseHTML("<html><body></body></html>");
		for (const [key, value] of Object.entries({
			window,
			document: window.document,
			navigator: window.navigator,
			IS_REACT_ACT_ENVIRONMENT: true,
		})) {
			globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		ids = ["n1"];
		updates = [];
		reconnects = 0;
		managerStale = () => false;
		for (const spy of [
			spyOn(narratorWSManager, "addListener").mockImplementation((options, callback) => {
				if (options.narratorIds === "*") onFrame = callback;
				return { _id: options.narratorIds === "*" ? 1 : 2 };
			}),
			spyOn(narratorWSManager, "removeListener").mockImplementation(() => {}),
			spyOn(narratorWSManager, "subscribe").mockImplementation((narratorIds) => ({
				_id: 1,
				_narratorIds: narratorIds,
				_kind: "list",
			})),
			spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {}),
			spyOn(narratorWSManager, "updateSubscription").mockImplementation(() => {}),
			spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
				onConnection = callback;
				return () => {};
			}),
			spyOn(narratorWSManager, "isStatusVersionStale").mockImplementation((id, data) =>
				managerStale(id, data),
			),
		])
			restores.push(() => spy.mockRestore());
		client = new QueryClient();
		root = createRoot(document.createElement("div"));
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		client.clear();
		for (const restore of restores.splice(0)) restore();
		for (const [key, descriptor] of globals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		globals.clear();
	});

	test("snapshot rev5 rejects full rev4 locally, then complete substatus rev6 rejects snapshot rev3", async () => {
		await render();
		await emit(snapshot(5));
		await emit(full(4));
		expect(statuses()).toHaveLength(1);
		expect(statuses()[0]?.event).toMatchObject({ status: "waiting", substatus: ["snapshot"] });
		await emit(
			full(6, {
				type: "substatus_change",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-6",
				backgroundWorkActive: true,
			}),
		);
		expect(statuses()).toHaveLength(2);
		expect(statuses()[1]?.event).toEqual({
			type: "status",
			status: "idle",
			substatus: ["unread"],
			turnStartedAt: "turn-6",
			backgroundWorkActive: true,
			stateOnly: true,
		});
		await emit(snapshot(3, { title: "independent title", activeTerminalCount: 2 }));
		expect(statuses()).toHaveLength(2);
		expect(
			updates.some(({ event }) => event.type === "title" && event.title === "independent title"),
		).toBe(true);
		expect(
			updates.some(
				({ event }) => event.type === "terminalCount" && event.activeTerminalCount === 2,
			),
		).toBe(true);
	});

	test("freshly mounted lists check the manager full-frame watermark without promoting it", async () => {
		managerStale = (id, data) =>
			id === "n1" && data.statusEpoch === "server-a" && (data.statusRevision as number) < 9;
		await render();
		await emit(snapshot(3));
		expect(statuses()).toHaveLength(0);
		expect(narratorWSManager.isStatusVersionStale).toHaveBeenCalledWith(
			"n1",
			expect.objectContaining({ statusRevision: 3 }),
		);
		await emit(snapshot(9));
		await emit(full(9, { status: "idle", substatus: [] }));
		expect(statuses()).toHaveLength(2); // Equality is legal, and the snapshot never mutates manager state.
	});

	test("late done rejected only by the list version becomes notification-only, just like a manager intent", async () => {
		await render();
		await emit(
			full(2, {
				type: "substatus_change",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
			}),
		);
		await emit(
			full(1, {
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
				backgroundWorkActive: true,
			}),
		);
		await emit(
			full(1, {
				type: "status_notification",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
				backgroundWorkActive: false,
			}),
		);
		expect(statuses().map(({ event }) => event)).toEqual([
			{
				type: "status",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
				stateOnly: true,
			},
			{
				type: "status",
				notificationOnly: true,
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
				backgroundWorkActive: true,
			},
			{
				type: "status",
				notificationOnly: true,
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
				backgroundWorkActive: false,
			},
		]);
	});

	test("new working, changed turn or read state reject a late done notification", async () => {
		await render();
		let revision = 0;
		for (const update of [
			{ status: "working", substatus: [] },
			{ status: "idle", substatus: ["unread"], turnStartedAt: "turn-2" },
			{ status: "idle", substatus: [] },
		]) {
			await emit(
				full(++revision, {
					type: "substatus_change",
					status: "idle",
					substatus: ["unread"],
					turnStartedAt: "turn-1",
				}),
			);
			await emit(
				full(++revision, { type: "substatus_change", turnStartedAt: "turn-1", ...update }),
			);
			await emit(
				full(0, {
					type: "status_notification",
					status: "idle",
					substatus: ["unread"],
					turnStartedAt: "turn-1",
				}),
			);
		}
		expect(statuses().filter(({ event }) => event.notificationOnly)).toHaveLength(0);
	});

	test("accepted list snapshots and legacy read events also fence notification intents", async () => {
		await render();
		await emit(snapshot(2, { status: "idle", substatus: ["unread"], turnStartedAt: "turn-1" }));
		await emit(
			full(1, {
				type: "status_notification",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
			}),
		);
		expect(statuses().filter(({ event }) => event.notificationOnly)).toHaveLength(1);
		await emit({ type: "substatus_change", narratorId: "n1", substatus: [] });
		await emit(
			full(1, {
				type: "status_notification",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
			}),
		);
		expect(statuses().filter(({ event }) => event.notificationOnly)).toHaveLength(1);
	});

	test("reconnection and membership pruning remove old notification eligibility", async () => {
		await render();
		await emit(
			full(2, {
				type: "substatus_change",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
			}),
		);
		await act(async () => onConnection(true, true));
		await emit(
			full(1, {
				type: "status_notification",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
			}),
		);
		await emit(
			full(2, {
				type: "substatus_change",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
			}),
		);
		ids = ["n2"];
		await render();
		ids = ["n1"];
		await render();
		await emit(
			full(1, {
				type: "status_notification",
				status: "idle",
				substatus: ["unread"],
				turnStartedAt: "turn-1",
			}),
		);
		expect(statuses().filter(({ event }) => event.notificationOnly)).toHaveLength(0);
	});

	test("legacy substatus-only messages keep their sparse semantics", async () => {
		await render();
		await emit({ type: "substatus_change", narratorId: "n1", substatus: ["reasoning"] });
		expect(statuses()[0]?.event).toEqual({ type: "status", substatus: ["reasoning"] });
		await emit({ type: "status_change", narratorId: "n1", status: "working", substatus: [] });
		expect(statuses()[1]?.event).toMatchObject({ status: "working", substatus: [] });
	});

	test("reconnection resets the local watermark and still notifies its recovery callback once", async () => {
		await render();
		await emit(full(50));
		await act(async () => {
			onConnection(false, false);
			onConnection(true, true);
		});
		await emit(snapshot(1, { statusEpoch: "server-b" }));
		await emit(full(0, { statusEpoch: "server-b" }));
		expect(statuses()).toHaveLength(2);
		expect(reconnects).toBe(1);
		// Same server can also establish a new socket lifetime with a fresh local baseline.
		await act(async () => {
			onConnection(false, false);
			onConnection(true, true);
		});
		await emit(full(0, { statusEpoch: "server-b" }));
		expect(statuses()).toHaveLength(3);
	});

	test("membership changes prune old narrator watermarks and ignore unsubscribed snapshots", async () => {
		await render();
		await emit(full(50));
		ids = ["n2"];
		await render();
		await emit(snapshot(60)); // Must not recreate a watermark for an unsubscribed narrator.
		await emit(full(60));
		expect(statuses()).toHaveLength(1);
		ids = ["n1"];
		await render();
		await emit(snapshot(1));
		expect(statuses()).toHaveLength(2);
	});
});

describe("RecentTabs list-state snapshots", () => {
	test("forwards service-only and mixed classified snapshots including explicit zero", () => {
		const events: unknown[] = [];
		dispatchRecentTabsListStateSnapshot(
			{
				items: [
					{
						narratorId: "services",
						activeBackgroundTaskCount: 2,
						activeBackgroundWorkCount: 0,
						activeBackgroundServiceCount: 2,
					},
					{
						narratorId: "mixed",
						state: {
							activeBackgroundTaskCount: 3,
							activeBackgroundWorkCount: 1,
							activeBackgroundServiceCount: 2,
						},
					},
				],
			},
			(id, event) => events.push({ id, ...event }),
		);
		expect(events).toEqual([
			{
				id: "services",
				type: "backgroundTaskCount",
				activeBackgroundTaskCount: 2,
				activeBackgroundWorkCount: 0,
				activeBackgroundServiceCount: 2,
			},
			{
				id: "mixed",
				type: "backgroundTaskCount",
				activeBackgroundTaskCount: 3,
				activeBackgroundWorkCount: 1,
				activeBackgroundServiceCount: 2,
			},
		]);
	});

	test("fans a batched list snapshot into narrator updates", () => {
		const updates: Array<{
			narratorId: string;
			type: string;
			status?: string;
			substatus?: string[];
		}> = [];
		const count = dispatchRecentTabsListStateSnapshot(
			{
				type: "list_state_snapshot",
				items: [
					{ narratorId: "n1", status: "working", substatus: ["reasoning"] },
					{ narratorId: "n2", status: "idle", substatus: [] },
				],
			},
			(narratorId, event) => updates.push({ narratorId, ...event }),
		);

		expect(count).toBe(2);
		expect(updates).toEqual([
			{ narratorId: "n1", type: "status", status: "working", substatus: ["reasoning"] },
			{ narratorId: "n2", type: "status", status: "idle", substatus: [] },
		]);
	});

	test("does not join or leave presence for the RecentTabs subscription", async () => {
		const source = await Bun.file(new URL("./useRecentTabsWS.ts", import.meta.url)).text();
		expect(source).toContain('"presence_update"');
		expect(source).not.toContain(".joinPresence(");
		expect(source).not.toContain(".leavePresence(");
	});

	test("fans background task counts out of a list snapshot into count updates", () => {
		const updates: Array<{
			narratorId: string;
			type: string;
			activeBackgroundTaskCount?: number;
		}> = [];
		dispatchRecentTabsListStateSnapshot(
			{
				type: "list_state_snapshot",
				items: [
					{ narratorId: "n1", status: "idle", activeBackgroundTaskCount: 3 },
					{ narratorId: "n2", status: "working", activeBackgroundTaskCount: 0 },
					// No count field → no event, so a partial snapshot never zeroes a badge.
					{ narratorId: "n3", status: "idle" },
				],
			},
			(narratorId, event) => updates.push({ narratorId, ...event }),
		);

		const countEvents = updates.filter((event) => event.type === "backgroundTaskCount");
		expect(countEvents).toEqual([
			{ narratorId: "n1", type: "backgroundTaskCount", activeBackgroundTaskCount: 3 },
			{ narratorId: "n2", type: "backgroundTaskCount", activeBackgroundTaskCount: 0 },
		]);
	});

	test("forwards the backgroundWorkActive suppression flag on snapshot status items", () => {
		const updates: Array<{
			narratorId: string;
			type: string;
			status?: string;
			substatus?: string[];
			backgroundWorkActive?: boolean;
		}> = [];
		dispatchRecentTabsListStateSnapshot(
			{
				type: "list_state_snapshot",
				items: [
					// Done-transition replay while background work is still running.
					{
						narratorId: "n1",
						status: "idle",
						substatus: ["unread"],
						backgroundWorkActive: true,
					},
					// Ordinary idle/unread replay — no flag.
					{ narratorId: "n2", status: "idle", substatus: ["unread"] },
				],
			},
			(narratorId, event) => updates.push({ narratorId, ...event }),
		);

		const statusEvents = updates.filter((event) => event.type === "status");
		expect(statusEvents).toEqual([
			{
				narratorId: "n1",
				type: "status",
				status: "idle",
				substatus: ["unread"],
				backgroundWorkActive: true,
			},
			{ narratorId: "n2", type: "status", status: "idle", substatus: ["unread"] },
		]);
	});
});
