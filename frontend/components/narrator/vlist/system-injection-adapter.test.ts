/**
 * system-injection-adapter.test.ts — the vlist adapter's handling of an injected
 * message row (`system_injection`).
 *
 * An injection now owns a message row instead of riding on a neighbour's as a
 * side-car. Two properties matter for the layout kernel and are pinned here:
 *
 *  1. It routes to the EXISTING `system-text` element kind (`origin_notice` card), so
 *     no new element kind, measure/render pair, registry entry or fold channel is
 *     introduced. That was the whole point of picking this shape.
 *  2. The reader sees the projected body, never the row's model-facing text block —
 *     which sits in the same row and carries the instruction boilerplate.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type {
	SideCarBody,
	SideCarDoneTask,
	SideCarInboundMessage,
	SideCarKnowledgeHit,
} from "@shared/sidecar-body";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VLIST_REGISTRY } from "./registry";
import { type AdapterContext, type AdapterSegment, adaptSegment } from "./segment-adapter";

beforeAll(() => {
	installCanvasStub();
});

const CTX: AdapterContext = { lod: 5 };

/** Model-facing copy, complete with the boilerplate a reader must NOT be shown. */
const MODEL_TEXT = [
	"Current Dynamic Spec reminder (compiled from spec://tasks.json):",
	"- doing: migrate the queues",
	"Keep tasks.json to only text/status/protected; do not add IDs, timestamps, summaries.",
].join("\n");

const TASKS_BODY: SideCarBody = {
	kind: "tasks",
	variant: "current",
	tasks: [{ role: "doing", text: "migrate the queues", protected: true }],
};

function injectionSegment(
	block: Record<string, unknown>,
	over: Record<string, unknown> = {},
): AdapterSegment {
	return {
		kind: "message",
		msg: {
			id: "m1",
			role: "sys",
			createdAt: "2026-07-28T10:00:00.000Z",
			// The real row shape: model text first, injection block second.
			contentJson: [{ type: "text", text: MODEL_TEXT }, block] as never,
			...over,
		},
	};
}

function injectionData(block: Record<string, unknown>, over: Record<string, unknown> = {}) {
	const specs = adaptSegment(injectionSegment(block, over), CTX);
	expect(specs).toHaveLength(1);
	expect(specs[0]?.kind).toBe("system-text");
	return specs[0]?.data as {
		kind: string;
		text: string;
		title: string;
		timeLabel: string;
		origin: string;
		originLabel: string | null;
	};
}

/**
 * A producer with no bubble entitlement, used wherever these tests are about the CARD
 * path itself rather than about one producer.
 *
 * `living_work_spec` used to serve here, but the platform reminders now get speaker
 * bubbles — so it would have quietly turned these into assertions about a path they no
 * longer take. An unmapped source is the honest stand-in for "the generic fallback".
 */
const CARD_SOURCE = "future_producer_xyz";

