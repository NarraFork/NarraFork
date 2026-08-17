import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// measure-system-text imports @chenglou/pretext (canvas measureText), so the
// deterministic OffscreenCanvas stub MUST be installed before importing it —
// hence every test dynamically `await import()`s the module.
beforeAll(() => {
	installCanvasStub();
});

const SANS =
	"-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji";

describe("measureSystemTextCard — per-kind single-line height model", () => {
	it("info = card padding(10)×2 + one xs body line(17) = 37", async () => {
		const { measureSystemTextCard, systemTextSingleLineHeight } = await import(
			"./measure-system-text"
		);
		expect(systemTextSingleLineHeight("info")).toBe(37);
		const r = measureSystemTextCard("info", { text: "ok" }, 1000);
		expect(r.height).toBe(37);
	});

	it("tool_loaded / tool_unloaded = 37 (same shape as info)", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		expect(measureSystemTextCard("tool_loaded", { text: "Loaded skill x" }, 1000).height).toBe(37);
		expect(measureSystemTextCard("tool_unloaded", { text: "Unloaded skill x" }, 1000).height).toBe(
			37,
		);
	});

	it("bash_command = 37 (monospace body, one line)", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		const r = measureSystemTextCard("bash_command", { command: "ls -la" }, 1000);
		expect(r.height).toBe(37);
	});

	it("error = 37 (icon-16 row floor equals the one xs line)", async () => {
		const { measureSystemTextCard, systemTextSingleLineHeight } = await import(
			"./measure-system-text"
		);
		expect(systemTextSingleLineHeight("error")).toBe(37);
		const r = measureSystemTextCard("error", { text: "boom" }, 1000);
		expect(r.height).toBe(37);
	});

	it("segment_compact_failed = 56 (title row 19 + one body line 17 + padding)", async () => {
		const { measureSystemTextCard, systemTextSingleLineHeight } = await import(
			"./measure-system-text"
		);
		expect(systemTextSingleLineHeight("segment_compact_failed")).toBe(56);
		const r = measureSystemTextCard(
			"segment_compact_failed",
			{ title: "Compact failed", text: "network error" },
			1000,
		);
		expect(r.height).toBe(56);
	});

	it("spec_goal_added = 61 (body line 17 + gap 6 + button 18 + padding)", async () => {
		const { measureSystemTextCard, systemTextSingleLineHeight } = await import(
			"./measure-system-text"
		);
		expect(systemTextSingleLineHeight("spec_goal_added")).toBe(61);
		const r = measureSystemTextCard(
			"spec_goal_added",
			{ text: "ship the feature", badges: ["protected", "added"], buttons: ["View tasks"] },
			1000,
		);
		expect(r.height).toBe(61);
	});

	it("spec_fork_carryover / spec_context_cleared = 61 (badge row + button row)", async () => {
		const { measureSystemTextCard, systemTextSingleLineHeight } = await import(
			"./measure-system-text"
		);
		expect(systemTextSingleLineHeight("spec_fork_carryover")).toBe(61);
		expect(systemTextSingleLineHeight("spec_context_cleared")).toBe(61);
		expect(
			measureSystemTextCard("spec_fork_carryover", { text: "carried 3 tasks" }, 1000).height,
		).toBe(61);
		expect(
			measureSystemTextCard("spec_context_cleared", { text: "kept 3 tasks" }, 1000).height,
		).toBe(61);
	});
});

describe("measureSystemTextCard — pre-wrap body grows with wrapped line count", () => {
	it("info height increases as width shrinks (soft wrapping)", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
		const wide = measureSystemTextCard("info", { text }, 2000);
		const narrow = measureSystemTextCard("info", { text }, 160);
		expect(narrow.height).toBeGreaterThan(wide.height);
		// Growth is always a whole number of 17px body lines above the 37px base.
		expect((narrow.height - wide.height) % 17).toBe(0);
	});

	it("bash_command wraps long commands (monospace) and grows with narrower width", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		const command = "git log --oneline --graph --decorate --all --since='2 weeks ago' | head -n 50";
		const wide = measureSystemTextCard("bash_command", { command }, 2000);
		const narrow = measureSystemTextCard("bash_command", { command }, 120);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});
});

describe("measureSystemTextCard — pre-wrap preserves hard newlines; normal collapses them", () => {
	it("info (pre-wrap) keeps 3 hard-wrapped lines even at huge width", async () => {
		const { measureSystemTextCard, MEASURE_SYSTEM_TEXT_CONSTANTS } = await import(
			"./measure-system-text"
		);
		const r = measureSystemTextCard("info", { text: "line1\nline2\nline3" }, 4000);
		const c = MEASURE_SYSTEM_TEXT_CONSTANTS;
		const bodyHeight = r.height - c.CARD_PADDING * 2;
		expect(bodyHeight).toBe(c.BODY_LINE_HEIGHT * 3); // 3 preserved lines
	});

	it("spec_fork_carryover (normal) collapses newlines into a single line at huge width", async () => {
		const { measureSystemTextCard, systemTextSingleLineHeight } = await import(
			"./measure-system-text"
		);
		// Same hard-newline text as above, but the carryover description uses
		// whiteSpace:"normal", so \n is collapsed to whitespace → one line.
		const r = measureSystemTextCard("spec_fork_carryover", { text: "line1\nline2\nline3" }, 4000);
		expect(r.height).toBe(systemTextSingleLineHeight("spec_fork_carryover"));
	});

	it("bash_command prepends '$ ' to the command body", async () => {
		const { resolveBodyText } = await import("./measure-system-text");
		expect(resolveBodyText("bash_command", { command: "pwd" })).toBe("$ pwd");
		// falls back to `text` when `command` is absent
		expect(resolveBodyText("bash_command", { text: "echo hi" })).toBe("$ echo hi");
	});
});

