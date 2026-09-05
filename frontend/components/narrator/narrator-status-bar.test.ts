import { describe, expect, test } from "bun:test";
import {
	getNarratorStatusBarDisplay,
	type NarratorWorkIndicatorPrimary,
	planNarratorWorkIndicator,
} from "./narrator-status-bar";

type WorkIndicatorInput = Parameters<typeof planNarratorWorkIndicator>[0];

const WORK_INDICATOR_FLAGS = [
	"isRetrying",
	"isBlockingCompacting",
	"isBackgroundCompacting",
	"isWaitingForModel",
	"hasSpecTask",
	"isWaiting",
	"isPlanning",
	"hasCompactFailure",
] as const satisfies readonly (keyof WorkIndicatorInput)[];

function workIndicatorInput(overrides: Partial<WorkIndicatorInput> = {}): WorkIndicatorInput {
	return {
		isRetrying: false,
		isBlockingCompacting: false,
		isBackgroundCompacting: false,
		isWaitingForModel: false,
		hasSpecTask: false,
		isWaiting: false,
		isPlanning: false,
		hasCompactFailure: false,
		...overrides,
	};
}

/** Every combination of the eight booleans (2^8 = 256). */
function allWorkIndicatorInputs(): WorkIndicatorInput[] {
	const inputs: WorkIndicatorInput[] = [];
	for (let mask = 0; mask < 1 << WORK_INDICATOR_FLAGS.length; mask++) {
		const overrides: Partial<WorkIndicatorInput> = {};
		WORK_INDICATOR_FLAGS.forEach((flag, index) => {
			overrides[flag] = (mask & (1 << index)) !== 0;
		});
		inputs.push(workIndicatorInput(overrides));
	}
	return inputs;
}