describe("system_injection — routing", () => {
	it("produces exactly one system-text element, reusing the origin_notice card", () => {
		const data = injectionData({
			type: "system_injection",
			source: CARD_SOURCE,
			body: TASKS_BODY,
		});
		// No new element kind: the card is one the measure/render pair already covers.
		expect(data.kind).toBe("origin_notice");
	});

	it("the kind it routes to is registered, so it can actually be measured", () => {
		// Guards the failure mode that a new kind would introduce: an adapter emitting
		// something with no registry entry measures to nothing and paints blank.
		expect(VLIST_REGISTRY["system-text"]).toBeDefined();
	});

	it("the emitted data measures to a real height", () => {
		// The end-to-end property the routing choice was made for: the adapter's output
		// must be laid out by the EXISTING measure pair. Routing to a registered kind is
		// not enough — the payload has to be one that pair understands, or the row
		// measures to zero and paints as an invisible gap.
		const data = injectionData({
			type: "system_injection",
			source: CARD_SOURCE,
			body: TASKS_BODY,
		});
		const measured = VLIST_REGISTRY["system-text"].measure(data as never, 800, 5);
		expect(measured.height).toBeGreaterThan(0);

		// And the body must actually drive it: a taller body measures taller. This is
		// what proves the projected Markdown reached the measured text, rather than the
		// card being sized by its fixed chrome alone.
		const tall = injectionData({
			type: "system_injection",
			source: CARD_SOURCE,
			body: {
				kind: "tasks",
				variant: "current",
				tasks: Array.from({ length: 12 }, (_, i) => ({
					role: "todo" as const,
					text: `task number ${i} with enough text to occupy its own line`,
				})),
			},
		});
		const measuredTall = VLIST_REGISTRY["system-text"].measure(tall as never, 800, 5);
		expect(measuredTall.height).toBeGreaterThan(measured.height);
	});

	it("does not emit a `sidecar` element — the row IS the injection", () => {
		const specs = adaptSegment(
			injectionSegment({ type: "system_injection", source: "bg_agent", body: TASKS_BODY }),
			CTX,
		);
		expect(specs.map((s) => s.kind)).not.toContain("sidecar");
	});

	it("carries the row timestamp into the heading row", () => {
		const data = injectionData({ type: "system_injection", source: "bg_agent" });
		expect(data.timeLabel).toBe("07/28 10:00");
	});
});

describe("system_injection — the body the reader gets", () => {
	it("renders the projected body, not the model-facing text block", () => {
		const data = injectionData({
			type: "system_injection",
			source: CARD_SOURCE,
			body: TASKS_BODY,
		});
		expect(data.text).toContain("migrate the queues");
		// The instruction half is prompt engineering. Its presence here would mean the
		// adapter read the row's text block instead of projecting the body.
		expect(data.text).not.toContain("do not add IDs");
		expect(data.text).not.toContain("text/status/protected");
	});

	it("projects to Markdown structure (heading + list), not the private line vocabulary", () => {
		const data = injectionData({
			type: "system_injection",
			source: CARD_SOURCE,
			body: TASKS_BODY,
		});
		expect(data.text).toContain("### ");
		expect(data.text).toContain("- doing: migrate the queues");
	});

	it("falls back to the row text verbatim when the producer supplied no body", () => {
		// No structure to project, so the model-facing text is all there is. Shown as-is
		// and deliberately not parsed.
		const data = injectionData({ type: "system_injection", source: "some_source" });
		expect(data.text).toContain("migrate the queues");
		expect(data.text).toContain("do not add IDs");
	});

	it("reads a body that arrived under the DB column name (bodyJson)", () => {
		// HTTP-loaded rows spread the DB row through passthrough layers that do not
		// reshape it, so both wire shapes reach the adapter.
		const data = injectionData({
			type: "system_injection",
			source: CARD_SOURCE,
			bodyJson: TASKS_BODY,
		});
		expect(data.text).toContain("- doing: migrate the queues");
	});

	it("ignores a malformed body rather than throwing inside a render pass", () => {
		const data = injectionData({
			type: "system_injection",
			source: CARD_SOURCE,
			body: { kind: "not-a-real-kind" },
		});
		// Falls back to the verbatim text path.
		expect(data.text).toContain("migrate the queues");
	});
});

