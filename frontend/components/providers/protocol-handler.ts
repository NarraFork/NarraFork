/**
 * `web+narrafork` link handler: registration and an end-to-end self-test.
 *
 * Browsers expose no way to ask whether a handler is registered (the old
 * `isProtocolHandlerRegistered` was never shipped / was removed as a
 * fingerprinting vector), and registration itself reports nothing back. So the
 * import page opens a self-test link: if the handler is in place, the browser
 * opens this NarraFork's import page in a new tab, which answers over a
 * BroadcastChannel and closes itself.
 *
 * Outcomes:
 * - `ok`: the handler opened this NarraFork and the link reached it intact.
 * - `no-payload`: this NarraFork's import page opened during the test but without
 *   the link, i.e. the browser does not substitute into the `#link=%s` fragment.
 * - `no-response`: nothing answered: not registered, declined in the browser
 *   prompt, removed in browser settings, or owned by another NarraFork address.
 *
 * Results are a per-browser convenience in localStorage; every access tolerates
 * storage being unavailable.
 */

import {
	buildSelfTestLink,
	IMPORT_LINK_SCHEME,
	PROVIDER_IMPORT_PAGE_PATH,
} from "@shared/provider-import";

const CHANNEL_NAME = "narrafork-protocol-selftest";
const PENDING_KEY = "narrafork_protocol_selftest_pending";
const RESULT_KEY = "narrafork_protocol_selftest_result";
/** A fresh tab has to load the app and pass the settings gate before it can answer. */
export const PROTOCOL_SELFTEST_TIMEOUT_MS = 15_000;

export type ProtocolSelfTestOutcome = "ok" | "no-payload" | "no-response" | "unsupported";

export interface ProtocolSelfTestResult {
	outcome: ProtocolSelfTestOutcome;
	/** Epoch ms of the test. */
	at: number;
}

interface PendingSelfTest {
	nonce: string;
	expiresAt: number;
}

interface SelfTestMessage {
	nonce: string;
	outcome: "ok" | "no-payload";
}

function readJson<T>(key: string): T | null {
	try {
		const raw = window.localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage blocked: the test still works, it just is not remembered.
	}
}

/** Ask the browser to route `web+narrafork:` links to this NarraFork. Throws when refused. */
export function registerProtocolHandler(): void {
	navigator.registerProtocolHandler(
		IMPORT_LINK_SCHEME,
		`${window.location.origin}${PROVIDER_IMPORT_PAGE_PATH}#link=%s`,
	);
}

export function readLastSelfTest(): ProtocolSelfTestResult | null {
	return readJson<ProtocolSelfTestResult>(RESULT_KEY);
}

function newNonce(): string {
	return typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
				b.toString(16).padStart(2, "0"),
			).join("");
}

/**
 * Open a self-test link and wait for this NarraFork's import page to answer.
 * Must be called from a click handler: browsers only allow popups on a user gesture.
 */
export function runProtocolSelfTest(): Promise<ProtocolSelfTestResult> {
	const finish = (outcome: ProtocolSelfTestOutcome): ProtocolSelfTestResult => {
		const result = { outcome, at: Date.now() };
		if (outcome !== "unsupported") writeJson(RESULT_KEY, result);
		return result;
	};
	if (typeof BroadcastChannel === "undefined" || !("registerProtocolHandler" in navigator)) {
		return Promise.resolve(finish("unsupported"));
	}

	const nonce = newNonce();
	writeJson(PENDING_KEY, { nonce, expiresAt: Date.now() + PROTOCOL_SELFTEST_TIMEOUT_MS });
	const channel = new BroadcastChannel(CHANNEL_NAME);
	// Without a handler the browser may leave a blank tab behind; keep its handle to close it.
	const opened = window.open(buildSelfTestLink(nonce), "_blank");

	return new Promise((resolve) => {
		const done = (outcome: ProtocolSelfTestOutcome) => {
			clearTimeout(timer);
			channel.close();
			writeJson(PENDING_KEY, null);
			try {
				opened?.close();
			} catch {}
			resolve(finish(outcome));
		};
		const timer = setTimeout(() => done("no-response"), PROTOCOL_SELFTEST_TIMEOUT_MS);
		channel.onmessage = (event: MessageEvent<SelfTestMessage>) => {
			if (event.data?.nonce === nonce) done(event.data.outcome);
		};
	});
}

/**
 * Called once by the import page on load. Answers a pending self-test and
 * reports whether this visit was one, so the page shows a short notice instead
 * of trying to import anything.
 *
 * `nonce` is what the page's URL carried. A visit without one while a test is
 * pending is the handler firing without its payload.
 */
export function answerProtocolSelfTest(nonce: string | null): boolean {
	const pending = readJson<PendingSelfTest>(PENDING_KEY);
	if (!pending || pending.expiresAt < Date.now()) return false;
	if (nonce && nonce !== pending.nonce) return false;
	if (typeof BroadcastChannel === "undefined") return false;
	const channel = new BroadcastChannel(CHANNEL_NAME);
	const message: SelfTestMessage = { nonce: pending.nonce, outcome: nonce ? "ok" : "no-payload" };
	channel.postMessage(message);
	channel.close();
	// Only closes tabs a script opened, which a self-test tab is.
	window.close();
	return true;
}
