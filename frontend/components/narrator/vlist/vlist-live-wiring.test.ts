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
 * Streaming-frequency events that must stay OUT of the document layer:
 * `tool_use_chunk` / `tool_output` fire per delta, so routing them through the
 * document would rebuild the whole layout per chunk. They belong to the streaming
 * tail. This exclusion is a performance invariant, not an omission.
 *
 * `reflection_progress` joins them for the same reason: a running gate ticks
 * several times a second and its label is painted inside an already-measured
 * fixed row, so it belongs to the render-only store
 * (`../reflection-progress-store.ts`), fed from `useNarratorPanelWS`.
 */
const FORBIDDEN_EVENTS = ["onToolUseChunk", "onToolOutput", "onReflectionProgress"];

describe("vlist live lifecycle subscription set", () => {
	it("subscribes to every event whose omission would strand a card in a stale state", () => {
		const missing = REQUIRED_EVENTS.filter((event) => !LIVE_HOOK.includes(`${event}:`));
		expect(missing).toEqual([]);
	});

	it("keeps streaming-frequency tool events out of the document layer", () => {
		const present = FORBIDDEN_EVENTS.filter((event) => LIVE_HOOK.includes(`${event}:`));
		expect(present).toEqual([]);
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
