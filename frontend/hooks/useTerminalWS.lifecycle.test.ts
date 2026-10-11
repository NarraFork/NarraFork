import { describe, expect, test } from "bun:test";
import { parseTerminalLifecycle } from "./useTerminalWS";

describe("terminal lifecycle evidence", () => {
	test("unknown/closing cannot turn a missing or unrelated code into success", () => {
		expect(parseTerminalLifecycle({ state: "unknown", code: 0 })).toEqual({
			state: "unknown",
			code: null,
		});
		expect(parseTerminalLifecycle({ state: "closing", code: -1 })).toEqual({
			state: "closing",
			code: null,
		});
		expect(parseTerminalLifecycle({ state: "exited", code: null })).toEqual({
			state: "unknown",
			code: null,
		});
		expect(parseTerminalLifecycle({ state: "exited", code: -1 })).toEqual({
			state: "unknown",
			code: null,
		});
	});
	test("only an actual numeric exit can show an exit code", () => {
		expect(parseTerminalLifecycle({ state: "exited", code: 7 })).toEqual({
			state: "exited",
			code: 7,
		});
		expect(parseTerminalLifecycle({ state: "ready", code: null })).toEqual({
			state: "ready",
			code: null,
		});
		expect(parseTerminalLifecycle({ state: "invented", code: 0 })).toBeNull();
	});
});
