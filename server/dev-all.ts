/**
 * Owns only the children it starts. Source development keeps hot reload; production
 * launches a frozen local runtime, optionally beside the source Vite frontend.
 */

import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type Subprocess, spawn } from "bun";
import { devAllBackendEnv } from "./lib/dev-app-url";

export interface LaunchOptions {
	production: boolean;
	frontendDev: boolean;
	cold: boolean;
	runtime?: string;
	serverArgs: string[];
}

export function parseLaunchOptions(args: string[]): LaunchOptions {
	const options: LaunchOptions = {
		production: false,
		frontendDev: false,
		cold: false,
		serverArgs: [],
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--production") options.production = true;
		else if (arg === "--frontend-dev") options.frontendDev = true;
		else if (arg === "--cold") options.cold = true;
		else if (arg === "--runtime" || arg.startsWith("--runtime=")) {
			const path = arg === "--runtime" ? args[++index] : arg.slice("--runtime=".length);
			if (!path || path.startsWith("--")) throw new Error("--runtime needs an executable path");
			options.runtime = resolve(path);
		} else options.serverArgs.push(arg);
	}
	if (!options.production && (options.runtime || options.frontendDev))
		throw new Error("--runtime and --frontend-dev require --production");
	return options;
}

type Child = Pick<Subprocess, "pid" | "exitCode" | "exited" | "kill">;
interface LaunchDependencies {
	spawnChild(command: string[], env: NodeJS.ProcessEnv): Child;
	build(options: { frontend: boolean; signal?: AbortSignal }): Promise<{ executable: string }>;
	stopChild(child: Child): Promise<void>;
}

async function stopChild(child: Child): Promise<void> {
	if (child.exitCode !== null) return;
	// Only owned children. The backend owns its graceful-shutdown budgets; do not
	// cut them short with a second, smaller watchdog in the launcher.
	if (process.platform === "win32") {
		const taskkill = spawn(["taskkill", "/T", "/F", "/PID", String(child.pid)], {
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: true,
			timeout: 5_000,
		});
		await taskkill.exited;
	} else child.kill("SIGTERM");
	await child.exited;
}

const dependencies: LaunchDependencies = {
	spawnChild: (command, env) => spawn(command, { stdio: ["inherit", "inherit", "inherit"], env }),
	build: async (options) => (await import("../scripts/build-runtime")).buildRuntime(options),
	stopChild,
};

/** Dependencies are injected by tests; normal launches always use the real build and processes. */
export async function runDevAll(
	options: LaunchOptions,
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
	deps: LaunchDependencies = dependencies,
): Promise<number> {
	const children: Child[] = [];
	let stopping: Promise<void> | undefined;
	const stopAll = () =>
		(stopping ??= Promise.all(children.map((child) => deps.stopChild(child))).then(() => {}));
	const onAbort = () => {
		void stopAll().catch(() => {});
	};
	const start = (command: string[], childEnv: NodeJS.ProcessEnv) => {
		signal?.throwIfAborted();
		const child = deps.spawnChild(command, childEnv);
		children.push(child);
		return child;
	};
	signal?.throwIfAborted();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		let runtime = options.runtime;
		if (options.production) {
			if (runtime) {
				runtime = await realpath(runtime);
				if (!(await stat(runtime)).isFile())
					throw new Error("--runtime must name an executable file");
			} else {
				({ executable: runtime } = await deps.build({
					frontend: !options.frontendDev,
					signal,
				}));
				signal?.throwIfAborted();
				console.log(`Runtime ready: ${runtime}\nReuse with: --runtime=${JSON.stringify(runtime)}`);
			}
		} else {
			const migration = start([process.execPath, "run", "db:migrate"], { ...env });
			const code = await migration.exited;
			signal?.throwIfAborted();
			if (code !== 0) return code;
		}
		signal?.throwIfAborted();
		const backendEnv = options.production
			? { ...env, NODE_ENV: "production" }
			: devAllBackendEnv(env);
		if (options.production && options.frontendDev)
			backendEnv.NF_SQL_TRACE = env.NF_SQL_TRACE || "summary";
		const backendCommand = options.production
			? [runtime as string, "--serve", ...options.serverArgs]
			: [
					process.execPath,
					...(options.cold ? [] : ["run", "--hot"]),
					"server/index.ts",
					...options.serverArgs,
				];
		const backend = start(backendCommand, backendEnv);
		const running: Child[] = [backend];
		if (!options.production || options.frontendDev) {
			const frontendEnv = options.production
				? { ...env, VITE_PORT: env.VITE_PORT || "41221", BACKEND_PORT: env.PORT || "7778" }
				: { ...env };
			running.push(
				start(
					[
						process.execPath,
						"x",
						"vite",
						"--config",
						"frontend/vite.config.ts",
						...(options.production ? ["--mode", "production"] : []),
					],
					frontendEnv,
				),
			);
		}
		return await Promise.race(running.map((child) => child.exited));
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await stopAll();
	}
}

if (import.meta.main) {
	const controller = new AbortController();
	let signalCode = 0;
	const interrupt = () => {
		signalCode = 130;
		controller.abort();
	};
	const terminate = () => {
		signalCode = 143;
		controller.abort();
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	try {
		process.exitCode = await runDevAll(
			parseLaunchOptions(process.argv.slice(2)),
			process.env,
			controller.signal,
		);
	} catch (error) {
		if (!controller.signal.aborted)
			console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = signalCode || 1;
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", terminate);
		if (signalCode) process.exitCode = signalCode;
	}
}
