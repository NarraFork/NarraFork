import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLaunchOptions, runDevAll } from "../../server/dev-all";

type Dependencies = NonNullable<Parameters<typeof runDevAll>[3]>;
type Child = ReturnType<Dependencies["spawnChild"]>;

function child(pid: number) {
	const done = Promise.withResolvers<number>();
	const process = {
		pid,
		exitCode: null as number | null,
		exited: done.promise,
		kill: () => finish(143),
	};
	function finish(code: number) {
		process.exitCode = code;
		done.resolve(code);
	}
	return { process: process as Child, finish };
}

function harness() {
	const calls: Array<{ command: string[]; env: NodeJS.ProcessEnv }> = [];
	const children: ReturnType<typeof child>[] = [];
	const builds: Array<{ frontend: boolean; signal?: AbortSignal }> = [];
	const stopped: number[] = [];
	const backendStarted = Promise.withResolvers<void>();
	const deps: Dependencies = {
		build: async (options) => {
			builds.push(options);
			return { executable: "/frozen/narrafork" };
		},
		spawnChild: (command, env) => {
			calls.push({ command, env });
			const current = child(1000 + children.length);
			children.push(current);
			if (command.includes("db:migrate")) current.finish(0);
			else backendStarted.resolve();
			return current.process;
		},
		stopChild: async (process) => {
			if (process.exitCode !== null) return;
			stopped.push(process.pid);
			children.find((current) => current.process === process)?.finish(143);
			await process.exited;
		},
	};
	return { calls, children, builds, stopped, backendStarted, deps };
}

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("launch arguments", () => {
	test("keeps development defaults and forwards server flags", () => {
		expect(parseLaunchOptions(["--cold", "--no-auto-resume"])).toEqual({
			production: false,
			frontendDev: false,
			cold: true,
			serverArgs: ["--no-auto-resume"],
		});
	});
	test("accepts an explicit reusable artifact with either path syntax", () => {
		for (const args of [["--runtime", "./artifact"], ["--runtime=./artifact"]])
			expect(parseLaunchOptions(["--production", ...args]).runtime).toBe(resolve("artifact"));
		expect(() => parseLaunchOptions(["--production", "--runtime"])).toThrow("executable path");
		expect(() => parseLaunchOptions(["--production", "--runtime="])).toThrow("executable path");
		expect(() => parseLaunchOptions(["--runtime=artifact"])).toThrow("require --production");
	});
});

describe("owned process lifecycle", () => {
	test("production builds before launch, never runs source migrations or Vite", async () => {
		const h = harness();
		const run = runDevAll(
			parseLaunchOptions(["--production", "--no-auto-resume"]),
			{},
			undefined,
			h.deps,
		);
		await h.backendStarted.promise;
		expect(h.builds).toHaveLength(1);
		expect(h.builds[0].frontend).toBe(true);
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]).toEqual({
			command: ["/frozen/narrafork", "--serve", "--no-auto-resume"],
			env: { NODE_ENV: "production" },
		});
		h.children[0].finish(7);
		expect(await run).toBe(7);
	});

	test("hybrid mode keeps Vite ports and trace defaults; frontend exit stops only its backend", async () => {
		const h = harness();
		const run = runDevAll(
			parseLaunchOptions(["--production", "--frontend-dev"]),
			{},
			undefined,
			h.deps,
		);
		await h.backendStarted.promise;
		expect(h.builds[0].frontend).toBe(false);
		expect(h.calls).toHaveLength(2);
		expect(h.calls[0].env).toMatchObject({ NODE_ENV: "production", NF_SQL_TRACE: "summary" });
		expect(h.calls[0].env.PORT).toBeUndefined();
		expect(h.calls[1].env).toMatchObject({ VITE_PORT: "41221", BACKEND_PORT: "7778" });
		expect(h.calls[1].command.slice(-2)).toEqual(["--mode", "production"]);
		h.children[1].finish(3);
		expect(await run).toBe(3);
		expect(h.stopped).toEqual([h.children[0].process.pid]);
	});

	test("source development still migrates and hot reloads on its existing ports", async () => {
		const h = harness();
		const run = runDevAll(parseLaunchOptions([]), {}, undefined, h.deps);
		await h.backendStarted.promise;
		expect(h.builds).toHaveLength(0);
		expect(h.calls[0].command).toEqual([process.execPath, "run", "db:migrate"]);
		expect(h.calls[1].command).toEqual([process.execPath, "run", "--hot", "server/index.ts"]);
		expect(h.calls[1].env).toMatchObject({
			PORT: "7779",
			NARRAFORK_DEV_APP_URL: "http://localhost:7778",
		});
		h.children[1].finish(0);
		expect(await run).toBe(0);
		expect(h.stopped).toEqual([h.children[2].process.pid]);
	});

	test("reusing an explicit artifact skips the compiler", async () => {
		const directory = await mkdtemp(join(tmpdir(), "nf-launch-"));
		temporary.push(directory);
		const artifact = join(directory, "narrafork");
		await writeFile(artifact, "fixture executable");
		const h = harness();
		const run = runDevAll(
			parseLaunchOptions(["--production", `--runtime=${artifact}`]),
			{},
			undefined,
			h.deps,
		);
		await h.backendStarted.promise;
		expect(h.builds).toHaveLength(0);
		expect(h.calls[0].command[0]).toBe(artifact);
		h.children[0].finish(0);
		await run;
	});

	test("a missing reusable artifact fails without building or starting anything", async () => {
		const h = harness();
		await expect(
			runDevAll(
				parseLaunchOptions(["--production", "--runtime=/missing/nf-artifact"]),
				{},
				undefined,
				h.deps,
			),
		).rejects.toThrow();
		expect(h.calls).toHaveLength(0);
		expect(h.builds).toHaveLength(0);
	});

	test("build failure cannot fall back to source, old artifacts or source migrations", async () => {
		const h = harness();
		h.deps.build = async () => {
			throw new Error("compile failed");
		};
		await expect(
			runDevAll(parseLaunchOptions(["--production"]), {}, undefined, h.deps),
		).rejects.toThrow("compile failed");
		expect(h.calls).toHaveLength(0);
		expect(h.stopped).toHaveLength(0);
	});

	test("cancellation during build cannot launch a late successful artifact", async () => {
		const h = harness();
		const controller = new AbortController();
		h.deps.build = async ({ signal }) => {
			expect(signal).toBe(controller.signal);
			controller.abort(new Error("cancel build"));
			return { executable: "/late/artifact" };
		};
		await expect(
			runDevAll(parseLaunchOptions(["--production"]), {}, controller.signal, h.deps),
		).rejects.toThrow("cancel build");
		expect(h.calls).toHaveLength(0);
	});

	test("frontend creation failure cleans up the backend it just created", async () => {
		const h = harness();
		const start = h.deps.spawnChild;
		h.deps.spawnChild = (command, env) => {
			if (command.includes("vite")) throw new Error("frontend spawn failed");
			return start(command, env);
		};
		await expect(
			runDevAll(parseLaunchOptions(["--production", "--frontend-dev"]), {}, undefined, h.deps),
		).rejects.toThrow("frontend spawn failed");
		expect(h.stopped).toEqual([h.children[0].process.pid]);
	});

	test("cancellation of a running pair stops only both owned children", async () => {
		const h = harness();
		const controller = new AbortController();
		const run = runDevAll(
			parseLaunchOptions(["--production", "--frontend-dev"]),
			{},
			controller.signal,
			h.deps,
		);
		await h.backendStarted.promise;
		controller.abort();
		await run;
		expect(h.stopped).toEqual(h.children.map((current) => current.process.pid));
	});
});
