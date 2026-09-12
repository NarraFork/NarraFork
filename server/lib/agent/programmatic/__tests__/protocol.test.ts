import { describe, expect, test } from "bun:test";
import {
	assertJson,
	type CallFrame,
	type ChildFrame,
	errorShape,
	PROGRAMMATIC_LIMITS as LIMITS,
	PROGRAMMATIC_PROTOCOL_VERSION,
	ProgrammaticError,
	parseChildFrame,
	parseJson,
	type ReadyFrame,
	type SandboxResult,
} from "../protocol";

// Wire entry points receive bounded JSON text, never arbitrary in-process Proxies.
// Direct assertJson fixtures below test ordinary objects, not Proxy isolation.
function rejects(action: () => unknown, code: string): ProgrammaticError {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ProgrammaticError);
	expect(caught).toMatchObject({ code, fatal: true });
	return caught as ProgrammaticError;
}

const call: CallFrame = {
	type: "call",
	version: 1,
	sequence: 1,
	receiver: "files",
	method: "read",
	args: null,
};
const success: SandboxResult = { type: "result", version: 1, ok: true, value: null, logs: [] };
const error = { code: "DENIED", message: "Not allowed", fatal: false };
const failure: SandboxResult = { type: "result", version: 1, ok: false, error, logs: [] };
const probe: ReadyFrame["probe"] = { uid: 0, memoryBytes: 1, pids: 1, cpuQuota: 1, cpuPeriod: 1 };
const ready: ReadyFrame = { type: "ready", version: 1, probe };
const parse = (frame: unknown): ChildFrame => parseChildFrame(JSON.stringify(frame));

function without(frame: object, key: string): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...frame };
	delete copy[key];
	return copy;
}

function nested(depth: number): unknown {
	let value: unknown = null;
	for (let i = 0; i < depth; i++) value = [value];
	return value;
}

describe("parseChildFrame strict protocol envelope", () => {
	test("accepts all three frame types at protocol version 1", () => {
		expect(PROGRAMMATIC_PROTOCOL_VERSION).toBe(1);
		for (const frame of [call, success, failure, ready]) expect(parse(frame)).toEqual(frame);
	});

	test.each([0, 2, "1", null])("rejects version %j for each frame type", (version) => {
		for (const frame of [call, success, ready]) {
			rejects(() => parse({ ...frame, version }), "PROTOCOL");
		}
	});

	test.each(["response", "start", "CALL", "", null, 1])("rejects type %j", (type) => {
		rejects(() => parse({ ...call, type }), "PROTOCOL");
	});

	test.each(
		[null, [], true, 42, "call"].map((value) => [value]),
	)("rejects non-frame %j", (frame) => {
		rejects(() => parse(frame), "PROTOCOL");
	});

	test("requires envelope fields and disallows unknown top-level keys", () => {
		for (const frame of [call, success, ready]) {
			for (const key of ["type", "version"]) {
				rejects(() => parse(without(frame, key)), "PROTOCOL");
			}
			rejects(() => parse({ ...frame, extra: true }), "PROTOCOL");
		}
	});

	test.each([
		"identity",
		"runId",
		"narratorId",
		"actorUserId",
		"outerToolCallId",
		"teamId",
		"projectId",
	])("rejects forged call identity field %s", (key) => {
		rejects(() => parse({ ...call, [key]: "forged" }), "PROTOCOL");
	});

	test.each([
		0,
		-1,
		1.5,
		LIMITS.maxCalls + 1,
		"1",
		null,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid sequence %j", (sequence) => {
		rejects(() => parse({ ...call, sequence }), "PROTOCOL");
	});

	test("accepts both sequence endpoints", () => {
		for (const sequence of [1, LIMITS.maxCalls]) {
			expect(parse({ ...call, sequence })).toEqual({ ...call, sequence });
		}
	});

	test("requires call fields and distinguishes null arguments from absent arguments", () => {
		for (const key of ["sequence", "receiver", "method"]) {
			rejects(() => parse(without(call, key)), "PROTOCOL");
		}
		expect(parse(call)).toEqual(call);
		expect(() => parse(without(call, "args"))).toThrow(ProgrammaticError);
	});

	test("bounds receiver and method names without coercion", () => {
		for (const [key, max] of [
			["receiver", 128],
			["method", 64],
		] as const) {
			const frame = { ...call, [key]: "a".repeat(max) };
			expect(parse(frame)).toEqual(frame);
			for (const value of ["", "a".repeat(max + 1), 1, null]) {
				rejects(() => parse({ ...call, [key]: value }), "PROTOCOL");
			}
		}
	});

	test("rejects malformed JSON and honors exact wire byte limit", () => {
		rejects(() => parseChildFrame("{"), "PROTOCOL");
		const text = JSON.stringify(call);
		const atLimit = text + " ".repeat(LIMITS.wireFrameBytes - Buffer.byteLength(text));
		expect(parseChildFrame(atLimit)).toEqual(call);
		rejects(() => parseChildFrame(`${atLimit} `), "FRAME_LIMIT");
		const unicode = JSON.stringify({
			...call,
			args: "中".repeat(Math.ceil(LIMITS.wireFrameBytes / 3)),
		});
		expect(unicode.length).toBeLessThan(LIMITS.wireFrameBytes);
		rejects(() => parseChildFrame(unicode), "FRAME_LIMIT");
	});
});

