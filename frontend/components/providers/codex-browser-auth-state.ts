/**
 * Reconciling the local "waiting for browser authorization" UI with the
 * server-side pending OAuth flow.
 *
 * The Codex authorize request redirects to `http://localhost:1455/auth/callback`,
 * which resolves on whichever machine runs the browser. When NarraFork itself runs
 * on another host, that callback never arrives and the user has to paste the URL
 * back into the app. That paste box therefore has to stay reachable across page
 * reloads and other tabs, which means the server's pending flow — not local
 * component state — is the source of truth.
 */

export interface CodexBrowserAuthServerState {
	pending: boolean;
	status?: string;
	errorCode?: string;
	error?: string;
	redirectUri: string;
	/**
	 * False when the server could not start its local callback listener
	 * (port busy, etc.). The flow is still pending — the user must finish it
	 * by pasting the callback URL, so the UI should say so explicitly.
	 */
	localCallbackServer?: boolean;
}

export interface CodexBrowserAuthReconcileInput {
	/** Latest server state, or undefined before the first fetch resolves. */
	serverState: CodexBrowserAuthServerState | undefined;
	/**
	 * When `serverState` was fetched (React Query's `dataUpdatedAt`).
	 *
	 * Needed because a `pending: false` fetched BEFORE this tab started its flow
	 * says nothing about that flow. The state query is idle while nothing is
	 * pending, so its cached answer is normally exactly that stale — and reading it
	 * as "no flow" would close the paste box in the same tick it opened.
	 */
	serverStateAt?: number;
	/** When this tab started a browser flow, or null if it did not. */
	startedAt?: number | null;
	/** Redirect URI already known to this tab, if any. */
	knownRedirectUri: string | null;
	/**
	 * Whether a manual callback submit is in flight. A state fetch may arrive before
	 * the submit response (or come from an older server), so `pending: false`
	 * during a submit must not tear down the UI.
	 */
	submitting: boolean;
}

export interface CodexBrowserAuthReconcileResult {
	/** Show the waiting/paste UI, or undefined to leave the current value alone. */
	pending?: boolean;
	/** Redirect URI to display, or undefined to keep the current value. */
	redirectUri?: string;
	/** Whether the local callback listener is up, or undefined to keep the current value. */
	localCallbackServer?: boolean;
}

/**
 * Decide how the pending-auth UI should follow the server state.
 *
 * Returning `undefined` fields means "no change", which keeps a tab that just
 * started a flow from flickering before its first state fetch lands.
 */
export function reconcileCodexBrowserAuthState(
	input: CodexBrowserAuthReconcileInput,
): CodexBrowserAuthReconcileResult {
	const { serverState, serverStateAt, startedAt, knownRedirectUri, submitting } = input;
	if (!serverState) return {};

	if (serverState.pending) {
		return {
			pending: true,
			// A locally captured redirect URI is the one actually used for this flow;
			// only fall back to the server's view when this tab has none.
			redirectUri: knownRedirectUri ?? serverState.redirectUri,
			localCallbackServer: serverState.localCallbackServer,
		};
	}

	if (submitting) return {};
	// A `pending: false` observed before this tab's own flow began is about the
	// PREVIOUS state of the world, so it cannot close this flow's UI. The refetch
	// triggered alongside the flow is what supplies a current answer.
	if (startedAt != null && serverStateAt != null && serverStateAt < startedAt) return {};
	return { pending: false };
}
