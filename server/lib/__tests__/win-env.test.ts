import { describe, expect, test } from "bun:test";
import { expandWindowsEnvironmentVariables } from "../win-env";

describe("expandWindowsEnvironmentVariables", () => {
	test("expands common Windows PATH references case-insensitively", () => {
		const env = {
			SystemRoot: "C:\\Windows",
			USERPROFILE: "C:\\Users\\alice",
		};

		expect(
			expandWindowsEnvironmentVariables("%SYSTEMROOT%\\System32;%UserProfile%\\bin", env),
		).toBe("C:\\Windows\\System32;C:\\Users\\alice\\bin");
	});

	test("expands nested references", () => {
		const env = {
			LOCALAPPDATA: "%USERPROFILE%\\AppData\\Local",
			USERPROFILE: "C:\\Users\\alice",
		};

		expect(expandWindowsEnvironmentVariables("%LOCALAPPDATA%\\Programs", env)).toBe(
			"C:\\Users\\alice\\AppData\\Local\\Programs",
		);
	});

	test("resolves variables missing from the inherited process environment", () => {
		const registryValues: Record<string, string> = {
			TOOL_HOME: "C:\\Tools\\example",
		};

		expect(
			expandWindowsEnvironmentVariables(
				"%TOOL_HOME%\\bin",
				{},
				(name) => registryValues[name] ?? null,
			),
		).toBe("C:\\Tools\\example\\bin");
	});

	test("prefers current registry values over stale inherited values", () => {
		const inheritedEnv = { TOOL_HOME: "C:\\Old" };
		const registryValues: Record<string, string> = { TOOL_HOME: "C:\\New" };

		expect(
			expandWindowsEnvironmentVariables(
				"%TOOL_HOME%\\bin",
				inheritedEnv,
				(name) => registryValues[name] ?? null,
			),
		).toBe("C:\\New\\bin");
	});

	test("preserves unknown references", () => {
		expect(expandWindowsEnvironmentVariables("%UNKNOWN%\\bin", {})).toBe("%UNKNOWN%\\bin");
	});

	test("terminates cyclic references", () => {
		const env = { FIRST: "%SECOND%", SECOND: "%FIRST%" };
		expect(expandWindowsEnvironmentVariables("%FIRST%\\bin", env)).toBe("%FIRST%\\bin");
	});
});
