import { beforeAll, describe, expect, test } from "bun:test";
import {
	COMMUNICATION_PREVIEW_MAX_LINES,
	limitCommunicationPreview,
} from "@shared/communication-tool";
import { installCanvasStub } from "./test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});
const {
	measureCommunicationBubble,
	COMMUNICATION_BODY_MAX_CHARS,
	COMMUNICATION_BODY_MAX_HEIGHT,
	COMMUNICATION_ERROR_MAX_CHARS,
} = await import("./measure-communication-bubble");
const { measureInjectionBubble, INJECTION_BUBBLE_PADDING } = await import(
	"./measure-injection-bubble"
);

describe("shared communication preview budget", () => {
	test("leaves exactly-budget input intact and clips larger single-line input", () => {
		const exact = "x".repeat(COMMUNICATION_BODY_MAX_CHARS);
		expect(limitCommunicationPreview(exact)).toEqual({ text: exact, truncated: false });
		expect(limitCommunicationPreview(`${exact}x`)).toEqual({ text: exact, truncated: true });
	});

	test("clips at the first line or character limit for LF, CRLF, and CR", () => {
		for (const newline of ["\n", "\r\n", "\r"]) {
			const exact = Array(COMMUNICATION_PREVIEW_MAX_LINES).fill("line").join(newline);
			expect(limitCommunicationPreview(exact)).toEqual({ text: exact, truncated: false });
			expect(limitCommunicationPreview(`${exact}${newline}later`)).toEqual({
				text: exact,
				truncated: true,
			});
		}
		const message = `${"x".repeat(COMMUNICATION_BODY_MAX_CHARS + 10)}\n`.repeat(130);
		expect(limitCommunicationPreview(message).text.length).toBe(COMMUNICATION_BODY_MAX_CHARS);
	});

	test("does not leave half a surrogate pair at the character boundary", () => {
		const prefix = "x".repeat(COMMUNICATION_BODY_MAX_CHARS - 1);
		expect(limitCommunicationPreview(prefix + String.fromCodePoint(0x1f600))).toEqual({
			text: prefix,
			truncated: true,
		});
	});
});

describe("communication bubble geometry", () => {
	test("matches the injection frame and keeps markdown expanded at all LODs", () => {
		const message = "### Updates\n\n- first\n- second\n\n**Done**";
		const injection = measureInjectionBubble({ markdown: message }, 800);
		for (const lod of [1, 2, 3, 4, 5] as const) {
			const measured = measureCommunicationBubble({ message }, 800, lod);
			expect(measured.form).toBe("communication");
			expect(measured.height).toBe(injection.height);
			expect(measured.contentWidth).toBe(injection.contentWidth);
			expect(measured.usedWidth).toBe(injection.usedWidth);
			expect(measured.bodyHeight).toBe(injection.frame.contentHeight);
			expect(measured.blocks.map((block) => block.kind)).toEqual(
				injection.blocks.map((block) => block.kind),
			);
			expect(measured.viewFullTop).toBe(-1);
		}
	});

	test("caps parsed text and visible height independently", () => {
		const message = "long message paragraph\n\n".repeat(4000);
		const measured = measureCommunicationBubble({ message }, 400);
		expect(measured.measuredMarkdown).toBe(limitCommunicationPreview(message).text);
		expect(measured.measuredMarkdown.length).toBeLessThanOrEqual(COMMUNICATION_BODY_MAX_CHARS);
		expect(measured.measuredMarkdown.split("\n").length).toBe(COMMUNICATION_PREVIEW_MAX_LINES);
		expect(measured.bodyHeight).toBe(COMMUNICATION_BODY_MAX_HEIGHT);
		expect(measured.isTruncated).toBe(true);
		expect(measured.viewFullTop).toBeGreaterThan(measured.bodyTop + measured.bodyHeight);
		expect(measured.height).toBeLessThan(600);
	});

	test("preview truncation reserves a full-message action even for a short prefix", () => {
		const measured = measureCommunicationBubble({ message: "prefix", messageTruncated: true }, 500);
		expect(measured.isTruncated).toBe(true);
		expect(measured.viewFullTop).toBeGreaterThan(0);
	});

	test("error line stays below the capped message and before the viewer action", () => {
		const measured = measureCommunicationBubble(
			{ message: "body\n\n".repeat(2000), status: "error", error: "delivery failed ".repeat(500) },
			500,
		);
		expect(measured.errorTop).toBeGreaterThan(measured.bodyTop + measured.bodyHeight);
		expect(measured.viewFullTop).toBeGreaterThan(measured.errorTop);
		expect(measured.errorText.length).toBe(COMMUNICATION_ERROR_MAX_CHARS);
		expect(
			measureCommunicationBubble({ message: "x", status: "error" }, 500).errorTop,
		).toBeGreaterThan(0);
	});

	test("real fail status reserves an error row even without errorMessage", () => {
		const success = measureCommunicationBubble({ message: "sent text", status: "success" }, 500);
		for (const status of ["fail", "error", "failed"]) {
			const failed = measureCommunicationBubble(
				{ message: "sent text", status, warning: "queued" },
				500,
			);
			expect(failed.errorTop).toBeGreaterThan(0);
			expect(failed.warningTop).toBe(-1);
			expect(failed.height).toBeGreaterThan(success.height);
			expect(failed.errorText).toBe("");
			expect(failed.measuredMarkdown).toBe("sent text");
		}
	});

	test("code panels use the measured inner width of the shrink-wrapped frame", () => {
		const measured = measureCommunicationBubble({ message: "```ts\nconst x = 1;\n```" }, 900);
		expect(measured.contentWidth).toBeLessThanOrEqual(
			measured.usedWidth - INJECTION_BUBBLE_PADDING * 2,
		);
		expect(measured.usedWidth).toBeLessThan(900);
	});

	test("cache invalidates body, truncation, and error without a status transition", async () => {
		const { measureElementCached, VLIST_REGISTRY } = await import("../registry");
		const data = { message: "short", status: "success" };
		const initial = measureElementCached(
			"communication-bubble",
			data,
			500,
			3,
			undefined,
			"communication-cache-test",
		);
		expect(VLIST_REGISTRY["communication-bubble"].lodSensitive).toBe(false);
		expect(
			measureElementCached(
				"communication-bubble",
				{ ...data },
				500,
				3,
				undefined,
				"communication-cache-test",
			),
		).toBe(initial);
		for (const next of [
			{ ...data, message: "a different message" },
			{ ...data, messageTruncated: true },
			{ ...data, error: "recipient unavailable" },
			{ ...data, warning: "agent is busy" },
		]) {
			expect(
				measureElementCached(
					"communication-bubble",
					next,
					500,
					3,
					undefined,
					"communication-cache-test",
				),
			).not.toBe(initial);
		}
	});
});
