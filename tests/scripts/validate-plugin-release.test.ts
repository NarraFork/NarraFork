import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePluginRelease } from "../../scripts/validate-plugin-release";

const examplesRoot = resolve(process.cwd(), "examples/plugins");

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

async function waitForProcessesToExit(pids: number[], timeoutMs = 2_500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (pids.some(processIsAlive) && Date.now() < deadline) {
		await Bun.sleep(10);
	}
}

describe("plugin GA release validation", () => {
	test("keeps static validation backward compatible across the supported matrix", async () => {
		const summary = await validatePluginRelease(examplesRoot);
		expect(summary.valid).toBe(true);
		expect(summary.mode).toBe("static");
		expect(summary.packageCount).toBe(6);
		expect(summary.matrixCombinationCount).toBe(36);
		expect(summary.errors).toEqual([]);
		expect(summary.packages.map((item) => item.kind)).toEqual([
			"provider",
			"sandbox-ui-panel",
			"theme-duo",
			"theme-pop-art",
			"theme-scenic",
			"tool-command",
		]);
		expect(summary.packages.every((item) => item.sbom.generatedSpdx)).toBe(true);
		expect(summary.packages.every((item) => item.runtime.status === "not-requested")).toBe(true);
	});

	test("does not execute a server entry in default static mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-static-test-"));
		try {
			const packageRoot = join(root, "tool-command");
			await cp(join(examplesRoot, "tool-command"), packageRoot, { recursive: true });
			await writeFile(
				join(packageRoot, "server/index.js"),
				'throw new Error("static validation executed the plugin entry");\n',
			);
			const summary = await validatePluginRelease(root);
			expect(summary.valid).toBe(true);
			expect(summary.packages[0]?.runtime.status).toBe("not-requested");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("starts real references and records handshake, tool, and provider evidence", async () => {
		const summary = await validatePluginRelease(examplesRoot, {
			mode: "ga",
			runtimeTimeoutMs: 8_000,
		});
		expect(summary.valid).toBe(true);
		expect(summary.mode).toBe("ga");
		expect(summary.errors).toEqual([]);

		const tool = summary.packages.find((item) => item.pluginId === "com.example.tool-command");
		expect(tool?.runtime).toMatchObject({
			status: "passed",
			handshake: { hello: true, initialize: true, activate: true, health: true, generation: 1 },
			toolInvoke: { contributionId: "describe-selection" },
		});
		expect(tool?.runtime.toolInvoke?.outputBytes).toBeGreaterThan(0);

		const provider = summary.packages.find((item) => item.pluginId === "com.example.provider");
		expect(provider?.runtime).toMatchObject({
			status: "passed",
			handshake: { hello: true, initialize: true, activate: true, health: true, generation: 1 },
			provider: {
				providerTypeId: "com.example.provider/example-provider",
				modelCount: 1,
			},
		});

		const ui = summary.packages.find((item) => item.pluginId === "com.example.sandbox-ui");
		expect(ui?.runtime.status).toBe("skipped-no-server");
	});

	test("fails runtime validation within the bounded hello timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-runtime-test-"));
		try {
			const packageRoot = join(root, "tool-command");
			await cp(join(examplesRoot, "tool-command"), packageRoot, { recursive: true });
			await writeFile(join(packageRoot, "server/index.js"), "setInterval(() => {}, 1000);\n");
			const startedAt = Date.now();
			const summary = await validatePluginRelease(root, {
				mode: "runtime",
				runtimeTimeoutMs: 1_000,
			});
			expect(summary.valid).toBe(false);
			expect(summary.packageCount).toBe(0);
			expect(summary.errors.join("\n")).toMatch(/hello|timeout|exited/i);
			expect(Date.now() - startedAt).toBeLessThan(5_000);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("waits for a timed-out plugin parent and its long-lived child to exit", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-tree-test-"));
		try {
			const packageRoot = join(root, "tool-command");
			const pidPath = join(packageRoot, "runtime-pids.json");
			await cp(join(examplesRoot, "tool-command"), packageRoot, { recursive: true });
			await writeFile(
				join(packageRoot, "server/index.js"),
				[
					'import { writeFileSync } from "node:fs";',
					'const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });',
					`writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
					"setInterval(() => {}, 1000);",
					"",
				].join("\n"),
			);
			const summary = await validatePluginRelease(root, {
				mode: "runtime",
				runtimeTimeoutMs: 1_000,
			});
			expect(summary.valid).toBe(false);
			const pids = JSON.parse(await readFile(pidPath, "utf8")) as {
				parent: number;
				child: number;
			};
			await waitForProcessesToExit([pids.parent, pids.child]);
			expect(processIsAlive(pids.parent)).toBe(false);
			expect(processIsAlive(pids.child)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
