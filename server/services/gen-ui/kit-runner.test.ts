import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { LocalBackend } from "@server/lib/agent/execution/local-backend";
import {
	kitBuildCommand,
	probeKitRunner,
	quoteKitArgument,
	readKitRunnerSignals,
} from "./kit-runner";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const signal = new AbortController().signal;
const authorize = async (path: string) => path;
async function fixture(files: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), "kit-runner-"));
	roots.push(root);
	for (const [name, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, name)), { recursive: true });
		await writeFile(join(root, name), contents);
	}
	return { root, backend: new LocalBackend() };
}

test("packageManager outranks a nearer lockfile and intermediate workspaces are inspected", async () => {
	const { root, backend } = await fixture({
		"packages/package.json": '{"packageManager":"pnpm@10.0.0"}',
		"packages/app/bun.lock": "",
	});
	const result = await readKitRunnerSignals(
		backend,
		join(root, "packages/app"),
		root,
		authorize,
		signal,
	);
	expect(result.manager).toBe("pnpm");
	expect(result.basis).toContain("packageManager");
	expect(result.diagnostics?.[0]).toContain("Runner conflict");
	expect(result.diagnostics?.[0]).toContain("bun.lock");
	const reports: string[] = [];
	await kitBuildCommand(backend, result, "config.mjs", authorize, signal, true, (message) =>
		reports.push(message),
	);
	expect(reports[0]).toContain("selected by packageManager");
	expect(reports[0]).toContain("Runner conflict");
	expect(result.directories).toHaveLength(3);
	expect(result.fingerprint).toContain("pnpm@10.0.0");
	await writeFile(join(root, "packages/package.json"), '{"packageManager":"yarn@4.0.0"}');
	expect(
		(await readKitRunnerSignals(backend, join(root, "packages/app"), root, authorize, signal))
			.fingerprint,
	).not.toBe(result.fingerprint);
});

test("lockfiles select runner; missing signals do not assume npm", async () => {
	const { root, backend } = await fixture({ "pnpm-lock.yaml": "" });
	expect((await readKitRunnerSignals(backend, root, root, authorize, signal)).manager).toBe("pnpm");
	await rm(join(root, "pnpm-lock.yaml"));
	expect(
		(await readKitRunnerSignals(backend, root, root, authorize, signal)).manager,
	).toBeUndefined();
});

test("rejects unsafe package managers, oversized reads and outside roots", async () => {
	const { root, backend } = await fixture({
		"package.json": '{"packageManager":"bun; touch bad"}',
	});
	await expect(readKitRunnerSignals(backend, root, root, authorize, signal)).rejects.toThrow(
		"Unsupported packageManager",
	);
	await writeFile(join(root, "package.json"), " ".repeat(65_537));
	await expect(readKitRunnerSignals(backend, root, root, authorize, signal)).rejects.toThrow(
		"limit",
	);
	await expect(
		readKitRunnerSignals(backend, dirname(root), root, authorize, signal),
	).rejects.toThrow("inside");
});

test("inspection honors file authorization before reading", async () => {
	const { root, backend } = await fixture({ "package.json": "{}" });
	const read = spyOn(backend, "readFileBytes");
	await expect(
		readKitRunnerSignals(
			backend,
			root,
			root,
			async () => {
				throw new Error("denied");
			},
			signal,
		),
	).rejects.toThrow("denied");
	expect(read).not.toHaveBeenCalled();
	read.mockRestore();
});

function probes(backend: LocalBackend, installed: string[]) {
	return spyOn(backend, "execCommand").mockImplementation(
		async (params) =>
			({
				exited: Promise.resolve(installed.includes(params.command.split(" ")[0]) ? 0 : 127),
				onData: () => () => {},
				kill: async () => {},
			}) as unknown as Awaited<ReturnType<ExecutionBackend["execCommand"]>>,
	);
}

test("probes the execution backend, prefers Bun and never falls back from explicit runner", async () => {
	const { root, backend } = await fixture({ "node_modules/vite/bin/vite.js": "" });
	const probe = probes(backend, ["bun", "npm"]);
	const info = { directories: [root], fingerprint: "" };
	expect(await kitBuildCommand(backend, info, "config.mjs", authorize, signal)).toStartWith(
		"bun --bun ",
	);
	expect(probe).toHaveBeenCalledTimes(1);
	await expect(
		kitBuildCommand(backend, { ...info, manager: "pnpm" }, "config.mjs", authorize, signal),
	).rejects.toThrow("requires pnpm");
	expect(probe).toHaveBeenCalledTimes(2);
	probe.mockRestore();
});

test("no-signal fallback uses the device probe and other managers execute only the local CLI", async () => {
	const { root, backend } = await fixture({ "node_modules/vite/bin/vite.js": "" });
	const probe = probes(backend, ["npm"]);
	const info = { directories: [root], fingerprint: "" };
	expect(await kitBuildCommand(backend, info, "config.mjs", authorize, signal)).toStartWith(
		"npm exec --offline --no -- node ",
	);
	expect(probe).toHaveBeenCalledTimes(2);
	probe.mockRestore();
	for (const manager of ["pnpm", "yarn", "npm"] as const) {
		const command = await kitBuildCommand(
			backend,
			{ ...info, manager },
			"config.mjs",
			authorize,
			signal,
			true,
		);
		expect(command).toContain("node_modules/vite/bin/vite.js");
		expect(command).not.toContain("dlx");
		expect(command).not.toContain("bunx");
		expect(command).not.toContain("npx");
	}
});

