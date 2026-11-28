import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePluginRelease } from "../../scripts/validate-plugin-release";
import { PluginPackageStore } from "../../server/services/plugin-package-store";

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
	test("validates the remaining generic references across the supported matrix", async () => {
		const summary = await validatePluginRelease(examplesRoot);
		expect(summary.errors).toEqual([]);
		expect(summary.valid).toBe(true);
		expect(summary.mode).toBe("static");
		expect(summary.packageCount).toBe(10);
		// 10 packages across the 6 os/arch combinations the release matrix supports.
		expect(summary.matrixCombinationCount).toBe(60);
		// Discovery sorts by directory name, so this list is alphabetical.
		expect(summary.packages.map((item) => item.kind)).toEqual([
			"provider",
			"provider-settings-reference",
			"sandbox-ui-panel",
			"theme-duo",
			"theme-framed",
			"theme-pop-art",
			"theme-qq-classic",
			"theme-scenic",
			"theme-strawberry",
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

	test("computes the same generic provider package digest as the installer", async () => {
		const releaseRoot = await mkdtemp(join(tmpdir(), "narrafork-plugin-digest-release-"));
		const storeRoot = await mkdtemp(join(tmpdir(), "narrafork-plugin-digest-store-"));
		try {
			const packageRoot = join(releaseRoot, "provider");
			await cp(join(examplesRoot, "provider"), packageRoot, { recursive: true });
			const summary = await validatePluginRelease(releaseRoot);
			const installed = await new PluginPackageStore(storeRoot).install(packageRoot);

			expect(summary.valid).toBe(true);
			expect(summary.packages[0]?.digest).toBe(installed.hash);
		} finally {
			await Promise.all([
				rm(releaseRoot, { recursive: true, force: true }),
				rm(storeRoot, { recursive: true, force: true }),
			]);
		}
	});

	test("rejects empty release sets rather than skipping the gate", async () => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-empty-release-"));
		try {
			expect(await validatePluginRelease(root, { mode: "ga" })).toMatchObject({
				valid: false,
				packageCount: 0,
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.each([
		"manifest.json",
		"server/index.js",
		"sbom.spdx.json",
	])("fails closed before runtime validation when %s is missing", async (path) => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-missing-release-"));
		try {
			const packageRoot = join(root, "tool-command");
			await cp(join(examplesRoot, "tool-command"), packageRoot, { recursive: true });
			await rm(join(packageRoot, path));
			const summary = await validatePluginRelease(root, { mode: "ga" });
			expect(summary.valid).toBe(false);
			expect(summary.errors.length).toBeGreaterThan(0);
			expect(summary.packages[0]?.runtime.status).toBe("not-requested");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.each([
		{ field: "license", value: "MIT", error: /SBOM package license/ },
		{ field: "version", value: "9.0.0", error: /SBOM does not contain/ },
		{ field: "engine.os", value: ["linux"], error: /release matrix does not support/ },
		{ field: "server.entry", value: "../escape.js", error: /manifest server.entry/ },
	])("keeps manifest, SBOM and matrix checks: %j", async ({ field, value, error }) => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-invalid-release-"));
		try {
			const packageRoot = join(root, "tool-command");
			await cp(join(examplesRoot, "tool-command"), packageRoot, { recursive: true });
			const path = join(packageRoot, "manifest.json");
			const manifest = JSON.parse(await readFile(path, "utf8"));
			const [parent, child] = field.split(".");
			if (child) manifest[parent][child] = value;
			else manifest[parent] = value;
			await writeFile(path, JSON.stringify(manifest));
			const summary = await validatePluginRelease(root, { mode: "ga" });
			expect(summary.valid).toBe(false);
			expect(summary.errors.join("\n")).toMatch(error);
			expect(summary.packages[0]?.runtime.status).toBe("not-requested");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects symlink entries without executing the linked server", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-symlink-release-"));
		try {
			const packageRoot = join(root, "tool-command");
			await cp(join(examplesRoot, "tool-command"), packageRoot, { recursive: true });
			const path = join(packageRoot, "server/index.js");
			await rm(path);
			await symlink(join(examplesRoot, "tool-command/server/index.js"), path);
			const summary = await validatePluginRelease(root, { mode: "ga" });
			expect(summary.valid).toBe(false);
			expect(summary.errors.join("\n")).toMatch(/symlink is not allowed/);
			expect(summary.packages[0]?.runtime.status).toBe("not-requested");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test.each([
		"\n",
		"\r\n",
	])("rejects a runtime that omits the installer package digest with newline=%j", async (newline) => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-plugin-digest-hello-"));
		try {
			const packageRoot = join(root, "tool-command");
			await cp(join(examplesRoot, "tool-command"), packageRoot, { recursive: true });
			const entryPath = join(packageRoot, "server/index.js");
			const entry = (await readFile(entryPath, "utf8"))
				.replaceAll("\r\n", "\n")
				.replaceAll("\n", newline);
			const digestField = `\t\t...(PACKAGE_DIGEST ? { packageDigest: PACKAGE_DIGEST } : {}),${newline}`;
			expect(entry.split(digestField)).toHaveLength(2);
			const missingDigest = entry.replace(digestField, "");
			expect(missingDigest).not.toContain("packageDigest: PACKAGE_DIGEST");
			await writeFile(entryPath, missingDigest);

			const summary = await validatePluginRelease(root, {
				mode: "runtime",
				runtimeTimeoutMs: 5_000,
			});
			expect(summary.valid).toBe(false);
			expect(summary.errors.join("\n")).toMatch(/package digest mismatch/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("starts offline references and records handshake, tool, and provider evidence", async () => {
		const summary = await validatePluginRelease(examplesRoot, {
			mode: "ga",
			runtimeTimeoutMs: 8_000,
		});
		expect(summary.errors).toEqual([]);
		expect(summary.valid).toBe(true);
		expect(summary.mode).toBe("ga");
		expect(summary.packageCount).toBe(10);
		expect(summary.matrixCombinationCount).toBe(60);

		const providerSettings = summary.packages.find(
			(item) => item.pluginId === "com.example.provider-settings.reference",
		);
		expect(providerSettings?.runtime).toMatchObject({
			status: "passed",
			handshake: { hello: true, initialize: true, activate: true, health: true, generation: 1 },
			providerSettingsAction: {
				contributionId: "settings",
				settingsReads: 1,
				text: "provider-settings-reference:reference:disabled:3",
			},
		});
		expect(providerSettings?.runtime.provider).toBeUndefined();
		expect(providerSettings?.runtime.toolInvoke).toBeUndefined();

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

	test.each([
		{
			name: "unbound settings reference",
			from: "const snapshot = await hostGet(params.reference);",
			to: 'const snapshot = await hostGet("00000000-0000-4000-8000-000000000000");',
			error: /Provider settings read was denied/,
		},
		{
			name: "fabricated settings without a host read",
			from: "const snapshot = await hostGet(params.reference);",
			to: "const snapshot = { values: {} };",
			error: /did not read its bound public settings/,
		},
		{
			name: "invalid action response",
			from: "text: `provider-settings-reference:",
			to: "text: 42, ignored: `provider-settings-reference:",
			error: /expected string/,
		},
	])("rejects a real provider-settings action with $name", async ({ from, to, error }) => {
		const root = await mkdtemp(join(tmpdir(), "narrafork-settings-release-reject-"));
		try {
			const packageRoot = join(root, "provider-settings-reference");
			await cp(join(examplesRoot, "provider-settings-reference"), packageRoot, { recursive: true });
			const entryPath = join(packageRoot, "server/index.js");
			const entry = await readFile(entryPath, "utf8");
			expect(entry.split(from)).toHaveLength(2);
			await writeFile(entryPath, entry.replace(from, to));
			const summary = await validatePluginRelease(root, { mode: "ga", runtimeTimeoutMs: 5_000 });
			expect(summary.valid).toBe(false);
			expect(summary.packages[0]?.runtime.status).toBe("failed");
			expect(summary.errors.join("\n")).toMatch(error);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
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
