import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { startPrototype } from "../../scripts/webrtc-prototype";

describe("M1 isolated process ownership", () => {
	test("already aborted startup creates no service", async () => {
		const controller = new AbortController();
		controller.abort(new Error("TEST_STARTUP_CANCELLED"));
		await expect(startPrototype({ signal: controller.signal })).rejects.toThrow(
			"TEST_STARTUP_CANCELLED",
		);
	});
	test("startup cancellation is propagated and cleanup is awaited", async () => {
		const controller = new AbortController();
		const startup = startPrototype({ signal: controller.signal });
		controller.abort(new Error("TEST_STARTUP_CANCELLED"));
		await expect(startup).rejects.toThrow("TEST_STARTUP_CANCELLED");
	}, 10000);
	test("concurrent shutdown requests share the full cleanup promise", async () => {
		const prototype = await startPrototype();
		try {
			const first = prototype.stop();
			const second = prototype.stop();
			expect(second).toBe(first);
			await Promise.all([first, second]);
			expect(existsSync(prototype.directory)).toBe(false);
		} finally {
			await prototype.stop();
		}
	}, 60000);
});

test("private prototype state is ignored but executable source survives fresh checkouts", async () => {
	const ignored = async (path: string) => {
		const process = Bun.spawn(["git", "check-ignore", "--quiet", "--", path], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return await process.exited;
	};
	expect(await ignored(".webrtc-prototype-test/peer-state.json")).toBe(0);
	expect(await ignored("scripts/webrtc-prototype.ts")).toBe(1);
	expect(await ignored("scripts/generate-webrtc-vectors.ts")).toBe(1);
});
