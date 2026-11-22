import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../logger";
import {
	readPoolDiagnosticSource,
	readPoolTaskSnapshot,
	warnReadPoolFailure,
} from "../read-diagnostics";

afterEach(() => {
	mockWarn.mockRestore();
});
let mockWarn: ReturnType<typeof spyOn<typeof logger, "warn">>;
const stats = { queued: 8, queuedBytes: 1234, workers: 1, active: 1, starting: 0 };

test("empty snapshots contain no fabricated task identity", () => {
	mockWarn = spyOn(logger, "warn").mockImplementation(() => {});
	expect(readPoolTaskSnapshot(undefined, 100, undefined)).toEqual({
		kind: "unattributed",
		source: "unattributed",
		ageMs: null,
	});
});

test.each([
	"knowledge.keyword-signature",
	"execution-policy-facts",
	"narrator.request-recording",
	"narrator.message-language",
])("attribution is preserved for %s but arbitrary text is discarded", (label) => {
	mockWarn = spyOn(logger, "warn").mockImplementation(() => {});
	const source = readPoolDiagnosticSource(label);
	expect(readPoolTaskSnapshot({ kind: "selectRows", source, startedAt: 0 }, 1, 0)).toMatchObject({
		source: label,
	});
	expect(readPoolDiagnosticSource(`${label}:request-id`)).toBe("unattributed");
});

test("queue rejection bursts are bounded independently from timeout evidence", () => {
	mockWarn = spyOn(logger, "warn").mockImplementation(() => {});
	const now = spyOn(Date, "now").mockReturnValue(50000);
	const task = { kind: "selectRows", source: "unattributed", startedAt: 49900 } as const;
	try {
		for (let i = 0; i < 10; i++) warnReadPoolFailure(task, "TASK_QUEUE_FULL", stats);
		expect(mockWarn).toHaveBeenCalledTimes(5);
		warnReadPoolFailure(task, "TASK_QUEUE_TIMEOUT", stats);
		expect(mockWarn).toHaveBeenCalledTimes(6);
		expect(mockWarn.mock.calls.at(-1)).toEqual([
			"Database read task timed out",
			expect.objectContaining({ kind: "selectRows", phase: "queued", ageMs: 100, queued: 8 }),
		]);
		now.mockReturnValue(60000);
		warnReadPoolFailure(task, "TASK_QUEUE_FULL", stats);
		expect(mockWarn.mock.calls.at(-1)?.[1]).toMatchObject({ suppressedSinceLastLog: 5 });
	} finally {
		now.mockRestore();
	}
});

test("logger failure cannot replace execution outcomes", () => {
	mockWarn = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("unavailable logger");
	});
	expect(() =>
		warnReadPoolFailure(
			{ kind: "selectRows", source: "unattributed", startedAt: 0 },
			"TASK_QUEUE_TIMEOUT",
			stats,
		),
	).not.toThrow();
});
