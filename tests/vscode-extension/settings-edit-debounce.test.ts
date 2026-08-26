/**
 * settings-edit-debounce.test.ts — Typing in `narrafork.serverUrl` must not thrash.
 *
 * WHAT THE USER SAW
 * -----------------
 * "Text gets swallowed while typing in the setting, as if the extension is editing it."
 *
 * The extension never writes settings — there is no `.update()` call anywhere in
 * `src/`, and this suite asserts that stays true. But VS Code's settings UI persists the
 * value on EVERY KEYSTROKE, so `onDidChangeConfiguration` fired once per character and
 * each fire started a full discovery with a 3s-per-candidate timeout, no debounce and no
 * cancellation. Typing `http://localhost:7778` launched ~21 overlapping probe chains,
 * each writing into the shared status bar as it completed — in completion order, not
 * keystroke order.
 *
 * So the field really did fight back: the window busy-spun probing half-typed addresses
 * like `http://l`, and stale verdicts repainted over fresh ones. Indistinguishable, from
 * the outside, from the extension rewriting the box.
 *
 * Asserted on source text because `extension.ts` imports the `vscode` runtime and this
 * is about wiring rather than a pure function — the established pattern here (see
 * `panel-reload-policy.test.ts`).
 */

import { describe, expect, it } from "bun:test";

const EXTENSION_SOURCE = await Bun.file("vscode-extension/src/extension.ts").text();

/** The `onDidChangeConfiguration` callback body. */
function configChangeHandler(): string {
	const start = EXTENSION_SOURCE.indexOf("vscode.workspace.onDidChangeConfiguration(");
	expect(start).toBeGreaterThan(-1);
	return EXTENSION_SOURCE.slice(start, start + 900);
}

describe("the extension never writes user settings", () => {
	it("has no configuration update call at all", () => {
		// The user's suspicion, ruled out permanently. A `.update()` on the config object
		// would race the text field and genuinely eat characters.
		expect(EXTENSION_SOURCE).not.toMatch(/getConfiguration\([^)]*\)[\s\S]{0,80}?\.update\(/);
		expect(EXTENSION_SOURCE).not.toContain(".update(");
	});
});

describe("reacting to a settings edit", () => {
	it("debounces the probe instead of firing per keystroke", () => {
		const handler = configChangeHandler();
		expect(handler).toContain("clearTimeout");
		expect(handler).toContain("setTimeout");
		expect(handler).toContain("CONFIG_CHANGE_DEBOUNCE_MS");
		// The pending timer must be cleared before a new one is armed, or the debounce
		// degrades into "one probe per keystroke, just later".
		expect(handler).toMatch(/if\s*\(configChangeTimer\)\s*clearTimeout\(configChangeTimer\)/);
	});

	it("still invalidates the cached endpoint immediately", () => {
		// Only the PROBE is delayed. Keeping a stale endpoint would let the next command
		// silently talk to the previous backend after the address changed.
		const handler = configChangeHandler();
		const clearIndex = handler.indexOf("lastEndpoint = undefined");
		const timerIndex = handler.indexOf("setTimeout(");
		expect(clearIndex).toBeGreaterThan(-1);
		expect(timerIndex).toBeGreaterThan(clearIndex);
	});

	it("uses a debounce long enough to outlast typing", () => {
		// Shorter than a typing pause would defeat the purpose; this only pins that a
		// deliberate, human-scale value was chosen rather than a token 50ms.
		const declared = EXTENSION_SOURCE.match(/CONFIG_CHANGE_DEBOUNCE_MS\s*=\s*(\d+)/);
		expect(declared).not.toBeNull();
		expect(Number(declared?.[1])).toBeGreaterThanOrEqual(300);
	});

	it("cancels a pending probe on disposal", () => {
		// A timer firing after teardown would render into a disposed status bar.
		expect(EXTENSION_SOURCE).toContain("new vscode.Disposable(() => {");
		const disposer = EXTENSION_SOURCE.slice(
			EXTENSION_SOURCE.indexOf("new vscode.Disposable(() => {"),
		);
		expect(disposer.slice(0, 200)).toContain("clearTimeout(configChangeTimer)");
	});
});

describe("out-of-order discovery results", () => {
	it("drops a superseded result rather than repainting with it", () => {
		// Even debounced, two discoveries can overlap (a command while a settings probe is
		// in flight). Without a generation check the slower one wins the status bar, which
		// is how a working endpoint gets evicted by a half-typed address.
		const start = EXTENSION_SOURCE.indexOf("async function findBackend(");
		const body = EXTENSION_SOURCE.slice(start, EXTENSION_SOURCE.indexOf("async function report"));
		expect(body).toContain("++discoveryGeneration");
		expect(body).toContain("superseded");
		// Both the success and the failure path must check it. The failure path matters
		// most: that is the one that clears `lastEndpoint`.
		expect(body.match(/superseded\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
	});
});