describe("ready probe numeric bounds", () => {
	test.each([
		"uid",
		"memoryBytes",
		"pids",
		"cpuQuota",
		"cpuPeriod",
	] as const)("validates %s integer range, presence and type", (key) => {
		const min = key === "uid" ? 0 : 1;
		for (const value of [min, Number.MAX_SAFE_INTEGER]) {
			const frame = { ...ready, probe: { ...probe, [key]: value } };
			expect(parse(frame)).toEqual(frame);
		}
		for (const value of [min - 1, 0.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
			rejects(() => parse({ ...ready, probe: { ...probe, [key]: value } }), "PROTOCOL");
		}
		rejects(() => parse({ ...ready, probe: without(probe, key) }), "PROTOCOL");
	});

	test("rejects missing or non-object probes and unknown probe keys", () => {
		for (const value of [null, [], { ...probe, extra: 1 }]) {
			rejects(() => parse({ ...ready, probe: value }), "PROTOCOL");
		}
		rejects(() => parse(without(ready, "probe")), "PROTOCOL");
		rejects(
			() =>
				parseChildFrame(JSON.stringify(ready).replace('"memoryBytes":1', '"memoryBytes":1e400')),
			"PROTOCOL",
		);
	});
});

describe("result contracts and budgets", () => {
	test.each(
		[null, false, 0, "", [], {}].map((value) => [value]),
	)("accepts explicit successful JSON value %j", (value) => {
		expect(parse({ ...success, value })).toEqual({ ...success, value });
	});

	test("success requires a value and forbids an error", () => {
		rejects(() => parse(without(success, "value")), "PROTOCOL");
		rejects(() => parse({ ...success, error }), "PROTOCOL");
		rejects(() => parse({ ...success, error: null }), "PROTOCOL");
	});

	test("failure requires a real error and cannot deliver even an empty delivery", () => {
		rejects(() => parse(without(failure, "error")), "PROTOCOL");
		rejects(() => parse({ ...failure, error: null }), "PROTOCOL");
		for (const delivery of [{}, { summary: "" }, { summary: "text" }, null]) {
			rejects(() => parse({ ...failure, delivery }), "PROTOCOL");
		}
		expect(parse(failure)).toEqual(failure);
	});

	test("requires boolean ok and a logs array", () => {
		for (const key of ["ok", "logs"]) rejects(() => parse(without(success, key)), "PROTOCOL");
		for (const ok of [1, "true", null]) rejects(() => parse({ ...success, ok }), "PROTOCOL");
		for (const logs of [null, "", [1]]) rejects(() => parse({ ...success, logs }), "PROTOCOL");
	});

	test("error fields are strict, required and bounded", () => {
		for (const key of ["code", "message", "fatal"]) {
			rejects(() => parse({ ...failure, error: without(error, key) }), "PROTOCOL");
		}
		for (const patch of [
			{ code: "" },
			{ code: "x".repeat(81) },
			{ message: "x".repeat(2001) },
			{ fatal: "false" },
			{ stack: "secret" },
		]) {
			rejects(() => parse({ ...failure, error: { ...error, ...patch } }), "PROTOCOL");
		}
		const frame = {
			...failure,
			error: { code: "x".repeat(80), message: "x".repeat(2000), fatal: true },
		};
		expect(parse(frame)).toEqual(frame);
	});

	test("result byte limit includes JSON quoting and UTF8 encoding", () => {
		const value =
			"中".repeat(Math.floor((LIMITS.resultBytes - 2) / 3)) +
			"a".repeat((LIMITS.resultBytes - 2) % 3);
		expect(Buffer.byteLength(JSON.stringify(value))).toBe(LIMITS.resultBytes);
		expect(parse({ ...success, value })).toEqual({ ...success, value });
		rejects(() => parse({ ...success, value: `${value}a` }), "OUTPUT_LIMIT");
		const escaped = "\n".repeat(LIMITS.resultBytes / 2);
		expect(escaped.length).toBeLessThan(LIMITS.resultBytes);
		rejects(() => parse({ ...success, value: escaped }), "OUTPUT_LIMIT");
	});

	test("logs have a total serialized byte budget, for success and failure", () => {
		const logs = [
			"中".repeat(Math.floor((LIMITS.logBytes - 7) / 3)),
			"a".repeat((LIMITS.logBytes - 7) % 3),
		];
		expect(Buffer.byteLength(JSON.stringify(logs))).toBe(LIMITS.logBytes);
		for (const frame of [success, failure]) {
			expect(parse({ ...frame, logs })).toEqual({ ...frame, logs });
			rejects(() => parse({ ...frame, logs: [logs[0], `${logs[1]}a`] }), "OUTPUT_LIMIT");
		}
	});

	test("log count and individual length are bounded", () => {
		const logs = Array.from({ length: LIMITS.maxLogs }, () => "");
		expect(parse({ ...success, logs })).toEqual({ ...success, logs });
		rejects(() => parse({ ...success, logs: [...logs, ""] }), "PROTOCOL");
		rejects(() => parse({ ...success, logs: ["x".repeat(LIMITS.logBytes + 1)] }), "PROTOCOL");
	});

	test("summary uses the configured string length limit, not a byte limit", () => {
		for (const summary of [
			"",
			"中".repeat(LIMITS.summaryChars),
			"😀".repeat(LIMITS.summaryChars / 2),
		]) {
			const frame = { ...success, delivery: { summary } };
			expect(parse(frame)).toEqual(frame);
		}
		for (const summary of [
			"x".repeat(LIMITS.summaryChars + 1),
			`${"😀".repeat(LIMITS.summaryChars / 2)}x`,
			null,
		]) {
			rejects(() => parse({ ...success, delivery: { summary } }), "PROTOCOL");
		}
		rejects(() => parse({ ...success, delivery: { extra: 1 } }), "PROTOCOL");
		expect(parse({ ...success, delivery: {} })).toEqual({ ...success, delivery: {} });
	});
});

describe("bounded JSON validation", () => {
	test("accepts finite JSON primitives, plain objects and null-prototype objects", () => {
		for (const value of [
			null,
			true,
			false,
			0,
			-0,
			Number.MAX_VALUE,
			"",
			[],
			{ x: [1, null] },
			Object.assign(Object.create(null), { x: 1 }),
		]) {
			expect(() => assertJson(value)).not.toThrow();
		}
	});

	test.each([
		undefined,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		1n,
		Symbol("x"),
		() => 1,
	])("rejects non-JSON value %#", (value) => {
		rejects(() => assertJson(value), "JSON_TYPE");
	});

	test("rejects non-plain objects without calling toJSON", () => {
		let invoked = false;
		class Custom {
			toJSON() {
				invoked = true;
				return null;
			}
		}
		for (const value of [new Date(), new Map(), new Set(), new Uint8Array(1), new Custom()]) {
			rejects(() => assertJson(value), "JSON_TYPE");
		}
		expect(invoked).toBe(false);
	});

	test("rejects object getters and setters without invoking them", () => {
		let invoked = false;
		for (const descriptor of [
			{
				get() {
					invoked = true;
					return 1;
				},
			},
			{
				set(_value: unknown) {
					invoked = true;
				},
			},
		]) {
			const value = Object.defineProperty({}, "x", { ...descriptor, enumerable: true });
			rejects(() => assertJson(value), "JSON_TYPE");
		}
		expect(invoked).toBe(false);
	});

	test("rejects array index getters without invoking them", () => {
		let invoked = false;
		const value = Object.defineProperty([0], "0", {
			get() {
				invoked = true;
				return 1;
			},
		});
		let caught: unknown;
		try {
			assertJson(value);
		} catch (error) {
			caught = error;
		}
		expect(invoked).toBe(false);
		expect(caught).toBeInstanceOf(ProgrammaticError);
		expect(caught).toMatchObject({ code: "JSON_TYPE" });
	});

	test("allows depth 32 and rejects depth 33, including on the wire", () => {
		expect(() => assertJson(nested(32))).not.toThrow();
		rejects(() => assertJson(nested(33)), "JSON_LIMIT");
		for (const frame of [
			{ ...call, args: nested(33) },
			{ ...success, value: nested(33) },
		]) {
			rejects(() => parse(frame), "JSON_LIMIT");
		}
	});

	test("counts the root in the 20000-node budget", () => {
		expect(() => assertJson(Array(19999).fill(null))).not.toThrow();
		rejects(() => assertJson(Array(20000).fill(null)), "JSON_LIMIT");
		rejects(() => assertJson(Array(20001).fill(null)), "JSON_LIMIT");
		const object = Object.fromEntries(Array.from({ length: 19999 }, (_, i) => [`k${i}`, null]));
		expect(() => assertJson(object)).not.toThrow();
		rejects(() => assertJson({ ...object, extra: null }), "JSON_LIMIT");
		rejects(() => assertJson({ ...object, extra: null, another: null }), "JSON_LIMIT");
	});

	test("rejects nested unsupported values and sparse arrays", () => {
		for (const value of [{ x: undefined }, [Number.NaN], Array(1)]) {
			rejects(() => assertJson(value), "JSON_TYPE");
		}
	});
});

describe("parseJson and error projection", () => {
	test.each(["中", "😀", "中😀"])("measures UTF8 bytes for %s, including quotes", (value) => {
		const text = JSON.stringify(value);
		const bytes = Buffer.byteLength(text);
		expect(bytes).toBeGreaterThan(text.length);
		expect(parseJson(text, bytes)).toBe(value);
		rejects(() => parseJson(text, bytes - 1), "OUTPUT_LIMIT");
		rejects(() => parseJson(text, text.length), "OUTPUT_LIMIT");
	});

	test("handles exact ASCII limits, whitespace, and explicit null", () => {
		expect(parseJson("null", 4)).toBeNull();
		rejects(() => parseJson("null", 3), "OUTPUT_LIMIT");
		expect(parseJson(" null ", 6)).toBeNull();
		rejects(() => parseJson(" null ", 5), "OUTPUT_LIMIT");
		expect(parseJson("0", 1)).toBe(0);
	});

	test.each([
		"",
		"undefined",
		"NaN",
		"Infinity",
		"{",
		'{"a":}',
		"[1,]",
		"null trailing",
	])("rejects invalid JSON %j with a fixed protocol error", (text) => {
		const caught = rejects(() => parseJson(text, 100), "PROTOCOL");
		expect(errorShape(caught)).toEqual({ code: "PROTOCOL", message: "Invalid JSON", fatal: true });
	});

	test("rejects finite-looking overflow and structural excess after parsing", () => {
		rejects(() => parseJson("1e400", 5), "JSON_TYPE");
		rejects(() => parseJson(JSON.stringify(nested(33)), 100), "JSON_LIMIT");
		rejects(() => parseJson(JSON.stringify(Array(20000).fill(0)), 50000), "JSON_LIMIT");
		rejects(
			() => parseChildFrame(JSON.stringify(call).replace('"args":null', '"args":1e400')),
			"JSON_TYPE",
		);
	});

	test("programmatic errors preserve code and fatal rather than fallback values", () => {
		for (const fatal of [true, false]) {
			const original = new ProgrammaticError("CUSTOM_CODE", "x".repeat(2001), fatal);
			expect(original.name).toBe("ProgrammaticError");
			expect(errorShape(original, "FALLBACK", !fatal)).toEqual({
				code: "CUSTOM_CODE",
				message: "x".repeat(2000),
				fatal,
			});
		}
	});

	test("ordinary errors expose only a bounded message and chosen fallback metadata", () => {
		const original = new Error("x".repeat(2001));
		original.stack = "SECRET STACK /private/location";
		expect(errorShape(original)).toEqual({
			code: "HOST_ERROR",
			message: "x".repeat(2000),
			fatal: true,
		});
		expect(errorShape(original, "CUSTOM", false)).toEqual({
			code: "CUSTOM",
			message: "x".repeat(2000),
			fatal: false,
		});
		expect(JSON.stringify(errorShape(original))).not.toContain("SECRET STACK");
	});

	test("non-Error thrown values do not leak arbitrary object content", () => {
		for (const value of [
			null,
			"secret",
			{ message: "secret", stack: "secret", code: "spoof", fatal: false },
		]) {
			expect(errorShape(value)).toEqual({
				code: "HOST_ERROR",
				message: "Host operation failed",
				fatal: true,
			});
		}
	});
});
