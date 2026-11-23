import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	checkDomainBudget,
	createDomainReadParams,
	DOMAIN_READ_DEFINITIONS,
	validateDomainRead,
} from "./domain-protocol";
import { runDomainRead } from "./domain-task-registry";
import { ReadBudgetMeter } from "./read-budget";

describe("registered database read domains", () => {
	test("publication terminal reads require an explicit block-read switch", () => {
		const run = {
			producerKind: "agent" as const,
			taskId: "actor",
			recipientId: "parent",
			logicalRunId: "run",
		};
		for (const fromBlocks of [false, true])
			expect(
				createDomainReadParams("publicationTerminalResult", { run, fromBlocks }).input,
			).toEqual({ run, fromBlocks });
		for (const fromBlocks of [undefined, null, "false", 1])
			expect(() =>
				validateDomainRead({
					kind: "domainRead",
					task: "publicationTerminalResult",
					input: { run, fromBlocks: fromBlocks as never },
				}),
			).toThrow();
	});

	test("knowledge and recall inputs bound identifiers, shape and result windows", () => {
		const input = { narratorId: "n", messageId: null, limit: 50 };
		expect(createDomainReadParams("recallConversation", input).input).toEqual(input);
		for (const id of ["", "x".repeat(257), "界".repeat(100), "x\0y"]) {
			expect(() => createDomainReadParams("knowledgeEntryDetail", { entryId: id })).toThrow();
			expect(() =>
				createDomainReadParams("recallToolCallDetail", { toolCallId: id, narratorId: null }),
			).toThrow();
			expect(() =>
				createDomainReadParams("recallConversation", { ...input, narratorId: id }),
			).toThrow();
		}
		for (const limit of [0, -1, 51, 0.5, NaN])
			expect(() => createDomainReadParams("recallConversation", { ...input, limit })).toThrow();
		const malformed = {
			kind: "domainRead",
			task: "knowledgeEntryDetail",
			input: { entryId: "entry", extra: true },
		} as const;
		expect(() => validateDomainRead(malformed)).toThrow();
	});
	test("file snapshot inputs bound identifiers, owner context and page size", () => {
		const editor = { sourceInstanceId: "source", sourceId: "operation" };
		const revert = {
			owner: { subjectKey: "user:alice", narratorId: null, projectId: null },
			planId: "plan",
			cursor: null,
			limit: 101,
		};
		expect(createDomainReadParams("editorOperationEvidence", editor).input).toEqual(editor);
		expect(createDomainReadParams("revertPlanSnapshot", revert).input).toEqual(revert);
		for (const id of ["", "a".repeat(257), "界".repeat(100), "a\0b"]) {
			expect(() =>
				createDomainReadParams("editorOperationEvidence", { ...editor, sourceId: id }),
			).toThrow();
			expect(() =>
				createDomainReadParams("editorOperationEvidence", { ...editor, sourceInstanceId: id }),
			).toThrow();
			expect(() =>
				createDomainReadParams("revertPlanSnapshot", { ...revert, planId: id }),
			).toThrow();
			expect(() =>
				createDomainReadParams("revertPlanSnapshot", {
					...revert,
					owner: { ...revert.owner, subjectKey: id },
				}),
			).toThrow();
		}
		for (const limit of [-1, 102, 0.5, NaN]) {
			expect(() => createDomainReadParams("revertPlanSnapshot", { ...revert, limit })).toThrow();
		}
		expect(() => createDomainReadParams("revertPlanSnapshot", { ...revert, cursor: "" })).toThrow();
		expect(() =>
			createDomainReadParams("revertPlanSnapshot", {
				...revert,
				owner: { ...revert.owner, narratorId: "" },
			}),
		).toThrow();
	});

	test("only registered read tasks cross the fixed registry", () => {
		expect(createDomainReadParams("readerProbe", null)).toEqual({
			kind: "domainRead",
			task: "readerProbe",
			input: null,
		});
		expect(() => createDomainReadParams("readerProbe", {} as never)).toThrow();
		const input = {
			authorityId: "authority",
			includeExpired: false,
			now: "2026-01-01T00:00:00.000Z",
		};
		expect(createDomainReadParams("platformIntegrationAuthoritySnapshot", input)).toEqual({
			kind: "domainRead",
			task: "platformIntegrationAuthoritySnapshot",
			input,
		});
		for (const invalid of [
			null,
			[],
			{},
			{ ...input, unexpected: true },
			{ ...input, authorityId: "" },
			{ ...input, authorityId: " " },
			{ ...input, authorityId: "a".repeat(257) },
			{ ...input, authorityId: "界".repeat(100) },
			...["\u0000", "\n", "\r"].map((char) => ({ ...input, authorityId: `a${char}` })),
			{ ...input, includeExpired: 1 },
			{ ...input, now: "invalid" },
			{ ...input, now: "2026" },
			{ ...input, now: "2026-99-99T00:00:00.000Z" },
		]) {
			expect(() =>
				createDomainReadParams("platformIntegrationAuthoritySnapshot", invalid as never),
			).toThrow();
		}
		for (const task of [
			"narratorBodyTexts",
			"benchmarkSuiteListSnapshot",
			"databaseCleanupContext",
			"unregistered",
		]) {
			expect(Object.hasOwn(DOMAIN_READ_DEFINITIONS, task)).toBe(false);
			expect(() => validateDomainRead({ kind: "domainRead", task, input: {} } as never)).toThrow();
		}
	});
	test("numeric DTO thresholds observe complete results rather than truncate", () => {
		const meter = new ReadBudgetMeter();
		const value = { rows: Array.from({ length: 20 }, () => "payload") };
		expect(checkDomainBudget(value, 8, 2, meter)).toBeGreaterThan(8);
		expect(value.rows).toHaveLength(20);
		expect(meter.snapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "domainResultItems", actual: 20, threshold: 2 }),
				expect.objectContaining({ kind: "domainResultBytes", threshold: 8 }),
			]),
		);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => checkDomainBudget(cyclic, 1024, 100)).toThrow();
	});

	test("the registry owns and releases one explicit read snapshot", async () => {
		const sqlite = new Database(":memory:");
		sqlite.run("PRAGMA query_only = ON");
		try {
			expect(
				await runDomainRead(
					sqlite,
					createDomainReadParams("readerProbe", null),
					new AbortController().signal,
					Date.now() + 1_000,
				),
			).toEqual({ ready: true });
			expect(sqlite.inTransaction).toBe(false);
			const controller = new AbortController();
			controller.abort();
			await expect(
				runDomainRead(sqlite, createDomainReadParams("readerProbe", null), controller.signal),
			).rejects.toMatchObject({ code: "DB_READ_ABORTED" });
			await expect(
				runDomainRead(
					sqlite,
					createDomainReadParams("readerProbe", null),
					new AbortController().signal,
					Date.now() - 1,
				),
			).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
			expect(sqlite.inTransaction).toBe(false);
		} finally {
			sqlite.close();
		}
	});
});
