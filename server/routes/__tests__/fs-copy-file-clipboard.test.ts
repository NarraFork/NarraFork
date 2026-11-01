/**
 * The clipboard route is the one place a browser turns "copy this file" into an action on the
 * SERVER host, so the two things worth pinning are: who is allowed to ask (only a browser on this
 * machine) and that a helper failure reaches the caller as an error it can show.
 *
 * The clipboard service is mocked: a test must never touch the developer's real clipboard.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";

const copyCalls: string[] = [];
let copyFailure: Error | undefined;
mock.module("../../services/file-clipboard", () => ({
	ClipboardCopyError: Error,
	copyFileToSystemClipboard: async (path: string) => {
		copyCalls.push(path);
		if (copyFailure) throw copyFailure;
	},
	clipboardPlatformSupported: () => true,
}));

const { fsRoutes } = await import("../fs");
const app = new Hono().route("/fs", fsRoutes).onError((error, c) => {
	return buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500);
});

const root = mkdtempSync(join(tmpdir(), "nf-clipboard-route-"));
const filePath = join(root, "CDK-Lite.jar");
writeFileSync(filePath, "jar");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	copyCalls.length = 0;
	copyFailure = undefined;
});

/** `clientIp` is the value the Bun boundary injects; the route decides from it alone. */
function copy(path: unknown, clientIp: string) {
	return app.request(
		"http://localhost/fs/copy-file-to-clipboard",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		},
		{ clientIp },
	);
}

describe("POST /fs/copy-file-to-clipboard", () => {
	test("a browser on this machine copies the file", async () => {
		const response = await copy(filePath, "127.0.0.1");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(copyCalls).toEqual([filePath]);
	});

	test("a remote browser is refused before anything touches the clipboard", async () => {
		const response = await copy(filePath, "203.0.113.9");
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("only works for a browser on the machine");
		expect(copyCalls).toEqual([]);
	});

	test("a missing path is a validation error", async () => {
		const response = await copy(undefined, "127.0.0.1");
		expect(response.status).toBe(400);
		expect(copyCalls).toEqual([]);
	});

	test("a path that is not a file is refused", async () => {
		const response = await copy(root, "127.0.0.1");
		expect(response.status).toBe(400);
		expect(copyCalls).toEqual([]);
	});

	test("a helper failure is reported with the helper's own message", async () => {
		copyFailure = new Error("wl-copy is not installed");
		const response = await copy(filePath, "127.0.0.1");
		expect(response.status).toBe(500);
		expect(await response.text()).toContain("wl-copy is not installed");
	});
});
