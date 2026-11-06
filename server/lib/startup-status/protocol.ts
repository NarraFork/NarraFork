/**
 * Messages between the startup thread (the one evaluating `./main`) and the status-page worker.
 *
 * Kept dependency-free: the worker imports it, and the worker must stay small.
 */

/** What startup is doing. The page words it in the browser's language. */
export type StartupStep =
	| { key: "starting" }
	| { key: "database" }
	| { key: "migrating"; current: number; total: number };

/** Something a person must do before NarraFork can start. */
export interface StartupProblem {
	message: { en: string; zh: string };
	/** A command to copy into a terminal, when one fixes it. */
	command?: string;
	/** The underlying error, collapsed on the page, for bug reports. */
	detail?: string;
}

export interface StartupSnapshot {
	version: string;
	step: StartupStep;
	/** When `step` began, epoch ms. */
	stepStartedAt: number;
	/** Set once startup gave up; the process exits shortly after. */
	problem?: StartupProblem;
}

export interface StatusListenTarget {
	hostname: string;
	port: number;
	tls?: { certFile: string; keyFile: string; passphrase?: string; caFile?: string };
}

export type ToStatusWorker =
	| { type: "listen"; target: StatusListenTarget; snapshot: StartupSnapshot; brandName: string }
	| { type: "update"; snapshot: StartupSnapshot }
	/** A browser is being opened on the page, so a failure is worth waiting to show. */
	| { type: "expect-viewer" };

export type FromStatusWorker =
	| { type: "listening" }
	| { type: "unavailable"; error: string }
	/** A page has read `snapshot.problem`, or there is no page to read it: exiting hides nothing. */
	| { type: "problem-shown" };

/**
 * What a browser may see. The command and the error detail name pids and local paths, so only a
 * browser on the server itself gets them.
 */
export function snapshotForViewer(snapshot: StartupSnapshot, local: boolean): StartupSnapshot {
	if (local || !snapshot.problem) return snapshot;
	return { ...snapshot, problem: { message: snapshot.problem.message } };
}

const FORWARDING_HEADERS = ["forwarded", "x-forwarded-for", "x-real-ip"];

/**
 * Whether the browser runs on the server itself. A reverse proxy or code-server on the same
 * machine also connects from loopback, so a request that carries a forwarding header counts as
 * remote: it came from wherever the proxy's client is. The startup page has no settings to say
 * which proxies to trust, and the main server only trusts loopback by default anyway.
 */
export function isLocalViewer(peerAddress: string | undefined, headers: Headers): boolean {
	if (!peerAddress || !/^(?:127\.|::1$|::ffff:127\.)/.test(peerAddress)) return false;
	return !FORWARDING_HEADERS.some((name) => headers.has(name));
}
