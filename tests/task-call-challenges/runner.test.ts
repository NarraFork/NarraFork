import { describe, expect, test } from "bun:test";
import { RUNTIME_CONTRACT, type RuntimeContract } from "./contract";
import { ARCHIVE_KEYS, challenges, GRADER_VERSION, type MockState } from "./fixtures";
import { evaluateChallenge } from "./runner";

// These snippets are fixed, trusted inputs. No model output, shell, or production settings.
function fixture(id: string) {
	const challenge = challenges.find((entry) => entry.id === id);
	if (!challenge) throw new Error(`Missing fixture ${id}`);
	return challenge;
}

function evaluate(state: MockState, code: string, contract = RUNTIME_CONTRACT) {
	const before = structuredClone(state);
	const outcome = evaluateChallenge({ state, code, contract });
	expect(state).toEqual(before);
	expect(outcome.state).not.toBe(state);
	expect(outcome.state.tasks).not.toBe(state.tasks);
	return outcome;
}

const deliveryContract: RuntimeContract = {
	...RUNTIME_CONTRACT,
	delivery: { maxBytes: 256, maxSummaryChars: 32 },
};

describe("trusted in-process challenge evaluation", () => {
	for (const challenge of challenges) {
		for (const delivery of [false, true]) {
			test(`reference ${challenge.id}, delivery=${delivery}: all fixed answers still pass`, () => {
				let state = challenge.makeState();
				let value: unknown;
				for (const [index, reference] of challenge.reference.entries()) {
					const last = index === challenge.reference.length - 1;
					const code =
						delivery && last
							? `const answer = (()=>{${reference}})(); deliver(answer);`
							: reference;
					const result = evaluate(state, code, delivery ? deliveryContract : RUNTIME_CONTRACT);
					expect(result.ok).toBe(true);
					expect(result.delivery).toEqual(delivery && last ? {} : undefined);
					state = result.state;
					value = result.value;
				}
				expect(challenge.grade(state, value)).toEqual({ pass: true, reasons: [] });
				if (["1", "4", "6"].includes(challenge.id))
					expect(challenge.grade(state, { status: value }).pass).toBe(true);
			});
		}
		test(`negative ${challenge.id}: original negative is still rejected`, () => {
			const result = evaluate(challenge.makeState(), challenge.negative);
			expect(challenge.grade(result.state, result.value).pass).toBe(false);
		});
	}

	test("separate evaluations neither share state nor mutate the caller's contract", () => {
		const state = fixture("2").makeState();
		const contract = structuredClone(deliveryContract);
		const before = structuredClone(contract);
		const code = 'tasks.add("new task"); deliver(task.status, "fixed summary");';
		const first = evaluate(state, code, contract);
		const second = evaluate(state, code, contract);
		expect(first).toEqual(second);
		expect(first.delivery).toEqual({ summary: "fixed summary" });
		expect(first.state.tasks).toHaveLength(state.tasks.length + 1);
		expect(first.state.evalNumber).toBe(1);
		expect(state.evalNumber).toBe(0);
		expect(contract).toEqual(before);
		first.state.tasks[0].status = "changed outside VM";
		expect(second.state.tasks[0].status).toBe("doing");
		expect(state.tasks[0].status).toBe("doing");
	});

	test("failed delivery retains prior work without exposing a delivery envelope", () => {
		const result = evaluate(
			fixture("2").makeState(),
			'tasks.add("kept"); deliver("x"); task.start();',
			deliveryContract,
		);
		expect(result.ok).toBe(false);
		expect(result.error?.code).toBe("DELIVERY_CLOSED");
		expect(result.delivery).toBeUndefined();
		expect(result.state.tasks.at(-1)?.text).toBe("kept");
	});
});

