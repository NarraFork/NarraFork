import { describe, expect, test } from "bun:test";
import {
	getNarratorStatusBarDisplay,
	type NarratorWorkIndicatorPrimary,
	planNarratorWorkIndicator,
	withQueueSubstatus,
} from "./narrator-status-bar";

describe("queue substatus", () => {
	const queued = ["reasoning", "queue_position:1", "queue_depth:2", "queue_message:waiting"];
	test("zero and empty events clear all queue tags before any text arrives", () => {
		expect(withQueueSubstatus(queued, 0, 0, "stale")).toEqual(["reasoning"]);
		expect(withQueueSubstatus(queued)).toEqual(["reasoning"]);
	});
	test("queue updates and message-only queues remain supported", () => {
		expect(withQueueSubstatus(queued, 2, 3)).toEqual([
			"reasoning",
			"queue_position:2",
			"queue_depth:3",
		]);
		expect(withQueueSubstatus(queued, undefined, undefined, "waiting")).toEqual([
			"reasoning",
			"queue_message:waiting",
		]);
	});
});

type WorkIndicatorInput = Parameters<typeof planNarratorWorkIndicator>[0];

const WORK_INDICATOR_FLAGS = [
	"isRetrying",
	"isBlockingCompacting",
	"isBackgroundCompacting",
	"isWaitingForModel",
	"isWaitingForQuota",
	"hasSpecTask",
	"isWaiting",
	"isPlanning",
	"hasCompactFailure",
] as const satisfies readonly (keyof WorkIndicatorInput)[];

function workIndicatorInput(overrides: Partial<WorkIndicatorInput> = {}): WorkIndicatorInput {
	return {
		isReflecting: false,
		isRetrying: false,
		isBlockingCompacting: false,
		isBackgroundCompacting: false,
		isWaitingForModel: false,
		isWaitingForQuota: false,
		hasSpecTask: false,
		isWaiting: false,
		isPlanning: false,
		hasCompactFailure: false,
		...overrides,
	};
}

/** Every combination of the nine booleans (2^9 = 512). */
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
	test("reflection takes precedence over waiting and task summaries", () => {
		expect(
			planNarratorWorkIndicator(
				workIndicatorInput({
					isReflecting: true,
					isWaiting: true,
					hasSpecTask: true,
				}),
			).primary,
		).toBe("reflecting");
		const display = getNarratorStatusBarDisplay({
			panelNarratorId: "n",
			narrator: { id: "n", status: "waiting" },
			liveSubstatus: ["reflecting"],
		});
		expect(display.labelKey).toBe("status_reflecting");
		expect(display.color).toBe("indigo");
	});
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
			// An exhausted quota window is the same kind of wait and ranks the same
			// way, right below the model outage.
			[{ isWaitingForModel: true, isWaitingForQuota: true }, "model_unavailable"],
			[{ isWaitingForQuota: true, hasSpecTask: true, isWaiting: true }, "quota_exhausted"],
			[{ isBlockingCompacting: true, isWaitingForQuota: true }, "blocking_compact"],
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

describe("status bar layout contract (NarratorInteractionStatusBar)", () => {
	const statusBar = () =>
		Bun.file(new URL("../interaction/NarratorInteractionStatusBar.tsx", import.meta.url)).text();
	const turnElapsed = () =>
		Bun.file(new URL("../interaction/TurnElapsedTime.tsx", import.meta.url)).text();

	test("queue suffix and separator share the positive-position/message condition", async () => {
		const source = await statusBar();
		expect(source).toContain(
			"((queue.positionValue != null && queue.positionValue > 0) || queue.messageValue) && (",
		);
	});
	test("idle background work reuses the live count and opens the correct task host", async () => {
		const source = await statusBar();
		// Keep preview/pushed-subagent views from opening a different narrator's tasks.
		expect(source).toContain("tasks.supported && tasks.buttonEnabled");
		expect(source).toContain("<BackgroundTasksStatusButton");
		expect(source).toContain("runningCount={tasks.runningCount}");
		// This entry reveals existing tabs instead of toggling them closed.
		expect(source).toContain("tasks.onOpenPanel");
	});

	test("long idle and elapsed labels can shrink without losing their full accessible text", async () => {
		const source = await statusBar();
		expect(source).toContain('style={{ flex: 1, minWidth: 0, overflow: "hidden" }}');
		// The elapsed-time popover repeats the full text as an accessible name.
		const elapsed = await turnElapsed();
		expect(elapsed).toMatch(/aria-label=\{`\$\{text\}, \$\{startedAtLabel\}`\}/);
		expect(elapsed).toContain('style={{ maxWidth: "100%" }}');
	});

	test("every clipped status-bar label has a reveal affordance", async () => {
		const source = await statusBar();
		// The labels the status row can clip route through TruncatedText, which only
		// arms its tooltip while the text is really cut off (a native title would not
		// work on touch).
		expect(source).toContain('import { TruncatedText } from "../../common/TruncatedText";');
		expect(source).toContain(
			'<TruncatedText size="xs" c="dimmed" text={t(workIndicator.statusBarDisplay.labelKey)} />',
		);
		expect(source).toContain("text={quota.balance}");

		// text is repeated inside the dropdown; without one it falls back to TruncatedText.
		const elapsed = await turnElapsed();
		const body = elapsed.slice(
			elapsed.indexOf("TurnElapsedTime({"),
			elapsed.indexOf("RetryCountdownText"),
		);
		expect(body).toContain("<TruncatedText");
		expect(body).toMatch(/Popover\.Dropdown[\s\S]*\{text\}[\s\S]*\{startedAtLabel\}/);
	});

	test("icon-only status actions expose stable accessible names", async () => {
		const source = await statusBar();
		expect(source).toContain('t("modelTooltip")');
		expect(source).toContain('t("reasoningEffort")');
		expect(source).toContain('t("permissionMode")');
	});

	test("registry-driven header entries are never nameless icons", async () => {
		// Header and bottom tools share the registry item renderer and accessible label.
		const toolbarItem = await Bun.file(
			new URL("./NarratorToolbarItem.tsx", import.meta.url),
		).text();
		expect(toolbarItem).toContain("aria-label={label}");
		// The overflow trigger owns its own name (it is not a registry entry).
		const overflow = await Bun.file(
			new URL("./NarratorToolbarOverflowMenu.tsx", import.meta.url),
		).text();
		expect(overflow).toContain("aria-label={moreLabel}");
	});
});
