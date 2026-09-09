/**
 * vlist-live-wiring.test.ts — Guards the LIVE LIFECYCLE subscription set and the
 * queue that drains it.
 *
 * The original defect was a silent omission, not a logic error: the exact shell
 * simply never subscribed to `tool_completed` or to any reflection event, so
 * finished tools rendered as "running" and resolved gates as "reflecting"
 * indefinitely. Nothing failed loudly — the UI just told the truth about a state
 * it had stopped receiving.
 *
 * Which invariants are asserted HOW
 * --------------------------------
 * Source-text scanning is kept for exactly one class of invariant: a REQUIRED (or
 * FORBIDDEN) callback NAME in the subscription object literal. That set is a
 * checklist against the backend's event list, it has no runtime representation to
 * observe, and the assertion is stable because the names are the WS contract — the
 * only way to "refactor past" it is to actually stop subscribing.
 *
 * Everything else is asserted BEHAVIOURALLY. The earlier version pinned things
 * like `not.toContain("reload(")` and sliced a source range to prove a hook was
 * not gated on `pinnedToBottom`, which was fragile in both directions: renaming a
 * function slipped past it, and merely writing the word `pinnedToBottom` in a
 * comment inside the sliced range failed it. Those now run the real code: the
 * queue coalesces, rejects a stale narrator's batch, and the shell's live-patch
 * path is driven with the reader scrolled up.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentBlock } from "../narrator-panel-types";
import { installCanvasStub } from "./measure/test-canvas-stub";

// The behavioural cases below drive the REAL layout pipeline, which measures text
// through pretext. Install the deterministic stub before any pretext-backed module
// loads (hence the dynamic imports inside the tests).
beforeAll(() => {
	installCanvasStub();
});

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");
const LIVE_HOOK = read("useVListLivePatches.ts");

/**
 * Every event whose absence silently corrupts a card's rendered state. Adding a
 * new lifecycle event to the backend? Add it here too, or the exact list will
 * quietly drift out of sync with reality again.
 */
const REQUIRED_EVENTS = [
	// Tool lifecycle — the original bug.
	"onToolStarted",
	"onToolCompleted",
	// The header's timeout editor: the commit goes out over WS and this frame is
	// the ONLY confirmation the card gets back.
	"onTimeoutUpdated",
	// A running Await-agent call resolving its target. Without this frame the row's
	// "open session" item stays hidden for the whole wait: the child narrator id does
	// not reach the persisted row until the tool RETURNS.
	"onAwaitAgentResolved",
	"onSendDeliveryResolved",
	// Permission decisions (persisted status half).
	"onPermissionRequest",
	"onPermissionResolved",
	// Reflection gates: 4 families × start / hand-back / resolve.
	"onDangerReflectionStarted",
	"onDangerReflectionStopped",
	"onDangerReflectionResolved",
	"onPlanReflectionStarted",
	"onPlanReflectionStopped",
	"onPlanReflectionResolved",
	"onTaskReflectionStarted",
	"onTaskReflectionStopped",
	"onTaskReflectionResolved",
	"onQuestionReflectionStarted",
	"onQuestionReflectionDisarmed",
	"onQuestionReflectionResolved",
	// Subagent cards.
	"onSubagentStarted",
	"onSubagentConclusionUpdated",
	// Background tasks.
	"onBackgroundTaskCompleted",
	"onBackgroundTaskFailed",
	"onBackgroundTaskCancelled",
	// Reconnect catch-up carries authoritative activity summaries.
	"onCatchUp",
];

/**
 * Streaming-frequency events that must stay OUT of the DOCUMENT PATCH channel.
 *
 * `tool_use_chunk` / `tool_output` fire per delta, and a document patch rebuilds
 * from the persisted message set — routing them here would mean a full rebuild per
 * chunk. They are handled by the live streaming ROW instead
 * (`useVListStreamingMessage` + `streaming-tool-chunks.ts`), which is rebuilt once
 * per frame anyway and leaves every committed row's measurement cached.
 *
 * Note this is now a ROUTING invariant, not a "we do not support them" one. For a
 * long time neither channel handled these events — the exclusion comment here
 * claimed they belonged to the streaming tail, while the tail only accumulated text
 * and reasoning. The result was no live tool card and no command output at all on
 * this path. `streaming-tool-chunks.test.ts` covers the fold; this only keeps them
 * off the expensive channel.
 *
 * `reflection_progress` stays out for the same reason: a running gate ticks several
 * times a second and its label is painted inside an already-measured fixed row, so
 * it belongs to the render-only store (`../reflection-progress-store.ts`), fed from
 * `useNarratorPanelWS`.
 */
const FORBIDDEN_EVENTS = ["onToolUseChunk", "onToolOutput", "onReflectionProgress"];
/** Events the streaming ROW must fold, so live tool state is never dropped again. */
const REQUIRED_STREAMING_ROW_EVENTS = [
	"onToolUseChunk",
	"onToolOutput",
	"onToolLongRunning",
	"onWebSearch",
	"onImageGeneration",
];

