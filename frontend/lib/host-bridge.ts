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
 *  4. **Only an APPROVED origin may be pinned**, and once pinned every later message must
 *     match it. The parent is a `vscode-webview://…` (desktop, and code-server's webview
 *     host) or, for a non-webview editor origin, an operator-configured embed origin. An
 *     arbitrary web origin — the page an attacker would frame us from — is never pinnable,
 *     so the bridge cannot be claimed by whoever merely messages first (see
 *     {@link isPinnableOrigin}). This is paired with a server-sent `frame-ancestors` CSP
 *     that stops such a page from framing the app at all; the two are defense in depth.
 *
 *  5. **Tokens are shape-validated** before being stored, and are never logged.
 *
 * What an attacker who framed this app would still need: to BE an approved embedder (a
 * `vscode-webview://` host or a configured origin) AND supply a token the backend accepts.
 * Framing from an ordinary web origin yields nothing — it is refused a pin, so the bridge
 * never emits the user's token to it.
 *
 * ⚠️ RESIDUAL REQUIREMENT. The strongest check available without changing the host is the
 * origin allow-list above; it is not a cryptographic proof of identity. A code-server
 * deployment whose editor origin is NOT a `vscode-webview://` URL must have that origin
 * added to `allowedEmbedOrigins` (the same origins the backend trusts for CORS /
 * `frame-ancestors`). A full handshake — an app-MINTED, single-use secret the host must
 * echo — would need matching changes on the host side (`vscode-extension/src/`) and the
 * server that mints it; the `nfEmbed` marker is NOT that secret (see guard #2).
 */

import { endSession, getToken, onTokenChange, setToken } from "@frontend/lib/api/client";

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
 * Whether a value is shaped like a session token the server issues: `nfs_` followed by
 * 32 random bytes in unpadded base64url.
 *
 * Not verified — only the backend can accept or reject it. This only refuses values that
 * could not possibly be a token, so that an arbitrary string cannot be parked in storage
 * and later sent as a credential.
 */
export function looksLikeSessionToken(value: unknown): value is string {
	return typeof value === "string" && /^nfs_[A-Za-z0-9_-]{43}$/.test(value);
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
	/** The parent origin pinned on first approved contact, for tests and diagnostics. */
	readonly pinnedOrigin: string | null;
}

export interface HostBridgeOptions {
	/**
	 * Extra embed origins the operator has approved, beyond the always-trusted
	 * `vscode-webview://` scheme and the app's own origin. These are the non-webview
	 * editor origins (e.g. a code-server instance) and should match what the backend
	 * trusts for CORS / `frame-ancestors`. Empty by default — an arbitrary web origin is
	 * never pinnable without an explicit entry here.
	 */
	allowedEmbedOrigins?: readonly string[];
}

/**
 * Whether `origin` is allowed to be pinned as the embedder.
 *
 * The embedder's origin is not knowable as a constant (the desktop webview carries a
 * per-webview UUID), but its SHAPE is: it is a `vscode-webview://` origin, the app's own
 * origin (same-origin framing cannot steal what it could already read), or an origin the
 * operator explicitly approved. Everything else — the arbitrary web origin an attacker
 * would frame us from — is refused, so "first to speak" can no longer win the bridge.
 */
export function isPinnableOrigin(
	origin: string,
	selfOrigin: string | null,
	allowedEmbedOrigins: readonly string[],
): boolean {
	// An opaque/unattributable origin can never be pinned: doing so would make every later
	// opaque sender match, i.e. the origin check would stop being a check.
	if (!origin || origin === "null") return false;
	if (origin.startsWith("vscode-webview://")) return true;
	if (selfOrigin && origin === selfOrigin) return true;
	return allowedEmbedOrigins.includes(origin);
}

/**
 * Install the bridge, or return null when this document is not an embedded panel.
 *
 * Safe to call unconditionally on startup; the guards decide.
 */
export function installHostBridge(
	win: Window = window,
	options: HostBridgeOptions = {},
): HostBridgeHandle | null {
	if (!isEmbeddedByHost(win)) return null;

	const allowedEmbedOrigins = options.allowedEmbedOrigins ?? [];
	// The app's own origin, for the same-origin allowance in `isPinnableOrigin`. A throw
	// (exotic context) just drops that one allowance; the scheme/configured checks remain.
	let selfOrigin: string | null = null;
	try {
		selfOrigin = new URL(win.location.href).origin;
	} catch {
		selfOrigin = null;
	}

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

		// Pin the FIRST approved origin; refuse any later origin. Only an approved origin
		// (vscode-webview scheme, same-origin, or a configured embed origin) may be pinned,
		// so an arbitrary framer cannot claim the bridge by messaging first — see
		// `isPinnableOrigin` and guard #4 in the module header.
		if (pinnedOrigin === null) {
			if (!isPinnableOrigin(event.origin, selfOrigin, allowedEmbedOrigins)) return;
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
			endSession();
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

	// Report changes upward so the host's copy follows token replacements. Only
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
