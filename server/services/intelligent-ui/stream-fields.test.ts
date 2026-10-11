import { describe, expect, test } from "bun:test";
import { ToolInputStream } from "@server/lib/agent/tool-input-stream";
import { intelligentUiParameters } from "@server/lib/agent/tools/intelligent-ui";
import { parseUiMarkup } from "@shared/intelligent-ui-markup";
import { INTELLIGENT_UI_STREAM_FIELDS } from "@shared/intelligent-ui-tool-policy";

/**
 * The server half of "UI appears while the model writes it": the agent loop feeds the
 * provider's raw argument JSON to a ToolInputStream configured with these fields and
 * forwards whatever it drains. This drives that stream the way a provider does, a few
 * characters at a time, and renders each forwarded delta the way the chat does.
 */
const INPUT = {
	action: "render",
	title: "Plans",
	size: "lg",
	source:
		'<Stack gap="sm">\n\t<Title order={4}>价格 "Plans"</Title>\n\t<Button onClick={sendPrompt("Compare")}>Compare</Button>\n</Stack>',
};

describe("IntelligentUI arguments stream as they are written", () => {
	test("the streamed fields are real parameters, and source is the last one declared", () => {
		const declared = Object.keys(intelligentUiParameters.shape);
		for (const field of [
			...INTELLIGENT_UI_STREAM_FIELDS.short,
			...INTELLIGENT_UI_STREAM_FIELDS.large,
		])
			expect(declared).toContain(field);
		expect(declared.at(-1)).toBe(INTELLIGENT_UI_STREAM_FIELDS.large[0] as string);
	});

	test("source arrives as ordered deltas, after the fields that label and size the card", () => {
		const raw = JSON.stringify(INPUT);
		const stream = new ToolInputStream(
			[...INTELLIGENT_UI_STREAM_FIELDS.short],
			[...INTELLIGENT_UI_STREAM_FIELDS.large],
		);
		const short: Record<string, string> = {};
		let source = "";
		let deltas = 0;
		let shortKnownAtFirstDelta: string[] | undefined;
		let previousElements = 0;
		for (let at = 0; at < raw.length; at += 5) {
			stream.feed(raw.slice(at, at + 5));
			Object.assign(short, stream.takeShortFields());
			for (const field of stream.drainFields()) {
				expect(field.name).toBe("source");
				expect(field.offset).toBe(source.length);
				shortKnownAtFirstDelta ??= Object.keys(short);
				source += field.delta;
				deltas++;
			}
			// What the chat would draw from the text forwarded so far.
			const partial = parseUiMarkup(source, { complete: false });
			expect(partial.elements).toBeGreaterThanOrEqual(previousElements);
			previousElements = partial.elements;
		}
		// Genuinely incremental, not one event when the argument closes.
		expect(deltas).toBeGreaterThan(10);
		expect(shortKnownAtFirstDelta).toEqual(["action", "title", "size"]);
		expect(short).toEqual({ action: "render", title: "Plans", size: "lg" });
		// JSON escapes (quotes, newlines, tabs, non-ASCII) are decoded before forwarding.
		expect(source).toBe(INPUT.source);
		expect(parseUiMarkup(source).diagnostics).toEqual([]);
		expect(previousElements).toBe(3);
		expect(stream.finish()).toEqual(INPUT);
	});
});
