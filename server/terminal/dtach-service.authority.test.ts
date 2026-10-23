import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { dtachService } from "./dtach-service";

// Actual dtach discovery/kill orchestration; all query subprocesses and signal
// effects are mocked. No real process, including the running agent, is signalled.
const rootPid = 900001;
const childPid = 900002;
const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
});
function harness(revokeAt?: "matching processes" | "descendants") {
	let revoked = false;
	const signal = spyOn(process, "kill").mockImplementation(() => true);
	restores.push(() => signal.mockRestore());
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		const matching = cmd[0] === "pgrep";
		if (!matching && cmd[0] !== "ps") throw new Error(`Unexpected process query: ${cmd[0]}`);
		const output = matching ? `${rootPid}\n` : `${rootPid} 1\n${childPid} ${rootPid}\n`;
		return {
			stdout: new Blob([output]).stream(),
			exited: Promise.resolve().then(() => {
				if (
					(matching && revokeAt === "matching processes") ||
					(!matching && revokeAt === "descendants")
				)
					revoked = true;
				return 0;
			}),
			kill() {},
		};
	}) as typeof Bun.spawn);
	restores.push(() => spawn.mockRestore());
	return {
		signal,
		guard() {
			if (revoked) throw new Error("original authority revoked");
		},
	};
}

describe("dtach original authority final effects", () => {
	for (const phase of ["matching processes", "descendants"] as const) {
		test(`revocation during ${phase} discovery sends zero process signals`, async () => {
			const { signal, guard } = harness(phase);
			await expect(dtachService.killSession("authority-fixture-no-socket", guard)).rejects.toThrow(
				"original authority revoked",
			);
			expect(signal).not.toHaveBeenCalled();
		});
	}
	test("unchanged authority permits child/root signals in the existing order", async () => {
		const { signal, guard } = harness();
		await dtachService.killSession("authority-fixture-no-socket", guard);
		expect(signal.mock.calls).toEqual([
			[childPid, "SIGKILL"],
			[rootPid, "SIGKILL"],
		]);
	});
});
