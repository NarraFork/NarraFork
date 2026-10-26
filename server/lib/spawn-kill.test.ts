import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeSpawn } from "./spawn";

setDefaultTimeout(30_000);

/** Running, per /proc: gone and zombie both count as dead (a container's init may not reap). */
function running(pid: number): boolean {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
	} catch {
		return false;
	}
}

/** A process closes its pipes early in its exit, so `running` can lag safeSpawn by a moment. */
async function exits(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 100 && running(pid); attempt++) await Bun.sleep(20);
	return !running(pid);
}

describe("safeSpawn process-tree kill", () => {
	test.if(process.platform === "linux")(
		"abort reaches a grandchild through the shell",
		async () => {
			const controller = new AbortController();
			let grandchild = 0;
			const startedAt = performance.now();
			// The grandchild holds the pipes: unless it is killed too, safeSpawn waits out its sleep.
			const result = await safeSpawn({
				cmd: ["sh", "-c", "sleep 60 & echo $!; wait"],
				timeout: 20_000,
				signal: controller.signal,
				killProcessTree: true,
				stdoutStream: {
					maxBytes: 1024,
					onChunk(chunk) {
						grandchild = Number.parseInt(new TextDecoder().decode(chunk), 10);
						controller.abort();
					},
				},
			});
			expect(result.terminationReason).toBe("abort");
			expect(grandchild).toBeGreaterThan(0);
			expect(await exits(grandchild)).toBe(true);
			expect(performance.now() - startedAt).toBeLessThan(10_000);
		},
	);

	test("tree kills never spawn their helper synchronously", () => {
		// Killing a tree runs when a client aborts (switching narrators aborts that narrator's
		// Git requests). A synchronous taskkill there held the event loop ~0.5s per process.
		for (const file of ["spawn.ts", "../terminal/runtime-pty.ts", "agent/shell.ts"]) {
			const source = readFileSync(join(import.meta.dir, file), "utf8");
			expect(source.match(/(?:spawnSync|execSync)\(\s*\[?\s*["'`](?:taskkill|pgrep)/g)).toBeNull();
		}
	});
});