describe("measureSystemTextCard — flanking chrome narrows the body width", () => {
	it("error body wraps at least as much as info for the same text/width", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		// error reserves icon + action icons L/R, so its body is narrower than
		// info's at the same card width → never fewer lines → height >= info.
		const text = "connection refused ".repeat(12);
		const info = measureSystemTextCard("info", { text }, 360);
		const error = measureSystemTextCard("error", { text }, 360);
		expect(error.height).toBeGreaterThanOrEqual(info.height);
	});

	it("segment_compact_failed body is narrower than info (icon + dismiss button reserves)", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		const text = "the summary model returned an error while compacting this segment ".repeat(4);
		const info = measureSystemTextCard("info", { text }, 400);
		const seg = measureSystemTextCard(
			"segment_compact_failed",
			{ title: "Failed", text, buttons: ["Dismiss"] },
			400,
		);
		// seg has more chrome (title row + narrower body) → strictly taller here.
		expect(seg.height).toBeGreaterThan(info.height);
	});
});

describe("measureSystemTextCard — height is independent of LOD", () => {
	it("all LOD levels produce the same height for every kind", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		const kinds = [
			"info",
			"tool_loaded",
			"tool_unloaded",
			"bash_command",
			"error",
			"segment_compact_failed",
			"spec_goal_added",
			"spec_fork_carryover",
			"spec_context_cleared",
		] as const;
		for (const kind of kinds) {
			const heights = ([1, 2, 3, 4, 5] as const).map(
				(lod) =>
					measureSystemTextCard(kind, { text: "some body text", title: "t" }, 500, lod).height,
			);
			expect(new Set(heights).size).toBe(1);
		}
	});
});

describe("measureSystemTextCard — block / frame shape", () => {
	it("produces exactly one pre-wrap code block carrying the body", async () => {
		const { measureSystemTextCard } = await import("./measure-system-text");
		const r = measureSystemTextCard("info", { text: "hello" }, 800);
		expect(r.blocks).toHaveLength(1);
		const [block] = r.blocks;
		expect(block?.kind).toBe("code");
	});

	it("frame contentHeight is the body-only height; total adds card chrome", async () => {
		const { measureSystemTextCard, MEASURE_SYSTEM_TEXT_CONSTANTS } = await import(
			"./measure-system-text"
		);
		const c = MEASURE_SYSTEM_TEXT_CONSTANTS;
		const r = measureSystemTextCard("info", { text: "one line" }, 800);
		// info has no pre/post chrome and sideMin 0, so total = padding×2 + body.
		expect(r.frame.contentHeight).toBe(c.BODY_LINE_HEIGHT);
		expect(r.height).toBe(c.CARD_PADDING * 2 + r.frame.contentHeight);
	});

	it("usedWidth follows the full card width; contentWidth is the inner body width", async () => {
		const { measureSystemTextCard, MEASURE_SYSTEM_TEXT_CONSTANTS } = await import(
			"./measure-system-text"
		);
		const c = MEASURE_SYSTEM_TEXT_CONSTANTS;
		const r = measureSystemTextCard("info", { text: "x" }, 640);
		expect(r.usedWidth).toBe(640);
		expect(r.contentWidth).toBe(640 - c.CARD_PADDING * 2); // info has no flanking chrome
	});

	it("error contentWidth subtracts the left icon + right action reserves", async () => {
		const { measureSystemTextCard, MEASURE_SYSTEM_TEXT_CONSTANTS } = await import(
			"./measure-system-text"
		);
		const c = MEASURE_SYSTEM_TEXT_CONSTANTS;
		const r = measureSystemTextCard("error", { text: "x" }, 640);
		expect(r.contentWidth).toBe(640 - c.CARD_PADDING * 2 - c.ERROR_LEFT - c.ERROR_RIGHT);
	});

	it("carries a prepared body measured with the SANS xs font for info", async () => {
		const { measureSystemTextCard, KIND_CHROME } = await import("./measure-system-text");
		expect(KIND_CHROME.info.font).toBe(`400 12px ${SANS}`);
		const r = measureSystemTextCard("info", { text: "x" }, 800);
		const [block] = r.blocks;
		expect(block?.kind).toBe("code");
	});

	it("bash_command uses a monospace font distinct from the SANS kinds", async () => {
		const { KIND_CHROME } = await import("./measure-system-text");
		expect(KIND_CHROME.bash_command.font).toContain("monospace");
		expect(KIND_CHROME.info.font).not.toContain("monospace");
	});
});
