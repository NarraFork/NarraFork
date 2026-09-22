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
				phase: "thinking",
				thinkingChars: 88.7,
				outputChars: 123.9,
				isSegment: true,
				mode: "background",
			}),
		).toEqual({
			messageId: "compact-1",
			phase: "thinking",
			thinkingChars: 88,
			outputChars: 123,
			isSegment: true,
			mode: "background",
			retryCount: 0,
		});
	});

	test("falls back to the output phase for a payload from an older server", () => {
		// Pre-two-phase servers send only outputChars; that must keep behaving exactly
		// as it did before (single-phase output counting).
		expect(
			coerceCompactProgressEvent({ messageId: "compact-1", outputChars: 42, mode: "blocking" }),
		).toEqual({
			messageId: "compact-1",
			phase: "output",
			thinkingChars: 0,
			outputChars: 42,
			isSegment: false,
			mode: "blocking",
			retryCount: 0,
		});
	});

	test("parses the retry state of an in-flight summary retry", () => {
		expect(
			coerceCompactProgressEvent({
				messageId: "compact-1",
				outputChars: 0,
				retryCount: 2.9,
				retryError: "provider overloaded",
			}),
		).toEqual({
			messageId: "compact-1",
			phase: "output",
			thinkingChars: 0,
			outputChars: 0,
			isSegment: false,
			mode: "blocking",
			retryCount: 2,
			retryError: "provider overloaded",
		});
	});

	test("drops a blank retry error and a malformed retry count", () => {
		expect(
			coerceCompactProgressEvent({
				messageId: "compact-1",
				outputChars: 0,
				retryCount: "3",
				retryError: "",
			}),
		).toEqual({
			messageId: "compact-1",
			phase: "output",
			thinkingChars: 0,
			outputChars: 0,
			isSegment: false,
			mode: "blocking",
			retryCount: 0,
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

		const subscribeCalls: Array<{
			narratorId: string;
			cursor: CatchUpCursor | undefined;
			messageVersion: number | undefined;
		}> = [];
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
			subscribeCalls.push({
				narratorId: narratorIds[0],
				cursor: options?.initialMessageSnapshot?.cursor,
				messageVersion: options?.initialMessageSnapshot?.messageVersion,
			});
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

		let props: { narratorId: string; cursor?: CatchUpCursor; messageVersion?: number } = {
			narratorId: "n1",
			cursor: { parentLastMessageId: "n1-tail" },
			messageVersion: 4,
		};
		function Harness(): ReactNode {
			useNarratorWS(
				props.narratorId,
				{},
				props.cursor || props.messageVersion != null
					? { cursor: props.cursor, messageVersion: props.messageVersion }
					: undefined,
				{ kind: "messages" },
			);
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
			props = {
				narratorId: "n2",
				cursor: { parentLastMessageId: "n2-tail" },
				messageVersion: 7,
			};
			root.render(createElement(Harness));
			await settle();

			expect(subscribeCalls).toEqual([
				{
					narratorId: "n1",
					cursor: { parentLastMessageId: "n1-tail" },
					messageVersion: 4,
				},
				{ narratorId: "n2", cursor: undefined, messageVersion: undefined },
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
		const receipts: unknown[] = [];
		function Harness(): ReactNode {
			useNarratorWS(narratorId, {
				onSendDeliveryResolved: (
					toolUseId,
					targets,
					parentToolUseId,
					toolCallBinding,
					targetCount,
				) => receipts.push({ toolUseId, targets, parentToolUseId, toolCallBinding, targetCount }),
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
			const targets = [
				{
					id: "child",
					deliveryMessageId: "reserved",
					title: "Worker",
					injectionConsumedAt: "2026-07-18T00:00:00.000Z",
				},
			];
			const targetCount = 3;
			const toolCallBinding = { toolCallId: "row", attempt: 2 };
			newListener?.({
				type: "send_delivery_resolved",
				narratorId: "n2",
				toolUseId: "send-tool",
				targets,
				toolCallBinding,
				targetCount,
			});
			expect(receipts).toEqual([
				{
					toolUseId: "send-tool",
					targets,
					parentToolUseId: undefined,
					toolCallBinding,
					targetCount,
				},
			]);
			oldListener?.({
				type: "send_delivery_resolved",
				narratorId: "n1",
				toolUseId: "stale-send",
				targets,
			});
			expect(receipts).toHaveLength(1);
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
	const changedFile = {
		filePath: "/repo/a.ts",
		linesAdded: 2,
		linesRemoved: 1,
		editCount: 1,
	};
	const fileChanges = {
		files: [changedFile],
		totalFiles: 1,
		totalUnmeasured: 0,
		bashTouchedCount: 2,
		countsTruncated: false,
	};
	function normalizeActivity(fields: Record<string, unknown>) {
		return normalizeSubagentActivityCatchUp([
			{ parentToolUseId: "parent-tool", activity: { latestToolCalls: [], ...fields } },
		])[0].activity;
	}

	test("preserves nonempty legacy file changes without inventing optional metadata", () => {
		expect(normalizeActivity({ fileChanges }).fileChanges).toEqual(fileChanges);
	});

	test("forwards an explicitly empty file-change aggregate", () => {
		const empty = { ...fileChanges, files: [], totalFiles: 0, bashTouchedCount: 0 };
		expect(normalizeActivity({ fileChanges: empty }).fileChanges).toEqual(empty);
	});

	test("omits absent file changes rather than synthesizing an empty aggregate", () => {
		for (const fields of [{}, { fileChanges: undefined }]) {
			expect(normalizeActivity(fields)).not.toHaveProperty("fileChanges");
		}
	});

	test("preserves file lists beyond the card preview up to the actual aggregate limit", () => {
		// queryChanges forwards all files up to MAX_AGGREGATED_FILES (2000), not
		// just CARD_FILE_LIST_MAX (5). A ten-file reconnect must keep all ten rows.
		for (const length of [5, 10, 2000]) {
			const projection = {
				...fileChanges,
				files: Array.from({ length }, (_, index) => ({
					...changedFile,
					filePath: `/repo/${index}.ts`,
				})),
				totalFiles: length,
				countsTruncated: length === 2000,
			};
			expect(normalizeActivity({ fileChanges: projection }).fileChanges).toEqual(projection);
		}
	});

	test("omits oversized aggregates without forwarding a silently truncated list", () => {
		const files = Array.from({ length: 2001 }, (_, index) => ({
			...changedFile,
			filePath: `/repo/${index}.ts`,
		}));
		expect(
			normalizeActivity({ fileChanges: { ...fileChanges, files, totalFiles: files.length } }),
		).not.toHaveProperty("fileChanges");
	});

	test("preserves optional attribution, nullable measurements and workspace metadata", () => {
		for (const attributionScope of ["exact_attempt", "mixed", "legacy_unscoped"] as const) {
			for (const outsideParentWorkspace of [true, false, null]) {
				const projection = {
					...fileChanges,
					files: [
						{
							...changedFile,
							linesAdded: null,
							linesRemoved: null,
							unmeasuredCount: 1,
							subagentNarratorId: "subagent-1",
							deviceId: "local",
							workspacePath: "/repo",
							outsideParentWorkspace,
						},
					],
					totalUnmeasured: 1,
					attributionScope,
					scope: {
						sourceToolUseId: "parent-tool",
						startedAt: "2026-09-01T00:00:00.000Z",
						completedAt: null,
					},
				};
				expect(normalizeActivity({ fileChanges: projection }).fileChanges).toEqual(projection);
			}
		}
		const nullable = {
			...fileChanges,
			files: [{ ...changedFile, subagentNarratorId: null, deviceId: null, workspacePath: null }],
			scope: { sourceToolUseId: null },
		};
		expect(normalizeActivity({ fileChanges: nullable }).fileChanges).toEqual(nullable);
	});

	test("rejects malformed aggregate shapes and counts without replacing previous data", () => {
		const malformed: unknown[] = [
			null,
			false,
			"changes",
			[],
			{},
			{ ...fileChanges, files: null },
			{ ...fileChanges, files: {} },
			{ ...fileChanges, countsTruncated: "false" },
			{ ...fileChanges, countsTruncated: undefined },
		];
		for (const key of ["totalFiles", "totalUnmeasured", "bashTouchedCount"]) {
			for (const invalid of [
				undefined,
				null,
				"1",
				-1,
				0.5,
				Number.MAX_SAFE_INTEGER + 1,
				Number.NaN,
				Infinity,
				-Infinity,
			]) {
				malformed.push({ ...fileChanges, [key]: invalid });
			}
		}
		for (const value of malformed) {
			const activity = normalizeActivity({ fileChanges: value });
			expect(activity).not.toHaveProperty("fileChanges");
			expect({ fileChanges, ...activity }.fileChanges).toEqual(fileChanges);
		}
	});

	test("rejects the entire file-change snapshot if any file row is malformed", () => {
		const malformed: unknown[] = [
			null,
			[],
			"file",
			{},
			{ ...changedFile, filePath: " " },
			{ ...changedFile, filePath: 42 },
			{ ...changedFile, filePath: undefined },
			{ ...changedFile, outsideParentWorkspace: "false" },
		];
		for (const key of ["linesAdded", "linesRemoved", "editCount", "unmeasuredCount"]) {
			for (const invalid of [
				"1",
				-1,
				0.5,
				Number.MAX_SAFE_INTEGER + 1,
				Number.NaN,
				Infinity,
				-Infinity,
			]) {
				malformed.push({ ...changedFile, [key]: invalid });
			}
		}
		for (const key of ["linesAdded", "linesRemoved", "editCount"]) {
			malformed.push({ ...changedFile, [key]: undefined });
		}
		malformed.push({ ...changedFile, editCount: null });
		malformed.push({ ...changedFile, unmeasuredCount: null });
		for (const key of ["subagentNarratorId", "deviceId", "workspacePath"]) {
			malformed.push({ ...changedFile, [key]: 42 });
		}
		for (const invalid of malformed) {
			// Neither a sole bad row nor a mixed valid/invalid list may be filtered.
			for (const files of [[invalid], [changedFile, invalid]]) {
				expect(
					normalizeActivity({ fileChanges: { ...fileChanges, files, totalFiles: files.length } }),
				).not.toHaveProperty("fileChanges");
			}
		}
	});

	test("rejects invalid optional scope metadata and strips unknown fields", () => {
		for (const metadata of [
			{ attributionScope: "unknown" },
			{ attributionScope: null },
			{ scope: null },
			{ scope: [] },
			{ scope: {} },
			{ scope: { sourceToolUseId: 42 } },
			{ scope: { sourceToolUseId: null, startedAt: 42 } },
			{ scope: { sourceToolUseId: null, completedAt: false } },
		]) {
			expect(
				normalizeActivity({ fileChanges: { ...fileChanges, ...metadata } }),
			).not.toHaveProperty("fileChanges");
		}
		expect(
			normalizeActivity({
				fileChanges: {
					...fileChanges,
					unknown: "ignored",
					files: [{ ...changedFile, unknown: "ignored" }],
					scope: { sourceToolUseId: null, unknown: "ignored" },
				},
			}).fileChanges,
		).toEqual({ ...fileChanges, scope: { sourceToolUseId: null } });
	});

	test("preserves only explicit true takeover state on reconnect", () => {
		expect(normalizeActivity({ takenOver: true }).takenOver).toBe(true);
		for (const takenOver of [undefined, null, false, "true", 1]) {
			expect(normalizeActivity({ takenOver })).not.toHaveProperty("takenOver");
		}
	});

	test("normalizes the canonical array contract", () => {
		const activity = {
			subagentNarratorId: "subagent-1",
			model: "model-1",
			reasoningEffort: "max",
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
					reasoningEffort: "max",
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

	// Reconnect catch-up ships the same projected summary the REST fetch does. Dropping
	// it here used to re-blank every activity row the moment a reconnect snapshot
	// replaced the fetched activity.
	test("keeps the projected input summary on catch-up headers", () => {
		const result = normalizeSubagentActivityCatchUp([
			{
				parentToolUseId: "parent-tool",
				activity: {
					subagentNarratorId: "sub-1",
					model: null,
					latestToolCalls: [
						{
							toolCallId: "row-1",
							toolUseId: "tool-1",
							toolName: "Bash",
							status: "success",
							inputSummary: { description: "列出文件", command: "ls -la" },
						},
					],
				},
			},
		]);
		expect(result[0].activity.latestToolCalls[0].inputSummary).toEqual({
			description: "列出文件",
			command: "ls -la",
		});
	});

	test("re-applies the whitelist and cap to an untrusted summary", () => {
		const result = normalizeSubagentActivityCatchUp([
			{
				parentToolUseId: "parent-tool",
				activity: {
					subagentNarratorId: null,
					model: null,
					latestToolCalls: [
						{
							toolCallId: null,
							toolUseId: "tool-1",
							toolName: "Write",
							status: "running",
							// A frame that tried to smuggle the payload through the summary field.
							inputSummary: { file_path: "/repo/a.ts", content: "z".repeat(5_000) },
						},
					],
				},
			},
		]);
		expect(result[0].activity.latestToolCalls[0].inputSummary).toEqual({
			file_path: "/repo/a.ts",
		});
	});

	test("omits the key entirely when no whitelisted value survives", () => {
		const result = normalizeSubagentActivityCatchUp([
			{
				parentToolUseId: "parent-tool",
				activity: {
					subagentNarratorId: null,
					model: null,
					latestToolCalls: [
						{
							toolCallId: null,
							toolUseId: "tool-1",
							toolName: "Read",
							status: "running",
							inputSummary: { unknown_key: "ignored" },
						},
					],
				},
			},
		]);
		// Absent, not `{}`: the tree merge spreads an incoming header over the existing
		// one, so an empty object would overwrite a label already on screen.
		expect(result[0].activity.latestToolCalls[0]).not.toHaveProperty("inputSummary");
	});
});
