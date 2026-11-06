import { describe, expect, test } from "bun:test";
import { __testing, initWindowsChildJob, terminateWindowsChildren } from "../windows-child-job";

describe("windows child job on a non-Windows host", () => {
	test("init and terminate are no-ops, so nothing is spawned and no FFI is loaded", () => {
		if (process.platform === "win32") return;
		expect(initWindowsChildJob()).toBe(false);
		expect(terminateWindowsChildren()).toBe(false);
		expect(__testing.available).toBe(false);
	});
});
