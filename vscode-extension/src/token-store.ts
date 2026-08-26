/**
 * token-store.ts — Keep the NarraFork session token in VS Code's SecretStorage.
 *
 * WHY THE EXTENSION HOLDS IT AT ALL
 * ---------------------------------
 * The SPA already persists its token in `localStorage` on the backend's origin, so a
 * plain browser tab never re-authenticates. A webview is less durable: its storage can be
 * cleared with the panel, and the same user may open panels in several windows. Holding
 * the token host-side makes the panel resume a session instead of presenting a login form
 * the user already completed.
 *
 * WHY IT MUST BE BIDIRECTIONAL
 * ----------------------------
 * ⚠️ The token is not stable. The backend re-signs it as it nears expiry and returns the
 * replacement in the `X-NarraFork-Session-Token` response header, which the SPA absorbs
 * (`frontend/lib/api/client.ts`). A write-only store therefore goes stale on its own, and
 * the symptom appears LATER and elsewhere: the next panel injects an expired token and
 * the user is bounced to the login screen for no visible reason. So the SPA reports every
 * change back and this store follows it.
 *
 * WHY IT IS NOT A CONFIGURATION SETTING
 * -------------------------------------
 * A `narrafork.token` setting would put a live credential in `settings.json`, which is
 * frequently synced and committed. SecretStorage is backed by the OS keychain and is
 * per-machine. The token is captured as a by-product of the user logging in normally, so
 * there is nothing for them to paste anywhere.
 */

import type * as vscode from "vscode";

/** One entry per backend origin: two backends are two different sessions. */
function secretKey(origin: string): string {
	return `narrafork.token::${origin}`;
}

/**
 * Reject anything that is not shaped like the JWT the backend issues.
 *
 * The value arrives from the webview, so it is untrusted input even though the relay
 * checks the sender's origin. Storing an arbitrary string would be harmless in itself but
 * would later be injected as a credential; refusing here keeps the store to values that
 * could plausibly be one.
 */
export function looksLikeSessionToken(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length < 20 || value.length > 8_192) return false;
	// Three base64url segments. Not verified — the extension has no key and does not need
	// one; the backend is the only party that can accept or reject it.
	return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export class TokenStore {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	async read(origin: string): Promise<string | undefined> {
		const stored = await this.secrets.get(secretKey(origin));
		// A stored value that no longer parses is dropped rather than injected: injecting
		// it would produce a 401 whose cause is invisible from the panel.
		if (stored !== undefined && !looksLikeSessionToken(stored)) {
			await this.clear(origin);
			return undefined;
		}
		return stored;
	}

	/** Returns true when the value was accepted and stored. */
	async write(origin: string, token: unknown): Promise<boolean> {
		if (!looksLikeSessionToken(token)) return false;
		await this.secrets.store(secretKey(origin), token);
		return true;
	}

	async clear(origin: string): Promise<void> {
		await this.secrets.delete(secretKey(origin));
	}
}
