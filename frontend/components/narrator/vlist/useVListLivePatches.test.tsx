import { expect, spyOn, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { messageBody, rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { normalizeSubagentToolInputSummary } from "@shared/subagent-tool-summary";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MeasuredSubagent, SubagentCardData } from "./measure/measure-subagent";
import { installCanvasStub } from "./measure/test-canvas-stub";
import type { AdapterSegment } from "./segment-adapter";
import { useVListLivePatches } from "./useVListLivePatches";

function row(narratorId = "n1"): TreeMessage {
	return {
		id: "m1",
		narratorId,
		role: "assistant",
		parentToolUseId: null,
		contentText: null,
		toolCalls: [],
		createdAt: "2026-10-01T00:00:00Z",
		blocks: [
			{
				id: "persistent-b",
				kind: "reasoning",
				subtype: null,
				phase: "done",
				revision: 2,
				wireId: null,
				attemptId: null,
				hasOriginal: false,
				named: true,
				elements: [{ type: "reasoning", id: "element", text: "abcdef" }],
			},
		],
	};
}

test("reduced child frames reach the parent adapter, cached measure and rendered card", async () => {
	const disposeCanvas = installCanvasStub();
	const { MantineProvider } = await import("@mantine/core");
	const { renderToStaticMarkup } = await import("react-dom/server");
	const { RenderSubagent } = await import("./render/RenderSubagent");
	const { subagentRecentCallSummary } = await import("../tool-call/tool-display");
	const { measureElementCached } = await import("./registry");
	const { measureCache } = await import("./measure-cache");
	const { adaptSegments } = await import("./segment-adapter");
	const { segmentMessages } = await import("../message/message-segments");
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	let nextRaf = 0;
	const frames = new Map<number, FrameRequestCallback>();
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextRaf, callback);
			return nextRaf;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
	};
	const previous = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(values)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const subscribe = spyOn(narratorWSManager, "subscribe").mockImplementation((ids, options) => ({
		_id: 9877,
		_narratorIds: ids,
		_kind: options?.kind ?? "messages",
	}));
	const unsubscribe = spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
	const connection = spyOn(narratorWSManager, "onConnectionChange").mockImplementation(
		() => () => {},
	);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const agentRow = (narratorId = "n1", child: string | null = "child"): TreeMessage =>
		rowWithElements({ ...row(narratorId), toolCalls: [] }, [
			{
				type: "tool_use",
				id: "agent",
				name: "Agent",
				status: "running",
				inputJson: { description: "Check listening port", subagent_type: "explore" },
				...(child
					? { _subagentActivity: { subagentNarratorId: child, model: null, latestToolCalls: [] } }
					: {}),
			},
		]);
	let current: readonly TreeMessage[] = [];
	let replace = (_rows: readonly TreeMessage[]) => {};
	let applications = 0;
	let unapplied = 0;
	function Harness({
		narratorId = "n1",
		enabled = true,
	}: {
		narratorId?: string;
		enabled?: boolean;
	}) {
		const [messages, setMessages] = useState<readonly TreeMessage[]>([agentRow()]);
		current = messages;
		replace = setMessages;
		useVListLivePatches(narratorId, {
			enabled,
			isSubagent: false,
			messages,
			onUnappliedToolCompletion: () => {
				unapplied++;
			},
			applyLivePatch: (livePatch) => {
				const result = livePatch(current);
				if (result.changed) {
					applications++;
					current = result.messages;
					setMessages(result.messages);
				}
				return result.changed;
			},
		});
		return null;
	}
	const raf = async () => {
		await act(async () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(performance.now());
		});
	};
	const frame = async (value: Record<string, unknown>) => {
		await act(async () =>
			narratorWSManager.dispatchLocalFrame({ narratorId: "n1", ...value } as never),
		);
		await raf();
	};
	function probe(messages = current) {
		const specs = adaptSegments(
			segmentMessages(messages as TreeMessage[]) as unknown as AdapterSegment[],
			{
				lod: 5,
				resolveSubagentRecentSummary: (name, summary) =>
					subagentRecentCallSummary(name, normalizeSubagentToolInputSummary(summary)),
				resolveToolCategory: () => "search",
			},
		);
		const spec = specs.find((entry) => entry.kind === "subagent-card");
		if (!spec) throw new Error("parent subagent card missing");
		const data = spec.data as SubagentCardData & {
			recentCallNames: string[];
			resultPreview?: string;
		};
		const measured = measureElementCached(
			spec.kind,
			data,
			700,
			5,
			spec.opts,
			spec.key,
			"fixed-message-version",
		) as MeasuredSubagent;
		const html = renderToStaticMarkup(
			<MantineProvider>
				<RenderSubagent
					measured={measured}
					description={data.description}
					agentType={data.agentType}
					recentCallNames={data.recentCallNames}
					resultPreview={data.resultPreview}
					isActive={!data.isTerminal}
				/>
			</MantineProvider>,
		);
		return { specs, data, measured, html };
	}
	const childChunk = (id: number, pattern: string) => ({
		type: "tool_use_chunk",
		toolUseId: `grep-${id}`,
		toolName: "Grep",
		parentToolUseId: "agent",
		subagentNarratorId: "child",
		toolCallId: `call-${id}`,
		createdAt: 1000 + id,
		inputCharsTotal: 99,
		inputSummary: { pattern, path: "excluded", content: "excluded" },
	});
	const activity = () => {
		const value = messageBody(current[0])[0]._subagentActivity;
		if (!value) throw new Error("parent activity missing");
		return value;
	};
	try {
		measureCache.clear();
		await act(async () => root.render(<Harness />));
		await raf();
		// Parent is outside the loaded document during the child's whole lifecycle.
		await act(async () => replace([]));
		await frame({ ...childChunk(1, "parent-late"), type: "tool_started", executionAttempt: 1 });
		await frame({
			...childChunk(1, "ignored"),
			type: "tool_completed",
			executionAttempt: 1,
			status: "success",
			inputSummary: undefined,
			durationMs: 2000,
		});
		await act(async () => replace([agentRow()]));
		await raf();
		expect(probe().measured.recentCallSummaries).toEqual(["parent-late"]);
		expect(probe().html).toContain("parent-late");
		expect(probe().html).toContain("2s");
		await frame({
			...childChunk(1, "ignored"),
			type: "tool_completed",
			executionAttempt: 1,
			status: "success",
			inputSummary: null,
			durationMs: 2000,
		});
		expect(probe().measured.recentCallSummaries).toEqual([null]);
		await frame({ ...childChunk(1, "late-revival"), executionAttempt: 1 });
		expect(probe().measured.recentCallSummaries).toEqual([null]);
		for (const [index, toolName, inputSummary, label] of [
			[1, "Read", { file_path: "/repo/server.ts" }, "server.ts"],
			[2, "Glob", { pattern: "**/*.tsx" }, "**/*.tsx"],
			[3, "Grep", { pattern: "listenPort" }, "listenPort"],
			[4, "Bash", { description: "Inspect listening port" }, "Inspect listening port"],
		] as const) {
			const event = {
				...childChunk(index, "ignored"),
				toolName,
				inputSummary,
				executionAttempt: 1,
			};
			await act(async () => replace([]));
			await frame({ ...event, type: "tool_started" });
			await act(async () => replace([agentRow()]));
			await raf();
			await frame({
				...event,
				type: "tool_completed",
				status: "success",
				durationMs: 2000,
				inputSummary: undefined,
			});
			expect(probe().measured.recentCallSummaries).toEqual([label]);
			expect(probe().html).toContain(label);
			expect(probe().html).toContain("2s");
			// Completion evidence alone also labels a completed background parent's child.
			await act(async () => replace([]));
			await frame({ ...event, type: "tool_completed", status: "success", durationMs: 3000 });
			await act(async () =>
				replace([
					rowWithElements(
						agentRow(),
						messageBody(agentRow()).map((block) => ({ ...block, status: "success" })),
					),
				]),
			);
			await raf();
			expect(probe().html).toContain(label);
			expect(probe().html).toContain("3s");
		}
		// started and completed in a single RAF cannot replace each other's closures.
		await act(async () => replace([]));
		await act(async () => {
			for (const type of ["tool_started", "tool_completed"]) {
				narratorWSManager.dispatchLocalFrame({
					narratorId: "n1",
					...childChunk(1, "same-frame"),
					type,
					executionAttempt: 1,
					status: "success",
					durationMs: 4000,
					...(type === "tool_completed" ? { inputSummary: undefined } : {}),
				} as never);
			}
		});
		await raf();
		// Coordinator/document can land before the hook's loaded-message prop updates.
		current = [agentRow()];
		await frame({ type: "message_updated", message: current[0] });
		expect(probe().measured.recentCallSummaries).toEqual(["same-frame"]);
		expect(probe().html).toContain("4s");
		const beforeNoop = applications;
		await frame({
			...childChunk(1, "same-frame"),
			type: "tool_completed",
			executionAttempt: 1,
			status: "success",
			durationMs: 4000,
		});
		await raf();
		expect(applications).toBe(beforeNoop);
		expect(frames.size).toBe(0);
		for (const type of ["message", "catch_up"]) {
			await act(async () => replace([]));
			await frame({ ...childChunk(1, type), type: "tool_started" });
			current = [agentRow()];
			await frame({
				type,
				message: current[0],
				topLevel: [],
				orphanChildren: [],
				subagentActivities: [],
			});
			expect(probe().measured.recentCallSummaries).toEqual([type]);
			expect(probe().html).toContain(type);
		}
		await act(async () => replace([agentRow()]));
		await act(async () => {
			narratorWSManager.dispatchLocalFrame({
				narratorId: "n1",
				...childChunk(2, "loaded-sibling"),
			} as never);
			narratorWSManager.dispatchLocalFrame({
				narratorId: "n1",
				...childChunk(3, "missing-sibling"),
				parentToolUseId: "late-agent",
			} as never);
		});
		await raf();
		expect(probe().html).toContain("loaded-sibling");
		const lateParent = rowWithElements(
			{ ...agentRow(), id: "late-parent-row" },
			messageBody(agentRow()).map((block) => ({ ...block, id: "late-agent" })),
		);
		await act(async () => replace([...current, lateParent]));
		await raf();
		expect(probe([current[1]]).html).toContain("missing-sibling");
		// A streaming snapshot carries the same three-state evidence while the parent is absent.
		await act(async () => replace([]));
		await frame({
			type: "streaming_snapshot",
			streamingBlocks: [],
			toolChunks: [childChunk(1, "snapshot-late")],
		});
		await act(async () => replace([agentRow()]));
		await raf();
		expect(probe().html).toContain("snapshot-late");
		await frame({
			type: "streaming_snapshot",
			streamingBlocks: [],
			toolChunks: [{ ...childChunk(1, "ignored"), inputSummary: null }],
		});
		expect(probe().measured.recentCallSummaries).toEqual([null]);
		await frame({
			type: "streaming_snapshot",
			streamingBlocks: [],
			toolChunks: [{ ...childChunk(1, "ignored"), inputSummary: { path: "invalid" } }],
		});
		expect(probe().measured.recentCallSummaries).toEqual([null]);
		await act(async () => replace([]));
		await frame({
			type: "catch_up",
			topLevel: [],
			orphanChildren: [],
			subagentActivities: [
				{
					parentToolUseId: "agent",
					activity: {
						subagentNarratorId: "child",
						model: null,
						latestToolCalls: [
							{
								toolUseId: "catchup-read",
								toolCallId: "catchup-call",
								executionAttempt: 1,
								toolName: "Read",
								status: "success",
								createdAt: 1,
								timing: { durationMs: 2000 },
								inputSummary: { file_path: "/repo/reconnected.ts" },
							},
						],
					},
				},
			],
		});
		await act(async () => replace([agentRow()]));
		await raf();
		expect(probe().html).toContain("reconnected.ts");
		expect(probe().html).toContain("2s");
		// Discard, deletion, replacement identity and disable end the compensation window.
		for (const cleanup of ["discard", "deletion", "identity", "disabled"]) {
			await act(async () => replace([]));
			await frame({ ...childChunk(1, cleanup), toolCallId: undefined });
			if (cleanup === "discard")
				await frame({
					type: "tool_use_discarded",
					parentToolUseId: "agent",
					subagentNarratorId: "child",
					toolUseIds: ["grep-1"],
				});
			if (cleanup === "deletion")
				await frame({ type: "messages_deleted", deletedMessageIds: ["unloaded-parent"] });
			if (cleanup === "identity")
				await frame({
					type: "subagent_started",
					toolUseId: "agent",
					subagentNarratorId: "replacement-child",
				});
			if (cleanup === "disabled") {
				await act(async () => root.render(<Harness enabled={false} />));
				await act(async () => root.render(<Harness />));
			}
			await act(async () => replace([agentRow()]));
			await raf();
			expect(activity().latestToolCalls).toEqual([]);
		}
		const beforeOverflow = unapplied;
		await act(async () => {
			for (let index = 0; index < 132; index++) {
				narratorWSManager.dispatchLocalFrame({
					narratorId: "n1",
					...childChunk(index, "bounded"),
					parentToolUseId: `unloaded-${index}`,
				} as never);
			}
		});
		await raf();
		expect(unapplied).toBe(beforeOverflow + 1);
		await frame({ type: "messages_deleted", deletedMessageIds: ["unloaded-parent"] });
		await act(async () => replace([agentRow()]));
		const beforeTopLevel = applications;
		await frame({ ...childChunk(1, "top-level-only"), parentToolUseId: undefined });
		expect(applications).toBe(beforeTopLevel);
		expect(activity().latestToolCalls).toEqual([]);
		await frame(childChunk(1, "listen"));
		const first = probe();
		expect(first.html).toContain("listen");
		expect(first.measured.recentCallSummaries).toEqual(["listen"]);
		expect(first.specs).toHaveLength(1);
		expect(messageBody(current[0])).toHaveLength(1);
		expect(activity().latestToolCalls[0].inputSummary).toEqual({ pattern: "listen" });
		const beforeDuplicate = applications;
		await frame(childChunk(1, "listen"));
		expect(applications).toBe(beforeDuplicate);
		await frame(childChunk(1, "defaultPort"));
		const labelled = probe();
		expect(labelled.measured).not.toBe(first.measured);
		expect(labelled.measured.height).toBe(first.measured.height);
		expect(labelled.html).toContain("defaultPort");

		const preparing = { ...childChunk(9, "discard me"), toolCallId: undefined };
		await frame(preparing);
		await frame({ type: "tool_use_discarded", parentToolUseId: "agent", toolUseIds: ["grep-9"] });
		expect(activity().latestToolCalls).toHaveLength(2);
		await frame({
			type: "tool_use_discarded",
			parentToolUseId: "agent",
			subagentNarratorId: "old-child",
			toolUseIds: ["grep-9"],
		});
		expect(activity().latestToolCalls).toHaveLength(2);
		await frame({
			type: "tool_use_discarded",
			parentToolUseId: "agent",
			subagentNarratorId: "child",
			toolUseIds: ["grep-1", "grep-9"],
		});
		expect(activity().latestToolCalls.map((call) => call.toolUseId)).toEqual(["grep-1"]);
		await frame({ ...preparing, executionAttempt: 2 });
		await frame({
			type: "tool_use_discarded",
			parentToolUseId: "agent",
			subagentNarratorId: "child",
			toolUseIds: ["grep-9"],
		});
		expect(
			activity().latestToolCalls.find((call) => call.toolUseId === "grep-9")?.executionAttempt,
		).toBe(2);
		// The next display scenario owns a new activity window; grep-9 above has
		// createdAt=1009 and must remain newer than replayed 1001/1002/1003 calls.
		await act(async () => replace([agentRow()]));
		for (let id = 1; id <= 3; id++) {
			await frame({
				...childChunk(id, `pattern-${id}`),
				type: "tool_started",
				executionAttempt: 1,
			});
			await frame({
				...childChunk(id, `pattern-${id}`),
				type: "tool_completed",
				executionAttempt: 1,
				status: "success",
				completedAt: 5000 + id,
				durationMs: id * 1000,
				inputSummary: undefined,
			});
		}
		expect(activity().latestToolCalls.map((call) => call.toolUseId)).toEqual([
			"grep-1",
			"grep-2",
			"grep-3",
		]);
		const sparseHeaders = activity().latestToolCalls.map(
			({ inputSummary: _summary, ...header }) => header,
		);
		await frame({
			type: "catch_up",
			topLevel: [],
			orphanChildren: [],
			subagentActivities: [
				{
					parentToolUseId: "agent",
					activity: { subagentNarratorId: "child", model: null, latestToolCalls: sparseHeaders },
				},
			],
		});
		const completed = probe();
		expect(completed.measured.recentCallSummaries).toEqual(["pattern-1", "pattern-2", "pattern-3"]);
		expect(completed.measured.recentCallTimings.map((call) => call.status)).toEqual([
			"success",
			"success",
			"success",
		]);
		expect(completed.measured.recentCallTimings.map((call) => call.durationMs)).toEqual([
			1000, 2000, 3000,
		]);
		const drawn = parseHTML(completed.html).document.querySelectorAll(
			'[data-testid="subagent-activity"]',
		);
		expect(drawn).toHaveLength(3);
		for (let index = 0; index < drawn.length; index++) {
			expect(drawn[index].textContent).toContain(`pattern-${index + 1}`);
			expect(drawn[index].textContent).toContain(`${index + 1}s`);
			expect(drawn[index].querySelector('[data-testid="trace-row-status-slot"]')).toBeNull();
		}
		const beforeLateDiscard = applications;
		await frame({
			type: "tool_use_discarded",
			parentToolUseId: "agent",
			subagentNarratorId: "child",
			toolUseIds: ["grep-1", "grep-2", "grep-3"],
		});
		expect(applications).toBe(beforeLateDiscard);
		await frame(childChunk(1, "late-pattern"));
		await frame({
			type: "streaming_snapshot",
			streamingBlocks: [],
			toolChunks: [
				{
					...childChunk(2, "snapshot-pattern"),
					started: false,
				},
			],
		});
		for (const call of activity().latestToolCalls) {
			expect(call.status).toBe("success");
			expect(call.timing?.durationMs).toBe(Number(call.toolUseId.slice(-1)) * 1000);
			expect(call.inputSummary?.pattern).toBe(`pattern-${call.toolUseId.slice(-1)}`);
		}
		await act(async () => replace([agentRow("n1", "replacement-child")]));
		await frame(childChunk(1, "stale-child"));
		await frame({
			type: "subagent_conclusion_updated",
			subagentNarratorId: "child",
			toolUseId: "agent",
			output: "old child result",
			hasError: false,
		});
		expect(activity().subagentNarratorId).toBe("replacement-child");
		expect(activity().latestToolCalls).toEqual([]);
		expect(messageBody(current[0])[0].outputJson).toBeUndefined();
		// Restore the bounded activity solely from subscription chunks, before started.
		await act(async () => replace([agentRow()]));
		await frame({
			type: "streaming_snapshot",
			streamingBlocks: [],
			toolChunks: [
				childChunk(1, "restored-1"),
				childChunk(2, "restored-2"),
				childChunk(3, "restored-3"),
			],
		});
		expect(probe().measured.recentCallSummaries).toEqual([
			"restored-1",
			"restored-2",
			"restored-3",
		]);
		// Cold loaded activity needs no live event to label the card.
		const cold = current;
		await act(async () => replace(cold.map((message) => ({ ...message }))));
		expect(probe().html).toContain("restored-2");
		const restored = activity().latestToolCalls;
		await frame({
			type: "catch_up",
			topLevel: [],
			orphanChildren: [],
			subagentActivities: [
				{
					parentToolUseId: "agent",
					activity: {
						subagentNarratorId: "child",
						model: null,
						latestToolCalls: [
							{ ...restored[0], inputSummary: null },
							{ ...restored[1], inputSummary: { path: "not-whitelisted" } },
							restored[2],
						],
					},
				},
			],
		});
		expect(probe().measured.recentCallSummaries).toEqual([null, "restored-2", "restored-3"]);
		await frame({
			type: "background_task_completed",
			taskNarratorId: "child",
			toolUseId: "agent",
			resultPreview: "Background port check finished",
		});
		const background = probe();
		expect(messageBody(current[0])[0].outputJson).toEqual([
			{ type: "text", text: "Background port check finished" },
		]);
		expect(background.data.resultPreview).toBe("Background port check finished");
		expect(background.html).toContain("Background port check finished");

		// A conclusion can race the parent tool's persisted row/checkpoint.
		await act(async () => replace([]));
		await frame({
			type: "subagent_conclusion_updated",
			subagentNarratorId: "child",
			toolUseId: "agent",
			output: "Port 7779 confirmed",
			hasError: false,
			durationMs: 4321,
		});
		expect(current).toHaveLength(0);
		await frame({
			type: "tool_completed",
			toolUseId: "agent",
			toolName: "Agent",
			status: "success",
			output: "Background task started",
		});
		await act(async () => replace([agentRow("n1", null)]));
		await raf();
		expect(probe().data.resultPreview).toBe("Background task started");
		await frame({ type: "subagent_started", toolUseId: "agent", subagentNarratorId: "child" });
		await raf();
		const conclusion = probe();
		expect(conclusion.data.resultPreview).toBe("Port 7779 confirmed");
		expect(conclusion.html).toContain("Port 7779 confirmed");
		expect(messageBody(current[0])[0].status).toBe("success");
		await act(async () => replace([]));
		const beforeOversized = unapplied;
		await frame({
			type: "subagent_conclusion_updated",
			subagentNarratorId: "child",
			toolUseId: "agent",
			output: "x".repeat(120_001),
			hasError: false,
		});
		expect(unapplied).toBeGreaterThan(beforeOversized);
		await act(async () => replace([agentRow()]));
		await raf();
		expect(messageBody(current[0])[0].outputJson).toBeUndefined();
		const beforeMixedMisses = unapplied;
		const beforeMixedApplications = applications;
		await act(async () => {
			// The child header hits while two unretainable conclusions miss the same
			// loaded document. A successful sibling must not suppress reconciliation.
			narratorWSManager.dispatchLocalFrame({
				narratorId: "n1",
				...childChunk(1, "mixed-frame"),
			} as never);
			for (const output of ["x".repeat(120_001), [{ type: "text", text: "unloaded result" }]]) {
				narratorWSManager.dispatchLocalFrame({
					narratorId: "n1",
					type: "subagent_conclusion_updated",
					subagentNarratorId: "child",
					toolUseId: "unloaded-agent",
					output,
					hasError: false,
				} as never);
			}
		});
		await raf();
		expect(applications).toBe(beforeMixedApplications + 1);
		expect(unapplied).toBe(beforeMixedMisses + 1);
		expect(activity().latestToolCalls[0].inputSummary).toEqual({ pattern: "mixed-frame" });
		await act(async () => replace([agentRow()]));
		for (let index = 0; index < 5; index++) {
			const conclusionFrame = {
				type: "subagent_conclusion_updated",
				subagentNarratorId: "child",
				toolUseId: `waiting-${index}`,
				output: "x".repeat(120_000),
				hasError: false,
			};
			if (index < 4) {
				await frame(conclusionFrame);
				continue;
			}
			const beforeFullBudget = unapplied;
			await act(async () => {
				narratorWSManager.dispatchLocalFrame({
					narratorId: "n1",
					...childChunk(1, "full-budget"),
				} as never);
				narratorWSManager.dispatchLocalFrame({ narratorId: "n1", ...conclusionFrame } as never);
			});
			await raf();
			expect(unapplied).toBe(beforeFullBudget + 1);
		}
		const waitingRows = Array.from({ length: 5 }, (_, index) =>
			rowWithElements({ ...row(), id: `waiting-message-${index}` }, [
				{
					type: "tool_use",
					id: `waiting-${index}`,
					name: "Agent",
					_subagentActivity: { subagentNarratorId: "child", model: null, latestToolCalls: [] },
				},
			]),
		);
		await act(async () => replace(waitingRows));
		await raf();
		for (let index = 0; index < 4; index++) {
			expect(messageBody(current[index])[0].outputJson).toHaveLength(120_000);
		}
		expect(messageBody(current[4])[0].outputJson).toBeUndefined();
		await act(async () => replace([]));
		await frame({
			type: "subagent_conclusion_updated",
			subagentNarratorId: "child",
			toolUseId: "agent",
			output: "stale conclusion",
			hasError: false,
		});
		await frame(childChunk(1, "stale pending child"));
		await act(async () => {
			root.render(<Harness narratorId="n2" />);
			replace([agentRow("n2")]);
		});
		await raf();
		expect(messageBody(current[0])[0].outputJson).toBeUndefined();
		expect(activity().latestToolCalls).toEqual([]);
		await act(async () => replace([]));
		await frame({ ...childChunk(1, "unmounted child"), narratorId: "n2" });
		await act(async () => root.render(null));
		await act(async () => root.render(<Harness />));
		await raf();
		expect(activity().latestToolCalls).toEqual([]);
	} finally {
		await act(async () => root.unmount());
		container.remove();
		subscribe.mockRestore();
		unsubscribe.mockRestore();
		connection.mockRestore();
		measureCache.clear();
		disposeCanvas();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
