import type { Protocol } from "devtools-protocol";
import { type Browser, type CDPSession, CDPSessionEvent } from "puppeteer-core";
import { PROFILE_LIMITS } from "./memory-profile-constants";
import { profileDeadline } from "./memory-profile-io";
import type { BrowserSession } from "./session";
import { acquireTraceLease, definiteTraceStartRejection, type TraceLease } from "./tracing-lease";

// Puppeteer emits a symbol here; its current declaration omits this runtime enum member.
const SESSION_DISCONNECTED = (CDPSessionEvent as unknown as { Disconnected: symbol }).Disconnected;

export interface PerformanceTracingState {
	active: boolean;
	startedAt: number;
	lease: TraceLease;
	browser: Browser;
	client?: CDPSession;
	pending?: Promise<void>;
	stopping?: Promise<Uint8Array | undefined>;
	startSent: boolean;
	startConfirmed: boolean;
	endSent: boolean;
	traceStopped: boolean;
	cancelled: boolean;
	exportController: AbortController;
	completed: Promise<Protocol.Tracing.TracingCompleteEvent>;
	complete: (event: Protocol.Tracing.TracingCompleteEvent) => void;
	stream?: string;
	cleanup?: Promise<void>;
	detaching?: Promise<void>;
	onComplete?: (event: Protocol.Tracing.TracingCompleteEvent) => void;
	onTargetDisconnected?: () => void;
	onBrowserDisconnected?: () => void;
}

function detachTraceClient(state: PerformanceTracingState): Promise<void> {
	const client = state.client;
	if (!client) return Promise.resolve();
	state.detaching ??= Promise.resolve().then(() =>
		profileDeadline(() => client.detach(), PROFILE_LIMITS.cleanupTimeoutMs, "trace_cleanup").catch(
			() => {},
		),
	);
	return state.detaching;
}

/** Only this captured generation may clear its state or detach its dedicated client. */
function cleanupTrace(session: BrowserSession, state: PerformanceTracingState): Promise<void> {
	if (!state.cleanup) {
		state.active = false;
		if (session.tracing === state) session.tracing = undefined;
		state.cleanup = Promise.resolve().then(async () => {
			const client = state.client;
			if (state.onBrowserDisconnected)
				state.browser.off("disconnected", state.onBrowserDisconnected);
			if (!client) return;
			if (state.onComplete) client.off("Tracing.tracingComplete", state.onComplete);
			if (state.onTargetDisconnected) client.off(SESSION_DISCONNECTED, state.onTargetDisconnected);
			if (state.stream) {
				await profileDeadline(
					() => client.send("IO.close", { handle: state.stream as string }),
					PROFILE_LIMITS.cleanupTimeoutMs,
					"trace_cleanup",
				).catch(() => {});
			}
			await detachTraceClient(state);
		});
	}
	return state.cleanup;
}

export async function startPerformanceTrace(
	session: BrowserSession,
	opts: { categories: string[]; screenshots: boolean },
): Promise<void> {
	if (session.memoryDiagnosticsClosed) throw new Error("Browser session is closing");
	if (session.tracing?.active) throw new Error("Tracing is already active on this session");
	const browser = session.page.browser();
	const lease = acquireTraceLease(browser, `perf:${session.id}`);
	let complete!: PerformanceTracingState["complete"];
	const state: PerformanceTracingState = {
		active: true,
		startedAt: Date.now(),
		lease,
		browser,
		startSent: false,
		startConfirmed: false,
		endSent: false,
		traceStopped: false,
		cancelled: false,
		exportController: new AbortController(),
		completed: new Promise((resolve) => {
			complete = resolve;
		}),
		complete,
	};
	// Register before attaching. A closing session must also see an in-flight start.
	session.tracing = state;
	state.onBrowserDisconnected = () => {
		state.cancelled = true;
		state.exportController.abort();
		void cleanupTrace(session, state);
	};
	browser.once("disconnected", state.onBrowserDisconnected);
	state.pending = (async () => {
		const client = await session.page.createCDPSession();
		state.client = client;
		// A late attach cannot resurrect a timed-out/closing/obsolete generation.
		if (state.cancelled || session.memoryDiagnosticsClosed || !lease.isCurrent()) {
			lease.confirmStopped(); // No start was sent by this client.
			await detachTraceClient(state);
			await cleanupTrace(session, state);
			throw new Error("Browser session is closing");
		}
		state.onComplete = (event) => {
			if (!state.startConfirmed || !state.endSent || state.traceStopped || !lease.isCurrent())
				return;
			state.traceStopped = true;
			state.active = false;
			state.stream = event.stream;
			// Evidence of shutdown precedes all artifact I/O, including missing-stream failures.
			lease.confirmStopped();
			// Keep the inactive generation until export cleanup so concurrent finish calls
			// share its result. New starts may replace it because active is already false.
			state.complete(event);
			if (state.cancelled) void cleanupTrace(session, state);
		};
		state.onTargetDisconnected = () => {
			state.cancelled = true;
			state.exportController.abort();
			if (!state.traceStopped) lease.markUncertain();
		};
		client.on("Tracing.tracingComplete", state.onComplete);
		client.on(SESSION_DISCONNECTED, state.onTargetDisconnected);
		const categories = opts.screenshots
			? [...opts.categories, "disabled-by-default-devtools.screenshot"]
			: opts.categories;
		state.startSent = true;
		try {
			await client.send("Tracing.start", {
				transferMode: "ReturnAsStream",
				streamFormat: "json",
				streamCompression: "none",
				traceConfig: {
					recordMode: "recordUntilFull",
					traceBufferSizeInKb: PROFILE_LIMITS.traceBufferKb,
					includedCategories: categories.filter((category) => !category.startsWith("-")),
					excludedCategories: categories
						.filter((category) => category.startsWith("-"))
						.map((category) => category.slice(1)),
				},
			});
		} catch (error) {
			if (definiteTraceStartRejection(error)) {
				lease.confirmStopped();
				await cleanupTrace(session, state);
			} else lease.markUncertain();
			throw error;
		}
		state.startConfirmed = true;
		state.startedAt = Date.now();
	})();
	try {
		await profileDeadline(
			() => state.pending as Promise<void>,
			PROFILE_LIMITS.startTimeoutMs,
			"trace_start",
		);
	} catch {
		state.cancelled = true;
		state.exportController.abort();
		if (!state.startSent) {
			lease.confirmStopped();
			void cleanupTrace(session, state);
		} else if (!state.traceStopped) lease.markUncertain();
		// Handle a late start reply using the captured state, never session.tracing (a new owner).
		void state.pending.then(
			() => {
				if (lease.isCurrent()) void stopTrace(session, state).catch(() => {});
			},
			() => {},
		);
		throw new Error("Performance tracing failed during startup");
	}
}

