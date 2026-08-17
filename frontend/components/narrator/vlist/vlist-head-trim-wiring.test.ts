/**
 * vlist-head-trim-wiring.test.ts — `trimHead` against a real coordinator.
 *
 * The pure decision rules live in vlist-head-trim.test.ts. What is pinned HERE is
 * the part that can lose data rather than merely look wrong:
 *
 * 1. The upward cursor retreats with the trimmed data, so the next older page picks
 *    up exactly where the survivors start — no hole in history.
 * 2. `messageVersion` does not move, so surviving rows keep their cached heights.
 * 3. A trim cannot start the trim/refetch loop with the shell's fill effect.
 * 4. Trimming while a live row is published is refused — the one failure mode that
 *    destroys output that was never persisted.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

type Loaded = Awaited<ReturnType<typeof load>>;

async function load() {
	const [coordinator, handoff, trim] = await Promise.all([
		import("./pretext-layout-coordinator"),
		import("./streaming-handoff"),
		import("./vlist-head-trim"),
	]);
	return { ...coordinator, ...handoff, ...trim };
}

const BUILD = {
	lod: 5 as const,
	widthBucket: "800",
	contentWidth: 800,
	viewportHeight: 600,
	gap: 4,
	segmentGap: 12,
	topPadding: 16,
	bottomPadding: 16,
	resolveToolCategory: () => "generic",
	resolveToolColor: () => "gray",
	resolveToolSummary: () => "cmd",
};

function message(seq: number, role: "user" | "assistant", text: string): TreeMessage {
	return {
		id: `m${seq}`,
		narratorId: "n1",
		parentToolUseId: null,
		role,
		contentJson: [{ type: "text", text }],
		contentText: text,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq,
	} as unknown as TreeMessage;
}

function streamingRow(chars: number): TreeMessage {
	const text = "词".repeat(chars);
	return {
		id: "__streaming__",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", id: "streaming:text:0", text }],
		contentText: null,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
		seq: 999_999,
	} as unknown as TreeMessage;
}

/** A tail page whose seqs start at `startSeq` (so a trim has real history above). */
function page(messages: readonly TreeMessage[], messageVersion: number, hasPrev = true) {
	const seqs = messages.map((m) => (m as unknown as { seq: number }).seq);
	return {
		messages: [...messages],
		messageVersion,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
		hasPrev,
		minSeq: Math.min(...seqs),
		maxSeq: Math.max(...seqs),
	};
}

const history = Array.from({ length: 40 }, (_, index) =>
	message(index + 100, "assistant", "词".repeat(120)),
);
const atBottom = () => ({ scrollTop: 0, pinnedToBottom: true, viewportHeight: 600 });

async function loadedCoordinator(mod: Loaded, messages = history, version = 7) {
	const coordinator = new mod.PretextLayoutCoordinator();
	await coordinator.load(
		"n1",
		BUILD,
		{ fetchPage: async () => page(messages, version) as never },
		undefined,
		600,
	);
	return coordinator;
}

describe("trimHead — dropping the head of the loaded window", () => {
	it("drops the oldest messages and keeps the newest", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		expect(coordinator.trimHead(10, atBottom)).toBe(true);
		const messages = coordinator.getSnapshot().input?.messages ?? [];
		expect(messages.length).toBe(30);
		expect(messages[0]?.id).toBe("m110");
		expect(messages[messages.length - 1]?.id).toBe("m139");
	});

	/**
	 * The cursor MUST retreat with the data. Left forward, the next upward page
	 * starts below the gap the trim opened and that span is never fetched again —
	 * a silent hole. This is the opposite of removeMessages' contract, which is why
	 * it is asserted rather than assumed.
	 */
	it("retreats oldestLoadedSeq to the oldest surviving message", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		expect(coordinator.getSnapshot().input?.oldestLoadedSeq).toBe(100);
		coordinator.trimHead(10, atBottom);
		expect(coordinator.getSnapshot().input?.oldestLoadedSeq).toBe(110);
	});

	it("forces hasPrev true even when the loaded page reported none", async () => {
		const mod = await load();
		const coordinator = new mod.PretextLayoutCoordinator();
		await coordinator.load(
			"n1",
			BUILD,
			{ fetchPage: async () => page(history, 7, false) as never },
			undefined,
			600,
		);
		expect(coordinator.getSnapshot().hasPrev).toBe(false);
		coordinator.trimHead(10, atBottom);
		// We gave fetched history back, so older messages certainly exist upstream.
		expect(coordinator.getSnapshot().hasPrev).toBe(true);
		expect(coordinator.getSnapshot().input?.hasPrev).toBe(true);
	});

	/**
	 * CONTRACT.md §4.5 constraint 2: every in-place path keeps the version fixed.
	 * The survivors' content did not change, so bumping it would re-measure the whole
	 * window for nothing — the exact cost the measure cache exists to avoid.
	 */
	it("keeps messageVersion fixed", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod, history, 7);
		coordinator.trimHead(10, atBottom);
		expect(coordinator.getSnapshot().input?.messageVersion).toBe(7);
	});

	it("shrinks the layout and reports ready", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		const before = coordinator.getSnapshot().index?.totalHeight ?? 0;
		coordinator.trimHead(20, atBottom);
		const after = coordinator.getSnapshot();
		expect(after.status).toBe("ready");
		expect(after.index?.totalHeight ?? 0).toBeLessThan(before);
		expect(after.items?.length ?? 0).toBeGreaterThan(0);
	});

	it("returns false and changes nothing when the drop count is unusable", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		const before = coordinator.getSnapshot().input?.messages;
		expect(coordinator.trimHead(0, atBottom)).toBe(false);
		expect(coordinator.trimHead(-5, atBottom)).toBe(false);
		// Never empties the document: the shell's load path owns that state.
		expect(coordinator.trimHead(history.length, atBottom)).toBe(false);
		expect(coordinator.trimHead(history.length + 10, atBottom)).toBe(false);
		expect(coordinator.getSnapshot().input?.messages).toBe(before);
	});

	it("returns false before any document is loaded", async () => {
		const mod = await load();
		expect(new mod.PretextLayoutCoordinator().trimHead(5, atBottom)).toBe(false);
	});
});