test("missing local Vite fails before any installer; injected build seam still works", async () => {
	const { root, backend } = await fixture();
	const probe = probes(backend, ["bun"]);
	const info = { directories: [root], fingerprint: "" };
	await expect(kitBuildCommand(backend, info, "config.mjs", authorize, signal)).rejects.toThrow(
		"not installed locally",
	);
	probe.mockClear();
	expect(await kitBuildCommand(backend, info, "config.mjs", authorize, signal, true)).toStartWith(
		"bun --bun ",
	);
	expect(probe).not.toHaveBeenCalled();
	probe.mockRestore();
});

test("missing optional signals and child Vite paths are never passed to the production-like authorizer", async () => {
	const { root, backend } = await fixture({ "bun.lock": "", "node_modules/vite/bin/vite.js": "" });
	const strictAuthorize = async (path: string) => {
		if (!(await backend.statFile(path))?.isFile) throw new Error("404 missing file");
		return path;
	};
	const info = await readKitRunnerSignals(
		backend,
		join(root, "apps/web"),
		root,
		strictAuthorize,
		signal,
	);
	expect(info.manager).toBe("bun");
	expect(info.basis).toContain("lockfile");
	const probe = probes(backend, ["bun"]);
	expect(await kitBuildCommand(backend, info, "config.mjs", strictAuthorize, signal)).toContain(
		"node_modules/vite/bin/vite.js",
	);
	probe.mockRestore();
});

for (const failure of ["hang", "reject"] as const) {
	test(`probe deadline does not await ${failure}ing kill or an unsettled exit`, async () => {
		const kill = mock(() =>
			failure === "hang" ? new Promise<void>(() => {}) : Promise.reject(new Error("kill failed")),
		);
		const backend = {
			execCommand: async () => ({ exited: new Promise<number>(() => {}), onData: () => {}, kill }),
		} as unknown as ExecutionBackend;
		expect(
			await probeKitRunner(backend, "bun", "/", signal, { timeoutMs: 10, outputBytes: 10 }),
		).toBe(false);
		expect(kill).toHaveBeenCalledTimes(1);
	}, 1_000);
}

test("probe cancellation rejects even if the backend never exits", async () => {
	const controller = new AbortController();
	const kill = mock(async () => {});
	const backend = {
		execCommand: async () => ({
			exited: new Promise<number>(() => {}),
			onData: () => queueMicrotask(() => controller.abort(new Error("cancelled"))),
			kill,
		}),
	} as unknown as ExecutionBackend;
	await expect(probeKitRunner(backend, "bun", "/", controller.signal)).rejects.toThrow("cancelled");
	expect(kill).toHaveBeenCalledTimes(1);
}, 1_000);

test("probe output cap terminates a noisy runner without waiting for exit", async () => {
	const kill = mock(async () => {});
	const backend = {
		execCommand: async () => ({
			exited: new Promise<number>(() => {}),
			onData: (callback: (bytes: Uint8Array) => void) => callback(new Uint8Array(11)),
			kill,
		}),
	} as unknown as ExecutionBackend;
	expect(
		await probeKitRunner(backend, "bun", "/", signal, { timeoutMs: 500, outputBytes: 10 }),
	).toBe(false);
	expect(kill).toHaveBeenCalledTimes(1);
}, 1_000);

test("probe deadline also covers a backend that never starts", async () => {
	const backend = { execCommand: () => new Promise(() => {}) } as unknown as ExecutionBackend;
	expect(
		await probeKitRunner(backend, "bun", "/", signal, { timeoutMs: 10, outputBytes: 10 }),
	).toBe(false);
}, 1_000);

test("quotes POSIX and PowerShell and rejects cmd expansion characters", () => {
	const backend = (shellType: string) =>
		({ platform: { shellType }, pathFlavor: "windows" }) as ExecutionBackend;
	expect(quoteKitArgument(backend("bash"), "a'$(bad) b")).toBe("'a'\\''$(bad) b'");
	expect(quoteKitArgument(backend("powershell"), "a'$(bad) b")).toBe("'a''$(bad) b'");
	expect(quoteKitArgument(backend("cmd"), "a& b")).toBe('"a& b"');
	expect(() => quoteKitArgument(backend("cmd"), "%PATH%!bad!")).toThrow("safely");
});

test("Bun executes a local Node-shebang CLI without node or npx on PATH", async () => {
	const { root } = await fixture({
		"node_modules/vite/bin/vite.js": '#!/usr/bin/env node\nconsole.log("local-vite-cli")',
	});
	const child = Bun.spawn(
		[process.execPath, "--bun", "--no-install", join(root, "node_modules/vite/bin/vite.js")],
		{
			env: { ...process.env, PATH: "" },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 5_000,
		},
	);
	expect(await child.exited).toBe(0);
	expect(await new Response(child.stdout).text()).toContain("local-vite-cli");
});
