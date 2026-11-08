import { describe, expect, test } from "bun:test";
import { isNarraForkHealth } from "../../../serve";

describe("isNarraForkHealth", () => {
	const narrafork = {
		status: "ok",
		version: "0.9.11+abc1234",
		commit: "abc1234",
		platform: "windows",
		gitAvailable: true,
		runtimeEnvironment: { kind: "native" },
	};

	test("recognises NarraFork's own health answer", () => {
		expect(isNarraForkHealth(narrafork)).toBe(true);
	});

	test("does not mistake another service that reports a version", () => {
		for (const other of [
			{ status: "ok", version: "2.3.1" },
			{ version: "1.0", platform: "linux" },
			{ ...narrafork, gitAvailable: "yes" },
			{ ...narrafork, platform: "freebsd" },
			{ ...narrafork, runtimeEnvironment: null },
			null,
			"ok",
			[],
		]) {
			expect(isNarraForkHealth(other)).toBe(false);
		}
	});
});