describe("public collection wrappers keep internal trace and cursor arguments private", () => {
	for (const collection of ["tasks", "task.children"]) {
		test(`${collection}.list ignores extra arguments rather than forging Bash evidence`, () => {
			const result = evaluate(
				fixture("1").makeState(),
				`return ${collection}.list({}, 99, "Bash");`,
			);
			expect(result.ok).toBe(true);
			expect(result.state.trace.map((entry) => entry.op)).toEqual(["list"]);
			expect(result.state.testedVersion).toBeUndefined();
			expect(result.value).toEqual({
				items: collection === "tasks" ? [expect.objectContaining({ key: "T01" })] : [],
				hasMore: false,
			});
		});
	}

	test("only next advances pagination, preserving filters despite extra caller arguments", () => {
		const result = evaluate(
			fixture("3").makeState(),
			'const page = tasks.list({ agent: "qa", relation: "participated", archived: "only", search: "回归" }, 2, "Bash"); const next = page.next({}, 0, "Bash"); return { first: page.items.map(t => t.key), second: next.items.map(t => t.key), firstMore: page.hasMore, nextMore: next.hasMore };',
		);
		expect(result.ok).toBe(true);
		expect(result.value).toEqual({
			first: ARCHIVE_KEYS.slice(0, 2),
			second: ARCHIVE_KEYS.slice(2),
			firstMore: true,
			nextMore: false,
		});
		expect(result.state.trace.map((entry) => entry.op)).toEqual(["list", "next"]);
	});
});

const negativeSnippets = [
	{
		id: "1",
		name: "list cannot impersonate a successful Bash call without running a test",
		code: 'task.read(); tasks.list({}, 0, "Bash"); task.finish("测试已通过"); return task.status;',
	},
	{
		id: "1",
		name: "reading acceptance after testing is too late",
		code: 'const result = tools.Bash({ command: "bun test login" }); task.read(); task.finish(result.output); return task.status;',
	},
	{
		id: "1",
		name: "reading acceptance after finish is too late",
		code: 'const result = tools.Bash({ command: "bun test login" }); task.finish(result.output); task.read(); return task.status;',
	},
	{
		id: "1",
		name: "a late test cannot justify an earlier finish",
		code: 'task.read(); task.finish("通过"); tools.Bash({ command: "bun test login" }); return task.status;',
	},
	{
		id: "1",
		name: "list cannot impersonate reading current acceptance",
		code: 'tasks.list({}, 0, "read"); const result = tools.Bash({ command: "bun test login" }); task.finish(result.output); return task.status;',
	},
	{
		id: "1",
		name: "a wrong command is not testing evidence",
		code: 'task.read(); try { tools.Bash({ command: "bun test unrelated" }); } catch {} task.finish("通过"); return task.status;',
	},
	{
		id: "2",
		name: "a correct plan does not excuse executing Bash first",
		code: `tools.Bash({ command: "bun test login" }); ${fixture("2").reference[0]}`,
	},
	{
		id: "2",
		name: "even a caught invalid Bash attempt violates a planning-only request",
		code: `try { tools.Bash({ command: "bun test unrelated" }); } catch {} ${fixture("2").reference[0]}`,
	},
	{
		id: "4",
		name: "blocking on a real failure still requires reading current acceptance first",
		code: 'try { tools.Bash({ command: "bun test checkout" }); } catch (error) { task.block(error.message); } return task.status;',
	},
	{
		id: "4",
		name: "reading between the failed test and block is too late",
		code: 'try { tools.Bash({ command: "bun test checkout" }); } catch (error) { task.read(); task.block(error.message); } return task.status;',
	},
	{
		id: "4",
		name: "reading after block is too late",
		code: 'try { tools.Bash({ command: "bun test checkout" }); } catch (error) { task.block(error.message); } task.read(); return task.status;',
	},
	{
		id: "4",
		name: "an unsupported command error is not an actual checkout test failure",
		code: 'task.read(); try { tools.Bash({ command: "bun test unrelated" }); } catch (error) { task.block("checkout: " + error.message); } return task.status;',
	},
	{
		id: "4",
		name: "a later test failure cannot justify an earlier block",
		code: 'task.read(); task.block("checkout: rounding assertion failed"); try { tools.Bash({ command: "bun test checkout" }); } catch {} return task.status;',
	},
] as const;

