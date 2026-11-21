import { describe, expect, test } from "bun:test";
import { type PowerOffSpawn, resolvePowerOffPlan, runPowerOff } from "../power-off";

function fakeSpawn(codes: number[]): { spawn: PowerOffSpawn; calls: string[][] } {
	const calls: string[][] = [];
	const spawn: PowerOffSpawn = (command) => {
		calls.push(command);
		const code = codes[calls.length - 1] ?? 1;
		return { exited: Promise.resolve(code), kill: () => {}, unref: () => {} };
	};
	return { spawn, calls };
}

describe("resolvePowerOffPlan", () => {
	test("windows runs the absolute system binary, never a PATH lookup", () => {
		const plan = resolvePowerOffPlan("win32");
		expect(plan.supported).toBe(true);
		expect(plan.candidates).toHaveLength(1);
		const command = plan.candidates[0] ?? [];
		expect(command[0]?.toLowerCase()).toContain("\\system32\\shutdown.exe");
		expect(command.slice(1)).toEqual(["/s", "/t", "0"]);
	});

	test("macOS asks System Events to shut the machine down", () => {
		const plan = resolvePowerOffPlan("darwin");
		expect(plan.candidates).toEqual([
			["osascript", "-e", 'tell application "System Events" to shut down'],
		]);
	});

	test("linux tries systemd, then shutdown", () => {
		const plan = resolvePowerOffPlan("linux");
		expect(plan.candidates).toEqual([
			["systemctl", "poweroff"],
			["shutdown", "-h", "now"],
		]);
	});

	test("a custom command goes through the platform shell", () => {
		expect(resolvePowerOffPlan("linux", "sudo poweroff").candidates).toEqual([
			["/bin/sh", "-c", "sudo poweroff"],
		]);
		expect(resolvePowerOffPlan("win32", "shutdown /s /f").candidates).toEqual([
			["cmd.exe", "/c", "shutdown /s /f"],
		]);
	});

	test("a blank custom command keeps the platform default", () => {
		expect(resolvePowerOffPlan("linux", "   ").candidates[0]).toEqual(["systemctl", "poweroff"]);
		expect(resolvePowerOffPlan("linux", null).candidates[0]).toEqual(["systemctl", "poweroff"]);
	});

	test("a multi-line custom command is refused", () => {
		const plan = resolvePowerOffPlan("linux", "poweroff\nrm -rf /");
		expect(plan.supported).toBe(false);
		expect(plan.note).toBe("invalid-custom-command");
		expect(plan.candidates).toEqual([]);
	});

	test("an unknown platform reports itself unsupported", () => {
		const plan = resolvePowerOffPlan("aix");
		expect(plan.supported).toBe(false);
		expect(plan.note).toBe("unsupported-platform");
	});
});

describe("runPowerOff", () => {
	test("a zero exit code counts as success and detaches the child", () => {
		let unrefs = 0;
		const result = runPowerOff(
			{},
			{
				platform: "linux",
				spawn: () => ({ exited: Promise.resolve(0), kill: () => {}, unref: () => void unrefs++ }),
			},
		);
		return result.then((value) => {
			expect(value.ok).toBe(true);
			expect(value.command).toEqual(["systemctl", "poweroff"]);
			expect(unrefs).toBe(1);
		});
	});

	test("a failing candidate falls through to the next one", async () => {
		const { spawn, calls } = fakeSpawn([1, 0, 0]);
		const result = await runPowerOff({}, { platform: "linux", spawn });
		expect(result.ok).toBe(true);
		expect(result.command).toEqual(["shutdown", "-h", "now"]);
		expect(calls).toHaveLength(2);
		expect(result.attempts.map((attempt) => attempt.code)).toEqual([1, 0]);
	});

	test("every candidate failing reports the last outcome and no success", async () => {
		const { spawn, calls } = fakeSpawn([1, 1]);
		const result = await runPowerOff({}, { platform: "linux", spawn });
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(2);
		expect(result.error).toContain("1");
	});

	test("a hanging candidate is bounded by the timeout", async () => {
		const result = await runPowerOff(
			{},
			{
				platform: "linux",
				timeoutMs: 100,
				spawn: () => ({ exited: new Promise<number>(() => {}), kill: () => {} }),
			},
		);
		expect(result.ok).toBe(false);
		expect(result.attempts.at(-1)?.code).toBe(-1);
		expect(result.error).toBe("timed out");
	});

	test("kills and reaps the timed-out candidate before the Linux fallback", async () => {
		const first = Promise.withResolvers<number>();
		const order: string[] = [];
		const result = await runPowerOff(
			{},
			{
				platform: "linux",
				timeoutMs: 200,
				spawn: ([command]) => {
					order.push(command);
					if (command === "systemctl") {
						return {
							exited: first.promise,
							kill: () => {
								order.push("kill");
								void Bun.sleep(1).then(() => {
									order.push("reaped");
									first.resolve(137);
								});
							},
						};
					}
					return { exited: Promise.resolve(0), kill: () => {} };
				},
			},
		);
		expect(result.ok).toBe(true);
		expect(result.attempts.map(({ code }) => code)).toEqual([-1, 0]);
		expect(order).toEqual(["systemctl", "kill", "reaped", "shutdown"]);
	});

	test("a throwing spawn is an attempt failure, never a throw", async () => {
		const result = await runPowerOff(
			{},
			{
				platform: "linux",
				spawn: () => {
					throw new Error("spawn EACCES");
				},
			},
		);
		expect(result.ok).toBe(false);
		expect(result.attempts[0]?.error).toBe("spawn EACCES");
	});

	test("an unsupported platform never spawns anything", async () => {
		const { spawn, calls } = fakeSpawn([0]);
		const result = await runPowerOff({}, { platform: "aix", spawn });
		expect(result.unsupported).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("a refused custom command never reaches the shell", async () => {
		const { spawn, calls } = fakeSpawn([0]);
		const result = await runPowerOff({ custom: "a\nb" }, { platform: "linux", spawn });
		expect(result.ok).toBe(false);
		expect(result.unsupported).toBe(true);
		expect(calls).toHaveLength(0);
	});
});
