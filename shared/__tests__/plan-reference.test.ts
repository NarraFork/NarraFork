/**
 * plan-reference.test.ts — the builder and the detector must stay in lockstep.
 *
 * The reference sentence is emitted in ONE place (model history rewriting) and
 * recognized in several (permission resolution, plan persistence, three render
 * paths). If the wording drifts from what the detector looks for, the detector
 * silently stops working and the sentence starts reaching users AS the plan —
 * the bug these tests exist to prevent. Asserting the round trip is therefore
 * the point: it fails the moment the two sides disagree.
 */

import { describe, expect, it } from "bun:test";
import {
	buildPlanReference,
	hasUsablePlanBody,
	isModelPlanReference,
	isPlanReferencePlaceholder,
} from "../plan-reference";

const PLAN_FILE = ".narrafork/plan-portable-jukebox-parrot--cnz6sszhQubPv9s0.md";

describe("buildPlanReference / isModelPlanReference round trip", () => {
	it("recognizes what the builder emits, for both approval outcomes", () => {
		for (const status of ["success", "fail"]) {
			expect(isModelPlanReference(buildPlanReference(PLAN_FILE, status))).toBe(true);
		}
	});

	it("states the outcome the tool call actually reached", () => {
		expect(buildPlanReference(PLAN_FILE, "fail")).toContain("The plan was not approved.");
		expect(buildPlanReference(PLAN_FILE, "success")).toContain("The plan was approved.");
		expect(buildPlanReference(PLAN_FILE, "success")).not.toContain("not approved");
	});

	it("names the plan file so the reader can reach the real plan", () => {
		expect(buildPlanReference(PLAN_FILE, "success")).toContain(PLAN_FILE);
	});
});

describe("isModelPlanReference — genuine plans are never flagged", () => {
	it("does not flag a real plan body", () => {
		const plan = "# Fix the thing\n\n## Step 1\n\nEdit the file.\n\n## Step 2\n\nRun the tests.";
		expect(isModelPlanReference(plan)).toBe(false);
	});

	it("does not flag a plan that merely discusses plan files", () => {
		expect(isModelPlanReference("# Plan\n\nWrite the plan to the plan file first.")).toBe(false);
	});

	it("does not flag a plan that quotes the sentence deep in its body", () => {
		// A plan ABOUT this mechanism legitimately quotes the reference. Only a
		// bounded prefix is scanned, so the quote must not make the whole plan
		// disappear from the UI.
		const plan = `${"# Plan\n\nBody paragraph.\n".repeat(60)}\n> ${buildPlanReference(PLAN_FILE, "success")}\n`;
		expect(isModelPlanReference(plan)).toBe(false);
	});

	it("handles empty and huge inputs without scanning everything", () => {
		expect(isModelPlanReference("")).toBe(false);
		expect(isModelPlanReference("x".repeat(1_000_000))).toBe(false);
	});
});

describe("isPlanReferencePlaceholder", () => {
	it("only accepts a string holding the reference", () => {
		expect(isPlanReferencePlaceholder(buildPlanReference(PLAN_FILE, "fail"))).toBe(true);
		expect(isPlanReferencePlaceholder("# Real plan\n\nbody")).toBe(false);
	});

	it("is safe on non-string inputs", () => {
		for (const value of [undefined, null, 42, {}, [], true]) {
			expect(isPlanReferencePlaceholder(value)).toBe(false);
		}
	});
});

/**
 * The rule every render path applies before trusting `inputJson.plan`. It is
 * shared precisely so the paths cannot disagree: one showing the reference while
 * another shows the plan is the failure mode this centralization removes.
 */
describe("hasUsablePlanBody", () => {
	it("accepts a real plan body", () => {
		expect(hasUsablePlanBody("# Plan\n\nDo the thing.")).toBe(true);
	});

	it("rejects our own model-facing reference, approved or not", () => {
		for (const status of ["success", "fail"]) {
			expect(hasUsablePlanBody(buildPlanReference(PLAN_FILE, status))).toBe(false);
		}
	});

	it("rejects absent and whitespace-only plans", () => {
		// A file-based plan resolved server-side never enters the streamed tool_use
		// input, so "no plan here" and "reference here" must answer identically.
		for (const value of ["", "   ", "\n\t ", undefined, null]) {
			expect(hasUsablePlanBody(value)).toBe(false);
		}
	});

	it("is safe on non-string inputs", () => {
		for (const value of [42, {}, [], true]) {
			expect(hasUsablePlanBody(value)).toBe(false);
		}
	});
});
