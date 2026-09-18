import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../lib/logger";
import { knowledgeInjectionReads } from "../knowledge-service";
import { narratorService } from "../narrator-service";
import {
	type SubagentKnowledgeCycle,
	syncSubagentKnowledgeCycle,
} from "../subagent-knowledge-injection";

// Exercise the exact authorized primary-loop block without booting the runtime,
// a provider session, a queue or a server. This is a call-segment test, NOT a claim
// of full orchestrator end-to-end coverage. It is deliberately fail-closed when
// either source boundary moves, rather than testing a copied implementation.
const source = readFileSync(resolve(import.meta.dir, "../agent-runtime/orchestrator.ts"), "utf8");
const start = source.indexOf("if (cycleSeq !== knowledgeCycleState.seq) {");
const end = source.indexOf("// Always use getModelHistorySinceLastCompact", start);
if (start < 0 || end <= start) throw new Error("Primary knowledge-cycle test boundary moved");
const segment = source.slice(start, end);
const primary = new Function(
	"knowledgeInjectionReads",
	`return async function(narratorId, knowledgeCycleState, cycleSeq) {
	const knowledgeInjectedIds = knowledgeCycleState.ids;
	${segment}
}`,
)(knowledgeInjectionReads) as (
	id: string,
	cycle: SubagentKnowledgeCycle,
	seq: number,
) => Promise<void>;

let compactSeq = 9;
let compactSpy: ReturnType<typeof spyOn<typeof narratorService, "getLatestCompactSeq">>;
let readSpy: ReturnType<typeof spyOn<typeof knowledgeInjectionReads, "listInjectedEntryIds">>;
let warnSpy: ReturnType<typeof spyOn<typeof logger, "warn">>;
beforeEach(() => {
	compactSeq = 9;
	compactSpy = spyOn(narratorService, "getLatestCompactSeq").mockImplementation(
		async () => compactSeq,
	);
	readSpy = spyOn(knowledgeInjectionReads, "listInjectedEntryIds");
	warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
	compactSpy.mockRestore();
	readSpy.mockRestore();
	warnSpy.mockRestore();
});

for (const kind of ["primary", "subagent"] as const) {
	const run = (cycle: SubagentKnowledgeCycle) =>
		kind === "primary"
			? primary("cycle-reader", cycle, compactSeq)
			: syncSubagentKnowledgeCycle("cycle-reader", cycle);
	describe(`${kind} async knowledge-cycle synchronization`, () => {
		test("holds seq and the existing Set unchanged until a delayed ledger read succeeds", async () => {
			let release!: (ids: Set<string>) => void;
			const delayed = new Promise<Set<string>>((resolve) => {
				release = resolve;
			});
			readSpy.mockImplementation(() => delayed);
			const ids = new Set(["old-cycle"]);
			const cycle = { seq: 8, ids };
			const pending = run(cycle);
			await Promise.resolve();
			expect(readSpy).toHaveBeenCalledWith("cycle-reader", 9);
			expect(cycle.seq).toBe(8);
			expect([...cycle.ids]).toEqual(["old-cycle"]);
			release(new Set(["persisted-a", "persisted-b"]));
			await pending;
			expect(cycle.seq).toBe(9);
			expect(cycle.ids).toBe(ids);
			expect([...cycle.ids]).toEqual(["persisted-a", "persisted-b"]);
			await run(cycle);
			expect(readSpy).toHaveBeenCalledTimes(1);
		});

		test("failed ledger read preserves state and the SAME compact cycle retries", async () => {
			readSpy.mockRejectedValueOnce(new Error("PG read temporarily unavailable"));
			readSpy.mockResolvedValueOnce(new Set(["persisted-after-retry"]));
			const ids = new Set(["old-cycle"]);
			const cycle = { seq: 8, ids };
			const failed = run(cycle);
			if (kind === "primary") await expect(failed).rejects.toThrow("temporarily unavailable");
			else expect(await failed).toBe(9); // existing warning/degrade policy
			expect(cycle.seq).toBe(8);
			expect([...cycle.ids]).toEqual(["old-cycle"]);
			expect(cycle.ids).toBe(ids);
			expect(warnSpy).toHaveBeenCalledTimes(kind === "subagent" ? 1 : 0);
			await run(cycle);
			expect(readSpy).toHaveBeenCalledTimes(2);
			expect(cycle.seq).toBe(9);
			expect([...cycle.ids]).toEqual(["persisted-after-retry"]);
		});

		test("compact changes rebuild from its own ledger, not the previous cycle", async () => {
			readSpy.mockResolvedValueOnce(new Set(["current-only"]));
			readSpy.mockResolvedValueOnce(new Set());
			const cycle = { seq: Number.NaN, ids: new Set<string>() };
			await run(cycle);
			expect(cycle.ids.has("current-only")).toBe(true);
			compactSeq = 10;
			await run(cycle);
			expect(readSpy).toHaveBeenLastCalledWith("cycle-reader", 10);
			expect(cycle.seq).toBe(10);
			expect(cycle.ids.size).toBe(0);
		});
	});
}

test("subagent compact-seq lookup failure warns without mutating the cycle", async () => {
	compactSpy.mockRejectedValueOnce(new Error("compact read failed"));
	const cycle = { seq: 8, ids: new Set(["keep"]) };
	expect(await syncSubagentKnowledgeCycle("cycle-reader", cycle)).toBe(8);
	expect(readSpy).not.toHaveBeenCalled();
	expect(warnSpy).toHaveBeenCalledTimes(1);
	expect([...cycle.ids]).toEqual(["keep"]);
	expect(cycle.seq).toBe(8);
});
