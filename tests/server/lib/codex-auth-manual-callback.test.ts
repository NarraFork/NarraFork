/**
 * Codex browser OAuth manual callback fallback.
 *
 * The authorize request redirects to `http://localhost:1455/auth/callback`, which
 * resolves on whatever machine runs the browser. For a remote NarraFork host that
 * callback never arrives, so the user pastes the dead URL back into the app. These
 * tests pin the parsing tolerance and the pending-flow guard.
 */

import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CodexOAuthError,
	cancelBrowserOAuth,
	completeBrowserOAuthFromCallbackUrl,
	getBrowserOAuthRedirectUri,
	getBrowserOAuthStatus,
	hasPendingBrowserOAuth,
	isBrowserOAuthServerRunning,
	parseCallbackParams,
	startBrowserOAuth,
} from "../../../server/lib/codex-auth";
import { logger } from "../../../server/lib/logger";
import * as excludedPorts from "../../../server/lib/windows-excluded-ports";

// Never bind the real OAuth port or send a callback to a running NarraFork process.
let callbackHandler!: (request: Request) => Response | Promise<Response>;
const serveStub = ((options: { fetch: typeof callbackHandler }) => {
	callbackHandler = options.fetch;
	return { port: 1455 };
}) as typeof Bun.serve;
const serveSpy = spyOn(Bun, "serve").mockImplementation(serveStub);
afterAll(() => serveSpy.mockRestore());
const localCallback = async (url: string) => callbackHandler(new Request(url));

describe("parseCallbackParams", () => {
	it("reads params from a full callback URL", () => {
		const params = parseCallbackParams("http://localhost:1455/auth/callback?code=abc123&state=s1");
		expect(params.get("code")).toBe("abc123");
		expect(params.get("state")).toBe("s1");
	});

	it("reads params from a bare query string", () => {
		const params = parseCallbackParams("?code=abc123&state=s1");
		expect(params.get("code")).toBe("abc123");
		expect(params.get("state")).toBe("s1");
	});

	it("reads params from a query string without the leading question mark", () => {
		const params = parseCallbackParams("code=abc123&state=s1");
		expect(params.get("code")).toBe("abc123");
		expect(params.get("state")).toBe("s1");
	});

	it("treats a naked value as the authorization code", () => {
		const params = parseCallbackParams("abc123");
		expect(params.get("code")).toBe("abc123");
		expect(params.get("state")).toBeNull();
	});

	it("preserves an error response so it can be reported verbatim", () => {
		const params = parseCallbackParams(
			"http://localhost:1455/auth/callback?error=access_denied&error_description=User%20declined",
		);
		expect(params.get("error")).toBe("access_denied");
		expect(params.get("error_description")).toBe("User declined");
	});
});

