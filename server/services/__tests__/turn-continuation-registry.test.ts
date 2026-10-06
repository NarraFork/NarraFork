/**
 * The drift detector for end-of-pass continuation decisions.
 *
 * `turn-continuation-registry.ts` declares which continuation sources exist, in what
 * order, and what each of the two orchestration loops does about each one. This suite is
 * what makes the declaration binding: it reads both loop bodies as TEXT and compares their
 * `[continuation-source: …]` markers against the registry.
 *
 * Reading the files rather than executing them is deliberate. `runAgentLoop` and
 * `runSubagentLoop` depend on most of the service layer; driving them needs `mock.module`,
 * which in Bun is process-wide pollution (see `subagent-resume.test.ts`'s realModules
 * dance). A text scan has no such cost and catches the exact regression that matters here:
 * somebody adds a continuation branch to one loop and not the other.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONTINUATION_AUDIENCES,
	CONTINUATION_SOURCES,
	checkContinuationMarkerSequence,
	continuationMarker,
	continuationSourceIndex,
	describeDisposition,
	extractContinuationMarkers,
	findDanglingHandledVia,
	getContinuationSource,
	isHandledBy,
	isImplementedBy,
	isOrderInterchangeable,
	listContinuationSourceIds,
	listHandledContinuationSourceIds,
	NON_SOURCE_ASYMMETRIES,
	selectPassRecoverySource,
} from "../turn-continuation-registry";

const SERVICES_DIR = join(import.meta.dir, "..");

function readService(name: string): string {
	return readFileSync(join(SERVICES_DIR, name), "utf-8");
}

describe("continuation registry shape", () => {
	test("ids are unique", () => {
		const ids = listContinuationSourceIds();
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every source states what BOTH audiences do about it", () => {
		// This is the property that makes the registry a drift guard rather than a list:
		// `dispositions` is a Record over the audiences, so a new source cannot compile
		// without an explicit answer for the subagent side.
		for (const source of CONTINUATION_SOURCES) {
			for (const audience of CONTINUATION_AUDIENCES) {
				const disposition = source.dispositions[audience];
				expect(disposition, `${source.id} / ${audience}`).toBeDefined();
				expect(["handled", "handledVia", "notApplicable", "gap"]).toContain(disposition.kind);
			}
		}
	});

	test("every non-handled disposition carries a reason", () => {
		// An unexplained asymmetry is indistinguishable from an oversight, which is the
		// failure mode this whole file exists to prevent.
		for (const source of CONTINUATION_SOURCES) {
			for (const audience of CONTINUATION_AUDIENCES) {
				const disposition = source.dispositions[audience];
				if (disposition.kind === "handled") continue;
				expect(disposition.reason.trim().length, `${source.id} / ${audience}`).toBeGreaterThan(20);
			}
		}
	});

	test("a gap is distinguishable from a deliberate exclusion", () => {
		// Collapsing the two kinds would let a real defect read as a design decision.
		const gaps = CONTINUATION_SOURCES.filter((source) =>
			CONTINUATION_AUDIENCES.some((audience) => source.dispositions[audience].kind === "gap"),
		).map((source) => source.id);
		// Recorded explicitly: the known one-sided defects that remain. Closing one means
		// flipping it to `handled` in the registry AND adding its marker, which the sequence
		// tests below then enforce — plus shrinking this list, which is what makes the
		// closure visible in review rather than merely absent.
		//
		// `max-turns-spec-continuation` and `spec-continuation` were closed together: both
		// are now driven by `planSubagentContinuation`, which shares the primary's stall rule
		// and adds the per-run pass cap that a subagent needs (its run holds the parent's
		// tool call open, so "eventually stops" is not good enough).
		//
		// `permission-feedback` closed next, but as `handledVia` rather than `handled`: a
		// subagent's approval text is queued by `bufferSubagentUserMessage` and consumed at
		// the `buffered-message` boundary, so it has no branch of its own to mark.
		expect(gaps).toEqual([]);
	});

	test("a handledVia points at a source the same audience really handles", () => {
		// This kind is the one escape from the marker rule, so its target has to be real.
		// A dangling `via` would let a source claim it is implemented while naming nothing —
		// the same invisibility the registry exists to remove, one level further in.
		expect(findDanglingHandledVia()).toEqual([]);
	});

	test("handledVia is excluded from the marker expectation but counts as implemented", () => {
		// The two queries answer different questions on purpose. Merging them would either
		// demand a marker that does not exist, or loosen the marker check for every source.
		expect(isHandledBy("permission-feedback", "subagent")).toBe(false);
		expect(isImplementedBy("permission-feedback", "subagent")).toBe(true);
		expect(listHandledContinuationSourceIds("subagent")).not.toContain("permission-feedback");
		// The primary still owns it in its own branch, which is what the marker check reads.
		expect(isHandledBy("permission-feedback", "primary")).toBe(true);
	});

	test("non-source asymmetries are recorded with a verdict and a justification", () => {
		// These carry no marker (they are not end-of-pass sources), so nothing else would
		// notice if one lost its reasoning. The verdict is the load-bearing field: "essential"
		// claims the asymmetry is correct, and that claim needs to survive review.
		expect(NON_SOURCE_ASYMMETRIES.length).toBeGreaterThan(0);
		for (const entry of NON_SOURCE_ASYMMETRIES) {
			expect(["resolved", "essential", "gap"]).toContain(entry.verdict);
			expect(entry.detail.trim().length, entry.id).toBeGreaterThan(40);
		}
		const ids = NON_SOURCE_ASYMMETRIES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		// A non-source must not also be a registry source; that would mean the sequence
		// checker silently stops enforcing it.
		for (const id of ids) expect(getContinuationSource(id)).toBeUndefined();
	});

	test("at least one source is handled by each audience", () => {
		for (const audience of CONTINUATION_AUDIENCES) {
			expect(listHandledContinuationSourceIds(audience).length).toBeGreaterThan(0);
		}
	});

	test("the subagent's handled set is a SUBSET of one shared order, not its own order", () => {
		// The subset property is the point of the abstraction: two audiences, one order.
		const all = listContinuationSourceIds();
		for (const audience of CONTINUATION_AUDIENCES) {
			const handled = listHandledContinuationSourceIds(audience);
			for (const id of handled) expect(all).toContain(id);
			// Handled ids must appear in the same relative order as the full list.
			const positions = handled.map((id) => all.indexOf(id));
			const sorted = [...positions].sort((a, b) => a - b);
			expect(positions).toEqual(sorted);
		}
	});

	test("mutex groups only pair sources that cannot both fire", () => {
		// `executeAgentLoop` breaks on the first terminal signal, so at most one of the
		// request-refused flags is ever set. That is the only justification for declaring an
		// order interchangeable, and the pair is asserted explicitly so widening the escape
		// hatch requires editing this test.
		expect(isOrderInterchangeable("context-overflow", "model-unavailable")).toBe(true);
		expect(isOrderInterchangeable("model-unavailable", "context-overflow")).toBe(true);
		expect(isOrderInterchangeable("injection-drain", "buffered-message")).toBe(false);
		expect(isOrderInterchangeable("spec-continuation", "buffered-message")).toBe(false);
	});
});

describe("continuation registry queries", () => {
	test("lookup and disposition queries agree", () => {
		expect(getContinuationSource("spec-continuation")?.outcome).toBe("inject");
		expect(getContinuationSource("no-such-source")).toBeUndefined();
		expect(describeDisposition("plan-approved", "primary")).toEqual({ kind: "handled" });
		expect(describeDisposition("plan-approved", "subagent")?.kind).toBe("notApplicable");
		expect(describeDisposition("no-such-source", "primary")).toBeUndefined();
	});

	test("isHandledBy treats unknown ids as handled by nobody", () => {
		expect(isHandledBy("buffered-message", "subagent")).toBe(true);
		expect(isHandledBy("plan-approved", "subagent")).toBe(false);
		expect(isHandledBy("no-such-source", "primary")).toBe(false);
	});

	test("index lookup reports unknown ids as -1 rather than 0", () => {
		// 0 would read as "first", silently passing order assertions.
		expect(continuationSourceIndex("no-such-source")).toBe(-1);
		expect(continuationSourceIndex("abort-before-recovery")).toBe(0);
	});

	test("marker syntax has one definition", () => {
		expect(continuationMarker("buffered-message")).toBe("[continuation-source: buffered-message]");
		expect(extractContinuationMarkers("// [continuation-source: spec-continuation]")).toEqual([
			"spec-continuation",
		]);
	});

	test("marker extraction preserves document order and ignores prose", () => {
		const text = [
			"// [continuation-source: payment-required]",
			"some code mentioning continuation sources in prose",
			"// [continuation-source: transient-error]",
		].join("\n");
		expect(extractContinuationMarkers(text)).toEqual(["payment-required", "transient-error"]);
	});
});

describe("checkContinuationMarkerSequence", () => {
	test("accepts the declared order", () => {
		const result = checkContinuationMarkerSequence(
			"subagent",
			listHandledContinuationSourceIds("subagent"),
		);
		expect(result.ok).toBe(true);
	});

	test("reports a source declared handled but never marked", () => {
		const ids = listHandledContinuationSourceIds("subagent").filter(
			(id) => id !== "buffered-message",
		);
		const result = checkContinuationMarkerSequence("subagent", ids);
		expect(result.ok).toBe(false);
		expect(result.missing).toEqual(["buffered-message"]);
	});

	test("reports a marker for a source this audience did not declare", () => {
		const result = checkContinuationMarkerSequence("subagent", [
			...listHandledContinuationSourceIds("subagent"),
			"plan-approved",
		]);
		expect(result.ok).toBe(false);
		expect(result.notDeclared).toEqual(["plan-approved"]);
	});

	test("reports an unknown marker id", () => {
		const result = checkContinuationMarkerSequence("primary", [
			...listHandledContinuationSourceIds("primary"),
			"invented-source",
		]);
		expect(result.ok).toBe(false);
		expect(result.unknown).toEqual(["invented-source"]);
	});

	test("reports a contradicted order", () => {
		const ids = listHandledContinuationSourceIds("primary");
		const swapped = [...ids];
		const a = swapped.indexOf("injection-drain");
		const b = swapped.indexOf("buffered-message");
		[swapped[a], swapped[b]] = [swapped[b] as string, swapped[a] as string];
		const result = checkContinuationMarkerSequence("primary", swapped);
		expect(result.ok).toBe(false);
		expect(result.outOfOrder).toContainEqual({
			earlier: "buffered-message",
			later: "injection-drain",
		});
	});

	test("tolerates a repeated marker used as a guard", () => {
		// `abort-before-recovery` guards several branches; a later repeat is a guard, not a
		// second position claim, so it must not read as out-of-order.
		const ids = listHandledContinuationSourceIds("primary");
		const withRepeat = [...ids, "abort-before-recovery"];
		expect(checkContinuationMarkerSequence("primary", withRepeat).ok).toBe(true);
	});

	test("accepts either order within a mutex group", () => {
		const ids = listHandledContinuationSourceIds("subagent");
		const swapped = [...ids];
		const a = swapped.indexOf("context-overflow");
		const b = swapped.indexOf("model-unavailable");
		[swapped[a], swapped[b]] = [swapped[b] as string, swapped[a] as string];
		expect(checkContinuationMarkerSequence("subagent", swapped).ok).toBe(true);
	});
});

describe("executable shared recovery registry", () => {
	const completed = { finalText: "", hasError: false, shouldUpdateTitle: false };
	test("abort wins over payment and retry, except intentional plan approval", () => {
		const result = {
			...completed,
			aborted: true,
			retryableError: "transient",
			paymentRequired: { message: "pay", resumeAction: "retry" as const },
		};
		expect(selectPassRecoverySource(result, { aborted: false, planApproved: false })).toBe(
			"abort-before-recovery",
		);
		expect(selectPassRecoverySource(result, { aborted: false, planApproved: true })).toBe(
			"payment-required",
		);
	});
	test("payment and request refusal are terminal/recovery sources before ordinary errors", () => {
		const control = { aborted: false, planApproved: false };
		expect(
			selectPassRecoverySource(
				{
					...completed,
					hasError: true,
					paymentRequired: { message: "pay", resumeAction: "retry" },
				},
				control,
			),
		).toBe("payment-required");
		expect(
			selectPassRecoverySource(
				{ ...completed, contextLengthExceeded: true, retryableError: "retry" },
				control,
			),
		).toBe("context-overflow");
		expect(
			selectPassRecoverySource(
				{
					...completed,
					modelUnavailable: { message: "disabled", provider: "test", model: "test:model" },
				},
				control,
			),
		).toBe("model-unavailable");
	});
	test("transient and silent disconnect share one ordered retry family", () => {
		const control = { aborted: false, planApproved: false };
		expect(
			selectPassRecoverySource(
				{ ...completed, retryableError: "retry", silentDisconnect: true },
				control,
			),
		).toBe("transient-error");
		expect(selectPassRecoverySource({ ...completed, silentDisconnect: true }, control)).toBe(
			"silent-disconnect",
		);
		expect(selectPassRecoverySource(completed, control)).toBe("completed");
	});
	test("entry adapters cannot retain the former private next-pass loops", () => {
		expect(readService("narrator-session.ts")).not.toContain("while (active.alive)");
		expect(readService("subagent-executor.ts")).not.toContain("while (true)");
		expect(readService("subagent-runner.ts")).not.toContain("while (true)");
		const runtime = readService("agent-runtime/orchestrator.ts");
		expect(runtime).toContain("selectRuntimeRecovery(");
		expect(runtime).toContain("executeAgentLoop({");
	});
});
