import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXECUTOR_MANIFEST_FILENAME, type ExecutorManifest } from "@shared/remote-executor";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { resetExecutorManifestCache } from "../../lib/executor-binaries";
import { issueExecutorTicket, resetExecutorTickets } from "../../lib/executor-bootstrap-ticket";
import { HELPER_BIN_DIR } from "../../lib/helper-binaries";
import { executorBootstrapRoutes, resetExecutorBootstrapRateLimit } from "../executor-bootstrap";

const originalFetch = globalThis.fetch;
const BINARY = Buffer.from("linux-amd64-executor-payload");
const SHA256 = createHash("sha256").update(BINARY).digest("hex");

function manifest(): ExecutorManifest {
	return {
		version: "0.5.24",
		protocolVersion: 1,
		releasedAt: "2026-08-15T00:00:00.000Z",
		platforms: {
			"linux-amd64": {
				filename: "narrafork-executor-0.5.24-linux-amd64",
				size: BINARY.byteLength,
				sha256: SHA256,
			},
		},
	};
}

function mockUpdateServer(): void {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.endsWith(EXECUTOR_MANIFEST_FILENAME)) {
			return new Response(JSON.stringify(manifest()), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.endsWith("narrafork-executor-0.5.24-linux-amd64")) {
			return new Response(new Blob([Uint8Array.from(BINARY)]), { status: 200 });
		}
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

function app(): Hono {
	const instance = new Hono();
	instance.route("/api/executor", executorBootstrapRoutes);
	// Mirror the production error handler so AppError subclasses (validation, rate
	// limiting) map to the same statuses a real client would observe.
	instance.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return instance;
}

beforeEach(() => {
	resetExecutorManifestCache();
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
	mkdirSync(HELPER_BIN_DIR, { recursive: true });
	mockUpdateServer();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	resetExecutorManifestCache();
	resetExecutorTickets();
	resetExecutorBootstrapRateLimit();
	rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
});

describe("GET /api/executor/download/:platform", () => {
	test("serves the verified binary for a valid ticket", async () => {
		const ticket = issueExecutorTicket("linux-amd64", { deviceId: "dev-1" });
		const response = await app().request(
			`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-executor-version")).toBe("0.5.24");
		expect(response.headers.get("x-executor-sha256")).toBe(SHA256);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(BINARY));
	});

	test("rejects a missing or unknown ticket with one generic message", async () => {
		const instance = app();
		const noTicket = await instance.request("/api/executor/download/linux-amd64");
		expect(noTicket.status).toBe(403);
		const body = (await noTicket.json()) as { error: string };
		expect(body.error).toBe("Invalid or expired download ticket");

		const unknown = await instance.request(
			`/api/executor/download/linux-amd64?ticket=${"c".repeat(64)}`,
		);
		expect(unknown.status).toBe(403);
		// Unknown, expired and exhausted tickets must be indistinguishable to callers:
		// the specific reason is logged server-side only.
		expect(((await unknown.json()) as { error: string }).error).toBe(body.error);
	});

	test("allows download retries but stops at the ticket's budget", async () => {
		/*
		 * Downloads are deliberately NOT single-use.
		 *
		 * A dropped connection partway through a multi-megabyte binary is ordinary, and
		 * the natural human response is to re-run the same install command. When the
		 * download was one-shot, a network blip meant going back to the UI to generate a
		 * new command. The key exchange is still strictly once — that is where
		 * single-use actually matters.
		 */
		const instance = app();
		const ticket = issueExecutorTicket("linux-amd64");
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(
				(await instance.request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`))
					.status,
			).toBe(200);
		}
		const exhausted = await instance.request(
			`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
		);
		expect(exhausted.status).toBe(403);
		expect(((await exhausted.json()) as { error: string }).error).toBe(
			"Invalid or expired download ticket",
		);
	});

	test("a ticket cannot be redirected to another platform", async () => {
		const ticket = issueExecutorTicket("linux-amd64");
		const response = await app().request(
			`/api/executor/download/darwin-arm64?ticket=${ticket.ticket}`,
		);
		expect(response.status).toBe(403);
	});

	test("rejects an unknown platform before touching the ticket", async () => {
		const ticket = issueExecutorTicket("linux-amd64");
		const response = await app().request(
			`/api/executor/download/linux-riscv64?ticket=${ticket.ticket}`,
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
		// The ticket must survive: it was never spent on an invalid platform.
		expect(
			(await app().request(`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`)).status,
		).toBe(200);
	});

	test("reports 503 when the release does not cover the requested platform", async () => {
		const ticket = issueExecutorTicket("windows-arm64");
		const response = await app().request(
			`/api/executor/download/windows-arm64?ticket=${ticket.ticket}`,
		);
		expect(response.status).toBe(503);
		expect(((await response.json()) as { error: string }).error).toMatch(
			/does not publish a build/,
		);
	});

	test("refuses to serve a binary whose bytes do not match the manifest", async () => {
		// Pre-seed the cache with a tampered file; the digest check must reject it and
		// the honest re-download must also fail because the mock serves bad bytes.
		writeFileSync(join(HELPER_BIN_DIR, "narrafork-executor-0.5.24-linux-amd64"), "tampered");
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.endsWith(EXECUTOR_MANIFEST_FILENAME)) {
				return new Response(JSON.stringify(manifest()), { status: 200 });
			}
			return new Response(new Blob([Uint8Array.from(Buffer.from("substituted"))]), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const ticket = issueExecutorTicket("linux-amd64");
		const response = await app().request(
			`/api/executor/download/linux-amd64?ticket=${ticket.ticket}`,
		);
		expect(response.status).toBe(503);
	});

	test("rate limits repeated attempts from one address", async () => {
		const instance = app();
		let limited = false;
		// Loops past the window rather than to a hard-coded count: the budget is sized
		// for how many machines share one NAT egress, so it is expected to be retuned.
		for (let i = 0; i < 200; i++) {
			const response = await instance.request(
				`/api/executor/download/linux-amd64?ticket=${"d".repeat(64)}`,
			);
			if (response.status === 429) {
				limited = true;
				break;
			}
		}
		expect(limited).toBe(true);
	});

	/**
	 * One install spends 3 attempts (script + binary + token). The budget is NOT sized
	 * for one machine: several hosts behind a single NAT egress — the ordinary LAN
	 * deployment — share this counter, and if it were tight the later installs would
	 * fail with a rate-limit message that has nothing to do with their ticket.
	 *
	 * Pins the headroom in units of installs, so a future reduction has to state that
	 * it is shrinking the number of machines enrollable per minute from one address.
	 */
	test("leaves room for a batch of machines behind one NAT egress", async () => {
		const instance = app();
		const attemptsPerInstall = 3;
		const machines = 10;
		for (let i = 0; i < attemptsPerInstall * machines; i++) {
			const response = await instance.request(
				`/api/executor/download/linux-amd64?ticket=${"d".repeat(64)}`,
			);
			// 403 is the expected outcome for a bogus ticket; 429 would mean the limiter
			// cut in before ten machines could enroll.
			expect(response.status).toBe(403);
		}
	});
});