describe("CodexManager.completeBrowserAuthFromCallbackUrl", () => {
	/**
	 * A rejected paste must NOT be recorded as a flow failure.
	 *
	 * `lastBrowserAuthError` means "the browser flow itself failed", and the settings
	 * UI reacts to it by tearing down the pending panel — which would remove the very
	 * input box the user needs to correct their paste. The server deliberately keeps
	 * the flow pending on a failed exchange, so the error belongs only in the thrown
	 * rejection (the route turns it into a 400).
	 */
	it("does not record a bad paste as a flow-level error", async () => {
		const { CodexManager } = await import("../../../server/lib/codex-manager");
		const home = mkdtempSync(join(tmpdir(), "narrafork-codex-manual-callback-"));
		const manager = new CodexManager({ homeDir: home, registerProcessHooks: false });
		try {
			cancelBrowserOAuth();
			await expect(manager.completeBrowserAuthFromCallbackUrl("?code=abc")).rejects.toThrow(
				"No pending browser authorization",
			);
			expect(manager.snapshot().lastBrowserAuthError).toBeUndefined();
		} finally {
			manager.dispose();
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("completeBrowserOAuthFromCallbackUrl", () => {
	it("rejects an empty input", async () => {
		await expect(completeBrowserOAuthFromCallbackUrl("   ")).rejects.toThrow(
			"Callback URL is empty",
		);
	});

	it("rejects when no browser flow is pending", async () => {
		// No flow was started in this test file, so nothing is pending. Cancelling is
		// a no-op that also guards against leakage from another suite in the same process.
		cancelBrowserOAuth();
		expect(hasPendingBrowserOAuth()).toBe(false);

		await expect(
			completeBrowserOAuthFromCallbackUrl(
				"http://localhost:1455/auth/callback?code=abc123&state=s1",
			),
		).rejects.toThrow("No pending browser authorization");
	});
});

describe("getBrowserOAuthRedirectUri", () => {
	it("falls back to the fixed callback port before any server starts", () => {
		// Starting the real callback server would bind a port, so this only asserts
		// the default the UI shows when no flow has run yet.
		expect(getBrowserOAuthRedirectUri()).toBe("http://localhost:1455/auth/callback");
	});
});

describe("startBrowserOAuth with a Windows-reserved callback port", () => {
	it("rechecks exclusions, never binds, and keeps manual callback available", async () => {
		const read = spyOn(excludedPorts, "readWindowsExcludedPortRangesAsync");
		const serve = serveSpy.mockClear().mockImplementation(() => {
			throw new Error("Must not bind a reserved port");
		});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			// Both ends are inclusive; a changed reservation must be read again.
			for (const range of [
				{ start: 1356, end: 1455 },
				{ start: 1455, end: 1555 },
			]) {
				read.mockResolvedValue([range]);
				const flow = await startBrowserOAuth();
				flow.tokenPromise.catch(() => {});
				try {
					expect(serve).not.toHaveBeenCalled();
					expect(flow.localCallbackServer).toBe(false);
					expect(isBrowserOAuthServerRunning()).toBe(false);
					expect(getBrowserOAuthRedirectUri()).toBe("http://localhost:1455/auth/callback");
					expect(new URL(flow.authorizeUrl).searchParams.get("redirect_uri")).toBe(
						"http://localhost:1455/auth/callback",
					);
					expect(hasPendingBrowserOAuth()).toBe(true);
					await expect(
						completeBrowserOAuthFromCallbackUrl("?code=abc&state=wrong"),
					).rejects.toThrow("Callback state does not match");
					expect(hasPendingBrowserOAuth()).toBe(true);
					expect(warn).toHaveBeenCalledWith(
						"Codex OAuth callback port is reserved by Windows; use manual callback",
						{ port: 1455, reservedRange: `${range.start}-${range.end}` },
					);
				} finally {
					cancelBrowserOAuth();
				}
			}
			expect(read).toHaveBeenCalledTimes(2);
		} finally {
			read.mockRestore();
			serveSpy.mockImplementation(serveStub);
			warn.mockRestore();
		}
	});
});

describe("startBrowserOAuth with the callback port occupied", () => {
	it("continues the flow without the local server instead of failing", async () => {
		const read = spyOn(excludedPorts, "readWindowsExcludedPortRangesAsync").mockResolvedValue([]);
		serveSpy.mockImplementationOnce(() => {
			throw new Error("EADDRINUSE");
		});
		try {
			const flow = await startBrowserOAuth();
			// The pending flow must still be cancelled so its rejection is observed.
			flow.tokenPromise.catch(() => {});
			try {
				expect(flow.localCallbackServer).toBe(false);
				expect(isBrowserOAuthServerRunning()).toBe(false);
				// The redirect_uri must stay on the fixed port — never a substitute port.
				expect(flow.authorizeUrl).toContain(
					`redirect_uri=${encodeURIComponent("http://localhost:1455/auth/callback")}`,
				);
				// The flow is pending, so the manual paste path stays available.
				expect(hasPendingBrowserOAuth()).toBe(true);
			} finally {
				cancelBrowserOAuth();
			}
		} finally {
			serveSpy.mockImplementation(serveStub);
			read.mockRestore();
		}
	});
});

describe("completeBrowserOAuthFromCallbackUrl with the callback server running", () => {
	it("still services pasted callbacks while the local listener is up", async () => {
		// Capture the real callback handler without binding the host's OAuth port.
		const read = spyOn(excludedPorts, "readWindowsExcludedPortRangesAsync").mockResolvedValue([]);
		const flow = await startBrowserOAuth();
		// The pending flow must be cancelled so its rejection is observed.
		flow.tokenPromise.catch(() => {});
		try {
			expect(flow.localCallbackServer).toBe(true);
			expect(isBrowserOAuthServerRunning()).toBe(true);
			// A wrong state proves the paste reached the pending flow — the guard
			// fires before any network exchange, and the flow stays pending so the
			// user can fix the input and retry.
			await expect(
				completeBrowserOAuthFromCallbackUrl("?code=abc&state=definitely-wrong"),
			).rejects.toThrow("Callback state does not match");
			expect(hasPendingBrowserOAuth()).toBe(true);
		} finally {
			cancelBrowserOAuth();
			read.mockRestore();
		}
	});
});

// Use a stub upstream, never real OpenAI credentials or network requests.
describe("browser token exchange outcomes", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
		cancelBrowserOAuth();
	});
	const callbackFor = (authorizeUrl: string) =>
		`http://localhost:1455/auth/callback?code=test&state=${new URL(authorizeUrl).searchParams.get("state")}`;
	const tokens = () =>
		Response.json({ access_token: "test", refresh_token: "refresh", expires_in: 3600 });

	it("ends a region-rejected flow and gives actionable proxy instructions", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ error: { code: "unsupported_country_region_territory" } },
				{ status: 403 },
			)) as unknown as typeof fetch;
		const flow = await startBrowserOAuth();
		const failure = flow.tokenPromise.catch((err) => err);
		try {
			await completeBrowserOAuthFromCallbackUrl(callbackFor(flow.authorizeUrl));
			throw new Error("Expected rejection");
		} catch (err) {
			expect(err).toBeInstanceOf(CodexOAuthError);
			expect((err as CodexOAuthError).code).toBe("region_unsupported");
			expect((err as Error).message).toContain("Configure a usable proxy");
			expect((err as Error).message).toContain("browser proxy");
		}
		expect((await failure).code).toBe("region_unsupported");
		expect(hasPendingBrowserOAuth()).toBe(false);
		expect(getBrowserOAuthStatus().errorCode).toBe("region_unsupported");
		await expect(
			completeBrowserOAuthFromCallbackUrl(callbackFor(flow.authorizeUrl)),
		).rejects.toThrow("Start authorization again");
	});

	it("keeps an exchange visible and prevents concurrent double spending", async () => {
		let release!: (response: Response) => void;
		let calls = 0;
		globalThis.fetch = (() => {
			calls++;
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		}) as unknown as typeof fetch;
		const flow = await startBrowserOAuth();
		flow.tokenPromise.catch(() => {});
		const first = completeBrowserOAuthFromCallbackUrl(callbackFor(flow.authorizeUrl));
		expect(getBrowserOAuthStatus().status).toBe("exchanging");
		expect(hasPendingBrowserOAuth()).toBe(true);
		await expect(
			completeBrowserOAuthFromCallbackUrl(callbackFor(flow.authorizeUrl)),
		).rejects.toThrow("already in progress");
		expect(calls).toBe(1);
		release(tokens());
		await first;
		await flow.tokenPromise;
		expect(getBrowserOAuthStatus().status).toBe("idle");
	});

	it("does not report automatic callback success before token exchange finishes", async () => {
		let release!: (response: Response) => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		globalThis.fetch = (() => {
			entered();
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		}) as unknown as typeof fetch;
		const flow = await startBrowserOAuth();
		flow.tokenPromise.catch(() => {});
		let finished = false;
		const callback = localCallback(callbackFor(flow.authorizeUrl)).then((response) => {
			finished = true;
			return response;
		});
		await started;
		expect(finished).toBe(false);
		release(tokens());
		const response = await callback;
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Authorization Successful");
		await flow.tokenPromise;
	});

	it("returns a failed automatic callback page on region rejection", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ error: { code: "unsupported_country_region_territory" } },
				{ status: 403 },
			)) as unknown as typeof fetch;
		const flow = await startBrowserOAuth();
		const failure = flow.tokenPromise.catch((err) => err);
		const response = await localCallback(callbackFor(flow.authorizeUrl));
		expect(response.status).toBe(400);
		const html = await response.text();
		expect(html).toContain("Configure a usable proxy");
		expect(html).not.toContain("Authorization Successful");
		await failure;
	});

	it("preserves the current flow when an old automatic callback arrives", async () => {
		const flow = await startBrowserOAuth();
		flow.tokenPromise.catch(() => {});
		const response = await localCallback("http://localhost:1455/auth/callback?code=old&state=old");
		expect(response.status).toBe(400);
		expect(hasPendingBrowserOAuth()).toBe(true);
		await expect(completeBrowserOAuthFromCallbackUrl("?code=old&state=old")).rejects.toThrow(
			"latest callback URL",
		);
		expect(hasPendingBrowserOAuth()).toBe(true);
	});

	it("requires fresh authorization after a network error", async () => {
		globalThis.fetch = (async () => {
			throw new Error("fetch failed: ECONNRESET");
		}) as unknown as typeof fetch;
		const flow = await startBrowserOAuth();
		const failure = flow.tokenPromise.catch((err) => err);
		await expect(
			completeBrowserOAuthFromCallbackUrl(callbackFor(flow.authorizeUrl)),
		).rejects.toThrow("start authorization again");
		expect((await failure).code).toBe("network_error");
		expect(hasPendingBrowserOAuth()).toBe(false);
	});

	it("does not mislabel other 403 responses as a regional restriction", async () => {
		globalThis.fetch = (async () =>
			Response.json(
				{ error: { code: "access_denied" } },
				{ status: 403 },
			)) as unknown as typeof fetch;
		const flow = await startBrowserOAuth();
		const failure = flow.tokenPromise.catch((err) => err);
		await expect(
			completeBrowserOAuthFromCallbackUrl(callbackFor(flow.authorizeUrl)),
		).rejects.toThrow("Token exchange failed: 403");
		expect((await failure).code).toBe("token_exchange_failed");
		expect(getBrowserOAuthStatus().status).toBe("failed");
	});

	it("rejects malformed successful responses without logging token contents", async () => {
		globalThis.fetch = (async () =>
			Response.json({ access_token: "secret-not-for-errors" })) as unknown as typeof fetch;
		const flow = await startBrowserOAuth();
		const failure = flow.tokenPromise.catch((err) => err);
		await expect(
			completeBrowserOAuthFromCallbackUrl(callbackFor(flow.authorizeUrl)),
		).rejects.toThrow("invalid token payload");
		const err = await failure;
		expect(err.message).not.toContain("secret-not-for-errors");
		expect(hasPendingBrowserOAuth()).toBe(false);
	});

	it("escapes upstream error text in the automatic callback HTML", async () => {
		const flow = await startBrowserOAuth();
		flow.tokenPromise.catch(() => {});
		const url = new URL(callbackFor(flow.authorizeUrl));
		url.searchParams.set("error", "access_denied");
		url.searchParams.set("error_description", "<script>alert(1)</script>");
		const html = await (await localCallback(url.toString())).text();
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
		expect(getBrowserOAuthStatus().status).toBe("failed");
	});

	it("does not resurrect a cancelled or superseded exchange", async () => {
		let release!: (response: Response) => void;
		globalThis.fetch = (() =>
			new Promise<Response>((resolve) => {
				release = resolve;
			})) as unknown as typeof fetch;
		const old = await startBrowserOAuth();
		old.tokenPromise.catch(() => {});
		const oldExchange = completeBrowserOAuthFromCallbackUrl(callbackFor(old.authorizeUrl));
		const next = await startBrowserOAuth();
		next.tokenPromise.catch(() => {});
		release(tokens());
		await expect(oldExchange).rejects.toThrow("authorization has ended");
		expect(getBrowserOAuthStatus().status).toBe("waiting");
		expect(getBrowserOAuthStatus().errorCode).toBeUndefined();
	});
});
