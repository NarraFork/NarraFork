/**
 * protocol.test.ts — Keep the two halves of the host bridge speaking the same names.
 *
 * The bridge spans two builds that cannot import each other: the SPA (`frontend/`, bundled
 * for the browser) and the extension (`vscode-extension/`, CommonJS on Node). So the
 * message names exist twice — once as constants in `frontend/lib/host-bridge.ts`, once as
 * literals in the extension's webview HTML.
 *
 * Every way of getting that wrong is silent. A rename on one side leaves a bridge where
 * messages are sent and simply ignored: no exception, no log, no failed request. The panel
 * just stops resuming sessions, or the sign-out command stops working, and the natural
 * conclusion is "the token sync is flaky" rather than "the two sides disagree by one
 * character". This test is the only place both spellings are visible at once.
 */

import { describe, expect, it } from "bun:test";
import { HOST_BRIDGE_MESSAGES } from "@frontend/lib/host-bridge";
import { buildFrameUrl, renderShellHtml } from "../../vscode-extension/src/shell";

const SHELL_HTML = renderShellHtml({
	baseUrl: "http://127.0.0.1:7778/",
	baseOrigin: "http://127.0.0.1:7778",
	nonce: "n0nce",
	handshakeNonce: "handshake123",
	loadingLabel: "Connecting…",
});

const PANEL_SOURCE = await Bun.file("vscode-extension/src/panel.ts").text();

describe("message names agree across the two builds", () => {
	it("the shell relays every name the SPA listens for", () => {
		// The SPA accepts `bootstrap` and `sign-out`; both must survive the relay hop or the
		// corresponding feature is inert.
		expect(SHELL_HTML).toContain(`"${HOST_BRIDGE_MESSAGES.bootstrap}"`);
		expect(SHELL_HTML).toContain(`"${HOST_BRIDGE_MESSAGES.signOut}"`);
	});

	it("the shell forwards the name the SPA sends upward", () => {
		expect(SHELL_HTML).toContain(`"${HOST_BRIDGE_MESSAGES.tokenChanged}"`);
	});

	it("the panel sends the names the shell relays", () => {
		expect(PANEL_SOURCE).toContain(`"${HOST_BRIDGE_MESSAGES.bootstrap}"`);
		expect(PANEL_SOURCE).toContain(`"${HOST_BRIDGE_MESSAGES.signOut}"`);
		expect(PANEL_SOURCE).toContain(`"${HOST_BRIDGE_MESSAGES.tokenChanged}"`);
	});

	it("the embed marker parameter matches", () => {
		// Without the marker the SPA never installs the bridge at all, so a mismatch here
		// disables the entire feature while every individual piece looks correct.
		expect(buildFrameUrl("http://127.0.0.1:7778/", "abc")).toContain(
			`${HOST_BRIDGE_MESSAGES.embedMarkerParam}=abc`,
		);
	});
});

describe("sign-out is distinct from an empty bootstrap", () => {
	it("the panel does not express sign-out as a null-token bootstrap", () => {
		// ⚠️ The bug this replaced: `bootstrap { token: null }` means "the host has no stored
		// copy", which the SPA deliberately ignores so that a fresh install cannot destroy a
		// live session. Reusing it for sign-out therefore did nothing — the panel stayed
		// logged in and reported its token straight back to the host on the next renewal.
		const signOutBody = PANEL_SOURCE.slice(
			PANEL_SOURCE.indexOf("async signOut()"),
			PANEL_SOURCE.indexOf("private async onShellMessage"),
		);
		expect(signOutBody.length).toBeGreaterThan(0);
		expect(signOutBody).toContain(HOST_BRIDGE_MESSAGES.signOut);
		expect(signOutBody).not.toContain(HOST_BRIDGE_MESSAGES.bootstrap);
	});

	it("the two names are not the same string", () => {
		expect(HOST_BRIDGE_MESSAGES.signOut).not.toBe(HOST_BRIDGE_MESSAGES.bootstrap);
	});
});
