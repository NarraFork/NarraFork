import { describe, expect, test } from "bun:test";
import { getNarratorStatusBarDisplay } from "./narrator-status-bar";

describe("getNarratorStatusBarDisplay", () => {
	test("ignores status/substatus from a different narrator cache entry", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: {
					id: "other-narrator",
					status: "idle",
					substatus: ["interrupted"],
				},
				liveSubstatus: [],
			}),
		).toEqual({ color: "gray", labelKey: "status_idle" });
	});

	test("shows interrupted only for the current narrator live substatus", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: { id: "current-narrator", status: "idle", substatus: [] },
				liveSubstatus: ["interrupted"],
			}),
		).toEqual({ color: "orange", labelKey: "status_interrupted" });
	});

	test("falls back to persisted substatus for a current non-active narrator", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: {
					id: "current-narrator",
					status: "idle",
					substatus: ["interrupted"],
				},
				liveSubstatus: [],
			}),
		).toEqual({ color: "orange", labelKey: "status_interrupted" });
	});

	test("normalizes legacy terminal status into substatus display", () => {
		expect(
			getNarratorStatusBarDisplay({
				panelNarratorId: "current-narrator",
				narrator: { id: "current-narrator", status: "interrupted", substatus: [] },
				liveSubstatus: [],
			}),
		).toEqual({ color: "orange", labelKey: "status_interrupted" });
	});
});

describe("NarratorPanel status layout contract", () => {
	test("long idle and elapsed labels can shrink without losing their full accessible text", async () => {
		const source = await Bun.file(new URL("./NarratorPanel.tsx", import.meta.url)).text();

		expect(source).toContain('style={{ flex: 1, minWidth: 0, overflow: "hidden" }}');
		expect(source).toMatch(/aria-label=\{`\$\{text\}, \$\{startedAtLabel\}`\}/);
		expect(source).toContain('maxWidth: "100%"');
	});

	test("every clipped status-bar label has a reveal affordance", async () => {
		const source = await Bun.file(new URL("./NarratorPanel.tsx", import.meta.url)).text();

		// The three labels the status row can clip route through TruncatedText, which
		// only arms its tooltip while the text is really cut off. A native `title`
		// would not work on touch, which is why it is no longer the mechanism here.
		expect(source).toContain('import { TruncatedText } from "../common/TruncatedText";');
		expect(source).toContain('<TruncatedText size="xs" c={workIndicatorColor}');
		expect(source).toContain(
			'<TruncatedText size="xs" c="dimmed" text={t(statusBarDisplay.labelKey)} />',
		);
		expect(source).toContain("text={quotaBalance}");

		// TurnElapsedTime has two shapes: with a start-time popover the full elapsed
		// text must be repeated inside the dropdown (a nested tooltip would double up
		// on the same gesture); without one it falls back to TruncatedText.
		const elapsed = source.slice(
			source.indexOf("function TurnElapsedTime("),
			source.indexOf("export function NarratorPanel("),
		);
		expect(elapsed).toContain("<TruncatedText");
		expect(elapsed).toMatch(/Popover\.Dropdown[\s\S]*\{text\}[\s\S]*\{startedAtLabel\}/);
	});

	test("icon-only status actions expose stable accessible names", async () => {
		const source = await Bun.file(new URL("./NarratorPanel.tsx", import.meta.url)).text();

		expect(source).toContain('aria-label={t("path_rules")}');
		expect(source.match(/aria-label=\{t\("relaxed_plan"\)\}/g)).toHaveLength(2);
		expect(source.match(/aria-label=\{terminalActionLabel\}/g)).toHaveLength(2);
		expect(source).toContain('aria-label={t("modelTooltip")}');
		expect(source).toContain('aria-label={t("reasoningEffort")}');
		expect(source).toContain('aria-label={t("permissionMode")}');
	});
});
