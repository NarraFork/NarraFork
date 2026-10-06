import { describe, expect, test } from "bun:test";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Navigate,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { parseHTML } from "linkedom";
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * Regression coverage for "passkey sign-in immediately shows Something went
 * wrong; a reload fixes it".
 *
 * The login page had TWO owners for the same post-login transition:
 *
 *  1. a render-time `if (getToken()) return <Navigate to={postLoginPath} />`, and
 *  2. each success handler's own `navigate({ to: postLoginPath })`.
 *
 * `applySession` stores the token BEFORE the handler navigates, so any re-render
 * in that window (a settling query, a WS event, the passkey mutation flipping
 * `isPending`) also rendered `<Navigate>`. Two owners then drove one transition.
 *
 * Passkey login hit this far more often than password login: the WebAuthn
 * ceremony awaits a browser prompt, so the token lands while several auth
 * queries are still settling, and `usePasskeyLogin.onSuccess` did not await
 * `applySession`, widening the window further.
 *
 * The failure surfaced as the FRAMEWORK's bare "Something went wrong!" rather
 * than our localized error UI, because the throw comes from `Match`/`Navigate`
 * effects that run above the root route's `errorComponent`.
 *
 * The fix makes the handler the single redirect owner and gates the render-time
 * `<Navigate>` on a ref, so a session created by this page never triggers both.
 */

function installBrowserDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	return window.document;
}

interface HarnessOptions {
	/** Whether the page guards the render-time redirect with a "signed in here" ref. */
	guarded: boolean;
}

/**
 * Minimal reproduction of the login page's redirect ownership, driving a real
 * router so the navigation count is observed rather than asserted from source.
 */
function createLoginHarness({ guarded }: HarnessOptions) {
	const navigations: string[] = [];
	// Stands in for the module-level token in lib/api/client.
	let token: string | null = null;

	function LoginPage() {
		const signedInHereRef = useRef(false);
		// Drives the extra re-render that a settling query would cause after the
		// token is stored but before the handler's navigate() is applied.
		const [, forceRender] = useState(0);

		const goToPostLogin = () => {
			signedInHereRef.current = true;
			navigations.push("handler");
		};

		const signIn = () => {
			// applySession(): the token exists before any navigation happens.
			token = "session-token";
			forceRender((n) => n + 1);
			goToPostLogin();
		};

		if ((!guarded || !signedInHereRef.current) && token) {
			navigations.push("render-navigate");
			return <Navigate to="/" />;
		}

		return (
			<button type="button" data-testid="signin" onClick={signIn}>
				sign in
			</button>
		);
	}

	const rootRoute = createRootRoute({ component: Outlet });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <div>dashboard</div>,
	});
	const loginRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/login",
		component: LoginPage,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute, loginRoute]),
		history: createMemoryHistory({ initialEntries: ["/login"] }),
	});

	return { router, navigations };
}

async function runSignIn(options: HarnessOptions): Promise<string[]> {
	const document = installBrowserDom();
	const container = document.createElement("div");
	document.body.appendChild(container);
	const { router, navigations } = createLoginHarness(options);
	const root = createRoot(container);

	try {
		await act(async () => {
			root.render(<RouterProvider router={router} />);
		});
		const button = container.querySelector<HTMLElement>('[data-testid="signin"]');
		if (!button) throw new Error("login harness did not render its sign-in control");
		await act(async () => {
			button.click();
		});
		return navigations;
	} finally {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	}
}

describe("login post-sign-in redirect ownership", () => {
	test("a session created on the login page has exactly one redirect owner", async () => {
		const navigations = await runSignIn({ guarded: true });

		expect(navigations).toEqual(["handler"]);
	});

	test("without the guard, storing the token makes the render redirect compete", async () => {
		const navigations = await runSignIn({ guarded: false });

		// Proves the race is real rather than theoretical: the render-time
		// <Navigate> also claims the transition the handler already owns.
		expect(navigations).toContain("handler");
		expect(navigations).toContain("render-navigate");
		expect(navigations.length).toBeGreaterThan(1);
	});
});
