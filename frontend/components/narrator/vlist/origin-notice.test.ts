/**
 * origin-notice.test.ts — vlist handling of messages stored as `role: "user"`
 * that no human authored.
 *
 * Two invariants matter here:
 *   1. Such messages must NOT be painted as user bubbles (that ambiguity is the
 *      whole reason `origin` exists); they route to the origin_notice card.
 *   2. Adding the attribution badge must not change any measured height — the
 *      user-bubble header is a fixed 20px row shared by measure and render.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterContext, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { measureMessageBubble } from "./measure/measure-message-bubble";
import {
	MEASURE_SYSTEM_TEXT_CONSTANTS as c,
	KIND_CHROME,
	measureSystemTextCard,
	systemTextChromeHeight,
} from "./measure/measure-system-text";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";

beforeAll(() => {
	installCanvasStub();
});

const WIDTH = 600;
/** Full detail level, matching segment-adapter.test.ts. */
const CTX: AdapterContext = { lod: 5 };

function userMessage(extra: Record<string, unknown>) {
	return {
		kind: "message" as const,
		msg: {
			id: "m1",
			role: "user",
			contentJson: [{ type: "text", text: "continue the task" }],
			createdAt: "2026-07-28T10:00:00.000Z",
			...extra,
		},
	};
}

function adapt(extra: Record<string, unknown>) {
	return adaptSegment(userMessage(extra), CTX);
}

describe("structured async question answer projection", () => {
	const body = {
		kind: "asyncQuestionAnswers",
		questionId: "q1",
		context: "Old context",
		outcome: "answered",
		items: [{ id: "choice", header: "Which option?", answer: "A" }],
	};
	test("human receipts are compact, preserve question identity, and never measure full model text", () => {
		const specs = adapt({
			narratorId: "owner",
			origin: "user",
			contentJson: [
				{ type: "text", text: "Model receipt ".repeat(10000) },
				{ type: "system_injection", source: "async_question_answer", body },
			],
		});
		expect(specs).toHaveLength(1);
		expect((specs[0]?.data as { questionSnapshot?: unknown }).questionSnapshot).toBe(body);
		expect(specs[0]?.data).toMatchObject({
			kind: "origin_notice",
			origin: "user",
			text: "Which option?",
			questionReference: { questionId: "q1", narratorId: "owner" },
		});
		const measured = measureSystemTextCard("origin_notice", specs[0]?.data as never, WIDTH);
		expect(measured.height).toBe(systemTextChromeHeight("origin_notice") + c.BODY_LINE_HEIGHT);
		const largerSnapshot = adapt({
			narratorId: "owner",
			origin: "user",
			contentJson: [
				{
					type: "system_injection",
					source: "async_question_answer",
					body: {
						...body,
						context: "historical context ".repeat(50),
						items: [{ ...body.items[0], answer: "historical answer ".repeat(800) }],
					},
				},
			],
		});
		expect(
			measureSystemTextCard("origin_notice", largerSnapshot[0]?.data as never, WIDTH).height,
		).toBe(measured.height);
		const spec = specs[0];
		if (!spec) throw new Error("Missing question event projection");
		const actual = VLIST_REGISTRY[spec.kind].measure(spec.data, WIDTH, 5, spec.opts);
		const rendered = renderToStaticMarkup(
			createElement(
				MantineProvider,
				{ env: "test" },
				renderElement(spec.kind, actual, resolveRenderExtra(spec)),
			),
		);
		expect(rendered).toContain(`height:${actual.height}px`);
		expect(rendered).toContain("Which option?");
		expect(rendered).toContain("asyncQuestionDetails");
		expect(rendered).not.toContain("Model receipt");
		expect(rendered).not.toContain("Old context");
	});
	test("supplements use the same compact geometry and legacy bodies retain their verbatim fallback", () => {
		const supplemental = adapt({
			narratorId: "owner",
			origin: "user",
			contentJson: [
				{
					type: "system_injection",
					source: "async_question_answer",
					body: { ...body, supplement: "Correction ".repeat(10000) },
				},
			],
		});
		expect(supplemental[0]?.data).toMatchObject({ origin: "user", text: "Which option?" });
		expect((supplemental[0]?.data as { title: string }).title).toContain("Supplemented");
		const legacy = adapt({
			origin: "user",
			contentJson: [
				{ type: "text", text: "Legacy complete receipt" },
				{
					type: "system_injection",
					source: "async_question_answer",
					body: { kind: "asyncQuestionAnswers", outcome: "answered", items: body.items },
				},
			],
		});
		expect(legacy[0]?.kind).toBe("message-bubble");
		expect(legacy[0]?.data).toMatchObject({ text: "Legacy complete receipt" });
	});
});

