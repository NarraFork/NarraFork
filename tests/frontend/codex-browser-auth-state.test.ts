/**
 * The Codex "paste callback URL" fallback must survive page reloads.
 *
 * The pending OAuth flow lives on the server, so the settings UI follows the
 * server state instead of local component state. These tests pin the reconcile
 * rules that decide when the waiting/paste box appears and disappears.
 */

import { describe, expect, it } from "bun:test";
import { reconcileCodexBrowserAuthState } from "../../frontend/components/providers/codex-browser-auth-state";

const REDIRECT_URI = "http://localhost:1455/auth/callback";

describe("reconcileCodexBrowserAuthState", () => {
	it("changes nothing before the first server state arrives", () => {
		// Otherwise a tab that just started a flow would flicker out of the pending UI.
		expect(
			reconcileCodexBrowserAuthState({
				serverState: undefined,
				knownRedirectUri: null,
				submitting: false,
			}),
		).toEqual({});
	});

	/**
	 * The state query is idle while nothing is pending, so at the moment a flow
	 * starts its cached answer is a STALE `pending: false` from before the flow
	 * existed. Reading that as "no flow" closed the paste box in the same tick that
	 * opened it, and it only came back when the window regained focus.
	 */
	it("ignores a pending:false that was fetched before this tab's flow began", () => {
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: false, redirectUri: REDIRECT_URI },
				serverStateAt: 1_000,
				startedAt: 2_000,
				knownRedirectUri: REDIRECT_URI,
				submitting: false,
			}),
		).toEqual({});
	});

	it("acts on a pending:false fetched after the flow began", () => {
		// The refetch triggered alongside the flow is what supplies a current answer —
		// so a genuinely finished/expired flow still closes the UI.
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: false, redirectUri: REDIRECT_URI },
				serverStateAt: 3_000,
				startedAt: 2_000,
				knownRedirectUri: REDIRECT_URI,
				submitting: false,
			}),
		).toEqual({ pending: false });
	});

	it("acts on a pending:false when this tab started no flow", () => {
		// A tab that only observes (never clicked the button) has no start time, so
		// the staleness guard must not latch its UI open.
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: false, redirectUri: REDIRECT_URI },
				serverStateAt: 1_000,
				startedAt: null,
				knownRedirectUri: null,
				submitting: false,
			}),
		).toEqual({ pending: false });
	});

	it("adopts a pending flow this tab did not start", () => {
		// Page reload, or authorization kicked off from another tab.
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: true, redirectUri: REDIRECT_URI },
				knownRedirectUri: null,
				submitting: false,
			}),
		).toEqual({ pending: true, redirectUri: REDIRECT_URI });
	});

	it("keeps the redirect URI this tab captured when the flow started", () => {
		const local = "http://localhost:1456/auth/callback";
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: true, redirectUri: REDIRECT_URI },
				knownRedirectUri: local,
				submitting: false,
			}),
		).toEqual({ pending: true, redirectUri: local });
	});

	it("closes the pending UI once the server has no flow", () => {
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: false, redirectUri: REDIRECT_URI },
				knownRedirectUri: REDIRECT_URI,
				submitting: false,
			}),
		).toEqual({ pending: false });
	});

	it("holds the pending UI open while a callback submit is in flight", () => {
		// The server detaches the pending flow during the token exchange, so a
		// mid-submit `pending: false` must not be read as "flow is over".
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: false, redirectUri: REDIRECT_URI },
				knownRedirectUri: REDIRECT_URI,
				submitting: true,
			}),
		).toEqual({});
	});

	it("still adopts a pending flow while submitting", () => {
		expect(
			reconcileCodexBrowserAuthState({
				serverState: { pending: true, redirectUri: REDIRECT_URI },
				knownRedirectUri: null,
				submitting: true,
			}),
		).toEqual({ pending: true, redirectUri: REDIRECT_URI });
	});
});
