import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { InstanceLockedError } from "./lib/startup-status/startup-problems";

const conflict = new InstanceLockedError(12345, "isolated fixture: instance conflict");
const shown: unknown[] = [];
let opens = 0;
mock.module("./lib/runtime-target", () => ({
	IS_LOCAL_RUNTIME: true,
	RUNTIME_BUILD_ID: "local-startup-test",
	isCompiledRuntime: () => true,
}));
mock.module("./lib/version", () => ({ APP_VERSION: "local-startup-test" }));
mock.module("./lib/settings", () => ({
	settings: { server: { host: "127.0.0.1", port: 7779 }, branding: {} },
}));
mock.module("./lib/manager-control-server", () => ({
	resolveManagerListenHost: async (host: string) => host,
}));
mock.module("./lib/windows-child-job", () => ({ initWindowsChildJob() {} }));
mock.module("./lib/hot-safe", () => ({ hotOnce: () => true }));
mock.module("./lib/open-frontend", () => ({
	openFrontendOnce() {
		opens++;
		return true;
	},
}));
mock.module("./lib/startup-status", () => ({
	startStartupStatus: async () => false,
	showStartupProblem: async (problem: unknown) => {
		shown.push(problem);
	},
	closeStartupStatus: async () => {},
	expectStartupViewer() {},
}));
mock.module("./main", () => {
	throw conflict;
});

const { serve } = await import("./serve");
afterAll(() => mock.restore());

test("a second local compiled launch reports the instance conflict instead of opening the old server", async () => {
	const exit = spyOn(process, "exit").mockImplementation((code) => {
		throw new Error(`fixture-exit:${code}`);
	});
	const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("local launch must not probe/open an old runtime"),
	);
	const stderr = spyOn(console, "error").mockImplementation(() => {});
	const managed = process.env.NARRAFORK_MANAGER_MANAGED;
	process.env.NARRAFORK_MANAGER_MANAGED = "0";
	try {
		await expect(serve()).rejects.toThrow("fixture-exit:1");
		expect(shown).toEqual([conflict.problem]);
		expect(exit).toHaveBeenCalledWith(1);
		expect(fetch).not.toHaveBeenCalled();
		expect(opens).toBe(0);
	} finally {
		if (managed === undefined) delete process.env.NARRAFORK_MANAGER_MANAGED;
		else process.env.NARRAFORK_MANAGER_MANAGED = managed;
		exit.mockRestore();
		fetch.mockRestore();
		stderr.mockRestore();
	}
});