describe("adapter routing by origin", () => {
	test("a human message still renders as a bubble", () => {
		const specs = adapt({ origin: "user" });
		expect(specs[0]?.kind).toBe("message-bubble");
	});

	test("a pre-column message (origin null) still renders as a bubble", () => {
		const specs = adapt({});
		expect(specs[0]?.kind).toBe("message-bubble");
	});

	test("a system-injected turn routes to the origin_notice card", () => {
		const specs = adapt({ origin: "system", originLabel: "autoContinuation" });
		expect(specs[0]?.kind).toBe("system-text");
		expect((specs[0]?.data as { kind: string }).kind).toBe("origin_notice");
	});

	test("an AI-initiated turn routes to the origin_notice card", () => {
		const specs = adapt({ origin: "assistant", originLabel: "forkNarrator" });
		expect((specs[0]?.data as { kind: string }).kind).toBe("origin_notice");
	});

	test("a legacy message from another agent uses an injection bubble", () => {
		// A `Send` to a subagent is persisted as `role: "user"` with a `created_by` naming
		// whoever's session triggered it. Before `origin` was written on this path the row
		// took the bubble branch and got signed with that person's avatar, even though an
		// AI wrote the words.
		const specs = adapt({ origin: "assistant", originLabel: "agentMessage:explore-1" });
		expect(specs[0]?.kind).toBe("injection-bubble");
		expect(specs[0]?.data).toMatchObject({
			markdown: "continue the task",
			speakerId: null,
			target: null,
		});
	});

	test("the agent-message heading names the SENDER, not the triggering human", () => {
		const specs = adaptSegment(
			userMessage({ origin: "assistant", originLabel: "agentMessage:Fix the lease path" }),
			{ ...CTX, labels: { originSourceAgentMessage: "代理消息" } },
		);
		expect((specs[0]?.data as { speaker: string }).speaker).toBe("代理消息 · Fix the lease path");
	});

	test("the agent-message source is recognized, so it never leaks its raw label", () => {
		// An unmapped source falls through to the raw stored string; that would surface
		// the internal `agentMessage:` token in the header.
		const specs = adapt({ origin: "assistant", originLabel: "agentMessage:explore-1" });
		expect((specs[0]?.data as { speaker: string }).speaker).toBe("Agent message · explore-1");
	});

	test("a plan-reflection-approved turn stays a bubble (origin user + planReflection label)", () => {
		// The plan reflection approves without a human, but the turn is persisted as
		// `origin: "user"` so it still routes to the bubble branch — the
		// `planReflection` label only drives the header identity / side, not the
		// system-card routing. Painting it as an origin_notice would drop the
		// "计划反思" header this feature exists to show.
		const specs = adapt({ origin: "user", originLabel: "planReflection" });
		expect(specs[0]?.kind).toBe("message-bubble");
		// The adapter forwards origin/originLabel so the header can resolve the
		// "计划反思" identity and the left-hand side (see segment-adapter).
		const data = specs[0]?.data as { origin?: string; originLabel?: string };
		expect(data.origin).toBe("user");
		expect(data.originLabel).toBe("planReflection");
	});

	test("the heading is localizable through ctx.labels", () => {
		const specs = adaptSegment(userMessage({ origin: "system", originLabel: "review" }), {
			...CTX,
			labels: { originSourceReview: "代码评审" },
		});
		expect((specs[0]?.data as { title: string }).title).toBe("代码评审");
	});

	test("dynamic detail is appended verbatim (it is an identifier, not prose)", () => {
		const specs = adaptSegment(
			userMessage({ origin: "system", originLabel: "scheduledTask:nightly-report" }),
			{ ...CTX, labels: { originSourceScheduledTask: "定时任务" } },
		);
		expect((specs[0]?.data as { title: string }).title).toBe("定时任务 · nightly-report");
	});

	test("carries the body text so the notice is not empty", () => {
		const specs = adapt({ origin: "system", originLabel: "review" });
		expect((specs[0]?.data as { text: string }).text).toBe("continue the task");
	});

	test("preformats the timestamp (the render layer has no locale imports)", () => {
		const specs = adapt({ origin: "system", originLabel: "review" });
		expect((specs[0]?.data as { timeLabel: string }).timeLabel).toMatch(/^\d{2}[:/]/);
	});
});

describe("origin_notice geometry", () => {
	test("reserves exactly one heading line plus its gap above the body", () => {
		expect(systemTextChromeHeight("origin_notice")).toBe(
			c.CARD_PADDING * 2 + c.BODY_LINE_HEIGHT + c.ORIGIN_HEADING_GAP,
		);
	});

	test("gives the body the full card width (heading stacks above, not beside)", () => {
		expect(KIND_CHROME.origin_notice.leftChrome).toBe(0);
		expect(KIND_CHROME.origin_notice.rightChrome).toBe(0);
	});

	test("a one-line body measures as chrome + one line", () => {
		const r = measureSystemTextCard("origin_notice", { text: "short" }, WIDTH);
		expect(r.height).toBe(systemTextChromeHeight("origin_notice") + c.BODY_LINE_HEIGHT);
	});

	test("height grows with the body, so long prompts are not clipped", () => {
		const short = measureSystemTextCard("origin_notice", { text: "short" }, WIDTH);
		const long = measureSystemTextCard(
			"origin_notice",
			{ text: "word ".repeat(400).trim() },
			WIDTH,
		);
		expect(long.height).toBeGreaterThan(short.height);
	});
});

describe("user-bubble header height is unaffected by attribution", () => {
	// The badge is an icon inside the already-reserved header row. If it ever
	// changed the measured height, measure and render would disagree and rows
	// would overlap in the virtual list.
	test("origin fields do not alter the measured bubble height", () => {
		const base = measureMessageBubble({ role: "user", text: "hello", hasHeader: true }, WIDTH);
		const withOrigin = measureMessageBubble(
			{
				role: "user",
				text: "hello",
				hasHeader: true,
				// Extra height-neutral fields the render layer reads.
				...({ origin: "user", originLabel: "gateway:telegram @foo" } as object),
			},
			WIDTH,
		);
		expect(withOrigin.height).toBe(base.height);
	});
});