describe("system_injection — heading label", () => {
	it("uses the producer's label when the shell injected one", () => {
		const data = injectionData({ type: "system_injection", source: "bg_agent" }, {});
		// Without ctx.labels the adapter falls back to its own English table, which
		// mirrors the `sidecar.sources.*` copy.
		expect(data.title).toBe("Background agent");
	});

	it("resolves through ctx.labels when provided", () => {
		const specs = adaptSegment(
			injectionSegment({ type: "system_injection", source: "spec_update" }),
			{ lod: 5, labels: { sidecarSourceSpecUpdate: "大纲更新" } },
		);
		expect((specs[0]?.data as { title: string }).title).toBe("大纲更新");
	});

	it("an unmapped producer shows the generic system label, never its raw tag", () => {
		const data = injectionData({ type: "system_injection", source: "future_producer_xyz" });
		expect(data.title).toBe("System");
		expect(data.title).not.toContain("future_producer_xyz");
	});

	it("keeps the source on the data for the render layer, without showing it as the title", () => {
		const data = injectionData({ type: "system_injection", source: "bg_bash" });
		expect(data.originLabel).toBe("bg_bash");
		expect(data.origin).toBe("system");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Injections that SPEAK for somebody → one bubble per sender
//
// A `subagent_message` / `team_message` delivery can carry messages from several
// senders (the queue caps at 20). The generic card flattens them into one Markdown
// blob where the sender names survive only as sub-headings — identity demoted to
// typography. These are somebody talking, and the payload already says who, so each
// message gets its own framed bubble with its own speaker row.
// ─────────────────────────────────────────────────────────────────────────────

const MESSAGES_BODY = (items: SideCarInboundMessage[]): SideCarBody => ({
	kind: "messages",
	items,
});

function bubbleSpecs(source: string, items: SideCarInboundMessage[]) {
	return adaptSegment(
		injectionSegment({ type: "system_injection", source, body: MESSAGES_BODY(items) }),
		CTX,
	);
}

describe("spoken injections — one bubble per message row", () => {
	it("renders one framed bubble for the single message the row carries", () => {
		// Persistence delivers ONE message per row now (the fan-out loop is gone), so the
		// adapter maps the single item to a single bubble.
		const specs = bubbleSpecs("subagent_message", [
			{ fromId: "sub-aaaaaaaa11", fromTitle: "explorer", text: "found the leak" },
		]);
		expect(specs.map((s) => s.kind)).toEqual(["injection-bubble"]);
		// The key carries the SENDER, with no positional suffix — there is no second
		// bubble on the row to collide with.
		expect(specs[0]?.key).toBe("m1-b1-m-sub-aaaaaaaa11");
	});

	it("names the speaker, falling back to a short id prefix", () => {
		const named = bubbleSpecs("team_message", [
			{ fromId: "narr-abcdefgh99", fromTitle: "alice", fromType: "primary", text: "ping" },
		]);
		const namedData = named[0]?.data as { speaker: string; speakerKind: string | null };
		expect(namedData.speaker).toBe("alice");
		expect(namedData.speakerKind).toBe("primary");

		const anonymous = bubbleSpecs("team_message", [
			{ fromId: "narr-zyxwvuts11", text: "anonymous ping" },
		]);
		// Mirrors `senderLabel` in @shared/sidecar-body (an 8-char id prefix) so the
		// bubble header and the model-facing text name the same participant.
		expect((anonymous[0]?.data as { speaker: string }).speaker).toBe("narr-zyx");
	});

	it("carries the message's own text and no model-facing boilerplate", () => {
		const specs = bubbleSpecs("team_message", [{ fromId: "s1", text: "hello" }]);
		const md = (specs[0]?.data as { markdown: string }).markdown;
		expect(md).not.toContain("do not add IDs");
		expect(md).toBe("hello");
	});

	it("marks a broadcast so a channel-wide message is not read as a direct one", () => {
		const specs = bubbleSpecs("team_message", [
			{ fromId: "s1", fromTitle: "alice", text: "all hands", isBroadcast: true },
		]);
		expect((specs[0]?.data as { isBroadcast: boolean }).isBroadcast).toBe(true);
	});

	it("a blank message falls back to the card path (no bubble for empty content)", () => {
		// `deliverInjection` refuses to persist an empty content row at all, so a blank
		// message never reaches the bubble path in production. Fed directly here, it
		// degrades to the ordinary card rather than a bodiless bubble.
		const specs = bubbleSpecs("subagent_message", [
			{ fromId: "s1", fromTitle: "one", text: "   " },
		]);
		expect(specs[0]?.kind).not.toBe("injection-bubble");
	});

	it("measures through the registered kind", () => {
		const specs = bubbleSpecs("subagent_message", [{ fromId: "s1", text: "hello" }]);
		const measured = VLIST_REGISTRY["injection-bubble"].measure(specs[0]!.data, 600, 5, undefined);
		expect(measured.height).toBeGreaterThan(0);
		// Left-hand bubbles never span the row (see INJECTION_BUBBLE_MAX_WIDTH_RATIO).
		expect(measured.usedWidth).toBeLessThan(600);
	});
});

describe("spoken injections — which producers qualify", () => {
	it("every bubble carries the model-facing copy, so every row can be inspected", () => {
		// The regression this pins: the platform and knowledge branches shipped without
		// `modelFacing`, so those rows had no "what the model saw" item in their context
		// menu while message / task rows did — the same object type, inconsistently
		// inspectable.
		const cases: Array<{ source: string; body: SideCarBody }> = [
			{
				source: "spec_update",
				body: {
					kind: "specUpdates",
					items: [
						{
							uri: "spec://tasks.json",
							timestamp: "2026-01-01T00:00:00Z",
							updatedBy: "alice",
							taskSummary: "1 open task",
						},
					],
				},
			},
			{ source: "living_work_spec", body: TASKS_BODY },
			{
				source: "knowledge_base_hint",
				body: {
					kind: "knowledge",
					hits: [{ entryId: "k1", title: "Deploys", summary: "how deploys work" }],
				},
			},
		];
		for (const { source, body } of cases) {
			const specs = adaptSegment(injectionSegment({ type: "system_injection", source, body }), CTX);
			expect(specs[0]?.kind).toBe("injection-bubble");
			// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
			const data = specs[0]?.data as any;
			expect(typeof data.modelFacing).toBe("string");
			expect(data.modelFacing.length).toBeGreaterThan(0);
		}
	});

	it("a task digest and a continuation share ONE presentation", () => {
		// The regression this pins: the periodic `living_work_spec` digest used to render
		// as markdown bullets (status demoted to a "doing: " text prefix, protected to the
		// words "· protected") while `spec_continuation` rendered as a glyph+lock task
		// row. Same data, two visual languages. Both must resolve to the spec-task payload.
		const digest = adaptSegment(
			injectionSegment({
				type: "system_injection",
				source: "living_work_spec",
				body: {
					kind: "tasks",
					variant: "current",
					tasks: [
						{ role: "doing", text: "wire the flag", protected: true },
						{ role: "todo", text: "write the tests" },
					],
				},
			}),
			CTX,
		);
		const continuation = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "m1",
					role: "system",
					contentJson: [{ type: "spec_continuation", task: "wire the flag", protected: true }],
				},
			},
			CTX,
		);
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const digestPayload = (digest[0]?.data as any).payload;
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const continuationPayload = (continuation[0]?.data as any).payload;
		expect(digest[0]?.kind).toBe("injection-bubble");
		expect(continuation[0]?.kind).toBe("injection-bubble");
		// The shared contract: one payload kind, therefore one renderer.
		expect(digestPayload.kind).toBe("spec-task");
		expect(continuationPayload.kind).toBe("spec-task");
		// The digest keeps every row's role and protected flag as STRUCTURE, not prose.
		expect(digestPayload.data.tasks).toEqual([
			{ text: "wire the flag", role: "doing", protected: true },
			{ text: "write the tests", role: "todo", protected: false },
		]);
	});

	it("names a periodic digest's cadence in the header subtitle (not on a continuation)", () => {
		// The distinction this feature exists for: the routine `living_work_spec` digest
		// (every N tool calls) and the turn-end `spec_continuation` list the SAME tasks,
		// so without a marker they read identically. The digest's `cadenceInterval` is
		// projected into the header's `speakerKind` slot ("every N tool calls"), while a
		// continuation carries no cadence and therefore no subtitle.
		const digest = adaptSegment(
			injectionSegment({
				type: "system_injection",
				source: "living_work_spec",
				body: {
					kind: "tasks",
					variant: "current",
					cadenceInterval: 15,
					tasks: [{ role: "doing", text: "wire the flag" }],
				},
			}),
			CTX,
		);
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const digestData = digest[0]?.data as any;
		expect(digestData.speakerKind).toBe("every 15 tool calls");

		const noCadence = adaptSegment(
			injectionSegment({
				type: "system_injection",
				source: "living_work_spec",
				body: {
					kind: "tasks",
					variant: "current",
					tasks: [{ role: "doing", text: "wire the flag" }],
				},
			}),
			CTX,
		);
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		expect((noCadence[0]?.data as any).speakerKind).toBeNull();
	});

	it("an empty task digest says so instead of drawing no rows", () => {
		const specs = adaptSegment(
			injectionSegment({
				type: "system_injection",
				source: "living_work_spec",
				body: { kind: "tasks", variant: "emptyNever", tasks: [] },
			}),
			CTX,
		);
		// biome-ignore lint/suspicious/noExplicitAny: test reads dynamic data shape
		const payload = (specs[0]?.data as any).payload;
		expect(payload.kind).toBe("spec-task");
		expect(typeof payload.data.emptyLabel).toBe("string");
		expect(payload.data.emptyLabel.length).toBeGreaterThan(0);
	});

	it("gives routine platform reminders a bubble too, as ONE statement", () => {
		// Reversed deliberately. The earlier rule kept these full-width on the theory that a
		// routine reminder must not carry a teammate's visual weight, but the scheduler
		// saying "you still have 3 open tasks" IS an utterance with a speaker — the same
		// speaker as `spec_continuation`, which was already a bubble. Keeping one as a card
		// and the other as a bubble was internally inconsistent.
		//
		// One bubble per delivery, not per item: unlike inbound messages there is no
		// per-sender split to make.
		for (const source of ["silent_progress", "living_work_spec", "behavior_fence"]) {
			const specs = adaptSegment(
				injectionSegment({ type: "system_injection", source, body: TASKS_BODY }),
				CTX,
			);
			expect(specs).toHaveLength(1);
			expect(specs[0]?.kind).toBe("injection-bubble");
			// No coined per-producer name: the platform identity is resolved downstream from
			// `source`, so inventing "Scheduler" / "Fence" here would imply actors that do
			// not exist.
			const data = specs[0]?.data as { speaker: string | null; source: string };
			expect(data.speaker).toBeNull();
			expect(data.source).toBe(source);
		}
	});

	it("keeps the bubble narrower than the row, which is what fixes the long lines", () => {
		// The reader-visible reason for the change: a full-width card let long task text run
		// far past a comfortable measure.
		const specs = adaptSegment(
			injectionSegment({
				type: "system_injection",
				source: "living_work_spec",
				body: TASKS_BODY,
			}),
			CTX,
		);
		const measured = VLIST_REGISTRY["injection-bubble"].measure(specs[0]!.data, 900, 5, undefined);
		expect(measured.usedWidth).toBeLessThan(900);
	});

	it("leaves a spoken producer carrying a NON-messages body on the card path", () => {
		// The split reads the payload, not just the tag: a producer that suddenly sends a
		// tasks digest must degrade to the card rather than mint speaker-less bubbles.
		const data = injectionData({
			type: "system_injection",
			source: "team_message",
			body: TASKS_BODY,
		});
		expect(data.kind).toBe("origin_notice");
	});

	it("falls back to the card when a spoken delivery has no messages at all", () => {
		const data = injectionData({
			type: "system_injection",
			source: "team_message",
			body: MESSAGES_BODY([]),
		});
		expect(data.kind).toBe("origin_notice");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Finished background work → one bubble per task
//
// A background task is an addressable, NAMED thing: `Bash` takes an `alias` precisely
// so a later `Await({ id })` can refer to it. So "run-tests finished, here is its
// output" has a subject in the same way a teammate's message does — which is why
// `bg_bash` qualifies for a bubble and not only `bg_agent`.
// ─────────────────────────────────────────────────────────────────────────────

const TASKS_DONE_BODY = (flavor: "agent" | "bash", items: SideCarDoneTask[]): SideCarBody => ({
	kind: "tasksDone",
	flavor,
	items,
});

function taskBubbleSpecs(source: string, flavor: "agent" | "bash", items: SideCarDoneTask[]) {
	return adaptSegment(
		injectionSegment({
			type: "system_injection",
			source,
			body: TASKS_DONE_BODY(flavor, items),
		}),
		CTX,
	);
}

describe("background completions — one bubble per task row", () => {
	it("renders one framed bubble for the single finished task the row carries", () => {
		// Persistence delivers ONE finished task per row now, so the adapter maps the
		// single item to a single bubble keyed by the task id (no positional suffix).
		const specs = taskBubbleSpecs("bg_agent", "agent", [
			{ id: "t1", title: "explore auth", status: "success", preview: "found it" },
		]);
		expect(specs.map((s) => s.kind)).toEqual(["injection-bubble"]);
		expect(specs[0]?.key).toBe("m1-b1-t-t1");
	});

	it("names a bash task by the alias it was launched with", () => {
		// The alias is what the reader typed and what `Await({ id })` refers to, so it
		// wins over the derived title.
		const specs = taskBubbleSpecs("bg_bash", "bash", [
			{ id: "b1", alias: "run-tests", title: "bun test", status: "success", preview: "ok" },
		]);
		const data = specs[0]?.data as { speaker: string; speakerKind: string | null };
		expect(data.speaker).toBe("run-tests");
		expect(data.speakerKind).toBe("success");
	});

	it("falls back title → id when there is no alias", () => {
		const withTitle = taskBubbleSpecs("bg_bash", "bash", [
			{ id: "b1", title: "bun test", status: "success", preview: "ok" },
		]);
		expect((withTitle[0]?.data as { speaker: string }).speaker).toBe("bun test");

		const bare = taskBubbleSpecs("bg_bash", "bash", [
			{ id: "b2", title: "", status: "success", preview: "ok" },
		]);
		expect((bare[0]?.data as { speaker: string }).speaker).toBe("b2");
	});

	it("carries the task's own output as the bubble body", () => {
		const specs = taskBubbleSpecs("bg_agent", "agent", [
			{ id: "t1", title: "one", status: "success", preview: "first output" },
		]);
		expect((specs[0]?.data as { markdown: string }).markdown).toBe("first output");
	});

	it("keeps a bubble for a task that produced no output, and SAYS it is empty", () => {
		// "It finished, with nothing to show" IS the result, and the status is in the
		// header. Dropping the row would make a silent success look like it never ran.
		const specs = taskBubbleSpecs("bg_bash", "bash", [
			{ id: "b1", alias: "fmt", status: "success", title: "fmt", preview: "" },
		]);
		expect(specs).toHaveLength(1);
		const data = specs[0]?.data as { speaker: string; markdown: string };
		expect(data.speaker).toBe("fmt");
		expect(data.markdown.trim().length).toBeGreaterThan(0);
		// And it must be localizable rather than a hard-coded English string.
		const zh = adaptSegment(
			injectionSegment({
				type: "system_injection",
				source: "bg_bash",
				body: TASKS_DONE_BODY("bash", [
					{ id: "b1", alias: "fmt", status: "success", title: "fmt", preview: "" },
				]),
			}),
			{ lod: 5, labels: { empty: "（空）" } },
		);
		expect((zh[0]?.data as { markdown: string }).markdown).toBe("（空）");

		// The body must actually occupy height, which is the property the reader sees.
		const measured = VLIST_REGISTRY["injection-bubble"].measure(specs[0]!.data, 600, 5, undefined);
		const headerOnly = VLIST_REGISTRY["injection-bubble"].measure(
			{ ...(specs[0]!.data as Record<string, unknown>), markdown: "" },
			600,
			5,
			undefined,
		);
		expect(measured.height).toBeGreaterThan(headerOnly.height);
	});

	it("reserves the truncation note only for a clipped result", () => {
		const clipped = taskBubbleSpecs("bg_bash", "bash", [
			{ id: "b1", alias: "long", title: "long", status: "success", preview: "…", truncated: true },
		]);
		const plain = taskBubbleSpecs("bg_bash", "bash", [
			{ id: "b2", alias: "short", title: "short", status: "success", preview: "done" },
		]);
		expect((clipped[0]?.data as { hasNote: boolean }).hasNote).toBe(true);
		expect((plain[0]?.data as { hasNote: boolean }).hasNote).toBe(false);

		// And the note actually costs a measured line, so the render copy has room.
		const noted = VLIST_REGISTRY["injection-bubble"].measure(clipped[0]!.data, 600, 5, undefined);
		const plainMeasured = VLIST_REGISTRY["injection-bubble"].measure(
			plain[0]!.data,
			600,
			5,
			undefined,
		);
		expect(noted.height).toBeGreaterThan(plainMeasured.height);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge-base hits → shape follows the DATA, not the tag
//
// A hit is addressable and titled, so "this entry is relevant" does have a subject.
// But `summary` is frequently empty, and the projection then emits a bullet holding
// nothing but the title — a bubble per hit would be a stack of empty shells whose body
// repeats its own header, costing several times the height of the compact list for
// strictly less information.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWLEDGE_BODY = (hits: SideCarKnowledgeHit[]): SideCarBody => ({ kind: "knowledge", hits });

function knowledgeSpecs(hits: SideCarKnowledgeHit[]) {
	return adaptSegment(
		injectionSegment({
			type: "system_injection",
			source: "knowledge_base_hint",
			body: KNOWLEDGE_BODY(hits),
		}),
		CTX,
	);
}

describe("knowledge hits — bubbles only when there is an excerpt", () => {
	it("gives each substantive hit its own bubble, titled by the entry", () => {
		const specs = knowledgeSpecs([
			{ entryId: "k1", title: "Rebase policy", summary: "Always rebase onto trunk first." },
			{ entryId: "k2", title: "Merge policy", summary: "Squash exploration branches." },
		]);
		expect(specs.map((s) => s.kind)).toEqual(["injection-bubble", "injection-bubble"]);
		expect(specs.map((s) => s.key)).toEqual(["m1-b1-k-k1", "m1-b1-k-k2"]);
		const first = specs[0]?.data as { speaker: string; markdown: string };
		expect(first.speaker).toBe("Rebase policy");
		expect(first.markdown).toBe("Always rebase onto trunk first.");
	});

	it("keeps summary-less hits as the compact list", () => {
		// The empty-shell case: body would hold nothing but a repeat of the header.
		const data = injectionData({
			type: "system_injection",
			source: "knowledge_base_hint",
			body: KNOWLEDGE_BODY([
				{ entryId: "k1", title: "Rebase policy", summary: "" },
				{ entryId: "k2", title: "Merge policy", summary: "   " },
			]),
		});
		expect(data.kind).toBe("origin_notice");
	});

	it("keeps a MIXED batch as one list rather than two visual languages", () => {
		const data = injectionData({
			type: "system_injection",
			source: "knowledge_base_hint",
			body: KNOWLEDGE_BODY([
				{ entryId: "k1", title: "Has one", summary: "a real excerpt" },
				{ entryId: "k2", title: "Has none", summary: "" },
			]),
		});
		expect(data.kind).toBe("origin_notice");
	});

	it("falls back to the entry id when a hit has no title", () => {
		const specs = knowledgeSpecs([{ entryId: "k-42", title: "", summary: "body text" }]);
		expect((specs[0]?.data as { speaker: string }).speaker).toBe("k-42");
	});

	it("keeps an empty hit list on the card path", () => {
		const data = injectionData({
			type: "system_injection",
			source: "knowledge_base_hint",
			body: KNOWLEDGE_BODY([]),
		});
		expect(data.kind).toBe("origin_notice");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-authored FACTS that still have an author → framed system card
//
// The earlier cut asked "does it have a subject?" and answered no for platform events.
// That was wrong: `container_ready`'s own text says "You can use the Browser tool…" — it
// addresses the model and the model answers it. The real line is between an UTTERANCE in
// the conversation and a NOTE about the conversation (compact markers, prune dividers).
//
// Option A: the card is not flattened to prose, it becomes the bubble's BODY, so branch
// names / commit shas / badges keep their structure.
// ─────────────────────────────────────────────────────────────────────────────

function framedSpecs(block: Record<string, unknown>, over: Record<string, unknown> = {}) {
	return adaptSegment(injectionSegment(block, over), CTX);
}

describe("framed system cards — a card inside a speaker bubble", () => {
	it("wraps merge_summary and keeps its data projection untouched", () => {
		const specs = framedSpecs({ type: "merge_summary", text: "Merged feature-x into trunk" });
		expect(specs).toHaveLength(1);
		expect(specs[0]?.kind).toBe("injection-bubble");
		const data = specs[0]?.data as {
			payload: { kind: string; data: { text: string; hasAvatar: boolean } };
			source: string;
		};
		expect(data.payload.kind).toBe("merge_summary");
		// The card's own projection, byte-identical to the standalone path.
		expect(data.payload.data.text).toBe("Merged feature-x into trunk");
		expect(data.payload.data.hasAvatar).toBe(true);
		expect(data.source).toBe("merge_summary");
	});

	it("carries the real account so a merge can name the person who pressed it", () => {
		const creator = { id: "u1", username: "alice", avatarColor: "#f00", avatarImageId: null };
		const specs = framedSpecs({ type: "merge_summary", text: "Merged" }, { creator });
		const data = specs[0]?.data as { creator: { username: string } | null };
		expect(data.creator?.username).toBe("alice");
	});

	it("wraps the continuation as a task row the bubble draws itself", () => {
		// The Dynamic Spec continuation is no longer a nested card: the bubble renders a
		// status glyph + lock + wrapping text row directly (see measure-spec-task).
		const specs = framedSpecs({ type: "spec_continuation", task: "ship it", protected: true });
		const data = specs[0]?.data as {
			payload: { kind: string; data: { text: string; protected: boolean; blocked: boolean } };
		};
		expect(specs[0]?.kind).toBe("injection-bubble");
		expect(data.payload.kind).toBe("spec-task");
		expect(data.payload.data).toEqual({ text: "ship it", protected: true, blocked: false });
	});

	it("measures as chrome + the card's own height", () => {
		const specs = framedSpecs({ type: "merge_summary", text: "Merged" });
		const measured = VLIST_REGISTRY["injection-bubble"].measure(specs[0]!.data, 700, 5, undefined);
		expect(measured.height).toBeGreaterThan(0);
		// A framed card is a bubble, so it must not span the whole row.
		expect(measured.usedWidth).toBeLessThan(700);
	});

	it("leaves NOTES about the conversation as plain cards", () => {
		// A compact marker says "history was truncated here" — it is not somebody speaking.
		for (const block of [
			{ type: "compact", summary: "compacted" },
			{ type: "segment_compact", status: "compacting", text: "…" },
		]) {
			const specs = framedSpecs(block);
			expect(specs[0]?.kind).not.toBe("injection-bubble");
		}
	});

	it("leaves cards with LIVE BUTTONS as plain cards", () => {
		// `spec_fork_carryover` / `spec_context_cleared` / `spec_goal_added` own buttons the
		// shell wires by matching `kind === "system-text"`. Rerouting them would silently
		// unwire every button — they would still paint and do nothing. A dead button is a
		// worse outcome than a missing speaker row.
		for (const type of ["spec_fork_carryover", "spec_context_cleared", "spec_goal_added"]) {
			const specs = framedSpecs({ type, task: "t", text: "x" });
			expect(specs[0]?.kind).toBe("system-text");
		}
	});
});
