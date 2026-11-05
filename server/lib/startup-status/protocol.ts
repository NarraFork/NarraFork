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
	| {
			type: "listen";
			target: StatusListenTarget;
			snapshot: StartupSnapshot;
			/** A browser is being opened on the page, so a failure is worth waiting to show. */
			viewerExpected: boolean;
	  }
	| { type: "update"; snapshot: StartupSnapshot };

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

export function isLoopbackAddress(address: string | undefined): boolean {
	return !!address && /^(?:127\.|::1$|::ffff:127\.)/.test(address);
}
