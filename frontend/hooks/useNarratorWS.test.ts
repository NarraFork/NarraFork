import { describe, expect, test } from "bun:test";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import { parseHTML } from "linkedom";
import { createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import {
	coerceCommitSyncErrorEvent,
	coerceCompactProgressEvent,
	coercePermissionRoutingFields,
	normalizeSubagentActivityCatchUp,
	useNarratorWS,
} from "./useNarratorWS";

describe("coerceCommitSyncErrorEvent", () => {
	test("preserves structured commit sync diagnostics", () => {
		expect(
			coerceCommitSyncErrorEvent({
				chapterId: "chapter-1",
				code: "WORKTREE_WATCHER_COMMIT_SYNC_FAILED",
				reason: "failed to read git log",
				error: "git log failed",
				fallback: true,
				fatal: false,
				backgroundSync: true,
				extra: "kept",
			}),
		).toEqual({
			chapterId: "chapter-1",
			code: "WORKTREE_WATCHER_COMMIT_SYNC_FAILED",
			reason: "failed to read git log",
			error: "git log failed",
			message: undefined,
			fallback: true,
			fatal: false,
			backgroundSync: true,
			extra: "kept",
		});
	});

	test("ignores events without a chapter id", () => {
		expect(coerceCommitSyncErrorEvent({ code: "WORKTREE_WATCHER_COMMIT_SYNC_FAILED" })).toBeNull();
	});
});

describe("coerceCompactProgressEvent", () => {
	test("normalizes live compact progress", () => {
		expect(
			coerceCompactProgressEvent({
				messageId: "compact-1",
				outputChars: 123.9,
				isSegment: true,
				mode: "background",
			}),
		).toEqual({
			messageId: "compact-1",
			outputChars: 123,
			isSegment: true,
			mode: "background",
		});
	});

	test("rejects malformed compact progress", () => {
		expect(coerceCompactProgressEvent({ messageId: "compact-1", outputChars: "12" })).toBeNull();
		expect(coerceCompactProgressEvent({ messageId: "", outputChars: 12 })).toBeNull();
	});
});

describe("coercePermissionRoutingFields", () => {
	test("keeps subagent permission ownership fields from reflection events", () => {
		expect(
			coercePermissionRoutingFields({
				parentToolUseId: "parent-tool",
				subagentNarratorId: "subagent-1",
				ownerNarratorId: "subagent-1",
			}),
		).toEqual({
			parentToolUseId: "parent-tool",
			subagentNarratorId: "subagent-1",
			ownerNarratorId: "subagent-1",
		});
	});
});

describe("useNarratorWS initial catch-up cursor ownership", () => {
	test("does not reuse another narrator's cursor and does not resubscribe for a late seed", async () => {
		const domKeys = [
			"window",
			"document",
			"navigator",
			"HTMLElement",
			"Element",
			"Node",
			"IS_REACT_ACT_ENVIRONMENT",
		] as const;
		const previousGlobals = new Map(
			domKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
		);
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		const globals: Record<(typeof domKeys)[number], unknown> = {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			IS_REACT_ACT_ENVIRONMENT: false,
		};
		for (const key of domKeys) {
			Object.defineProperty(globalThis, key, {
				configurable: true,
				writable: true,
				value: globals[key],
			});
		}

		const subscribeCalls: Array<{ narratorId: string; cursor: CatchUpCursor | undefined }> = [];
		const seedCalls: Array<{ narratorId: string; cursor: CatchUpCursor | undefined }> = [];
		const originals = {
			subscribe: narratorWSManager.subscribe,
			unsubscribe: narratorWSManager.unsubscribe,
			joinPresence: narratorWSManager.joinPresence,
			leavePresence: narratorWSManager.leavePresence,
			addListener: narratorWSManager.addListener,
			removeListener: narratorWSManager.removeListener,
			onConnectionChange: narratorWSManager.onConnectionChange,
			seedCatchUpCursor: narratorWSManager.seedCatchUpCursor,
		};
		let nextHandleId = 1;
		narratorWSManager.subscribe = ((narratorIds, options) => {
			subscribeCalls.push({ narratorId: narratorIds[0], cursor: options?.catchUpCursor });
			return {
				_id: nextHandleId++,
				_narratorIds: [...narratorIds],
				_kind: options?.kind ?? "list",
			};
		}) as typeof narratorWSManager.subscribe;
		narratorWSManager.unsubscribe = (() => {}) as typeof narratorWSManager.unsubscribe;
		narratorWSManager.joinPresence = (() => {}) as typeof narratorWSManager.joinPresence;
		narratorWSManager.leavePresence = (() => {}) as typeof narratorWSManager.leavePresence;
		narratorWSManager.addListener = (() => ({
			_id: nextHandleId++,
		})) as typeof narratorWSManager.addListener;
		narratorWSManager.removeListener = (() => {}) as typeof narratorWSManager.removeListener;
		narratorWSManager.onConnectionChange = (() =>
			() => {}) as typeof narratorWSManager.onConnectionChange;
		narratorWSManager.seedCatchUpCursor = ((narratorId, cursor) => {
			seedCalls.push({ narratorId, cursor });
			return true;
		}) as typeof narratorWSManager.seedCatchUpCursor;

		let props: { narratorId: string; cursor?: CatchUpCursor } = {
			narratorId: "n1",
			cursor: { parentLastMessageId: "n1-tail" },
		};
		function Harness(): ReactNode {
			useNarratorWS(props.narratorId, {}, props.cursor, { kind: "messages" });
			return null;
		}
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const settle = async () => {
			for (let turn = 0; turn < 3; turn++) {
				await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		};

		try {
			root.render(createElement(Harness));
			await settle();
			props = { narratorId: "n2" };
			root.render(createElement(Harness));
			await settle();
			props = { narratorId: "n2", cursor: { parentLastMessageId: "n2-tail" } };
			root.render(createElement(Harness));
			await settle();

			expect(subscribeCalls).toEqual([
				{ narratorId: "n1", cursor: { parentLastMessageId: "n1-tail" } },
				{ narratorId: "n2", cursor: undefined },
			]);
			expect(seedCalls).toEqual([
				{ narratorId: "n1", cursor: { parentLastMessageId: "n1-tail" } },
				{ narratorId: "n2", cursor: { parentLastMessageId: "n2-tail" } },
			]);
		} finally {
			root.unmount();
			await settle();
			container.remove();
			Object.assign(narratorWSManager, originals);
			for (const key of [...domKeys].reverse()) {
				const descriptor = previousGlobals.get(key);
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete (globalThis as Record<string, unknown>)[key];
			}
		}
	});

	test("drops an old narrator frame during render before the previous effect cleanup", async () => {
		const domKeys = [
			"window",
			"document",
			"navigator",
			"HTMLElement",
			"Element",
			"Node",
			"IS_REACT_ACT_ENVIRONMENT",
		] as const;
		const previousGlobals = new Map(
			domKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
		);
		const { window } = parseHTML("<!doctype html><html><body></body></html>");
		const globals: Record<(typeof domKeys)[number], unknown> = {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			IS_REACT_ACT_ENVIRONMENT: false,
		};
		for (const key of domKeys) {
			Object.defineProperty(globalThis, key, {
				configurable: true,
				writable: true,
				value: globals[key],
			});
		}

		type ListenerCallback = Parameters<typeof narratorWSManager.addListener>[1];
		const listeners = new Map<
			number,
			{ narratorId: string | undefined; callback: ListenerCallback }
		>();
		const originals = {
			subscribe: narratorWSManager.subscribe,
			unsubscribe: narratorWSManager.unsubscribe,
			joinPresence: narratorWSManager.joinPresence,
			leavePresence: narratorWSManager.leavePresence,
			addListener: narratorWSManager.addListener,
			removeListener: narratorWSManager.removeListener,
			onConnectionChange: narratorWSManager.onConnectionChange,
		};
		let nextHandleId = 1;
		narratorWSManager.subscribe = ((narratorIds, options) => ({
			_id: nextHandleId++,
			_narratorIds: [...narratorIds],
			_kind: options?.kind ?? "list",
		})) as typeof narratorWSManager.subscribe;
		narratorWSManager.unsubscribe = (() => {}) as typeof narratorWSManager.unsubscribe;
		narratorWSManager.joinPresence = (() => {}) as typeof narratorWSManager.joinPresence;
		narratorWSManager.leavePresence = (() => {}) as typeof narratorWSManager.leavePresence;
		narratorWSManager.addListener = ((options, callback) => {
			const id = nextHandleId++;
			listeners.set(id, {
				narratorId: Array.isArray(options.narratorIds) ? options.narratorIds[0] : undefined,
				callback,
			});
			return { _id: id };
		}) as typeof narratorWSManager.addListener;
		narratorWSManager.removeListener = ((handle) => {
			listeners.delete(handle._id);
		}) as typeof narratorWSManager.removeListener;
		narratorWSManager.onConnectionChange = (() =>
			() => {}) as typeof narratorWSManager.onConnectionChange;

		let narratorId = "n1";
		let dispatchOldFrameDuringRender = false;
		let oldListener: ListenerCallback | undefined;
		const oldWrites: string[] = [];
		const newWrites: string[] = [];
		function Harness(): ReactNode {
			useNarratorWS(narratorId, {
				onTitleUpdated:
					narratorId === "n1" ? (title) => oldWrites.push(title) : (title) => newWrites.push(title),
			});
			if (dispatchOldFrameDuringRender && oldListener) {
				dispatchOldFrameDuringRender = false;
				oldListener({ type: "title_updated", narratorId: "n1", title: "stale-old-frame" });
			}
			return null;
		}
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const settle = async () => {
			for (let turn = 0; turn < 3; turn++) {
				await Promise.resolve();
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		};

		try {
			root.render(createElement(Harness));
			await settle();
			oldListener = [...listeners.values()].find((entry) => entry.narratorId === "n1")?.callback;
			expect(oldListener).toBeFunction();

			narratorId = "n2";
			dispatchOldFrameDuringRender = true;
			root.render(createElement(Harness));
			await settle();

			expect(oldWrites).toEqual([]);
			expect(newWrites).toEqual([]);
			const newListener = [...listeners.values()].find(
				(entry) => entry.narratorId === "n2",
			)?.callback;
			expect(newListener).toBeFunction();
			newListener?.({ type: "title_updated", narratorId: "n2", title: "fresh-new-frame" });
			expect(newWrites).toEqual(["fresh-new-frame"]);
		} finally {
			root.unmount();
			await settle();
			container.remove();
			Object.assign(narratorWSManager, originals);
			for (const key of [...domKeys].reverse()) {
				const descriptor = previousGlobals.get(key);
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete (globalThis as Record<string, unknown>)[key];
			}
		}
	});
});

describe("normalizeSubagentActivityCatchUp", () => {
	test("normalizes the canonical array contract", () => {
		const activity = {
			subagentNarratorId: "subagent-1",
			model: "model-1",
			latestToolCalls: [
				{
					toolCallId: "row-1",
					toolUseId: "tool-1",
					toolName: "Read",
					status: "success",
					createdAt: "2026-07-18T00:00:00.000Z",
					completedAt: "2026-07-18T00:00:01.000Z",
					durationMs: 1000,
				},
			],
		};

		expect(
			normalizeSubagentActivityCatchUp([{ parentToolUseId: "parent-tool", activity }]),
		).toEqual([
			{
				parentToolUseId: "parent-tool",
				activity: {
					subagentNarratorId: "subagent-1",
					model: "model-1",
					latestToolCalls: [
						{
							toolCallId: "row-1",
							toolUseId: "tool-1",
							toolName: "Read",
							status: "success",
							createdAt: "2026-07-18T00:00:00.000Z",
							timing: {
								completedAt: "2026-07-18T00:00:01.000Z",
								durationMs: 1000,
							},
						},
					],
				},
			},
		]);
	});

	test("rejects record payload (no longer supported)", () => {
		const activity = {
			subagentNarratorId: "subagent-1",
			model: "model-1",
			latestToolCalls: [],
		};
		expect(normalizeSubagentActivityCatchUp({ "parent-tool": activity })).toEqual([]);
	});

	test("does not accept id alias on tool call headers", () => {
		const result = normalizeSubagentActivityCatchUp([
			{
				parentToolUseId: "parent-tool",
				activity: {
					subagentNarratorId: null,
					model: null,
					latestToolCalls: [
						{ id: "alias-id", toolUseId: "tool-1", toolName: "Read", status: "success" },
					],
				},
			},
		]);
		expect(result[0].activity.latestToolCalls[0].toolCallId).toBeNull();
	});
});
