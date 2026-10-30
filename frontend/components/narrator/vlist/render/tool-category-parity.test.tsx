/**
 * tool-category-parity.test.tsx — every category the classifier can emit must be
 * paintable by the vlist render layer.
 *
 * `tool-display.ts` (the classifier) and `measure/measure-tool-call.ts` (the pure
 * measure layer) each declare their own `ToolCategory` union, and the vlist colour
 * and icon tables are keyed by the measure copy. When `schedule` was added to the
 * classifier only, a ScheduledTask card header looked up `CATEGORY_COLOR.schedule`,
 * got `undefined`, and Mantine's colour parser threw ("Failed to parse color"),
 * taking the whole narrator view down with the root error boundary.
 *
 * The compile-time check below fails `tsgo` the moment the two unions drift; the
 * runtime cases cover the tables and a real card render for the category that broke.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type ToolCategory as ClassifierCategory,
	getCategory,
	getCategoryColor,
} from "../../tool-call/tool-display";
import type { ToolCategory as MeasureCategory, ToolCallData } from "../measure/measure-tool-call";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { categoryIcon } from "./category-icons";
import { CATEGORY_COLOR, RenderToolCall } from "./RenderToolCall";

// Compile-time: the two unions must be identical in both directions.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const unionsMatch: Exact<ClassifierCategory, MeasureCategory> = true;

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let measureToolCall: typeof import("../measure/measure-tool-call").measureToolCall;
beforeAll(async () => {
	measureToolCall = (await import("../measure/measure-tool-call")).measureToolCall;
});

/**
 * Every category the CLASSIFIER can emit, enumerated independently of the vlist
 * tables (iterating `Object.keys(CATEGORY_COLOR)` would skip exactly the missing key).
 * `satisfies Record<…>` makes tsgo reject this list if a category is added or removed.
 */
const CLASSIFIER_CATEGORIES = Object.keys({
	read: 1,
	file: 1,
	bash: 1,
	search: 1,
	structure: 1,
	structureEdit: 1,
	webSearch: 1,
	webFetch: 1,
	tasks: 1,
	taskOutput: 1,
	agent: 1,
	await: 1,
	stop: 1,
	send: 1,
	ask: 1,
	plan: 1,
	pipeline: 1,
	terminal: 1,
	share: 1,
	transfer: 1,
	recall: 1,
	skill: 1,
	browser: 1,
	knowledge: 1,
	outline: 1,
	schedule: 1,
	contextAsk: 1,
	workspace: 1,
	generic: 1,
} satisfies Record<ClassifierCategory, 1>) as ClassifierCategory[];

describe("tool category parity — classifier vs vlist render tables", () => {
	it("keeps the classifier and measure ToolCategory unions identical", () => {
		expect(unionsMatch).toBe(true);
	});

	it("gives every classifier category a defined vlist colour equal to getCategoryColor", () => {
		for (const category of CLASSIFIER_CATEGORIES) {
			const color = (CATEGORY_COLOR as Record<string, string | undefined>)[category];
			expect(typeof color, category).toBe("string");
			expect(color, category).toBe(getCategoryColor(category));
		}
	});

	it("classifies ScheduledTask as schedule and paints it yellow with its own glyph", () => {
		expect(getCategory("ScheduledTask", { action: "create" })).toBe("schedule");
		expect(CATEGORY_COLOR.schedule).toBe("yellow");
		expect(categoryIcon("schedule")).not.toBe(categoryIcon("generic"));
		expect(categoryIcon("schedule")).not.toBe(categoryIcon("await"));
	});

	it("renders a ScheduledTask card header without throwing", () => {
		const measured = measureToolCall(
			{
				toolName: "ScheduledTask",
				summary: "create · Nightly report",
				category: "schedule",
				status: "success",
			} as ToolCallData,
			600,
			5,
		);
		const render = (node: ReactNode) =>
			renderToStaticMarkup(<MantineProvider forceColorScheme="dark">{node}</MantineProvider>);
		const html = render(<RenderToolCall measured={measured} />);
		expect(html).toContain("data-nf-card-header-chip");
		expect(html).toContain("yellow");
	});
});
