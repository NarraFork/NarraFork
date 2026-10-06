import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@server/lib/plugins/manifest";
import { LocalProcessRunner, PluginRuntime } from "@server/services/plugin-runtime";

const referenceFixture = join(import.meta.dir, "../../../fixtures/plugins/e2e/reference-tool-rpc");
const tempRoots: string[] = [];

async function copyReferenceFixture(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-acceptance-"));
	tempRoots.push(root);
	const packageRoot = join(root, "package");
	await cp(referenceFixture, packageRoot, { recursive: true });
	return packageRoot;
}

function createRuntime(
	packageRoot: string,
	manifest: ReturnType<typeof parseManifest>,
	onStateChange?: (state: string) => void,
): PluginRuntime {
	if (!manifest.server) throw new Error("reference fixture must declare a server entry");
	return new PluginRuntime({
		pluginId: manifest.pluginId,
		pluginVersion: manifest.version,
		command: [process.execPath, join(packageRoot, manifest.server.entry)],
		cwd: packageRoot,
		rpcProtocol: manifest.server.protocol,
		hostApiVersion: "1.0",
		grantedCapabilities: manifest.permissions.host,
		activationReason: "c1-c2-acceptance",
		runner: new LocalProcessRunner({
			allowedCwds: [packageRoot],
			maxHeaderBytes: 8 * 1024,
			maxBodyBytes: 128 * 1024,
			maxStdoutBytes: 256 * 1024,
			stderrRingBytes: 8 * 1024,
			maxStderrBytes: 16 * 1024,
			maxStderrBytesPerSecond: 16 * 1024,
			// Raised from 2s: see the note in plugin-to-host-dispatcher.e2e.test.ts. The budget
			// bounds a hung plugin, not the scheduler.
			spawnTimeoutMs: 20_000,
			idleTimeoutMs: 30_000,
			totalTimeoutMs: 45_000,
			killProcessTree: true,
			resourceLimits: { cpuTimeSeconds: 30, memoryBytes: 1024 * 1024 * 1024 },
			allowUnboundedResourceUsage: process.platform === "win32",
		}),
		timeouts: {
			handshakeMs: 20_000,
			activationMs: 20_000,
			rpcMs: 20_000,
			drainMs: 100,
			shutdownMs: 750,
			cancelGraceMs: 50,
		},
		idleTimeoutMs: 5_000,
		totalTimeoutMs: 8_000,
		maxInFlight: 4,
		onStateChange: (state) => onStateChange?.(state),
	});
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "EINVAL";
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 1_500): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!processIsAlive(pid)) return true;
		await Bun.sleep(10);
	}
	return !processIsAlive(pid);
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("C1/C2 reference plugin lifecycle acceptance", () => {
	test("runs hello → initialize → activate → health → tool → shutdown in a real child process", async () => {
		const packageRoot = await copyReferenceFixture();
		const manifest = parseManifest(
			JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")),
		);
		const states: string[] = [];
		const runtime = createRuntime(packageRoot, manifest, (state) => states.push(state));

		try {
			await runtime.start();
			const active = runtime.getDiagnostics();
			expect(active).toMatchObject({
				pluginId: manifest.pluginId,
				pluginVersion: manifest.version,
				generation: 1,
				state: "active",
				inFlight: 0,
				lateMessages: 0,
			});
			expect(active.pid).toBeGreaterThan(0);

			const result = await runtime.request<{
				output: string;
				title: string;
				metadata: { length: number; preview: string };
			}>("tools.invoke", {
				contributionId: "describe-selection",
				input: { text: "C1/C2 reference lifecycle" },
				context: { requestId: "acceptance-tool", correlationId: "acceptance" },
			});
			expect(JSON.parse(result.output)).toEqual({
				length: 25,
				preview: "C1/C2 reference lifecycle",
			});
			expect(result.title).toBe("Selection description");
			expect(result.metadata.length).toBe(25);
			await expect(runtime.request("reference.unknown")).rejects.toMatchObject({ code: "-32601" });
		} finally {
			const pid = runtime.pid;
			await runtime.shutdown();
			const stopped = runtime.getDiagnostics();
			expect(stopped.state).toBe("stopped");
			expect(stopped.inFlight).toBe(0);
			expect(stopped.stoppedAt).toBeDefined();
			if (pid) expect(await waitForProcessExit(pid)).toBe(true);
		}
		expect(states).toEqual(["starting", "handshaking", "active", "draining", "stopped"]);
	}, 15_000);

	test("repeats bounded start/stop cycles without live child processes or pending RPC", async () => {
		const packageRoot = await copyReferenceFixture();
		const manifest = parseManifest(
			JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8")),
		);
		const pids: number[] = [];

		for (let cycle = 0; cycle < 8; cycle += 1) {
			const runtime = createRuntime(packageRoot, manifest);
			try {
				await runtime.start();
				const pid = runtime.pid;
				if (!pid) throw new Error(`cycle ${cycle} did not expose a child pid`);
				pids.push(pid);
				const result = await runtime.request<{ output: string }>("tools.invoke", {
					contributionId: "describe-selection",
					input: { text: `cycle-${cycle}` },
					context: { requestId: `cycle-${cycle}`, correlationId: "leak-check" },
				});
				expect(result.output).toContain(`cycle-${cycle}`);
			} finally {
				await runtime.shutdown();
				expect(runtime.getDiagnostics()).toMatchObject({ state: "stopped", inFlight: 0 });
			}
		}

		for (const pid of pids) expect(await waitForProcessExit(pid)).toBe(true);
	}, 45_000);
});
