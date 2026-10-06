/**
 * host-bridge.ts — Session handoff with an editor host that embeds this app.
 *
 * The VS Code extension renders this SPA inside an iframe and keeps the session token in
 * the OS keychain (`vscode-extension/src/token-store.ts`), so reopening a panel resumes
 * the session instead of showing a login form the user already completed. Two messages
 * cross the boundary:
 *
 *   host → app   `narrafork.bootstrap`      { token: string | null }
 *   app  → host  `narrafork.token-changed`  { token: string | null }
 *
 * ═══ SECURITY ═══
 *
 * ⚠️ This is the ONLY place where something outside the app can write a session
 * credential, and the only place that sends one out. Every guard below is load-bearing:
 *
 *  1. **Inert unless embedded.** A top-level document never installs a listener, so an
 *     ordinary browser tab has no such entry point at all.
 *
 *  2. **`nfEmbed` marker required.** The embedder puts a per-load nonce in the URL. It is
 *     NOT a secret and NOT the boundary — it travels in a URL and cannot be verified —
 *     but it means the bridge stays off for a page that merely happens to be framed. It
 *     answers "was I deliberately embedded", not "by whom".
 *
 *  3. **Sender identity is the actual boundary, and it is checked upward.** Only messages
 *     from `window.parent` are considered (`event.source`), and outbound messages go to a
 *     single explicit target origin — never `"*"`, which would hand the token to whatever
 *     occupies the frame.
 *
 *  4. **The parent's origin is pinned on first contact** and every later message must
 *     match it. The parent is a `vscode-webview://…` (desktop) or the editor's own origin
 *     (code-server); neither is knowable in advance, so it cannot be a constant — but
 *     accepting a *changing* origin would defeat the check entirely.
 *
 *  5. **Tokens are shape-validated** before being stored, and are never logged.
 *
 * What an attacker who framed this app would still need: the `nfEmbed` marker AND a token
 * that the backend accepts. Framing alone yields nothing, because the bridge only ever
 * emits a token to the origin that first spoke to it — the frame's own parent — which is
 * a party that could already read the token from the document it hosts.
 */

import { clearToken, getToken, onTokenChange, setToken } from "@frontend/lib/api/client";

/** URL parameter through which the embedder declares itself. */
const EMBED_MARKER_PARAM = "nfEmbed";

const BOOTSTRAP_MESSAGE = "narrafork.bootstrap";
const TOKEN_CHANGED_MESSAGE = "narrafork.token-changed";
const SIGN_OUT_MESSAGE = "narrafork.sign-out";

interface HostMessage {
	type?: unknown;
	token?: unknown;
}

/**
 * Whether a value is shaped like the session JWT the server issues.
 *
 * Not verified — the client has no key, and the backend is the only party that can accept
 * or reject it. This only refuses values that could not possibly be a token, so that an
 * arbitrary string cannot be parked in storage and later sent as a credential.
 */
export function looksLikeSessionToken(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length < 20 || value.length > 8_192) return false;
	return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/** True when this document is framed AND the embedder supplied the marker. */
export function isEmbeddedByHost(win: Window = window): boolean {
	// `window.parent !== window` is the standard "am I framed" test. Reading it can throw
	// in exotic contexts, so it is guarded — a throw means "treat as not embedded".
	try {
		if (win.parent === win) return false;
	} catch {
		return false;
	}
	try {
		return new URL(win.location.href).searchParams.get(EMBED_MARKER_PARAM) !== null;
	} catch {
		return false;
	}
}

export interface HostBridgeHandle {
	dispose(): void;
	/** The parent origin pinned on first contact, for tests and diagnostics. */
	readonly pinnedOrigin: string | null;
}

/**
 * Install the bridge, or return null when this document is not an embedded panel.
 *
 * Safe to call unconditionally on startup; the guards decide.
 */
export function installHostBridge(win: Window = window): HostBridgeHandle | null {
	if (!isEmbeddedByHost(win)) return null;

	let pinnedOrigin: string | null = null;
	let disposed = false;

	const onMessage = (event: MessageEvent): void => {
		if (disposed) return;
		// Upward only. A sibling frame or a popup is not our embedder, and `event.source`
		// is set by the browser rather than by the sender, so it cannot be forged.
		if (event.source !== win.parent) return;

		const data = event.data as HostMessage | null;
		if (!data || typeof data !== "object") return;
		if (data.type !== BOOTSTRAP_MESSAGE && data.type !== SIGN_OUT_MESSAGE) return;

		// Pin on first contact; refuse any later origin. The parent's origin is not
		// knowable in advance (a per-webview UUID on desktop), so this is the strongest
		// available check — and without it the origin check would be no check at all.
		if (pinnedOrigin === null) {
			// A `null` origin is unattributable, so it can never be pinned: doing so would
			// make every subsequent opaque sender match.
			if (!event.origin || event.origin === "null") return;
			pinnedOrigin = event.origin;
		} else if (event.origin !== pinnedOrigin) {
			return;
		}

		/*
		 * An EXPLICIT sign-out, which is the only thing that may end a session from
		 * outside.
		 *
		 * ⚠️ This is deliberately a separate message from `bootstrap { token: null }`. That
		 * one means "I have no stored copy" — a fresh install, a cleared keychain — and must
		 * NOT log the user out of a session they established inside the panel. Overloading
		 * one message with both meanings makes the two indistinguishable, and whichever
		 * behaviour is chosen is wrong for the other case: either the sign-out command does
		 * nothing (the user stays logged in, and the next panel load reports the token
		 * straight back to the host), or opening a panel on a machine with no stored token
		 * silently destroys a live session.
		 */
		if (data.type === SIGN_OUT_MESSAGE) {
			clearToken();
			// Reload so the SPA drops in-memory session state (React Query caches, open
			// WebSockets) and lands on its login screen. Clearing storage alone leaves a
			// fully-rendered app whose next request 401s, which reads as a crash rather than
			// as a sign-out.
			win.location.reload();
			return;
		}

		if (data.token === null || data.token === undefined) return;
		if (!looksLikeSessionToken(data.token)) return;
		// Through `setToken`, not `localStorage` directly, so the value goes through the one
		// storage path the app already uses (and so the change notification below fires).
		if (data.token !== getToken()) setToken(data.token);
	};

	win.addEventListener("message", onMessage);

	// Report changes upward so the host's copy follows the server's sliding renewal. Only
	// after an origin is pinned — before that there is no verified party to send to, and
	// `"*"` is never acceptable for a credential.
	const unsubscribe = onTokenChange((token) => {
		if (disposed || pinnedOrigin === null) return;
		win.parent.postMessage({ type: TOKEN_CHANGED_MESSAGE, token }, pinnedOrigin);
	});

	return {
		dispose() {
			disposed = true;
			unsubscribe();
			win.removeEventListener("message", onMessage);
		},
		get pinnedOrigin() {
			return pinnedOrigin;
		},
	};
}

/**
 * The message names, exported so the host side and the tests refer to one definition.
 *
 * The extension cannot import this module (different build, different runtime), so its
 * copies are literals in `vscode-extension/src/`. `tests/vscode-extension/protocol.test.ts`
 * compares the two sides: a rename here with no counterpart there leaves a bridge that
 * silently ignores every message, which looks exactly like "the panel just does not sync".
 */
export const HOST_BRIDGE_MESSAGES = {
	bootstrap: BOOTSTRAP_MESSAGE,
	tokenChanged: TOKEN_CHANGED_MESSAGE,
	signOut: SIGN_OUT_MESSAGE,
	embedMarkerParam: EMBED_MARKER_PARAM,
} as const;