async function readTrace(state: PerformanceTracingState, stream: string): Promise<Uint8Array> {
	const client = state.client as CDPSession;
	const chunks: Uint8Array[] = [];
	let total = 0;
	const deadline = Date.now() + PROFILE_LIMITS.stopTimeoutMs;
	// Bound both bytes and tiny-chunk CPU/command amplification.
	const maxReads = Math.ceil(PROFILE_LIMITS.traceBytes / PROFILE_LIMITS.traceReadBytes) * 4;
	for (let reads = 0; reads < maxReads; reads++) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Performance trace export timed out");
		const chunk = await profileDeadline(
			() => client.send("IO.read", { handle: stream, size: PROFILE_LIMITS.traceReadBytes }),
			remaining,
			"trace_export",
			state.exportController.signal,
		);
		state.exportController.signal.throwIfAborted();
		if (Buffer.byteLength(chunk.data) > PROFILE_LIMITS.traceReadBytes * 2)
			throw new Error("Performance trace stream limit exceeded");
		const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
		if (
			bytes.length > PROFILE_LIMITS.traceReadBytes ||
			total + bytes.length > PROFILE_LIMITS.traceBytes
		)
			throw new Error("Performance trace stream limit exceeded");
		if (!chunk.eof && !bytes.length) throw new Error("Performance trace stream made no progress");
		chunks.push(bytes);
		total += bytes.length;
		if (chunk.eof) return Buffer.concat(chunks, total);
	}
	throw new Error("Performance trace stream read limit exceeded");
}

/** Stop is generation-bound and idempotent, including closing and late-start recovery. */
function stopTrace(
	session: BrowserSession,
	state: PerformanceTracingState,
): Promise<Uint8Array | undefined> {
	if (!state.stopping) {
		state.stopping = (async () => {
			try {
				await profileDeadline(
					async () => {
						await state.pending;
						if (!state.lease.isCurrent() || !state.startConfirmed) return;
						state.endSent = true;
						const end = (state.client as CDPSession).send("Tracing.end");
						// Completion is the proof, not the command reply. Even a hanging reply
						// cannot turn a confirmed stop into an uncertain lease.
						await Promise.race([state.completed, end.then(() => state.completed)]);
					},
					PROFILE_LIMITS.stopTimeoutMs,
					"trace_stop",
				);
			} catch {
				if (!state.traceStopped) {
					state.cancelled = true;
					state.exportController.abort();
					state.lease.markUncertain();
					// Keep this generation's completion observer for late shutdown evidence.
					throw new Error("Performance tracing could not confirm shutdown");
				}
			}
			if (!state.traceStopped) return undefined;
			try {
				if (state.cancelled) return undefined;
				if (!state.stream) throw new Error("Performance trace export has no stream");
				return await readTrace(state, state.stream);
			} finally {
				await cleanupTrace(session, state);
			}
		})();
	}
	return state.stopping;
}

/** Public interface retains the existing Uint8Array result. */
export async function finishPerformanceTrace(
	session: BrowserSession,
): Promise<Uint8Array | undefined> {
	const state = session.tracing;
	if (!state) return undefined;
	if (session.memoryDiagnosticsClosed) {
		state.cancelled = true;
		state.exportController.abort();
	}
	return stopTrace(session, state);
}
