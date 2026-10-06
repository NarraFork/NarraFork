/**
 * shell.ts — The webview document: one full-bleed iframe plus a message relay.
 *
 * WHY AN IFRAME INSTEAD OF BUNDLING THE SPA
 * -----------------------------------------
 * The panel loads NarraFork's own front end from the backend that is running. That keeps
 * the UI and the API at the same version by construction — a bundled copy would drift
 * every time the backend is upgraded, and the mismatch would appear as unexplained API
 * errors rather than as a version problem. It also keeps the extension small and means
 * the SPA's storage, service worker and asset loading all happen on the backend's own
 * origin, where they already work.
 *
 * The cost is that the panel needs a reachable backend; there is no offline mode. That is
 * accepted deliberately.
 */

import { isValidCspSource } from "./loopback";

export interface ShellOptions {
	/** Webview-reachable base URL, trailing slash included. */
	baseUrl: string;
	/** Origin of `baseUrl`, for CSP. */
	baseOrigin: string;
	/** Per-load nonce for the inline relay script. */
	nonce: string;
	/**
	 * Per-load handshake nonce passed to the SPA in the URL.
	 *
	 * NOT a security boundary — it travels in a URL and the SPA cannot verify who minted
	 * it. Its job is narrower: it tells the SPA "an editor host deliberately embedded
	 * you", so the token bridge stays inert for every other embedder. The actual
	 * boundary is the origin check on each message.
	 */
	handshakeNonce: string;
	/** Localized text shown while the iframe has not painted yet. */
	loadingLabel: string;
}

export function generateNonce(): string {
	// 128 bits, hex. `crypto` is global in the Node versions VS Code ships.
	return [...crypto.getRandomValues(new Uint8Array(16))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** The URL the iframe loads: the SPA root plus the handshake marker. */
export function buildFrameUrl(baseUrl: string, handshakeNonce: string): string {
	const url = new URL(baseUrl);
	url.searchParams.set("nfEmbed", handshakeNonce);
	return url.toString();
}

/** Raised when the frame origin cannot be expressed in a CSP source list. */
export class UnrepresentableFrameOriginError extends Error {
	constructor(readonly origin: string) {
		super(`Origin cannot appear in a Content-Security-Policy source list: ${origin}`);
		this.name = "UnrepresentableFrameOriginError";
	}
}

/**
 * Build the webview HTML.
 *
 * CSP notes:
 *  - `frame-src` is the backend origin, which is the whole point of the document.
 *  - `script-src` is a nonce and nothing else, so no injected markup can execute.
 *  - `connect-src 'none'`: the relay never makes requests. All API traffic happens
 *    INSIDE the iframe, on the backend's origin, under the SPA's own code.
 *  - `default-src 'none'` so anything not named above is refused rather than inherited.
 *
 * ⚠️ An origin that cannot appear in a source list is REFUSED here rather than
 * interpolated. A bracketed IPv6 host is the real case: the browser discards the
 * invalid source, `frame-src` collapses to `'none'`, and the iframe is blocked by a
 * policy that looks permissive in the served HTML. The only evidence is a console
 * warning inside a webview nobody has open — so this must fail where it can be
 * explained. (`toMappableLoopbackOrigin` in `loopback.ts` normally prevents such an
 * origin from getting this far; this is the backstop that keeps a future caller from
 * reintroducing it silently.)
 */
export function renderShellHtml(options: ShellOptions): string {
	if (!isValidCspSource(options.baseOrigin)) {
		throw new UnrepresentableFrameOriginError(options.baseOrigin);
	}
	const frameUrl = buildFrameUrl(options.baseUrl, options.handshakeNonce);
	const csp = [
		"default-src 'none'",
		`frame-src ${options.baseOrigin}`,
		`script-src 'nonce-${options.nonce}'`,
		"style-src 'unsafe-inline'",
		"connect-src 'none'",
		"img-src 'none'",
		"font-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
	].join("; ");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>NarraFork</title>
<style>
	html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #1a1b1e); }
	#frame { display: block; border: 0; width: 100%; height: 100vh; }
	#status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
		font: 13px var(--vscode-font-family, sans-serif); color: var(--vscode-descriptionForeground, #9aa0a6); }
	#status[hidden] { display: none; }
</style>
</head>
<body>
<div id="status">${escapeHtml(options.loadingLabel)}</div>
<iframe id="frame" src="${escapeHtml(frameUrl)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${options.nonce}">
(function () {
	const vscodeApi = acquireVsCodeApi();
	const frame = document.getElementById("frame");
	const status = document.getElementById("status");
	// Exact origin string the SPA is served from; used as BOTH the postMessage target
	// and the sender check. Never "*": a wildcard target would broadcast a session
	// token to whatever happens to occupy the frame.
	const backendOrigin = ${JSON.stringify(options.baseOrigin)};

	frame.addEventListener("load", function () { status.hidden = true; });

	// Extension host -> SPA.
	//
	// NOTE: this script lives inside a template literal, so no backticks below.
	window.addEventListener("message", function (event) {
		const data = event.data;
		if (!data || typeof data !== "object") return;

		// Messages from the extension host arrive with no useful origin (the webview's
		// own context), so they are distinguished by shape and relayed downward.
		//
		// sign-out is a separate message from bootstrap on purpose: a bootstrap with no
		// token means "the host has no stored copy", which must not end a session the user
		// established in the panel. See the SPA-side comment in frontend/lib/host-bridge.ts.
		if (data.type === "narrafork.bootstrap" || data.type === "narrafork.sign-out") {
			if (frame.contentWindow) frame.contentWindow.postMessage(data, backendOrigin);
			return;
		}

		// SPA -> extension host. Only same-origin senders are relayed: this is the real
		// trust boundary for the token, so the check is on the EVENT's origin, not on
		// anything the message claims about itself.
		if (event.origin === backendOrigin && data.type === "narrafork.token-changed") {
			vscodeApi.postMessage({ type: "narrafork.token-changed", token: data.token });
		}
	});

	// Tell the host the relay is live, so a bootstrap is not sent into a void.
	vscodeApi.postMessage({ type: "narrafork.shell-ready" });
})();
</script>
</body>
</html>`;
}
