/**
 * update-server-url.test.ts — the update origin's trust gate, on both paths.
 *
 * The predicate decides where the updater may fetch EXECUTABLE code from. It is
 * consumed twice: `update-service.getServerBaseUrl` filters at read time, and the
 * settings PATCH schema rejects at write time. Both are pinned here, because the
 * read-time filter alone turns a mistyped `http://` into a silently disabled
 * updater — a 200 response and no updates, with nothing said about why.
 */

import { describe, expect, test } from "bun:test";
import { isTrustedUpdateServerUrl } from "../update-server-url";

/** Parse just the update block through the real settings schema. */
async function parseServerUrl(serverUrl: string) {
	const { updateSettingsSchema } = await import("../../routes/settings");
	return updateSettingsSchema.safeParse({ update: { serverUrl } });
}

describe("isTrustedUpdateServerUrl", () => {
	test("accepts https for any host", () => {
		expect(isTrustedUpdateServerUrl("https://narrafork-update.b.domexie.cn")).toBe(true);
		expect(isTrustedUpdateServerUrl("https://nfupdatetest.domexie.cn")).toBe(true);
	});

	test("rejects plaintext http for a remote host", () => {
		// TLS is the only trust anchor for the payload today (the expected SHA-512 arrives in the
		// same response as the binary), so plaintext is code execution for a man in the middle.
		expect(isTrustedUpdateServerUrl("http://narrafork-update.b.domexie.cn")).toBe(false);
	});

	test("allows plaintext loopback for the documented local test server", () => {
		expect(isTrustedUpdateServerUrl("http://127.0.0.1:17780")).toBe(true);
		expect(isTrustedUpdateServerUrl("http://localhost:17780")).toBe(true);
		// URL.hostname keeps the brackets on an IPv6 literal.
		expect(isTrustedUpdateServerUrl("http://[::1]:17780")).toBe(true);
	});

	test("rejects other schemes, unparseable values, and the empty string", () => {
		expect(isTrustedUpdateServerUrl("file:///tmp/evil")).toBe(false);
		expect(isTrustedUpdateServerUrl("ftp://updates.example.com")).toBe(false);
		expect(isTrustedUpdateServerUrl("not a url")).toBe(false);
		// "no origin" is not "a trusted origin". Absence is handled by the callers:
		// the schema treats "" as "clear the override", the service as "not configured".
		expect(isTrustedUpdateServerUrl("")).toBe(false);
	});
});

describe("update-service re-exports the same predicate", () => {
	test("the service export is the lib function, not a copy", async () => {
		const service = await import("../../services/update-service");
		expect(service.isTrustedUpdateServerUrl).toBe(isTrustedUpdateServerUrl);
	});
});

describe("settings PATCH schema gates update.serverUrl", () => {
	test("accepts https", async () => {
		expect((await parseServerUrl("https://narrafork-update.b.domexie.cn")).success).toBe(true);
	});

	test("rejects plaintext http for a remote host, with a reason", async () => {
		const result = await parseServerUrl("http://narrafork-update.b.domexie.cn");
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.message).toContain("https");
	});

	test("accepts plaintext loopback", async () => {
		expect((await parseServerUrl("http://127.0.0.1:17780")).success).toBe(true);
		expect((await parseServerUrl("http://localhost:17780")).success).toBe(true);
	});

	test('accepts "" — it clears the override rather than naming an origin', async () => {
		// The refine must not treat absence as an untrusted origin: an admin needs a way
		// back to the built-in default server.
		expect((await parseServerUrl("")).success).toBe(true);
	});

	test("still rejects a value that is not a URL at all", async () => {
		expect((await parseServerUrl("not a url")).success).toBe(false);
	});
});
