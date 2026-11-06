import { describe, expect, test } from "bun:test";
import { StartupError, toStartupProblem } from "../startup-error";
import {
	databaseUpgradeFailed,
	InstanceLockedError,
	noPortAvailable,
	portUnavailable,
	quotePath,
} from "../startup-problems";

describe("startup problems", () => {
	test("an instance lock conflict keeps the line the Windows manager parses", () => {
		const detail = "Another NarraFork process (pid 4242) is already using /data/narrafork.db.";
		const error = new InstanceLockedError(4242, detail);
		expect(error).toBeInstanceOf(StartupError);
		// The manager reads the pid from this text on stderr (server/manager/listen-log.ts).
		expect(toStartupProblem(error).detail).toBe(detail);
		expect(toStartupProblem(error).command).toMatch(/4242$/);
	});

	test("messages shown to every viewer name no pid or path", () => {
		const problems = [
			new InstanceLockedError(4242, "pid 4242 /home/me/.narrafork").problem,
			databaseUpgradeFailed(new Error("at /home/me/x.ts")).problem,
		];
		for (const problem of problems) {
			expect(`${problem.message.en} ${problem.message.zh}`).not.toMatch(/4242|\/home\//);
		}
	});

	test("a database upgrade failure carries the original error as detail", () => {
		const problem = databaseUpgradeFailed(new Error("no such column: x")).problem;
		expect(problem.detail).toContain("no such column: x");
	});

	test("a reserved Windows port points at the reserved ranges", () => {
		const problem = portUnavailable(8022, "7990-8089").problem;
		expect(problem.message.en).toContain("7990-8089");
		expect(problem.command).toContain("excludedportrange");
	});

	test("a busy port gives a command that finds the program using it", () => {
		expect(portUnavailable(7778).problem.command).toContain("7778");
	});

	test("only a Windows run with reserved ranges suggests listing them", () => {
		expect(noPortAvailable("7778, 7779").problem.command).toBeUndefined();
		expect(noPortAvailable("7778", "7700-7799").problem.command).toContain("excludedportrange");
	});
});

describe("quotePath", () => {
	test("quotes for PowerShell", () => {
		expect(quotePath("C:\\Users\\O'Neil\\settings.json", true)).toBe(
			"'C:\\Users\\O''Neil\\settings.json'",
		);
	});

	test("quotes for sh", () => {
		expect(quotePath("/home/o'neil/settings.json", false)).toBe(`'/home/o'\\''neil/settings.json'`);
	});
});
