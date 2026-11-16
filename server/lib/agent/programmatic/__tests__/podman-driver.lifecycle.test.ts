import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerHandle } from "../../../worker-runtime/lifecycle";
import { createPodmanDriver } from "../podman-driver";

const roots: string[] = [];
const nativeClose = WorkerHandle.prototype.close;
async function eventually(predicate: () => boolean) {
	const end = Date.now() + 1500;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("Helper synchronization timed out");
		await Bun.sleep(0);
	}
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// A fake CLI is an actual child process, NOT evidence of qualified Podman or
// container isolation. We assert only helper cancellation/output/deadline ownership.
describe("Podman helper process lifetime", () => {
	for (const fault of ["cancel", "timeout", "output"] as const)
		test(`${fault} cannot release an availability helper before actual exit`, async () => {
			const root = await mkdtemp(join(tmpdir(), "nf-podman-helper-"));
			roots.push(root);
			const executable = join(root, "fixture-podman");
			await writeFile(
				executable,
				`#!${process.execPath}\nsetInterval(()=>{},1000);${fault === "output" ? 'for(let n=0;n<64;n++)process.stdout.write("x".repeat(65536));' : ""}`,
			);
			await chmod(executable, 0o700);
			const abort = new AbortController();
			let child: ChildProcess | undefined;
			let killRequested = false;
			let nativeKill: (() => void) | undefined;
			let killSpy: ReturnType<typeof spyOn> | undefined;
			const close = spyOn(WorkerHandle.prototype, "close").mockImplementation(function (
				this: WorkerHandle<unknown>,
			) {
				if (!child) {
					child = this.resource as ChildProcess;
					const kill = child.kill.bind(child);
					nativeKill = () => {
						kill("SIGKILL");
					};
					killSpy = spyOn(child, "kill").mockImplementation(() => {
						killRequested = true;
						return true;
					});
				}
				return nativeClose.call(this);
			});
			const schedule = globalThis.setTimeout;
			let watchdog = false;
			const timer =
				fault === "timeout"
					? spyOn(globalThis, "setTimeout").mockImplementation(((
							callback: (...args: unknown[]) => void,
							delay: number,
							...args: unknown[]
						) => {
							if (delay === 5000) {
								watchdog = true;
								return schedule(callback, 1, ...args);
							}
							return schedule(callback, delay, ...args);
						}) as typeof setTimeout)
					: undefined;
			let settled = false;
			const driver = createPodmanDriver({ imageId: "0".repeat(64), podmanPath: executable });
			const pending = driver.checkAvailable(abort.signal);
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			try {
				if (fault === "cancel") {
					await Bun.sleep(0);
					abort.abort();
				}
				await eventually(() => killRequested);
				expect(settled).toBe(false);
				expect(child?.exitCode).toBeNull();
				if (!nativeKill) throw new Error("Helper did not request its owned process stop");
				nativeKill();
				await expect(pending).rejects.toMatchObject({
					code: { cancel: "CANCELLED", timeout: "SANDBOX_UNAVAILABLE", output: "OUTPUT_LIMIT" }[
						fault
					],
				});
				expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
				if (fault === "timeout") expect(watchdog).toBe(true);
			} finally {
				nativeKill?.();
				killSpy?.mockRestore();
				close.mockRestore();
				timer?.mockRestore();
				await Promise.allSettled([pending]);
			}
		});
});
