/**
 * host-bridge.test.ts — Contract for the ONE inbound path that can set a session token.
 *
 * Every assertion here guards a failure that produces no error message. A missing guard
 * lets an unrelated framing page write a credential; an over-strict guard leaves the
 * VS Code panel showing a login form the user already completed. Both look like "it just
 * behaves that way" from the outside, so the boundary is pinned down explicitly.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { clearToken, getToken, setToken } from "@frontend/lib/api/client";
import {
	type HostBridgeHandle,
	installHostBridge,
	isEmbeddedByHost,
	looksLikeSessionToken,
} from "@frontend/lib/host-bridge";

/** A syntactically plausible session JWT (never verified by the client). */
const TOKEN_A = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";
const TOKEN_B = "dddddddddddd.eeeeeeeeeeee.ffffffffffff";
const HOST_ORIGIN = "vscode-webview://7803497a-8232-4556-988a-7a1636d48b30";

interface SentMessage {
	data: unknown;
	targetOrigin: string;
}

interface FakeWindow {
	parent: unknown;
	location: { href: string; reload: () => void };
	addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
	removeEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
	/** Deliver a message as the browser would. */
	deliver: (init: { source?: unknown; origin: string; data: unknown }) => void;
	sent: SentMessage[];
	listenerCount: () => number;
	reloads: number;
}

function makeWindow(href: string, framed = true): FakeWindow {
	const listeners = new Set<(event: MessageEvent) => void>();
	const sent: SentMessage[] = [];
	const parent = {
		postMessage(data: unknown, targetOrigin: string) {
			sent.push({ data, targetOrigin });
		},
	};
	const win: FakeWindow = {
		parent: null,
		reloads: 0,
		location: {
			href,
			reload() {
				win.reloads++;
			},
		},
		addEventListener(type, listener) {
			if (type === "message") listeners.add(listener);
		},
		removeEventListener(type, listener) {
			if (type === "message") listeners.delete(listener);
		},
		deliver({ source, origin, data }) {
			// `source` defaults to the parent, since that is the only sender the bridge
			// accepts and most cases are about other properties of the message.
			const event = { source: source === undefined ? parent : source, origin, data };
			for (const listener of [...listeners]) listener(event as unknown as MessageEvent);
		},
		sent,
		listenerCount: () => listeners.size,
	};
	// A top-level document has `parent === self`; that is exactly the test the bridge runs.
	win.parent = framed ? parent : win;
	return win;
}

/** Minimal in-memory localStorage, since the token helpers read it directly. */
function installLocalStorage(): void {
	const store = new Map<string, string>();
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	};
}

let bridge: HostBridgeHandle | null = null;

beforeEach(() => {
	installLocalStorage();
});