describe("planNarratorWorkIndicator", () => {
	test("a plain background compaction is reported once, in the primary slot", () => {
		// The regression: the primary label already says "compacting in background",
		// so appending the short suffix repeated both the phrase and the progress
		// fragment ("… · 256 chars · background compact · 256 chars").
		expect(planNarratorWorkIndicator(workIndicatorInput({ isBackgroundCompacting: true }))).toEqual(
			{
				primary: "background_compact",
				showBackgroundCompactSuffix: false,
				showCompactFailureSuffix: false,
			},
		);
	});

	test("the suffix carries the compaction when the primary slot shows a spec task", () => {
		// Also covers the inverse defect: this holds whether or not the turn is
		// still running, so a finished turn with a current task still reports it.
		expect(
			planNarratorWorkIndicator(
				workIndicatorInput({ isBackgroundCompacting: true, hasSpecTask: true }),
			),
		).toEqual({
			primary: "spec_task",
			showBackgroundCompactSuffix: true,
			showCompactFailureSuffix: false,
		});
	});

	test("blocking compaction owns the row and never gets a second compact line", () => {
		expect(
			planNarratorWorkIndicator(
				workIndicatorInput({ isBlockingCompacting: true, isBackgroundCompacting: true }),
			),
		).toEqual({
			primary: "blocking_compact",
			showBackgroundCompactSuffix: false,
			showCompactFailureSuffix: false,
		});
	});

	test("a compact failure gets the failure suffix regardless of the primary slot", () => {
		expect(planNarratorWorkIndicator(workIndicatorInput({ hasCompactFailure: true }))).toEqual({
			primary: "thinking",
			showBackgroundCompactSuffix: false,
			showCompactFailureSuffix: true,
		});
		expect(
			planNarratorWorkIndicator(workIndicatorInput({ hasCompactFailure: true, hasSpecTask: true })),
		).toEqual({
			primary: "spec_task",
			showBackgroundCompactSuffix: false,
			showCompactFailureSuffix: true,
		});
	});

	test("the failure suffix never sits next to a live compact", () => {
		// The state machine clears the failure the moment a new compact starts, so
		// these inputs "cannot happen" — the plan still refuses the combination, as
		// a backstop against a future caller that wires the flag differently.
		for (const input of allWorkIndicatorInputs()) {
			const plan = planNarratorWorkIndicator(input);
			if (input.isBlockingCompacting || input.isBackgroundCompacting) {
				expect(plan.showCompactFailureSuffix).toBe(false);
			}
			if (plan.showCompactFailureSuffix) {
				expect(input.hasCompactFailure).toBe(true);
			}
		}
	});

	test("background compaction is never announced twice in one row", () => {
		for (const input of allWorkIndicatorInputs()) {
			const plan = planNarratorWorkIndicator(input);
			expect(plan.showBackgroundCompactSuffix && plan.primary === "background_compact").toBe(false);
			if (plan.showBackgroundCompactSuffix) {
				expect(input.isBackgroundCompacting).toBe(true);
				expect(input.isBlockingCompacting).toBe(false);
			}
		}
	});

	test("keeps the established primary priority order", () => {
		const cases: Array<[Partial<WorkIndicatorInput>, NarratorWorkIndicatorPrimary]> = [
			// Retrying outranks everything, including a blocking compaction.
			[{ isRetrying: true, isBlockingCompacting: true, isWaiting: true }, "retrying"],
			[{ isBlockingCompacting: true, isWaitingForModel: true }, "blocking_compact"],
			// "Waiting for the model" must beat the plain waiting label it shares a
			// status with, and beat a current spec task.
			[{ isWaitingForModel: true, hasSpecTask: true, isWaiting: true }, "model_unavailable"],
			[{ hasSpecTask: true, isWaiting: true, isPlanning: true }, "spec_task"],
			[{ isWaiting: true, isPlanning: true }, "waiting"],
			[{ isPlanning: true, isBackgroundCompacting: true }, "planning"],
			[{ isBackgroundCompacting: true }, "background_compact"],
			[{}, "thinking"],
		];
		for (const [overrides, expected] of cases) {
			expect(planNarratorWorkIndicator(workIndicatorInput(overrides)).primary).toBe(expected);
		}
	});
});

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
		expect(source).toContain('aria-label={t("modelTooltip")}');
		expect(source).toContain('aria-label={t("reasoningEffort")}');
		expect(source).toContain('aria-label={t("permissionMode")}');

		/*
		 * The terminal entry moved into the registry-driven header toolbar, so its
		 * accessible name now comes from the resolved registry label rather than a
		 * local `terminalActionLabel` binding. Only the status-bar copy computes its
		 * own name inline.
		 *
		 * Asserted as "every terminal button has SOME aria-label" rather than by
		 * matching one expression: the point of this test is that an icon-only
		 * control is never nameless, and pinning it to a specific variable name is
		 * what made it fail on a refactor that kept the names intact.
		 */
		// Walk back from each terminal icon to the ActionIcon that opens it, rather
		// than matching a fixed window: a character budget silently reports "no
		// terminal buttons found" the moment a prop is reformatted, which passes a
		// `length > 0` check only by accident.
		const terminalButtons: string[] = [];
		for (let at = source.indexOf("<IconTerminal"); at !== -1; ) {
			const open = source.lastIndexOf("<ActionIcon", at);
			if (open !== -1) terminalButtons.push(source.slice(open, at));
			at = source.indexOf("<IconTerminal", at + 1);
		}
		expect(terminalButtons.length).toBeGreaterThan(0);
		for (const button of terminalButtons) {
			expect(button).toContain("aria-label=");
		}
	});

	test("registry-driven header entries are never nameless icons", async () => {
		const source = await Bun.file(new URL("./NarratorPanel.tsx", import.meta.url)).text();

		// Header tool entries render from `narrator-toolbar-items.tsx`, so their
		// accessible name is the resolved registry label. If this wiring is dropped,
		// EVERY tool button in the header loses its name at once — a single missing
		// prop, but a whole row of unlabelled icons.
		expect(source).toContain("aria-label={label}");
		// The overflow trigger owns its own name (it is not a registry entry).
		const overflow = await Bun.file(
			new URL("./NarratorToolbarOverflowMenu.tsx", import.meta.url),
		).text();
		expect(overflow).toContain("aria-label={moreLabel}");
	});
});
