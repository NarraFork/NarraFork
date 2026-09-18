import { beforeAll, describe, expect, test } from "bun:test";
import { measureToolCall, resolveToolCallOpened } from "./measure-tool-call";
import { installCanvasStub } from "./test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

describe("preferOpen — ask cards default-expand at low LOD, fold still wins", () => {
	test("preferOpen expands at L1–L4 when the reader has not folded", () => {
		for (const lod of [1, 2, 3, 4] as const) {
			expect(
				resolveToolCallOpened(lod, {
					lodExempt: false,
					isRecent: false,
					opened: false,
					preferOpen: true,
				}),
			).toBe(true);
		}
	});

	test("preferOpen collapses on an EXPLICIT reader fold", () => {
		for (const lod of [1, 2, 3, 4, 5] as const) {
			expect(
				resolveToolCallOpened(lod, {
					lodExempt: false,
					isRecent: true,
					opened: false,
					userCollapsed: true,
					preferOpen: true,
				}),
			).toBe(false);
		}
	});

	test("preferOpen re-expands when the reader toggles open again", () => {
		expect(
			resolveToolCallOpened(3, {
				lodExempt: false,
				isRecent: false,
				opened: true,
				preferOpen: true,
			}),
		).toBe(true);
	});

	test("lodExempt still outranks preferOpen fold (pending forms stay open)", () => {
		expect(
			resolveToolCallOpened(3, {
				lodExempt: true,
				isRecent: false,
				opened: false,
				userCollapsed: true,
				preferOpen: true,
			}),
		).toBe(true);
	});

	test("category ask measure defaults to expanded at L3 without a stored preference", () => {
		const measured = measureToolCall(
			{
				toolName: "AskUserQuestion",
				summary: "Pick an option",
				category: "ask",
				status: "success",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.results",
							body: {
								kind: "ask",
								questions: [
									{
										header: "Approach?",
										omitHeader: false,
										options: [{ label: "Alpha", description: "First", selected: true }],
									},
								],
							},
						},
					],
				},
			},
			400,
			3,
			{},
		);
		expect(measured.effectiveOpened).toBe(true);
		expect(measured.height).toBeGreaterThan(measured.collapsedHeight);
	});

	test("category ask measure collapses when the reader stored a fold", () => {
		const measured = measureToolCall(
			{
				toolName: "AskUserQuestion",
				summary: "Pick an option",
				category: "ask",
				status: "success",
			},
			400,
			3,
			{ opened: false },
		);
		expect(measured.effectiveOpened).toBe(false);
		expect(measured.height).toBe(measured.collapsedHeight);
	});

	// ExitPlanMode is prefer-open by tool NAME (adapter stamps opts.preferOpen).
	// Category "plan" alone must NOT auto-expand — EnterPlanMode shares that category
	// and carries no plan body worth pinning open.
	test("ExitPlanMode preferOpen expands at L3; category plan alone does not", () => {
		const planBody = {
			kind: "sections" as const,
			sections: [
				{
					key: "input.plan",
					body: {
						kind: "capped" as const,
						id: "input.plan",
						source: "input.plan" as const,
						format: "markdown" as const,
						live: false,
						cap: "plan" as const,
						followTarget: { kind: "end" as const },
						text: "# Plan\n\nDo the thing.",
					},
				},
			],
		};
		const base = {
			toolName: "ExitPlanMode",
			summary: "Submit plan",
			category: "plan" as const,
			status: "success" as const,
			detail: planBody,
		};
		const preferOpen = measureToolCall(base, 600, 3, { preferOpen: true });
		const categoryOnly = measureToolCall(
			{ ...base, toolName: "EnterPlanMode", detail: undefined },
			600,
			3,
			{},
		);
		expect(preferOpen.effectiveOpened).toBe(true);
		expect(preferOpen.height).toBeGreaterThan(preferOpen.collapsedHeight);
		expect(categoryOnly.effectiveOpened).toBe(false);
	});

	test("ExitPlanMode preferOpen still honours an explicit reader fold", () => {
		const measured = measureToolCall(
			{
				toolName: "ExitPlanMode",
				summary: "Submit plan",
				category: "plan",
				status: "success",
			},
			600,
			3,
			{ preferOpen: true, opened: false },
		);
		expect(measured.effectiveOpened).toBe(false);
		expect(measured.height).toBe(measured.collapsedHeight);
	});
});