afterEach(() => {
	bridge?.dispose();
	bridge = null;
	delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("looksLikeSessionToken", () => {
	it("accepts a three-segment base64url token", () => {
		expect(looksLikeSessionToken(TOKEN_A)).toBe(true);
	});

	it("rejects values that could not be a token", () => {
		// Refusing these keeps an arbitrary string from being parked in storage and later
		// sent out as a credential.
		for (const value of [
			null,
			undefined,
			42,
			{},
			"",
			"short",
			"only.two",
			"has spaces.in it.here",
			"a.b.c",
			`${"x".repeat(9000)}.y.z`,
		]) {
			expect(looksLikeSessionToken(value)).toBe(false);
		}
	});
});

describe("isEmbeddedByHost", () => {
	it("is false for a top-level document even with the marker", () => {
		expect(isEmbeddedByHost(makeWindow("https://nf.test/?nfEmbed=abc", false) as never)).toBe(
			false,
		);
	});

	it("is false for a framed document without the marker", () => {
		// Being framed is not consent. Without the marker any page could embed the app and
		// start speaking to this listener.
		expect(isEmbeddedByHost(makeWindow("https://nf.test/") as never)).toBe(false);
	});

	it("is true only when framed AND marked", () => {
		expect(isEmbeddedByHost(makeWindow("https://nf.test/?nfEmbed=abc") as never)).toBe(true);
	});
});

describe("installHostBridge", () => {
	it("installs nothing when the document is not an embedded panel", () => {
		const win = makeWindow("https://nf.test/");
		bridge = installHostBridge(win as never);
		expect(bridge).toBeNull();
		expect(win.listenerCount()).toBe(0);
	});

	it("stores a bootstrapped token", () => {
		const win = makeWindow("https://nf.test/?nfEmbed=n1");
		bridge = installHostBridge(win as never);
		win.deliver({ origin: HOST_ORIGIN, data: { type: "narrafork.bootstrap", token: TOKEN_A } });
		expect(getToken()).toBe(TOKEN_A);
	});

	it("ignores a message that did not come from the parent", () => {
		// `event.source` is set by the browser, so it cannot be forged — which makes it the
		// right thing to check. A sibling frame or popup is not our embedder.
		const win = makeWindow("https://nf.test/?nfEmbed=n1");
		bridge = installHostBridge(win as never);
		win.deliver({
			source: { postMessage() {} },
			origin: HOST_ORIGIN,
			data: { type: "narrafork.bootstrap", token: TOKEN_A },
		});
		expect(getToken()).toBeNull();
	});

	it("refuses to pin an opaque origin", () => {
		// A `null` origin is unattributable; pinning it would make every later opaque
		// sender match, i.e. the origin check would stop being a check.
		const win = makeWindow("https://nf.test/?nfEmbed=n1");
		bridge = installHostBridge(win as never);
		win.deliver({ origin: "null", data: { type: "narrafork.bootstrap", token: TOKEN_A } });
		expect(getToken()).toBeNull();
		expect(bridge?.pinnedOrigin).toBeNull();
	});

	it("pins the first origin and refuses a different one afterwards", () => {
		const win = makeWindow("https://nf.test/?nfEmbed=n1");
		bridge = installHostBridge(win as never);
		win.deliver({ origin: HOST_ORIGIN, data: { type: "narrafork.bootstrap", token: TOKEN_A } });
		expect(bridge?.pinnedOrigin).toBe(HOST_ORIGIN);

		win.deliver({
			origin: "https://evil.example.com",
			data: { type: "narrafork.bootstrap", token: TOKEN_B },
		});
		expect(getToken()).toBe(TOKEN_A);
	});

	it("ignores unknown message types and malformed payloads", () => {
		const win = makeWindow("https://nf.test/?nfEmbed=n1");
		bridge = installHostBridge(win as never);
		for (const data of [
			null,
			"a string",
			{ type: "something.else", token: TOKEN_A },
			{ type: "narrafork.bootstrap", token: "not-a-token" },
			{ type: "narrafork.bootstrap" },
		]) {
			win.deliver({ origin: HOST_ORIGIN, data });
		}
		expect(getToken()).toBeNull();
	});

	it("does not clear an existing session when the host reports no token", () => {
		// The app's own storage is the source of truth. A host that simply has no copy
		// (a fresh install, a cleared keychain) must not be able to end a session the user
		// established inside the panel.
		const win = makeWindow("https://nf.test/?nfEmbed=n1");
		setToken(TOKEN_A);
		bridge = installHostBridge(win as never);
		win.deliver({ origin: HOST_ORIGIN, data: { type: "narrafork.bootstrap", token: null } });
		expect(getToken()).toBe(TOKEN_A);
		expect(win.reloads).toBe(0);
	});

	describe("explicit sign-out", () => {
		/*
		 * ⚠️ Why this is a SEPARATE message from `bootstrap { token: null }`.
		 *
		 * The first implementation expressed sign-out as an empty bootstrap, which the bridge
		 * deliberately ignores (see the test above). The command therefore did nothing: the
		 * panel stayed logged in, and on the next sliding renewal it reported its token
		 * straight back to the host — a sign-out that undid itself, with the keychain cleared
		 * so it even looked like it had worked.
		 *
		 * The two meanings cannot share one message. Whichever behaviour is chosen is wrong
		 * for the other case: either sign-out is inert, or opening a panel on a machine with
		 * no stored token silently destroys a live session.
		 */
		it("clears the session and reloads", () => {
			const win = makeWindow("https://nf.test/?nfEmbed=n1");
			setToken(TOKEN_A);
			bridge = installHostBridge(win as never);
			win.deliver({ origin: HOST_ORIGIN, data: { type: "narrafork.sign-out" } });
			expect(getToken()).toBeNull();
			// Reload matters: clearing storage alone leaves a fully rendered app with live
			// WebSockets and cached queries whose next request 401s, which reads as a crash
			// rather than as a sign-out.
			expect(win.reloads).toBe(1);
		});

		it("is subject to the same origin checks as a bootstrap", () => {
			// Ending a session is at least as sensitive as starting one, so it must not be
			// reachable from a sender the bridge would otherwise refuse.
			const win = makeWindow("https://nf.test/?nfEmbed=n1");
			setToken(TOKEN_A);
			bridge = installHostBridge(win as never);

			// Wrong sender.
			win.deliver({
				source: { postMessage() {} },
				origin: HOST_ORIGIN,
				data: { type: "narrafork.sign-out" },
			});
			expect(getToken()).toBe(TOKEN_A);

			// Pin the origin, then try a different one.
			win.deliver({ origin: HOST_ORIGIN, data: { type: "narrafork.bootstrap", token: TOKEN_A } });
			win.deliver({
				origin: "https://evil.example.com",
				data: { type: "narrafork.sign-out" },
			});
			expect(getToken()).toBe(TOKEN_A);
			expect(win.reloads).toBe(0);
		});
	});

	describe("reporting changes upward", () => {
		function bootstrapped(): FakeWindow {
			const win = makeWindow("https://nf.test/?nfEmbed=n1");
			bridge = installHostBridge(win as never);
			win.deliver({ origin: HOST_ORIGIN, data: { type: "narrafork.bootstrap", token: TOKEN_A } });
			win.sent.length = 0;
			return win;
		}

		it("reports a renewed token to the pinned origin, never to a wildcard", () => {
			// The renewal path is the whole reason this direction exists: the server re-signs
			// the token mid-session, and a host copy taken at load time would go stale and
			// later bounce the user to the login screen for no visible reason.
			const win = bootstrapped();
			setToken(TOKEN_B);
			expect(win.sent).toEqual([
				{ data: { type: "narrafork.token-changed", token: TOKEN_B }, targetOrigin: HOST_ORIGIN },
			]);
		});

		it("reports a sign-out", () => {
			const win = bootstrapped();
			clearToken();
			expect(win.sent).toEqual([
				{ data: { type: "narrafork.token-changed", token: null }, targetOrigin: HOST_ORIGIN },
			]);
		});

		it("says nothing when the value did not actually change", () => {
			// Hydration and `absorbRenewedToken` both re-assert the current value; announcing
			// those would send a message per request.
			const win = bootstrapped();
			setToken(TOKEN_A);
			expect(win.sent).toEqual([]);
		});

		it("sends nothing before an origin has been pinned", () => {
			// With no verified counterparty there is no safe target, and `"*"` is never
			// acceptable for a credential.
			const win = makeWindow("https://nf.test/?nfEmbed=n1");
			bridge = installHostBridge(win as never);
			setToken(TOKEN_B);
			expect(win.sent).toEqual([]);
		});

		it("stops listening and reporting after dispose", () => {
			const win = bootstrapped();
			bridge?.dispose();
			bridge = null;
			setToken(TOKEN_B);
			expect(win.sent).toEqual([]);
			expect(win.listenerCount()).toBe(0);
		});
	});
});
