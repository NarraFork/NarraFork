import { describe, expect, mock, test } from "bun:test";
import { shouldRunManager } from "../../manager/launch-mode";
import { replacementLaunchArgs, spawnReplacementProcess } from "../replacement-launch";

describe("replacementLaunchArgs", () => {
	test("a manager-supervised Windows server relaunches the new exe as a manager", () => {
		const args = replacementLaunchArgs(["--serve"], { platform: "win32", managerManaged: true });
		expect(args).toEqual(["--manager"]);
		// The new exe must land in the manager, which then takes over from the old one.
		expect(
			shouldRunManager({ argv: ["narrafork.exe", ...args], platform: "win32", compiled: true }),
		).toBe(true);
	});

	test("keeps unrelated arguments", () => {
		expect(
			replacementLaunchArgs(["--port=8000", "--serve"], {
				platform: "win32",
				managerManaged: true,
			}),
		).toEqual(["--port=8000", "--manager"]);
	});

	test("a server started without the manager keeps its own arguments", () => {
		expect(replacementLaunchArgs([], { platform: "win32", managerManaged: false })).toEqual([]);
		expect(replacementLaunchArgs(["--serve"], { platform: "linux", managerManaged: true })).toEqual(
			["--serve"],
		);
	});
});

describe("spawnReplacementProcess", () => {
	for (const platform of ["win32", "linux", "darwin"]) {
		test(`${platform}: starts the executable directly without a shell`, () => {
			const unref = mock(() => {});
			const spawn = mock(() => ({ pid: 4321, unref }));
			const spawnWindows = mock(() => 5678);
			const env = {
				HTTPS_PROXY: "http://proxy.invalid:8080",
				NARRAFORK_MANAGER_TOKEN: "manager-secret",
				NARRAFORK_GRACEFUL_RESTART_URL: "https://127.0.0.1:7778/api/gracefully_shutdown",
				NARRAFORK_GRACEFUL_RESTART_TOKEN: "handoff-secret",
				NARRAFORK_GRACEFUL_RESTART_MARKER_PATH: "C:\\用户 空格\\marker.json",
				NARRAFORK_GRACEFUL_RESTART_MARKER_NONCE: "marker-nonce",
			};
			const execPath = "C:\\用户 空格 & %PATH%\\narrafork.exe";
			const args = ["--manager", "--name=中文 & %PATH%", 'literal"quote', ""];
			const cwd = "C:\\项目 空格 & %PATH%";
			const options = { execPath, args, cwd, env, platform };
			const pid = spawnReplacementProcess(options, { spawn, spawnWindows });
			if (platform === "win32") {
				expect(pid).toBe(5678);
				expect(spawnWindows).toHaveBeenCalledTimes(1);
				expect(spawnWindows).toHaveBeenCalledWith(options);
				expect(spawn).not.toHaveBeenCalled();
				expect(unref).not.toHaveBeenCalled();
			} else {
				expect(pid).toBe(4321);
				expect(spawnWindows).not.toHaveBeenCalled();
				expect(spawn).toHaveBeenCalledTimes(1);
				expect(spawn).toHaveBeenCalledWith([execPath, ...args], {
					cwd,
					env,
					detached: true,
					stdio: ["ignore", "ignore", "ignore"],
					windowsHide: false,
				});
				expect(unref).toHaveBeenCalledTimes(1);
			}
		});
	}

	for (const platform of ["win32", "linux"]) {
		test(`${platform}: reports spawn failure without fallback`, () => {
			const failure = new Error("process creation failed");
			const fail = mock(() => {
				throw failure;
			});
			const unused = mock(() => ({ pid: 0, unref() {} }));
			expect(() =>
				spawnReplacementProcess(
					{
						execPath: "missing.exe",
						args: ["--manager"],
						cwd: ".",
						env: {},
						platform,
					},
					platform === "win32" ? { spawnWindows: fail, spawn: unused } : { spawn: fail },
				),
			).toThrow(failure);
			expect(fail).toHaveBeenCalledTimes(1);
			expect(unused).not.toHaveBeenCalled();
		});
	}
});
