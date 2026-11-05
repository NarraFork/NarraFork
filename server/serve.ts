/**
 * The server path of `server/index.ts`: show a status page while starting, start, and when that
 * fails, say why in one place instead of from wherever it went wrong.
 *
 * Only modules that cannot fail are imported statically. Settings are read on import, so they
 * are loaded inside the `try` below, where an unreadable settings.json becomes a startup problem
 * like any other.
 */

import { urlHost } from "../shared/server-host";
import { STARTUP_PAGE_LOG } from "../shared/startup-status";
import { hotOnce } from "./lib/hot-safe";
import { logger } from "./lib/logger";
import { resolveManagerListenHost } from "./lib/manager-control-server";
import { readManagerToken } from "./lib/manager-token";
import { resolveListenHost } from "./lib/net/listen-host";
import { isCompiledRuntime } from "./lib/runtime-target";
import { closeStartupStatus, showStartupProblem, startStartupStatus } from "./lib/startup-status";
import type { StatusListenTarget } from "./lib/startup-status/protocol";
import { formatStartupProblem, toStartupProblem } from "./lib/startup-status/startup-error";
import { InstanceLockedError } from "./lib/startup-status/startup-problems";
import { APP_VERSION } from "./lib/version";

type Settings = typeof import("./lib/settings").settings;

export async function serve(): Promise<void> {
	let settings: Settings | undefined;
	try {
		({ settings } = await import("./lib/settings"));
		// `bun --hot` re-runs this inside a process that already serves the port.
		if (hotOnce("narrafork.startupStatusPage")) await showStatusPage(settings);
		await import("./main");
	} catch (error) {
		if (settings && error instanceof InstanceLockedError && (await openRunning(settings))) {
			process.exit(0);
		}
		await exitWithStartupProblem(error);
	}
}

/**
 * Starting the app a second time is how people get back to it, so when the instance holding the
 * lock answers on the configured address, open that instead of reporting a conflict. Only for
 * the compiled app: someone running from source wants to know a second server did not start.
 */
async function openRunning(settings: Settings): Promise<boolean> {
	if (!isCompiledRuntime()) return false;
	await closeStartupStatus();
	const target = await listenTarget(settings);
	const origin = `${target.tls ? "https" : "http"}://${urlHost(target.hostname)}:${target.port}`;
	try {
		const response = await fetch(`${origin}/api/health`, {
			signal: AbortSignal.timeout(2_000),
			proxy: false,
			tls: { rejectUnauthorized: false },
		} as BunFetchRequestInit);
		const health = (await response.json()) as { version?: unknown };
		if (typeof health.version !== "string") return false;
	} catch {
		return false;
	}
	logger.info("NarraFork is already running; opening it", { url: origin });
	const { openFrontendOnce } = await import("./lib/open-frontend");
	openFrontendOnce(origin, { explicit: true });
	return true;
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

async function showStatusPage(settings: Settings): Promise<void> {
	// dev:all serves the app from Vite; that origin is opened once the API is up.
	const devApp = !!process.env.NARRAFORK_DEV_APP_URL;
	const target = await listenTarget(settings);
	const listening = await startStartupStatus(target, {
		version: APP_VERSION,
		viewerExpected: !devApp && settings.server.openBrowser !== "off",
	});
	if (!listening || devApp) return;
	const url = `${target.tls ? "https" : "http"}://${urlHost(target.hostname)}:${target.port}`;
	// The Windows manager opens the browser itself when it reads this line.
	logger.info(`${STARTUP_PAGE_LOG} ${url}`);
	const { openFrontendOnce } = await import("./lib/open-frontend");
	openFrontendOnce(url);
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
