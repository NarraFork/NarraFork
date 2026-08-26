/**
 * panel-reload-policy.test.ts — When the panel may throw away the running SPA.
 *
 * Assigning `webview.html` destroys the iframe and reloads the app, which discards a
 * streaming narrator, live WebSocket subscriptions and unsent composer text. That is
 * precisely the state `retainContextWhenHidden` is enabled to preserve, so doing it on an
 * ordinary "Open Panel" would undo that setting's entire purpose — silently, since a
 * reloaded panel looks perfectly healthy to anyone who was not mid-task.
 *
 * `panel.ts` imports the `vscode` runtime, so the policy cannot be exercised directly here
 * without a fake editor. It is asserted on the source instead, which is the established
 * pattern in this repo for cross-file invariants (see `tests/frontend/branding-boot.test.ts`).
 */

import { describe, expect, it } from "bun:test";

const PANEL_SOURCE = await Bun.file("vscode-extension/src/panel.ts").text();
const EXTENSION_SOURCE = await Bun.file("vscode-extension/src/extension.ts").text();

/** The body of `createOrShow`, where the reveal-vs-reload decision is made. */
function createOrShowBody(): string {
	const start = PANEL_SOURCE.indexOf("static async createOrShow(");
	const end = PANEL_SOURCE.indexOf("static get active()");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return PANEL_SOURCE.slice(start, end);
}

describe("createOrShow", () => {
	it("only reloads an existing panel when forced or when the endpoint changed", () => {
		const body = createOrShowBody();
		expect(body).toContain("forceReload");
		expect(body).toContain("endpointChanged");
		// The reload must be conditional. An unconditional `await existing.load(...)` on the
		// already-open branch is the regression this guards.
		expect(body).toMatch(/if\s*\(options\.forceReload\s*\|\|\s*endpointChanged\)/);
	});

	it("reveals the existing panel regardless", () => {
		// Focusing is the part that must always happen: the command is how the user finds
		// the panel again.
		expect(createOrShowBody()).toContain("reveal(");
	});
});

describe("command wiring", () => {
	it("only reconnect asks for a reload", () => {
		// A `forceReload: true` anywhere else means some ordinary command silently discards
		// the user's in-flight work.
		const occurrences = EXTENSION_SOURCE.match(/forceReload:\s*true/g) ?? [];
		expect(occurrences).toHaveLength(1);

		const reconnectBody = EXTENSION_SOURCE.slice(
			EXTENSION_SOURCE.indexOf('registerCommand("narrafork.reconnect"'),
			EXTENSION_SOURCE.indexOf('registerCommand("narrafork.signOut"'),
		);
		expect(reconnectBody.length).toBeGreaterThan(0);
		expect(reconnectBody).toContain("forceReload: true");
	});

	it("openPanel does not force a reload", () => {
		const openPanelBody = EXTENSION_SOURCE.slice(
			EXTENSION_SOURCE.indexOf("async function openPanel("),
			EXTENSION_SOURCE.indexOf("export async function activate("),
		);
		expect(openPanelBody.length).toBeGreaterThan(0);
		expect(openPanelBody).not.toContain("forceReload");
	});
});