describe("trimHead — history remains reachable", () => {
	/**
	 * The whole safety argument for trimming: what was dropped can be paged back in,
	 * contiguously. A gap here would be permanent data loss from the reader's view.
	 */
	it("re-fetches the dropped span with no gap and no overlap", async () => {
		const mod = await load();
		// `loadOlder` uses the load-time fetchPage, so the older-page server is wired
		// here: it answers `beforeSeq` by serving the messages strictly below it, which
		// is what a real server does.
		let requestedBeforeSeq: number | undefined;
		const coordinator = new mod.PretextLayoutCoordinator();
		await coordinator.load(
			"n1",
			BUILD,
			{
				fetchPage: async (_id: string, opts: { beforeSeq?: number }) => {
					if (opts.beforeSeq == null) return page(history, 7) as never;
					requestedBeforeSeq = opts.beforeSeq;
					const older = history.filter(
						(m) => (m as unknown as { seq: number }).seq < (opts.beforeSeq as number),
					);
					return page(older, 7) as never;
				},
			},
			undefined,
			600,
		);
		coordinator.trimHead(10, atBottom);
		expect(coordinator.getSnapshot().input?.oldestLoadedSeq).toBe(110);

		await coordinator.loadOlder(BUILD, atBottom);

		expect(requestedBeforeSeq).toBe(110);
		const messages = coordinator.getSnapshot().input?.messages ?? [];
		expect(messages.length).toBe(40);
		// Contiguous 100..139 again: no hole where the trim was.
		expect(messages.map((m) => (m as unknown as { seq: number }).seq)).toEqual(
			Array.from({ length: 40 }, (_, i) => i + 100),
		);
	});
});

describe("trimHead — the fill loop cannot be re-triggered by a trim", () => {
	/**
	 * The shell's first-screen fill effect re-fetches whenever the canvas is shorter
	 * than one viewport+overscan band while pinned. A trim sets `hasPrev` true and
	 * shortens the canvas, i.e. it recreates that effect's exact trigger — so without
	 * a guard, trim → refetch → regrow → trim loops forever, one request per round.
	 *
	 * Guard 1 (primary): resolveHeadTrim refuses unless the SURVIVORS still cover
	 * several bands. This asserts the loop is broken at the decision, before any of
	 * the shell's timing is involved.
	 */
	it("refuses a trim that would leave the canvas inside the fill trigger", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		const snapshot = coordinator.getSnapshot();
		const totalHeight = snapshot.index?.totalHeight ?? 0;
		const messages = snapshot.input?.messages ?? [];

		// A 40-message window is nowhere near the real trigger, so drive the count
		// thresholds down and leave the height rule at its production value: the point
		// is that the HEIGHT rule alone stops it.
		const decision = mod.resolveHeadTrim({
			messages: messages as readonly { id?: unknown; seq?: unknown }[],
			totalHeight,
			viewportHeight: 600,
			overscan: 600,
			pinnedToBottom: true,
			hasStreamingRow: false,
			targetMessages: 5,
			triggerMessages: 10,
		});
		expect(decision.trim).toBe(false);
		expect(decision.reason).toBe("below-threshold");
	});

	/** Guard 2: the cooldown timestamp is published for the shell's fill effect. */
	it("records a trim timestamp the fill loop can read, and clears it on reset", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		expect(coordinator.getLastTrimAt()).toBe(0);
		coordinator.trimHead(10, atBottom);
		const stamped = coordinator.getLastTrimAt();
		expect(stamped).toBeGreaterThan(0);
		expect(mod.trimClockNow() - stamped).toBeLessThan(mod.TRIM_FILL_COOLDOWN_MS);
		// A narrator switch must not hand the next document a stale cooldown.
		coordinator.reset();
		expect(coordinator.getLastTrimAt()).toBe(0);
	});
});