describe("vlist live lifecycle subscription set", () => {
	it("subscribes to every event whose omission would strand a card in a stale state", () => {
		const missing = REQUIRED_EVENTS.filter((event) => !LIVE_HOOK.includes(`${event}:`));
		expect(missing).toEqual([]);
	});

	it("keeps streaming-frequency tool events out of the document patch channel", () => {
		const present = FORBIDDEN_EVENTS.filter((event) => LIVE_HOOK.includes(`${event}:`));
		expect(present).toEqual([]);
	});

	it("folds those streaming-frequency events into the live row instead", () => {
		// The other half of the routing invariant. Without it, "not in the patch
		// channel" was satisfied by handling them NOWHERE — which is exactly the state
		// that left this path with no live tool cards and no command output.
		const streamingHook = read("useVListStreamingMessage.ts");
		const missing = REQUIRED_STREAMING_ROW_EVENTS.filter(
			(event) => !streamingHook.includes(`${event}:`),
		);
		expect(missing).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Queue behaviour: coalescing + narrator scoping (the hook's own logic)
// ─────────────────────────────────────────────────────────────────────────────

describe("LivePatchQueue", () => {
	type Msg = import("@frontend/lib/api").TreeMessage;
	type LivePatch = import("./vlist-live-patch").LivePatch;

	/** A manual scheduler so a "frame" is an explicit step, not a timing race. */
	function harness(narratorId: string | undefined) {
		const drains: (() => void)[] = [];
		const applied: LivePatch[] = [];
		let cancelled = 0;
		let current = narratorId;
		return {
			applied,
			get cancelled() {
				return cancelled;
			},
			get scheduled() {
				return drains.length;
			},
			setNarrator: (next: string | undefined) => {
				current = next;
			},
			frame: () => {
				const drain = drains.shift();
				drain?.();
			},
			host: {
				currentNarratorId: () => current,
				apply: (patch: LivePatch) => {
					applied.push(patch);
					return true;
				},
				schedule: (drain: () => void) => {
					drains.push(drain);
					return drains.length;
				},
				cancel: () => {
					cancelled++;
				},
			},
		};
	}

	const marker = (id: string): LivePatch => {
		return (messages) => ({
			messages: [...messages, { id } as unknown as Msg],
			changed: true,
		});
	};

	it("coalesces a burst of events into ONE apply per frame", async () => {
		// A turn finishing several tools at once must not rebuild the document once
		// per event. Asserted by counting applies, not by grepping for
		// requestAnimationFrame.
		const { LivePatchQueue } = await import("./vlist-live-patch");
		const h = harness("n1");
		const queue = new LivePatchQueue(h.host);
		queue.enqueue(marker("a"));
		queue.enqueue(marker("b"));
		queue.enqueue(marker("c"));
		expect(h.scheduled).toBe(1);
		expect(h.applied).toHaveLength(0);
		h.frame();
		expect(h.applied).toHaveLength(1);
		// The single composed patch really carries all three.
		const result = h.applied[0]?.([]);
		expect(result?.messages).toHaveLength(3);
	});

	it("drops a batch whose narrator changed before the frame drained", async () => {
		// THE window the effect cleanup cannot cover: React runs the new render (new
		// apply function already installed) before the previous effect's cleanup, so a
		// frame firing in between would write the old narrator's patches onto the new
		// document.
		const { LivePatchQueue } = await import("./vlist-live-patch");
		const h = harness("n1");
		const queue = new LivePatchQueue(h.host);
		queue.enqueue(marker("stale"));
		h.setNarrator("n2");
		h.frame();
		expect(h.applied).toHaveLength(0);
	});

	it("does not mix two narrators' patches into one batch", async () => {
		const { LivePatchQueue } = await import("./vlist-live-patch");
		const h = harness("n1");
		const queue = new LivePatchQueue(h.host);
		queue.enqueue(marker("old"));
		h.setNarrator("n2");
		queue.enqueue(marker("new"));
		h.frame();
		expect(h.applied).toHaveLength(1);
		const result = h.applied[0]?.([]);
		// Only the new narrator's patch survives.
		expect(result?.messages).toHaveLength(1);
		expect((result?.messages[0] as { id?: string } | undefined)?.id).toBe("new");
	});

	it("discards queued patches and cancels the frame on dispose", async () => {
		const { LivePatchQueue } = await import("./vlist-live-patch");
		const h = harness("n1");
		const queue = new LivePatchQueue(h.host);
		queue.enqueue(marker("a"));
		queue.dispose();
		expect(h.cancelled).toBe(1);
		h.frame();
		expect(h.applied).toHaveLength(0);
	});

	it("schedules a fresh frame after a drain (the queue stays usable)", async () => {
		const { LivePatchQueue } = await import("./vlist-live-patch");
		const h = harness("n1");
		const queue = new LivePatchQueue(h.host);
		queue.enqueue(marker("a"));
		h.frame();
		queue.enqueue(marker("b"));
		expect(h.scheduled).toBe(1);
		h.frame();
		expect(h.applied).toHaveLength(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Patch routing: lifecycle events never reload, and are never gated on scroll
// ─────────────────────────────────────────────────────────────────────────────

describe("live patches vs the structural reload", () => {
	const BUILD_OPTIONS = {
		lod: 5 as const,
		widthBucket: "860",
		contentWidth: 860,
		viewportHeight: 720,
		topPadding: 16,
		bottomPadding: 16,
		gap: 4,
	};

	it("a lifecycle patch commits while the reader is scrolled up", async () => {
		// The structural reload is deliberately deferred while scrolled up; a patch
		// must NOT be, since it neither re-windows the document nor moves the view. The
		// old assertion sliced the shell's source and forbade the string
		// "pinnedToBottom" inside it, which failed as soon as a comment mentioned the
		// word. This drives the two decisions instead: the reload defers, the patch
		// applies, on identical scroll state.
		const { resolveExactReloadDecision } = await import("./vlist-reload-policy");
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const { toolCompletedPatch } = await import("./vlist-live-events");

		const scrolledUp = {
			messageRevision: 5,
			appliedRevision: 4,
			hasIndex: true,
			pinnedToBottom: false,
		};
		expect(resolveExactReloadDecision(scrolledUp)).toEqual({ reload: false, deferred: true });

		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD_OPTIONS, { fetchPage: async () => runningToolPage() });
		const applied = coordinator.applyLivePatch(
			toolCompletedPatch({ toolUseId: "tu-1", status: "success", output: "done" }),
			// A reader scrolled up: the patch still commits, anchored to their row.
			() => ({ scrollTop: 400, pinnedToBottom: false, viewportHeight: 720 }),
		);
		expect(applied).toBe(true);
		expect(loadedToolStatus(coordinator.getSnapshot())).toBe("success");
	});

	it("a patch never triggers a refetch (the request storm this channel removes)", async () => {
		// Routing a lifecycle event through reload() would cost one full tail fetch per
		// tool. Asserted by counting fetches rather than by forbidding the token
		// "reload(" in the hook's source.
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const { toolCompletedPatch } = await import("./vlist-live-events");
		const coordinator = new PretextLayoutCoordinator();
		let fetches = 0;
		await coordinator.load("n1", BUILD_OPTIONS, {
			fetchPage: async () => {
				fetches++;
				return runningToolPage();
			},
		});
		for (const status of ["success", "fail", "success"]) {
			coordinator.applyLivePatch(toolCompletedPatch({ toolUseId: "tu-1", status }));
		}
		expect(fetches).toBe(1);
	});

	it("keeps messageVersion fixed so untouched rows keep their cached measurements", async () => {
		// A patch is a FIELD patch, not a structural change. Bumping the version would
		// invalidate every row's measure-cache entry and turn a one-card update into a
		// full re-measure.
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const { toolCompletedPatch } = await import("./vlist-live-events");
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD_OPTIONS, { fetchPage: async () => runningToolPage() });
		const before = coordinator.getSnapshot().input?.messageVersion;
		coordinator.applyLivePatch(toolCompletedPatch({ toolUseId: "tu-1", status: "success" }));
		expect(coordinator.getSnapshot().input?.messageVersion).toBe(before);
	});

	it("anchors the rebuild so a resized card cannot jump the viewport", async () => {
		// The exact list's protected invariant: a committed row never moves without a
		// user action. A status change DOES resize its card, so the commit must emit a
		// scroll correction. Asserted through the emitted correction rather than by
		// grepping the coordinator for captureCoordinatorAnchor.
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const { toolCompletedPatch } = await import("./vlist-live-events");
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load(
			"n1",
			BUILD_OPTIONS,
			{ fetchPage: async () => runningToolPage() },
			undefined,
			720,
		);
		coordinator.applyLivePatch(
			toolCompletedPatch({
				toolUseId: "tu-1",
				status: "success",
				output: "line\nline\nline\nline\nline\nline",
			}),
			() => ({ scrollTop: 0, pinnedToBottom: true, viewportHeight: 720 }),
		);
		const snap = coordinator.getSnapshot();
		expect(snap.scrollTopAnchorKind).toBe("bottom");
		expect(snap.scrollTop).toBeGreaterThanOrEqual(0);
	});

	// A patch rebuilds `input.messages` into a NEW array to change a field in place.
	// The streaming row's "text since the last commit" counter must not read that as
	// the document having grown: it is the signal that keeps a multi-step turn's live
	// step alive (see streaming-handoff.ts), and zeroing it lets an already-stored
	// EARLIER step retire output that was never persisted. Driving the real coordinator
	// is what makes this a regression guard — the array identity really does change.
	it("a lifecycle patch is not mistaken for document growth by the streaming row", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const { toolCompletedPatch } = await import("./vlist-live-events");
		const { commitGrowthSignature } = await import("./streaming-handoff");
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD_OPTIONS, { fetchPage: async () => runningToolPage() });

		const before = coordinator.getSnapshot().input?.messages ?? [];
		const beforeSignature = commitGrowthSignature(before);
		expect(
			coordinator.applyLivePatch(toolCompletedPatch({ toolUseId: "tu-1", status: "success" })),
		).toBe(true);
		const after = coordinator.getSnapshot().input?.messages ?? [];

		// The identity DID change — that is exactly why watching it was wrong.
		expect(after).not.toBe(before);
		expect(commitGrowthSignature(after)).toBe(beforeSignature);
	});

	it("still sees growth when a message is appended", async () => {
		const { PretextLayoutCoordinator } = await import("./pretext-layout-coordinator");
		const { commitGrowthSignature } = await import("./streaming-handoff");
		const coordinator = new PretextLayoutCoordinator();
		await coordinator.load("n1", BUILD_OPTIONS, { fetchPage: async () => runningToolPage() });
		const beforeSignature = commitGrowthSignature(coordinator.getSnapshot().input?.messages ?? []);

		expect(
			coordinator.appendMessage(
				{
					id: "m2",
					narratorId: "n1",
					parentToolUseId: null,
					role: "assistant",
					contentJson: [{ type: "text", text: "下一步" }],
					contentText: "下一步",
					toolCalls: [],
					createdAt: "2026-01-01T00:01:00.000Z",
					children: [],
					seq: 1,
				} as unknown as Msg,
				false,
			),
		).toBe(true);
		expect(commitGrowthSignature(coordinator.getSnapshot().input?.messages ?? [])).not.toBe(
			beforeSignature,
		);
	});

	type Msg = import("@frontend/lib/api").TreeMessage;

	function runningToolPage(): import("@frontend/lib/api/types").PretextDocumentPageResult {
		return {
			messages: [
				{
					id: "m1",
					narratorId: "n1",
					parentToolUseId: null,
					role: "assistant",
					contentJson: [
						{
							type: "tool_use",
							id: "tu-1",
							name: "Bash",
							input: { command: "bun test" },
							inputJson: { command: "bun test" },
							status: "running",
						},
					],
					contentText: null,
					toolCalls: [
						{
							id: "tc-1",
							narratorId: "n1",
							messageId: "m1",
							toolUseId: "tu-1",
							toolName: "Bash",
							inputJson: { command: "bun test" },
							status: "running",
							createdAt: "2026-01-01T00:00:00.000Z",
						},
					],
					createdAt: "2026-01-01T00:00:00.000Z",
					children: [],
				} as unknown as Msg,
			],
			messageVersion: 7,
			pruneBoundaryMessageId: null,
			prunedPercent: null,
			minSeq: 0,
			maxSeq: 0,
			hasNext: false,
			hasPrev: false,
		};
	}

	function loadedToolStatus(snapshot: { input?: { messages: readonly Msg[] } }): unknown {
		const block = snapshot.input?.messages[0]?.contentJson?.find((b) => b.type === "tool_use");
		return (block as { status?: unknown } | undefined)?.status;
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Event → patch field mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("reflectionResolvedStatus", () => {
	it("maps decisions to suggestion statuses per family", async () => {
		const { reflectionResolvedStatus } = await import("./vlist-live-events");
		for (const kind of ["danger_reflection", "plan_reflection", "task_reflection"] as const) {
			expect(reflectionResolvedStatus(kind, "allow")).toBe("confirmed");
			expect(reflectionResolvedStatus(kind, "aborted")).toBe("aborted");
			expect(reflectionResolvedStatus(kind, "deny")).toBe("cancelled");
		}
		// An aborted question gate returns the decision to the user (awaiting_user)
		// where the other three families abort. Copied deliberately from the chunked
		// path; asserted here so a future "cleanup" cannot silently normalize it.
		expect(reflectionResolvedStatus("question_reflection", "allow")).toBe("confirmed");
		expect(reflectionResolvedStatus("question_reflection", "aborted")).toBe("awaiting_user");
		expect(reflectionResolvedStatus("question_reflection", "deny")).toBe("cancelled");
	});
});

describe("live event → patch field mapping", () => {
	type Msg = import("@frontend/lib/api").TreeMessage;

	function toolDoc(toolUseId: string, status: string): Msg[] {
		return [
			{
				id: "m1",
				narratorId: "n1",
				parentToolUseId: null,
				role: "assistant",
				contentJson: [
					{ type: "tool_use", id: toolUseId, name: "Bash", input: {}, status, inputJson: {} },
				],
				contentText: null,
				toolCalls: [
					{
						id: `tc-${toolUseId}`,
						narratorId: "n1",
						messageId: "m1",
						toolUseId,
						toolName: "Bash",
						status,
						inputJson: {},
						createdAt: "2026-01-01T00:00:00.000Z",
					},
				],
				createdAt: "2026-01-01T00:00:00.000Z",
				children: [],
			} as unknown as Msg,
		];
	}

	const block = (messages: readonly Msg[]) =>
		messages[0]?.contentJson?.[0] as unknown as Record<string, unknown>;

	it("tool_completed writes status, output and duration onto the card", async () => {
		const { toolCompletedPatch } = await import("./vlist-live-events");
		const result = toolCompletedPatch({
			toolUseId: "tu-1",
			status: "success",
			output: "all good",
			durationMs: 42,
		})(toolDoc("tu-1", "running"));
		expect(result.changed).toBe(true);
		expect(block(result.messages).status).toBe("success");
		expect(block(result.messages).outputJson).toBe("all good");
		expect(block(result.messages).durationMs).toBe(42);
	});

	it("tool_completed without an output keeps a previously streamed body", async () => {
		const { toolCompletedPatch } = await import("./vlist-live-events");
		const doc = toolDoc("tu-1", "running");
		(block(doc) as { outputJson?: unknown }).outputJson = "streamed";
		const result = toolCompletedPatch({ toolUseId: "tu-1", status: "success" })(doc);
		expect(block(result.messages).outputJson).toBe("streamed");
	});

	it("permission deny fails the tool with the reviewer's message", async () => {
		const { permissionResolvedPatch } = await import("./vlist-live-events");
		const patch = permissionResolvedPatch({
			toolUseId: "tu-1",
			decision: "deny",
			feedbackText: "  not allowed  ",
		});
		const result = patch?.(toolDoc("tu-1", "pending"));
		expect(block(result?.messages ?? []).status).toBe("fail");
		expect(block(result?.messages ?? []).permissionDenyMessage).toBe("not allowed");
	});

	it("an undecided permission produces no patch at all", async () => {
		const { permissionResolvedPatch } = await import("./vlist-live-events");
		expect(permissionResolvedPatch({ toolUseId: "tu-1" })).toBeNull();
	});

	it("timeout_updated writes the new deadline onto a RUNNING card", async () => {
		// The field name matters: the adapter's effectiveTimeoutMs reads `_timeoutMs`
		// first, so writing anything else would leave the header on the old value.
		const { timeoutUpdatedPatch } = await import("./vlist-live-events");
		const result = timeoutUpdatedPatch({ toolUseId: "tu-1", timeoutMs: 6_000_000 })(
			toolDoc("tu-1", "running"),
		);
		expect(result.changed).toBe(true);
		expect(block(result.messages)._timeoutMs).toBe(6_000_000);
		// Extending a deadline says nothing about the lifecycle.
		expect(block(result.messages).status).toBe("running");
	});

	it("timeout_updated leaves a FINISHED card's status alone", async () => {
		// A replayed frame after completion must not carry a card back to running;
		// the patch writes no status at all, so the terminal guard has nothing to strip.
		const { timeoutUpdatedPatch } = await import("./vlist-live-events");
		const result = timeoutUpdatedPatch({ toolUseId: "tu-1", timeoutMs: 90_000 })(
			toolDoc("tu-1", "success"),
		);
		expect(block(result.messages).status).toBe("success");
		expect(block(result.messages)._timeoutMs).toBe(90_000);
	});

	it("Send awaiting reply gains navigation from the live target event", async () => {
		const { awaitAgentResolvedPatch } = await import("./vlist-live-events");
		const { deriveToolMeta } = await import("./vlist-tool-meta");
		const doc = toolDoc("tu-1", "running");
		Object.assign(block(doc), { name: "Send", input: { id: "worker", await: true } });
		const result = awaitAgentResolvedPatch({ toolUseId: "tu-1", subagentNarratorId: "sub-live" })(
			doc,
		);
		expect(
			deriveToolMeta(block(result.messages) as unknown as ContentBlock)?.sendTargetNarratorId,
		).toBe("sub-live");
		expect(block(result.messages).status).toBe("running");
		expect(block(result.messages).outputJson).toBeUndefined();
	});

	it("Send receipt WS patch survives message segmentation and reaches adapter recipients", async () => {
		const { sendDeliveryResolvedPatch } = await import("./vlist-live-events");
		const { resolveAllToolCallsFromMsg } = await import("../message-segments");
		const { adaptSegment } = await import("./segment-adapter");
		const doc = toolDoc("tu-1", "running");
		Object.assign(block(doc), {
			name: "Send",
			input: { ids: ["a", "b"], message: "same", await: true },
		});
		const a = { id: "child-a", deliveryMessageId: "reserved-a" };
		const b = { id: "child-b", deliveryMessageId: "reserved-b" };
		const first = sendDeliveryResolvedPatch({ toolUseId: "tu-1", targets: [a] })(doc);
		const second = sendDeliveryResolvedPatch({ toolUseId: "tu-1", targets: [b] })(first.messages);
		const duplicate = sendDeliveryResolvedPatch({ toolUseId: "tu-1", targets: [a] })(
			second.messages,
		);
		expect(duplicate.changed).toBe(false);
		expect(block(second.messages)._sendDeliveryTargets).toEqual([a, b]);
		expect(block(second.messages).status).toBe("running");
		expect(block(second.messages).outputJson).toBeUndefined();
		const tc = resolveAllToolCallsFromMsg(second.messages[0] as never)[0];
		expect(tc._sendDeliveryTargets).toEqual([a, b]);
		const rows = adaptSegment(
			{
				kind: "tool-run",
				sourceMessages: [],
				items: [
					{
						blockIndex: 0,
						isSubagent: false,
						msg: second.messages[0],
						tc,
					},
				],
			} as never,
			{ lod: 5 },
		);
		expect(rows[0].kind).toBe("communication-bubble");
		expect((rows[0].data as { recipients: unknown[] }).recipients).toEqual([
			{ ...a, label: "child-a" },
			{ ...b, label: "child-b" },
		]);
	});

	it("live tail receipt survives the explicit streaming field projection and reaches adapter", async () => {
		const { applyStreamingToolStarted, applyStreamingSendDelivery, createStreamingToolStore } =
			await import("./streaming-tool-chunks");
		const { buildTopLevelStreamingChunksMsg, topLevelStreamingChunkToToolFields } = await import(
			"../narrator-message-helpers"
		);
		const { resolveAllToolCallsFromMsg } = await import("../message-segments");
		const { adaptSegment } = await import("./segment-adapter");
		const store = createStreamingToolStore();
		const started = {
			toolUseId: "live-send",
			toolName: "Send",
			input: { id: "worker", message: "same", await: true },
		};
		applyStreamingToolStarted(store, started);
		const target = {
			id: "child",
			deliveryMessageId: "reserved",
			title: "Worker title",
			injectionConsumedAt: "2026-07-18T00:00:00.000Z",
		};
		expect(
			applyStreamingSendDelivery(store, {
				toolUseId: "live-send",
				targets: [target],
				targetCount: 3,
				toolCallBinding: { toolCallId: "row", attempt: 1 },
			}),
		).toBe(true);
		applyStreamingToolStarted(store, started);
		const chunk = [...store.values()][0];
		expect(topLevelStreamingChunkToToolFields(chunk)._sendDeliveryTargets).toEqual([target]);
		expect(topLevelStreamingChunkToToolFields(chunk)._sendDeliveryTargetCount).toBe(3);
		expect(topLevelStreamingChunkToToolFields(chunk)).not.toHaveProperty("outputJson");
		const msg = buildTopLevelStreamingChunksMsg([...store.values()], "n1", null);
		if (!msg) throw new Error("Expected live Send message");
		const tc = resolveAllToolCallsFromMsg(msg)[0];
		expect(tc._sendDeliveryTargets).toEqual([target]);
		expect(tc._sendDeliveryTargetCount).toBe(3);
		const rows = adaptSegment(
			{
				kind: "tool-run",
				sourceMessages: [],
				items: [{ blockIndex: 0, isSubagent: false, msg, tc }],
			} as never,
			{ lod: 5 },
		);
		expect((rows[0].data as { recipients: unknown[] }).recipients).toEqual([
			{ ...target, label: "Worker title" },
		]);
		expect((rows[0].data as { deliveryState: unknown }).deliveryState).toMatchObject({
			targetCount: 3,
			receivedCount: 1,
		});
		expect(
			applyStreamingSendDelivery(store, {
				toolUseId: "live-send",
				targets: [{ id: "wrong", deliveryMessageId: "old" }],
				toolCallBinding: { toolCallId: "old-row", attempt: 0 },
			}),
		).toBe(false);
	});

	it("consumption after Send success enriches only matching receipts and stays monotonic", async () => {
		const { sendDeliveryResolvedPatch, toolCompletedPatch } = await import("./vlist-live-events");
		const doc = toolDoc("tu-1", "running");
		Object.assign(block(doc), { name: "Send", tcId: "row", executionAttempt: 1 });
		const toolCallBinding = { toolCallId: "row", attempt: 1 };
		const target = { id: "child", deliveryMessageId: "receipt", title: "Worker" };
		const seeded = sendDeliveryResolvedPatch({
			toolUseId: "tu-1",
			targets: [target],
			toolCallBinding,
			targetCount: 3,
		})(doc);
		const completed = toolCompletedPatch({
			toolUseId: "tu-1",
			status: "success",
			output: "queued",
		})(seeded.messages);
		const received = { ...target, injectionConsumedAt: "2026-07-18T00:00:00.000Z" };
		const event = { toolUseId: "tu-1", targets: [received], toolCallBinding };
		const consumed = sendDeliveryResolvedPatch(event)(completed.messages);
		expect(consumed.changed).toBe(true);
		expect(block(consumed.messages)).toMatchObject({
			status: "success",
			outputJson: "queued",
			_sendDeliveryTargets: [received],
			_sendDeliveryTargetCount: 3,
		});
		expect(sendDeliveryResolvedPatch(event)(consumed.messages).changed).toBe(false);
		expect(
			sendDeliveryResolvedPatch({
				...event,
				targets: [{ id: "child", deliveryMessageId: "receipt" }],
				targetCount: 1,
			})(consumed.messages).changed,
		).toBe(false);
		for (const invalid of [
			{ ...event, toolCallBinding: undefined },
			{ ...event, toolCallBinding: { toolCallId: "row", attempt: 2 } },
			{ ...event, targets: [{ ...received, deliveryMessageId: "other-receipt" }] },
		])
			expect(sendDeliveryResolvedPatch(invalid)(consumed.messages).changed).toBe(false);
	});

	it("parent history updates an exact completed child attempt, never the reused newer row", async () => {
		const { sendDeliveryResolvedPatch } = await import("./vlist-live-events");
		const old = toolDoc("same", "success");
		const recent = toolDoc("same", "running");
		const target = { id: "child", deliveryMessageId: "receipt" };
		Object.assign(block(old), {
			name: "Send",
			tcId: "old",
			executionAttempt: 1,
			_sendDeliveryTargets: [target],
		});
		Object.assign(block(recent), { name: "Send", tcId: "new", executionAttempt: 2 });
		const parent = toolDoc("parent", "running");
		parent[0] = { ...parent[0], children: [...old, ...recent] };
		const received = { ...target, injectionConsumedAt: "2026-07-18T00:00:00.000Z" };
		const event = {
			toolUseId: "same",
			targets: [received],
			toolCallBinding: { toolCallId: "old", attempt: 1 },
		};
		const result = sendDeliveryResolvedPatch(event)(parent);
		expect(result.changed).toBe(true);
		expect(block(result.messages[0].children ?? [])._sendDeliveryTargets).toEqual([received]);
		expect(result.messages[0].children?.[1]).toBe(recent[0]);
		expect(
			sendDeliveryResolvedPatch({ ...event, toolCallBinding: { toolCallId: "new", attempt: 2 } })(
				old,
			).changed,
		).toBe(false);
	});

	it("completed streaming Send accepts consumption but rejects wrong attempts and receipts", async () => {
		const {
			applyStreamingToolStarted,
			applyStreamingToolCompleted,
			applyStreamingSendDelivery,
			createStreamingToolStore,
		} = await import("./streaming-tool-chunks");
		const store = createStreamingToolStore();
		applyStreamingToolStarted(store, {
			toolUseId: "send",
			toolName: "Send",
			input: { id: "child" },
		});
		const target = { id: "child", deliveryMessageId: "receipt", title: "Worker" };
		const toolCallBinding = { toolCallId: "row", attempt: 1 };
		applyStreamingSendDelivery(store, {
			toolUseId: "send",
			targets: [target],
			toolCallBinding,
			targetCount: 3,
		});
		applyStreamingToolCompleted(store, { toolUseId: "send", status: "success", output: "queued" });
		const received = { ...target, injectionConsumedAt: "2026-07-18T00:00:00.000Z" };
		const event = { toolUseId: "send", targets: [received], toolCallBinding };
		expect(applyStreamingSendDelivery(store, event)).toBe(true);
		expect(applyStreamingSendDelivery(store, event)).toBe(false);
		expect(
			applyStreamingSendDelivery(store, {
				...event,
				targets: [{ id: "child", deliveryMessageId: "receipt" }],
				targetCount: 1,
			}),
		).toBe(false);
		for (const invalid of [
			{ ...event, toolCallBinding: undefined },
			{ ...event, toolCallBinding: { toolCallId: "row", attempt: 2 } },
			{ ...event, targets: [{ ...received, deliveryMessageId: "other" }] },
		])
			expect(applyStreamingSendDelivery(store, invalid)).toBe(false);
		expect(store.get("send")).toMatchObject({
			_status: "success",
			_output: "queued",
			_sendDeliveryTargets: [received],
			_sendDeliveryTargetCount: 3,
		});
	});

	it("unbound consumption cannot create or replace a running attempt's receipt", async () => {
		const { sendDeliveryResolvedPatch } = await import("./vlist-live-events");
		const { applyStreamingSendDelivery, applyStreamingToolStarted, createStreamingToolStore } =
			await import("./streaming-tool-chunks");
		const binding = { toolCallId: "row", attempt: 2 };
		const current = { id: "child", deliveryMessageId: "r2", title: "Current" };
		const oldConsumed = {
			id: "child",
			deliveryMessageId: "r1",
			injectionConsumedAt: "2026-07-18T00:00:00.000Z",
		};
		for (const hasReceipt of [false, true]) {
			const doc = toolDoc("send", "running");
			Object.assign(block(doc), {
				name: "Send",
				tcId: "row",
				executionAttempt: 2,
				...(hasReceipt ? { _sendDeliveryTargets: [current] } : {}),
				_sendDeliveryTargetCount: 2,
			});
			const store = createStreamingToolStore();
			applyStreamingToolStarted(store, {
				toolUseId: "send",
				toolName: "Send",
				input: { id: "child" },
			});
			applyStreamingSendDelivery(store, {
				toolUseId: "send",
				targets: hasReceipt ? [current] : [],
				targetCount: 2,
				toolCallBinding: binding,
			});
			const previous = store.get("send");
			const stale = { toolUseId: "send", targets: [oldConsumed], targetCount: 99 };
			expect(sendDeliveryResolvedPatch(stale)(doc).changed).toBe(false);
			expect(applyStreamingSendDelivery(store, stale)).toBe(false);
			expect(store.get("send")).toBe(previous);
			const same = {
				toolUseId: "send",
				targets: [{ ...current, injectionConsumedAt: oldConsumed.injectionConsumedAt }],
				targetCount: 99,
			};
			const patched = sendDeliveryResolvedPatch(same)(doc);
			expect(patched.changed).toBe(hasReceipt);
			expect(applyStreamingSendDelivery(store, same)).toBe(hasReceipt);
			if (hasReceipt) {
				expect(block(patched.messages)._sendDeliveryTargets).toEqual(same.targets);
				expect(block(patched.messages)._sendDeliveryTargetCount).toBe(2);
				expect(store.get("send")?._sendDeliveryTargets).toEqual(same.targets);
				expect(store.get("send")?._sendDeliveryTargetCount).toBe(2);
			}
		}
		const empty = createStreamingToolStore();
		expect(
			applyStreamingSendDelivery(empty, {
				toolUseId: "send",
				targets: [oldConsumed],
				targetCount: 99,
			}),
		).toBe(false);
		expect(empty.size).toBe(0);
	});

	it("completed communication tools recognize final metadata receipts without runtime navigation", async () => {
		const { sendDeliveryResolvedPatch } = await import("./vlist-live-events");
		const {
			applyStreamingSendDelivery,
			applyStreamingToolStarted,
			applyStreamingToolCompleted,
			createStreamingToolStore,
		} = await import("./streaming-tool-chunks");
		const binding = { toolCallId: "row", attempt: 2 };
		const receipt = { id: "child", deliveryMessageId: "receipt", title: "Child" };
		const received = { ...receipt, injectionConsumedAt: "2026-07-18T00:00:00.000Z" };
		const metadata = {
			targetCount: 1,
			targets: [{ ...receipt, status: "queued", awaited: false }],
		};
		const output = { _text: "queued", _metadata: metadata };
		for (const toolName of ["Send", "TeamStatus"]) {
			for (const action of ["send", "broadcast"]) {
				const input = { action, id: "child", message: "hello" };
				const event = { toolUseId: "send", targets: [received], toolCallBinding: binding };
				for (const final of [{ _metadata: metadata }, { outputJson: output }]) {
					const doc = toolDoc("send", "success");
					Object.assign(block(doc), {
						name: toolName,
						inputJson: input,
						input,
						tcId: "row",
						executionAttempt: 2,
						...final,
					});
					const patched = sendDeliveryResolvedPatch(event)(doc);
					expect(patched.changed).toBe(true);
					expect(block(patched.messages)).toMatchObject({
						name: toolName,
						status: "success",
						_sendDeliveryTargets: [received],
						...final,
					});
					expect(
						sendDeliveryResolvedPatch({
							...event,
							toolCallBinding: { toolCallId: "row", attempt: 1 },
						})(doc).changed,
					).toBe(false);
				}
				const store = createStreamingToolStore();
				applyStreamingToolStarted(store, { toolUseId: "send", toolName, input });
				applyStreamingSendDelivery(store, {
					toolUseId: "send",
					targets: [],
					targetCount: 1,
					toolCallBinding: binding,
				});
				applyStreamingToolCompleted(store, { toolUseId: "send", status: "success", output });
				expect(applyStreamingSendDelivery(store, event)).toBe(true);
				expect(store.get("send")).toMatchObject({
					toolName,
					_status: "success",
					_sendDeliveryTargets: [received],
					_output: output,
				});
				expect(store.get("send")?._output).toBe(output);
			}
		}
		const list = toolDoc("send", "running");
		Object.assign(block(list), {
			name: "TeamStatus",
			inputJson: { action: "list" },
			tcId: "row",
			executionAttempt: 2,
		});
		expect(
			sendDeliveryResolvedPatch({
				toolUseId: "send",
				targets: [receipt],
				toolCallBinding: binding,
			})(list).changed,
		).toBe(false);
		const listStore = createStreamingToolStore();
		applyStreamingToolStarted(listStore, {
			toolUseId: "send",
			toolName: "TeamStatus",
			input: { action: "list" },
		});
		expect(
			applyStreamingSendDelivery(listStore, {
				toolUseId: "send",
				targets: [receipt],
				toolCallBinding: binding,
			}),
		).toBe(false);
	});

	it("count-only target resolution survives partial fanout and every projection", async () => {
		const { sendDeliveryResolvedPatch } = await import("./vlist-live-events");
		const { applyStreamingSendDelivery, createStreamingToolStore } = await import(
			"./streaming-tool-chunks"
		);
		const { buildTopLevelStreamingChunksMsg } = await import("../narrator-message-helpers");
		const { resolveAllToolCallsFromMsg } = await import("../message-segments");
		const event = {
			toolUseId: "tu-1",
			targets: [],
			targetCount: 4,
			toolCallBinding: { toolCallId: "row", attempt: 1 },
		};
		const store = createStreamingToolStore();
		expect(applyStreamingSendDelivery(store, event)).toBe(true);
		expect(applyStreamingSendDelivery(store, event)).toBe(false);
		const msg = buildTopLevelStreamingChunksMsg([...store.values()], "n", null);
		if (!msg) throw new Error("Expected count-only live Send");
		expect(resolveAllToolCallsFromMsg(msg)[0]._sendDeliveryTargetCount).toBe(4);
		const doc = toolDoc("tu-1", "running");
		Object.assign(block(doc), { name: "Send", tcId: "row", executionAttempt: 1 });
		const countOnly = sendDeliveryResolvedPatch(event)(doc);
		expect(countOnly.changed).toBe(true);
		expect(sendDeliveryResolvedPatch(event)(countOnly.messages).changed).toBe(false);
		const partial = sendDeliveryResolvedPatch({
			...event,
			targetCount: undefined,
			targets: [{ id: "child", deliveryMessageId: "receipt" }],
		})(countOnly.messages);
		expect(block(partial.messages)._sendDeliveryTargetCount).toBe(4);
	});

	it("segmentation preserves a consumed row beneath an older enriched navigation block", async () => {
		const { resolveAllToolCallsFromMsg } = await import("../message-segments");
		const doc = toolDoc("tu-1", "success");
		const received = {
			id: "child",
			deliveryMessageId: "receipt",
			title: "Worker",
			injectionConsumedAt: "2026-07-18T00:00:00.000Z",
		};
		Object.assign(block(doc), {
			name: "Send",
			_sendDeliveryTargets: [{ id: "child" }],
			_sendDeliveryTargetCount: 1,
		});
		doc[0] = {
			...doc[0],
			toolCalls: [
				{
					toolUseId: "tu-1",
					toolName: "Send",
					_sendDeliveryTargets: [received],
					_sendDeliveryTargetCount: 4,
				},
			],
		};
		const tool = resolveAllToolCallsFromMsg(doc[0] as never)[0];
		expect(tool._sendDeliveryTargets).toEqual([received]);
		expect(tool._sendDeliveryTargetCount).toBe(4);
	});

	it("title-only navigation snapshots cannot erase consumption or borrow another receipt's fact", async () => {
		const { mergeSendDeliveryTargets } = await import("@shared/communication-tool");
		const received = {
			id: "child",
			deliveryMessageId: "receipt",
			title: "Worker",
			injectionConsumedAt: "2026-07-18T00:00:00.000Z",
		};
		expect(mergeSendDeliveryTargets([received], [{ id: "child" }])).toEqual([received]);
		expect(mergeSendDeliveryTargets([received], [{ id: "child", title: null }])).toEqual([
			received,
		]);
		expect(
			mergeSendDeliveryTargets([received], [{ id: "child", deliveryMessageId: "new" }]),
		).toEqual([{ id: "child", deliveryMessageId: "new", title: "Worker" }]);
	});

	it("Send receipt bindings reject delayed frames from a different attempt", async () => {
		const { sendDeliveryResolvedPatch } = await import("./vlist-live-events");
		const doc = toolDoc("tu-1", "running");
		Object.assign(block(doc), { name: "Send", tcId: "row-new", executionAttempt: 2 });
		const targets = [{ id: "child", deliveryMessageId: "reserved" }];
		expect(
			sendDeliveryResolvedPatch({
				toolUseId: "tu-1",
				targets,
				toolCallBinding: { toolCallId: "row-old", attempt: 1 },
			})(doc).changed,
		).toBe(false);
		expect(
			sendDeliveryResolvedPatch({
				toolUseId: "tu-1",
				targets,
				toolCallBinding: { toolCallId: "row-new", attempt: 2 },
			})(doc).changed,
		).toBe(true);
	});

	it("Send receipt patch ignores old failed attempts and terminal replay", async () => {
		const { sendDeliveryResolvedPatch } = await import("./vlist-live-events");
		const old = toolDoc("tu-1", "fail");
		const live = toolDoc("tu-1", "running");
		Object.assign(block(old), { name: "Send", outputJson: null });
		Object.assign(block(live), { name: "Send" });
		const patch = sendDeliveryResolvedPatch({
			toolUseId: "tu-1",
			targets: [{ id: "child", deliveryMessageId: "reserved" }],
		});
		const result = patch([...old, ...live]);
		expect(block(result.messages)._sendDeliveryTargets).toBeUndefined();
		expect(result.messages[1].contentJson?.[0]).toHaveProperty("_sendDeliveryTargets");
		expect(patch(old).changed).toBe(false);
	});

	it("await_agent_resolved writes the child id without touching the lifecycle", async () => {
		// The field name is the contract with `deriveAwaitAgentNarratorId`; writing it
		// as `_metadata.subagentId` instead would ALSO grow the card (see the
		// height-neutrality cases in live-patch-measure-audit.test.ts).
		const { awaitAgentResolvedPatch } = await import("./vlist-live-events");
		const result = awaitAgentResolvedPatch({
			toolUseId: "tu-1",
			subagentNarratorId: "sub-live",
		})(toolDoc("tu-1", "running"));
		expect(result.changed).toBe(true);
		expect(block(result.messages)._awaitAgentNarratorId).toBe("sub-live");
		expect(block(result.messages).status).toBe("running");
		const metadata = block(result.messages)._metadata as Record<string, unknown> | undefined;
		expect(metadata?.subagentId).toBeUndefined();
	});

	it("subagent_takeover_changed flags the card without touching the lifecycle", async () => {
		// `_takenOver` (not `_metadata`) is the contract: a metadata entry becomes a
		// detail ROW via classifyAwait, so it would grow every Await card — a layout
		// change caused by a badge. And the status must NOT move: the call is parked,
		// not finished, which is exactly what the badge is there to say.
		const { subagentTakeoverPatch } = await import("./vlist-live-events");
		const result = subagentTakeoverPatch({ toolUseId: "tu-1", takenOver: true })(
			toolDoc("tu-1", "running"),
		);
		expect(result.changed).toBe(true);
		expect(block(result.messages)._takenOver).toBe(true);
		expect(block(result.messages).status).toBe("running");
		const metadata = block(result.messages)._metadata as Record<string, unknown> | undefined;
		expect(metadata?.takenOver).toBeUndefined();
	});

	it("stopping a takeover clears the flag (false is written, not omitted)", async () => {
		// Omitting the field on release would leave the badge on forever: the card
		// keeps whatever the previous patch wrote, and no later event repeats it.
		const { subagentTakeoverPatch } = await import("./vlist-live-events");
		const taken = subagentTakeoverPatch({ toolUseId: "tu-1", takenOver: true })(
			toolDoc("tu-1", "running"),
		);
		const released = subagentTakeoverPatch({ toolUseId: "tu-1", takenOver: false })(taken.messages);
		expect(released.changed).toBe(true);
		expect(block(released.messages)._takenOver).toBe(false);
	});

	it("a takeover frame without a toolUseId still finds the card by child narrator id", async () => {
		// The spawning tool_use is resolved from the child's first user message and can
		// be missing. Falling back to the child id keeps the badge working there; every
		// card already carries that id (activity summary / resolved Await target).
		const { patchSubagentTakeoverByNarrator } = await import("./vlist-live-patch");
		const doc = toolDoc("tu-1", "running");
		(block(doc) as Record<string, unknown>)._subagentActivity = {
			subagentNarratorId: "sub-9",
			model: null,
			latestToolCalls: [],
		};
		const result = patchSubagentTakeoverByNarrator(doc, "sub-9", true);
		expect(result.changed).toBe(true);
		expect(block(result.messages)._takenOver).toBe(true);
	});

	it("a takeover frame for an unrelated child leaves the document identical", async () => {
		const { patchSubagentTakeoverByNarrator } = await import("./vlist-live-patch");
		const doc = toolDoc("tu-1", "running");
		(block(doc) as Record<string, unknown>)._awaitAgentNarratorId = "sub-9";
		const result = patchSubagentTakeoverByNarrator(doc, "sub-other", true);
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(doc);
	});

	/**
	 * The release path's real failure. The badge is an OR over TWO fields
	 * (`resolveTakenOver`), and only one of them is in the frame:
	 *
	 *   tc._takenOver                  ← this patch
	 *   tc._subagentActivity.takenOver ← stamped by the server on any page loaded
	 *                                    mid-takeover, and deliberately carried
	 *                                    across every child tool event by
	 *                                    `upsertSubagentToolCallHeader`
	 *
	 * So writing `_takenOver: false` alone leaves the OR true and the badge lit
	 * until an unrelated full reload — the user has stopped the takeover and the
	 * card still claims they are driving. It only breaks in the RELEASE direction,
	 * which is why the earlier single-field write looked correct.
	 */
	it("stopping a takeover also clears the activity summary's flag", async () => {
		const { subagentTakeoverPatch } = await import("./vlist-live-events");
		const { resolveToolItemTakenOver } = await import("@shared/pretext-layout/segment-adapter");
		const doc = toolDoc("tu-1", "running");
		(block(doc) as Record<string, unknown>)._subagentActivity = {
			subagentNarratorId: "sub-9",
			model: null,
			latestToolCalls: [],
			takenOver: true,
		};
		const released = subagentTakeoverPatch({ toolUseId: "tu-1", takenOver: false })(doc);
		expect(released.changed).toBe(true);
		const patched = block(released.messages);
		expect(patched._takenOver).toBe(false);
		// Absent, not `false`: matches how the server builds the snapshot, so both
		// producers yield one shape.
		expect((patched._subagentActivity as Record<string, unknown>).takenOver).toBeUndefined();
		// The whole point — what the card actually paints.
		expect(resolveToolItemTakenOver({ tc: patched } as never)).toBe(false);
		// The rest of the summary survives (it is the card's model / recent calls).
		expect((patched._subagentActivity as Record<string, unknown>).subagentNarratorId).toBe("sub-9");
	});

	it("the by-narrator route clears the activity flag too (both routes agree)", async () => {
		const { patchSubagentTakeoverByNarrator } = await import("./vlist-live-patch");
		const doc = toolDoc("tu-1", "running");
		(block(doc) as Record<string, unknown>)._subagentActivity = {
			subagentNarratorId: "sub-9",
			model: null,
			latestToolCalls: [],
			takenOver: true,
		};
		const released = patchSubagentTakeoverByNarrator(doc, "sub-9", false);
		expect(released.changed).toBe(true);
		const patched = block(released.messages);
		expect(patched._takenOver).toBe(false);
		expect((patched._subagentActivity as Record<string, unknown>).takenOver).toBeUndefined();
	});

	/**
	 * A card with NO summary must not gain a synthesized one: fabricating a partial
	 * summary would erase the model / recent calls the adapter reads from it.
	 */
	it("does not synthesize an activity summary on a card that has none", async () => {
		const { subagentTakeoverPatch } = await import("./vlist-live-events");
		const released = subagentTakeoverPatch({ toolUseId: "tu-1", takenOver: true })(
			toolDoc("tu-1", "running"),
		);
		expect(block(released.messages)._subagentActivity).toBeUndefined();
	});

	/**
	 * The frame's `toolUseId` is the call that SPAWNED the child. A separate
	 * in-flight `Await({type:"agent"})` on the same child is a DIFFERENT card that
	 * only carries `_awaitAgentNarratorId`. Treating the id as exclusive (early
	 * return) left that Await card lit forever after the release, because the
	 * message-load path does flag it while no live frame ever cleared it.
	 */
	it("dispatches BOTH addressing routes so a separate Await card is released too", () => {
		const enqueued: string[] = [];
		const handler = (info: {
			subagentNarratorId?: string;
			toolUseId?: string;
			takenOver: boolean;
		}) => {
			if (info.toolUseId) enqueued.push(`byTool:${info.toolUseId}`);
			if (!info.subagentNarratorId) return;
			enqueued.push(`byNarrator:${info.subagentNarratorId}`);
		};
		handler({ toolUseId: "tu-spawn", subagentNarratorId: "sub-9", takenOver: false });
		expect(enqueued).toEqual(["byTool:tu-spawn", "byNarrator:sub-9"]);
		// And the shipped handler must not early-return on the tool id.
		const body = LIVE_HOOK.slice(
			LIVE_HOOK.indexOf("onSubagentTakeoverChanged:"),
			LIVE_HOOK.indexOf("onToolExecuting:"),
		);
		expect(body).toContain("if (toolUseId) enqueue(");
		expect(body).not.toContain("return;\n\t\t\t\t}");
	});

	it("a resolved question gate leaves the tool answerable (pending, not fail)", async () => {
		const { reflectionResolvedPatch } = await import("./vlist-live-events");
		const result = reflectionResolvedPatch({
			kind: "question_reflection",
			toolUseId: "tu-1",
			requestId: "req-1",
			decision: "deny",
		})(withGate(toolDoc("tu-1", "pending"), "question_reflection", "req-1"));
		expect(result.changed).toBe(true);
		expect(block(result.messages).status).toBe("pending");
	});

	it("a denied danger gate fails the tool and records the reason", async () => {
		const { reflectionResolvedPatch } = await import("./vlist-live-events");
		const result = reflectionResolvedPatch({
			kind: "danger_reflection",
			toolUseId: "tu-1",
			requestId: "req-1",
			decision: "deny",
			reason: "target outside workspace",
		})(withGate(toolDoc("tu-1", "pending"), "danger_reflection", "req-1"));
		expect(block(result.messages).status).toBe("fail");
		expect(block(result.messages).errorMessage).toBe("target outside workspace");
	});

	/** Seed a live gate so the terminal patch's request-id check accepts. */
	function withGate(messages: Msg[], type: string, requestId: string): Msg[] {
		const suggestion = [{ type, status: "running", requestId }];
		(block(messages) as { permissionSuggestions?: unknown }).permissionSuggestions = suggestion;
		const row = messages[0]?.toolCalls?.[0] as unknown as Record<string, unknown> | undefined;
		if (row) row.permissionSuggestions = suggestion;
		return messages;
	}
});
