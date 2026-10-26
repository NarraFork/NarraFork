import { describe, expect, test } from "bun:test";
import { shouldRunManager } from "../../manager/launch-mode";
import { replacementLaunchArgs } from "../replacement-launch";

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
