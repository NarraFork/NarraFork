/**
 * The server path of `server/index.ts`: show a status page while starting, start, and when that
 * fails, say why in one place instead of from wherever it went wrong.
 *
 * Only modules that cannot fail are imported statically. Settings are read on import, so they
 * are loaded inside the `try` below, where an unreadable settings.json becomes a startup problem
 * like any other.
 */

import { resolveBranding } from "../shared/branding";
import { urlHost } from "../shared/server-host";
import { STARTUP_PAGE_LOG } from "../shared/startup-status";
import { hotOnce } from "./lib/hot-safe";
import { logger } from "./lib/logger";
import { resolveManagerListenHost } from "./lib/manager-control-server";
import { readManagerToken } from "./lib/manager-token";
import { resolveListenHost } from "./lib/net/listen-host";
import { isCompiledRuntime } from "./lib/runtime-target";
import {
	closeStartupStatus,
	expectStartupViewer,
	showStartupProblem,
	startStartupStatus,
} from "./lib/startup-status";
import type { StatusListenTarget } from "./lib/startup-status/protocol";
import { formatStartupProblem, toStartupProblem } from "./lib/startup-status/startup-error";
import { InstanceLockedError } from "./lib/startup-status/startup-problems";
import { APP_VERSION } from "./lib/version";
import { initWindowsChildJob } from "./lib/windows-child-job";

type Settings = typeof import("./lib/settings").settings;

export async function serve(): Promise<void> {
	// `bun --hot` re-runs this inside a process that already serves the port. There a failed
	// re-evaluation should leave the process waiting for the next save, as it always has, so
	// only the first evaluation shows the page and owns the exit.
	const firstStart = hotOnce("narrafork.startupStatusPage");
	let settings: Settings | undefined;
	let statusPageListening = false;
	try {
		// Before anything below spawns a child: membership is inherited at CreateProcess time, so
		// every child and grandchild born after this lands in the job (see windows-child-job).
		initWindowsChildJob();
		({ settings } = await import("./lib/settings"));
		if (firstStart) statusPageListening = await showStatusPage(settings);
		await import("./main");
	} catch (error) {
		if (!firstStart) throw error;
		if (
			settings &&
			error instanceof InstanceLockedError &&
			(await openRunning(settings, statusPageListening))
		) {
			process.exit(0);
		}
		await exitWithStartupProblem(error);
	}
}

/**
 * Starting the app a second time is how people get back to it, so when the instance holding the
 * lock answers on the configured address, open that instead of reporting a conflict.
 *
 * Only for the compiled app run by a person: someone running from source wants to know a second
 * server did not start, and the Windows manager handles a lock conflict itself (it waits for the
 * holder to exit, then retries), which needs the conflict reported, not a quiet exit 0.
 */
async function openRunning(settings: Settings, statusPageListening: boolean): Promise<boolean> {
	if (!isCompiledRuntime() || process.env.NARRAFORK_MANAGER_MANAGED === "1") return false;
	// Our own status page holds the configured address, so the holder is elsewhere. Keep the page:
	// it is where an open browser reads why this start failed.
	if (statusPageListening) return false;
	const target = await listenTarget(settings);
	const origin = `${target.tls ? "https" : "http"}://${urlHost(target.hostname)}:${target.port}`;
	try {
		const response = await fetch(`${origin}/api/health`, {
			signal: AbortSignal.timeout(2_000),
			proxy: false,
			tls: { rejectUnauthorized: false },
		} as BunFetchRequestInit);
		if (!isNarraForkHealth(await response.json())) return false;
	} catch {
		return false;
	}
	logger.info("NarraFork is already running; opening it", { url: origin });
	const { openFrontendOnce } = await import("./lib/open-frontend");
	openFrontendOnce(origin, { explicit: true });
	return true;
}

/**
 * Whether a `/api/health` body is NarraFork's (`server/app.ts`), not another program's that also
 * reports a version: the port may well be taken by something else, which is why a running
 * NarraFork can be on a fallback port in the first place.
 */
export function isNarraForkHealth(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	const health = body as Record<string, unknown>;
	return (
		typeof health.version === "string" &&
		typeof health.gitAvailable === "boolean" &&
		["windows", "macos", "linux"].includes(health.platform as string) &&
		!!health.runtimeEnvironment &&
		typeof health.runtimeEnvironment === "object"
	);
}

/** Print why startup failed, let an open status page show it, and exit. */
export async function exitWithStartupProblem(error: unknown): Promise<never> {
	const problem = toStartupProblem(error);
	logger.error("NarraFork could not start", { problem });
	console.error(`\n${formatStartupProblem(problem)}\n`);
	await showStartupProblem(problem);
	await closeStartupStatus();
	process.exit(1);
}

/** Resolves to whether the page is listening on the configured address. */
async function showStatusPage(settings: Settings): Promise<boolean> {
	const target = await listenTarget(settings);
	const { name: brandName } = resolveBranding(settings.branding);
	if (!(await startStartupStatus(target, { version: APP_VERSION, brandName }))) return false;
	// dev:all serves the app from Vite; that origin is opened once the API is up.
	if (process.env.NARRAFORK_DEV_APP_URL) return true;
	const url = `${target.tls ? "https" : "http"}://${urlHost(target.hostname)}:${target.port}`;
	// The Windows manager opens the browser itself when it reads this line.
	logger.info(`${STARTUP_PAGE_LOG} ${url}`);
	const { openFrontendOnce } = await import("./lib/open-frontend");
	if (openFrontendOnce(url)) expectStartupViewer();
	return true;
}

/**
 * The address the real server will use (same flags, env and settings as `main.ts`), so the page
 * the browser opened keeps working after the server takes over.
 */
async function listenTarget(settings: Settings): Promise<StatusListenTarget> {
	const flag = (name: string) =>
		process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
	const host = flag("host") || process.env.HOST || settings.server.host;
	const tls = settings.server.tls;
	return {
		hostname: await resolveManagerListenHost(resolveListenHost(host), readManagerToken()),
		port: Number(flag("port")) || Number(process.env.PORT) || settings.server.port,
		tls: tls?.enabled && tls.certFile && tls.keyFile ? tls : undefined,
	};
}