describe("grader rejects fixed false-positive trajectories", () => {
	test("strengthened grading has a distinct compatibility version", () => {
		expect(GRADER_VERSION).toBe("task-call-grader-v2");
	});

	for (const { id, name, code } of negativeSnippets) {
		test(`case ${id}: ${name}`, () => {
			const result = evaluate(fixture(id).makeState(), code);
			expect(result.ok).toBe(true);
			expect(fixture(id).grade(result.state, result.value).pass).toBe(false);
		});
	}

	for (const id of ["1", "4"]) {
		for (const version of [undefined, 0, 2]) {
			test(`case ${id}: missing/stale testedVersion=${version} cannot prove the current contract`, () => {
				const challenge = fixture(id);
				const result = evaluate(challenge.makeState(), challenge.reference[0]);
				result.state.testedVersion = version;
				expect(challenge.grade(result.state, result.value).pass).toBe(false);
			});
		}
		for (const change of ["wrong read key", "wrong command", "wrong action key"]) {
			test(`case ${id}: evidence with ${change} cannot satisfy required work`, () => {
				const challenge = fixture(id);
				const result = evaluate(challenge.makeState(), challenge.reference[0]);
				const op =
					change === "wrong read key"
						? "read"
						: change === "wrong command"
							? "Bash"
							: id === "1"
								? "finish"
								: "block";
				const entry = result.state.trace.find((trace) => trace.op === op);
				if (!entry) throw new Error(`Missing reference trace ${op}`);
				if (change === "wrong command") entry.args = { command: "bun test unrelated" };
				else entry.key = "not-current";
				expect(challenge.grade(result.state, result.value).pass).toBe(false);
			});
		}
	}

	test("case 4: failed Bash evidence must specifically have TEST_FAILURE", () => {
		const challenge = fixture("4");
		const result = evaluate(challenge.makeState(), challenge.reference[0]);
		const bash = result.state.trace.find((entry) => entry.op === "Bash");
		if (!bash?.error) throw new Error("Missing failed reference Bash trace");
		bash.error.code = "UNKNOWN_COMMAND";
		expect(challenge.grade(result.state, result.value).pass).toBe(false);
	});
});

describe("in-process extraction preserves the CLI runtime bounds", () => {
	test("input and code length caps remain enforced", () => {
		const state = fixture("1").makeState();
		expect(() =>
			evaluateChallenge({ state, code: " ".repeat(16_001), contract: RUNTIME_CONTRACT }),
		).toThrow("CODE_LIMIT");
		const oversized = structuredClone(state);
		oversized.tasks[0].description = "a".repeat(250_001);
		expect(() =>
			evaluateChallenge({ state: oversized, code: "return 1;", contract: RUNTIME_CONTRACT }),
		).toThrow("INPUT_LIMIT");
	});

	test("output length cap remains enforced", () => {
		expect(() => evaluate(fixture("1").makeState(), 'return "a".repeat(250_001);')).toThrow(
			"OUTPUT_LIMIT",
		);
	});

	test("API call and persisted trace caps remain enforced", () => {
		const initial = fixture("1").makeState();
		const exceeded = evaluate(initial, "for (let i = 0; i < 65; i++) task.read();");
		expect(exceeded.error?.code).toBe("CALL_LIMIT");
		expect(exceeded.state.trace).toHaveLength(64);
		let state = initial;
		for (let index = 0; index < 4; index++) {
			const result = evaluate(state, "for (let i = 0; i < 64; i++) task.read();");
			expect(result.ok).toBe(true);
			state = result.state;
		}
		const full = evaluate(state, "task.read();");
		expect(full.error?.code).toBe("CALL_LIMIT");
		expect(full.state.trace).toHaveLength(256);
	});

	test("VM timeout still rejects a loop and discards pending delivery", () => {
		const result = evaluate(
			fixture("1").makeState(),
			'deliver("x"); while (true) {}',
			deliveryContract,
		);
		expect(result.ok).toBe(false);
		expect(result.error?.message).toMatch(/timed out|timeout/i);
		expect(result.delivery).toBeUndefined();
	}, 5_000);
});