describe("trimHead — streaming output is never destroyed", () => {
	/**
	 * The concrete mechanism, pinned as an executable fact rather than a comment.
	 *
	 * `commitGrowthSignature` is `${length}:${newestId}`. A head trim changes the
	 * length while the newest id stays put, so the signature MOVES even though no
	 * message landed. The hand-off treats a signature change as "the document grew"
	 * and resets `charsSinceLastCommit` to 0 — which is precisely what stops
	 * `isStreamingMessageSuperseded` from protecting a live row. If this assertion
	 * ever fails, the reason trimming must avoid streaming has changed and the
	 * decision rule should be revisited.
	 */
	it("head-trimming moves commitGrowthSignature although nothing was appended", async () => {
		const mod = await load();
		const full = [...history];
		const trimmed = full.slice(10);
		expect(mod.commitGrowthSignature(trimmed)).not.toBe(mod.commitGrowthSignature(full));
		// ...and the newest id is unchanged, so the move is purely the length.
		expect(trimmed[trimmed.length - 1]?.id).toBe(full[full.length - 1]?.id);
	});

	it("refuses to trim while a live row is published", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		coordinator.setStreamingMessage(streamingRow(200), atBottom);
		const snapshot = coordinator.getSnapshot();
		const decision = mod.resolveHeadTrim({
			messages: (snapshot.input?.messages ?? []) as readonly { id?: unknown; seq?: unknown }[],
			totalHeight: snapshot.index?.totalHeight ?? 0,
			viewportHeight: 600,
			overscan: 600,
			pinnedToBottom: true,
			hasStreamingRow: snapshot.streamingMessage != null,
			targetMessages: 5,
			triggerMessages: 10,
			keepHeightFactor: 1,
		});
		expect(decision.trim).toBe(false);
		expect(decision.reason).toBe("streaming");
	});

	/**
	 * The dangerous shape spelled out: a text-only live row whose content is NOT yet
	 * persisted, with a renderable assistant message at the tail. With
	 * `charsSinceLastCommit` reset to 0 the hand-off retires the live row — so the
	 * only thing standing between this state and lost output is not trimming here.
	 */
	it("shows the live row would be retired if a trim reset the char counter", async () => {
		const mod = await load();
		const committed = [...history, message(140, "assistant", "已存储的回复")];
		const live = streamingRow(300);
		// While the counter is intact the row is safe...
		expect(
			mod.isStreamingMessageSuperseded({
				streamingMessage: live,
				committedMessages: committed,
				charsSinceLastCommit: 300,
			}),
		).toBe(false);
		// ...and once a trim-induced signature change zeroes it, it is retired.
		expect(
			mod.isStreamingMessageSuperseded({
				streamingMessage: live,
				committedMessages: committed,
				charsSinceLastCommit: 0,
			}),
		).toBe(true);
	});

	it("trims normally once the live row has cleared", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		coordinator.setStreamingMessage(streamingRow(200), atBottom);
		coordinator.setStreamingMessage(null, atBottom);
		expect(coordinator.getSnapshot().streamingMessage ?? null).toBe(null);
		expect(coordinator.trimHead(10, atBottom)).toBe(true);
		expect(coordinator.getSnapshot().input?.messages.length).toBe(30);
	});
});

describe("trimHead — protected rows", () => {
	it("refuses when the edited message is inside the cut", async () => {
		const mod = await load();
		const coordinator = await loadedCoordinator(mod);
		const snapshot = coordinator.getSnapshot();
		const messages = snapshot.input?.messages ?? [];
		const decision = mod.resolveHeadTrim({
			messages: messages as readonly { id?: unknown; seq?: unknown }[],
			// A tall canvas so the height rule cannot mask the rejection under test; the
			// same window WITHOUT the protected id must trim (control below).
			totalHeight: 400_000,
			viewportHeight: 600,
			overscan: 600,
			pinnedToBottom: true,
			hasStreamingRow: false,
			// The oldest loaded message is being edited: its draft must not be destroyed.
			protectedMessageIds: ["m100"],
			targetMessages: 20,
			triggerMessages: 30,
		});
		expect(decision.trim).toBe(false);
		expect(decision.reason).toBe("protected-in-range");

		// Control: identical input, no protected id → the trim proceeds. Without this
		// the assertion above could pass for the wrong reason.
		const control = mod.resolveHeadTrim({
			messages: messages as readonly { id?: unknown; seq?: unknown }[],
			totalHeight: 400_000,
			viewportHeight: 600,
			overscan: 600,
			pinnedToBottom: true,
			hasStreamingRow: false,
			targetMessages: 20,
			triggerMessages: 30,
		});
		expect(control.trim).toBe(true);
	});
});
