/**
 * token-store.test.ts — Host-side custody of the session token.
 *
 * `token-store.ts` imports only a TYPE from `vscode`, so the store runs against a stub
 * SecretStorage here. That is deliberate: the interesting behaviour is what it refuses to
 * store and how it keys entries, neither of which needs an editor.
 */

import { describe, expect, it } from "bun:test";
import { looksLikeSessionToken, TokenStore } from "../../vscode-extension/src/token-store";

const TOKEN = "aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc";

function makeStore(): { store: TokenStore; raw: Map<string, string> } {
	const raw = new Map<string, string>();
	const secrets = {
		get: async (key: string) => raw.get(key),
		store: async (key: string, value: string) => void raw.set(key, value),
		delete: async (key: string) => void raw.delete(key),
		onDidChange: () => ({ dispose() {} }),
	};
	return { store: new TokenStore(secrets as never), raw };
}

describe("looksLikeSessionToken", () => {
	it("accepts a three-segment base64url token", () => {
		expect(looksLikeSessionToken(TOKEN)).toBe(true);
	});

	it("rejects values that could not be a token", () => {
		for (const value of [null, undefined, 7, {}, "", "nope", "only.two", "a b.c d.e f"]) {
			expect(looksLikeSessionToken(value)).toBe(false);
		}
	});
});

describe("TokenStore", () => {
	it("round-trips a token", async () => {
		const { store } = makeStore();
		expect(await store.write("http://127.0.0.1:7778", TOKEN)).toBe(true);
		expect(await store.read("http://127.0.0.1:7778")).toBe(TOKEN);
	});

	it("keys entries per backend origin", async () => {
		// Two backends are two different sessions; a shared key would inject one instance's
		// token into the other and produce a 401 that looks like a broken login.
		const { store } = makeStore();
		await store.write("http://127.0.0.1:7778", TOKEN);
		expect(await store.read("http://127.0.0.1:9999")).toBeUndefined();
	});

	it("refuses to store a value that is not shaped like a token", async () => {
		// The value arrives from the webview. Storing an arbitrary string is harmless in
		// itself, but it would later be injected AS a credential.
		const { store, raw } = makeStore();
		expect(await store.write("http://127.0.0.1:7778", "garbage")).toBe(false);
		expect(raw.size).toBe(0);
	});

	it("drops a stored value that no longer parses instead of injecting it", async () => {
		// Injecting it would cause a 401 whose cause is invisible from the panel; dropping
		// it falls back to the login form, which at least explains itself.
		const { store, raw } = makeStore();
		raw.set("narrafork.token::http://127.0.0.1:7778", "corrupted");
		expect(await store.read("http://127.0.0.1:7778")).toBeUndefined();
		expect(raw.size).toBe(0);
	});

	it("clears only the requested origin", async () => {
		const { store } = makeStore();
		await store.write("http://127.0.0.1:7778", TOKEN);
		await store.write("http://127.0.0.1:9999", TOKEN);
		await store.clear("http://127.0.0.1:7778");
		expect(await store.read("http://127.0.0.1:7778")).toBeUndefined();
		expect(await store.read("http://127.0.0.1:9999")).toBe(TOKEN);
	});
});
