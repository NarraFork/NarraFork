/**
 * Where the plan approval card offers 计划反思.
 *
 * The button is the only way to reflect on a plan that is ALREADY waiting, so it must appear on
 * exactly the requests the backend can still review — and nowhere a reflection makes no sense.
 * Those conditions are pure, so they are pinned here instead of being re-derived from a rendered
 * Mantine card (importing the component pulls the whole form, its preview query and the platform
 * capability hook into the test).
 */

import { describe, expect, test } from "bun:test";
import type { PendingPermission } from "@frontend/types/narrator";
import { shouldShowPlanReflectButton } from "./InlinePermission";

function planPermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
	return {
		id: "request-1",
		toolName: "ExitPlanMode",
		inputJson: { plan: "Add the regression test, then run it." },
		planReflectionAvailable: true,
		...overrides,
	};
}

describe("计划反思 button visibility", () => {
	test("a waiting plan approval backed by a runner offers the button", () => {
		expect(
			shouldShowPlanReflectButton({
				permission: planPermission(),
				hasHandler: true,
				editing: false,
			}),
		).toBe(true);
	});

	test("a request whose loop published no runner keeps the button off", () => {
		for (const value of [undefined, false]) {
			expect(
				shouldShowPlanReflectButton({
					permission: planPermission({ planReflectionAvailable: value }),
					hasHandler: true,
					editing: false,
				}),
			).toBe(false);
		}
	});

	test("other tools and an outline plan submission have no plan to reflect on", () => {
		expect(
			shouldShowPlanReflectButton({
				permission: planPermission({ toolName: "Bash", inputJson: { command: "ls" } }),
				hasHandler: true,
				editing: false,
			}),
		).toBe(false);
		expect(
			shouldShowPlanReflectButton({
				permission: planPermission({
					inputJson: {
						plan: "outline plan",
						_planRoot: { blockId: "plan-block", spaceId: "space", address: "1", title: "Plan" },
						_planSeq: 2,
						_planBaseSeq: 1,
					},
				}),
				hasHandler: true,
				editing: false,
			}),
		).toBe(false);
	});

	test("a card without the handler, or mid-edit, offers nothing", () => {
		expect(
			shouldShowPlanReflectButton({
				permission: planPermission(),
				hasHandler: false,
				editing: false,
			}),
		).toBe(false);
		expect(
			shouldShowPlanReflectButton({
				permission: planPermission(),
				hasHandler: true,
				editing: true,
			}),
		).toBe(false);
	});

	test("an edited draft keeps the button off: the review would approve the original", () => {
		expect(
			shouldShowPlanReflectButton({
				permission: planPermission(),
				hasHandler: true,
				editing: false,
				planEdited: true,
			}),
		).toBe(false);
	});
});
