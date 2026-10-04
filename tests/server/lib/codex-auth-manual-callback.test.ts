/**
 * Codex browser OAuth manual callback fallback.
 *
 * The authorize request redirects to `http://localhost:1455/auth/callback`, which
 * resolves on whatever machine runs the browser. For a remote NarraFork host that
 * callback never arrives, so the user pastes the dead URL back into the app. These
 * tests pin the parsing tolerance and the pending-flow guard.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cancelBrowserOAuth,
	completeBrowserOAuthFromCallbackUrl,
	getBrowserOAuthRedirectUri,
	hasPendingBrowserOAuth,
	isBrowserOAuthServerRunning,
	parseCallbackParams,
	startBrowserOAuth,
} from "../../../server/lib/codex-auth";
import { logger } from "../../../server/lib/logger";
import * as excludedPorts from "../../../server/lib/windows-excluded-ports";

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
		const serve = spyOn(Bun, "serve").mockImplementation(() => {
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
			serve.mockRestore();
			warn.mockRestore();
		}
	});
});

describe("startBrowserOAuth with the callback port occupied", () => {
	it("continues the flow without the local server instead of failing", async () => {
		// Simulate bind failure without competing with a running NarraFork's listener.
		const read = spyOn(excludedPorts, "readWindowsExcludedPortRangesAsync").mockResolvedValue([]);
		const serve = spyOn(Bun, "serve").mockImplementation(() => {
			throw Object.assign(new Error("Address already in use"), { code: "EADDRINUSE" });
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
			serve.mockRestore();
			read.mockRestore();
		}
	});
});

describe("completeBrowserOAuthFromCallbackUrl with the callback server running", () => {
	it("still services pasted callbacks while the local listener is up", async () => {
		// This must remain last: production intentionally retains the server across flows.
		// Stub the listener so the test never opens or shares the host's OAuth port.
		const read = spyOn(excludedPorts, "readWindowsExcludedPortRangesAsync").mockResolvedValue([]);
		const serve = spyOn(Bun, "serve").mockReturnValue({
			port: 1455,
		} as ReturnType<typeof Bun.serve>);
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
			serve.mockRestore();
			read.mockRestore();
		}
	});
});
