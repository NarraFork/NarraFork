/**
 * The server path of `server/index.ts`: show a status page while starting, start, and when that
 * fails, say why in one place instead of from wherever it went wrong.
 */

import { urlHost } from "../shared/server-host";
import { STARTUP_PAGE_LOG } from "../shared/startup-status";
import { hotOnce } from "./lib/hot-safe";
import { logger } from "./lib/logger";
import { resolveManagerListenHost } from "./lib/manager-control-server";
import { readManagerToken } from "./lib/manager-token";
import { resolveListenHost } from "./lib/net/listen-host";
import { openFrontendOnce } from "./lib/open-frontend";
import { settings } from "./lib/settings";
import { closeStartupStatus, showStartupProblem, startStartupStatus } from "./lib/startup-status";
import type { StatusListenTarget } from "./lib/startup-status/protocol";
import { formatStartupProblem, toStartupProblem } from "./lib/startup-status/startup-error";
import { APP_VERSION } from "./lib/version";

export async function serve(): Promise<void> {
	// `bun --hot` re-runs this inside a process that already serves the port.
	if (hotOnce("narrafork.startupStatusPage")) await showStatusPage();
	try {
		await import("./main");
	} catch (error) {
		const problem = toStartupProblem(error);
		logger.error("NarraFork could not start", { problem });
		console.error(`\n${formatStartupProblem(problem)}\n`);
		await showStartupProblem(problem);
		await closeStartupStatus();
		process.exit(1);
	}
}

async function showStatusPage(): Promise<void> {
	// dev:all serves the app from Vite; that origin is opened once the API is up.
	const devApp = !!process.env.NARRAFORK_DEV_APP_URL;
	const target = await listenTarget();
	const listening = await startStartupStatus(target, {
		version: APP_VERSION,
		viewerExpected: !devApp && settings.server.openBrowser !== "off",
	});
	if (!listening || devApp) return;
	const url = `${target.tls ? "https" : "http"}://${urlHost(target.hostname)}:${target.port}`;
	// The Windows manager opens the browser itself when it reads this line.
	logger.info(`${STARTUP_PAGE_LOG} ${url}`);
	openFrontendOnce(url);
}

/**
 * The address the real server will use (same flags, env and settings as `main.ts`), so the page
 * the browser opened keeps working after the server takes over.
 */
async function listenTarget(): Promise<StatusListenTarget> {
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
