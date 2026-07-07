import { describe, expect, test } from "bun:test";
import { resolveToolPlacement } from "./tool-placement";

describe("resolveToolPlacement", () => {
	test("first tool with chat present → split right at ~1/3 width", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: false,
			hasChatPanel: true,
			surfaceWidth: 900,
		});
		expect(p).toEqual({ mode: "split-right", initialWidth: 300 });
	});

	test("subsequent tool → stacks within the existing secondary group", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: true,
			hasChatPanel: true,
			surfaceWidth: 900,
		});
		expect(p).toEqual({ mode: "within-secondary" });
	});

	test("secondary group takes precedence even if width is unknown", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: true,
			hasChatPanel: true,
			surfaceWidth: 0,
		});
		expect(p.mode).toBe("within-secondary");
	});

	test("unknown surface width → split right with undefined initialWidth", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: false,
			hasChatPanel: true,
			surfaceWidth: 0,
		});
		expect(p).toEqual({ mode: "split-right", initialWidth: undefined });
	});

	test("no chat panel (defensive) → standalone", () => {
		const p = resolveToolPlacement({
			hasSecondaryGroup: false,
			hasChatPanel: false,
			surfaceWidth: 900,
		});
		expect(p).toEqual({ mode: "standalone" });
	});
});
