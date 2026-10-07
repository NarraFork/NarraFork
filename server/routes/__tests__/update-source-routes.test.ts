import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ReleaseInfo, UpdateCheckResult, UpdateProgress } from "../../services/update-service";

let role = "admin";
let checks: Array<{ force?: boolean } | undefined> = [];
let downloads: ReleaseInfo[] = [];
let checkResult: UpdateCheckResult;
let currentSource = true;
const requireAuth: MiddlewareHandler = async (c, next) => {
	if (!role) return c.json({ error: "Unauthenticated" }, 401);
	await next();
};
const requireAdmin: MiddlewareHandler = async (c, next) => {
	if (role !== "admin") return c.json({ error: "Forbidden" }, 403);
	await next();
};
mock.module("../../middleware/auth", () => ({ requireAuth, requireAdmin }));
mock.module("../../services/update-service", () => ({
	isUpdateSourceCurrent: () => currentSource,
	checkForUpdate: async (options?: { force?: boolean }) => {
		checks.push(options);
		return checkResult;
	},
	downloadUpdate: async (release: ReleaseInfo, onProgress: (p: UpdateProgress) => void) => {
		downloads.push(release);
		for (let i = 0; i < 1000; i++)
			onProgress({ phase: "downloading", bytesDownloaded: i, totalBytes: 1000, percent: i / 10 });
		onProgress({ phase: "complete", bytesDownloaded: 1000, totalBytes: 1000, percent: 100 });
		return { success: true, version: release.version, updatePath: "fixture.bin" };
	},
	getUpdateInstructions: () => ({ manual: true, message: "Fixture only" }),
	applyUpdate: async () => ({ success: true }),
	cancelPreparedUpdate: () => ({ cancelled: false, status: {} }),
	cleanupOldUpdates: () => {},
	getUpdateDirectory: () => "fixture",
	getUpdateStatus: async () => ({ ready: false }),
	shutdownForManualUpdate: () => ({ success: false }),
}));
const { updateRoutes } = await import("../update");
const app = new Hono().route("/update", updateRoutes);
const release: ReleaseInfo = {
	source: "github",
	repository: "NarraFork/NarraFork",
	version: "2.0.0",
	releaseDate: "2026-10-06",
	path: "narrafork-2.0.0-linux-x64",
	sha512: "trusted",
	files: [{ url: "trusted", size: 1000, sha512: "trusted" }],
	_github: { repository: "NarraFork/NarraFork", downloadUrl: "https://github.com/trusted/asset" },
};
const post = (body: unknown) =>
	app.request("/update/download", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	role = "admin";
	currentSource = true;
	checks = [];
	downloads = [];
	checkResult = {
		source: "github",
		repository: "NarraFork/NarraFork",
		currentVersion: "1.0.0",
		latestVersion: "2.0.0",
		updateAvailable: true,
		releaseInfo: structuredClone(release),
	};
});

describe("update source download boundary", () => {
	test("client request size is bounded even without Content-Length", async () => {
		const response = await post({
			releaseInfo: { version: "2.0.0" },
			ignored: "x".repeat(64 * 1024),
		});
		expect(response.status).toBe(413);
		expect(checks.length).toBe(0);
	});
	test("malformed JSON is rejected without external checks", async () => {
		const response = await app.request("/update/download", { method: "POST", body: "{broken" });
		expect(response.status).toBe(400);
		expect(checks.length).toBe(0);
	});
	test("only freshly rechecked server metadata reaches the downloader; progress is coalesced", async () => {
		const response = await post({
			source: "github",
			repository: "narrafork/narrafork",
			releaseInfo: {
				...release,
				sha512: "attacker",
				_github: { downloadUrl: "https://evil.example/payload" },
			},
		});
		expect(response.status).toBe(200);
		const events = await response.text();
		expect(checks).toEqual([{ force: true }]);
		expect<unknown>(downloads).toEqual([checkResult.releaseInfo]);
		expect(events).toContain("event: complete");
		expect(events.match(/event: progress/g)?.length).toBeLessThan(10);
		expect(events).toContain('"percent":100');
	});
	test("settings changed during the outbound check fail with JSON 409 before SSE", async () => {
		currentSource = false;
		const response = await post({
			source: "github",
			repository: "NarraFork/NarraFork",
			releaseInfo: { version: "2.0.0" },
		});
		expect(response.status).toBe(409);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect((await response.json()).errorCode).toBe("UPDATE_SOURCE_CHANGED");
		expect(downloads.length).toBe(0);
	});
	test("same-version source switch requires rechecking instead of silently changing origin", async () => {
		const response = await post({ source: "update-server", releaseInfo: { version: "2.0.0" } });
		expect(response.status).toBe(409);
		expect((await response.json()).errorCode).toBe("UPDATE_SOURCE_CHANGED");
		expect(downloads.length).toBe(0);
	});
	test("same-version repository switch requires rechecking", async () => {
		const response = await post({
			source: "github",
			repository: "Other/Repository",
			releaseInfo: { version: "2.0.0" },
		});
		expect(response.status).toBe(409);
		expect(downloads.length).toBe(0);
	});
	test("new release version is a separate conflict", async () => {
		const response = await post({ source: "github", releaseInfo: { version: "1.9.0" } });
		expect(response.status).toBe(409);
		expect((await response.json()).errorCode).toBe("UPDATE_VERSION_CHANGED");
	});
	test("legacy version-only requests still resolve their payload on the server", async () => {
		const response = await post({ releaseInfo: { version: "2.0.0", url: "http://evil.example" } });
		expect(response.status).toBe(200);
		await response.text();
		expect<unknown>(downloads).toEqual([checkResult.releaseInfo]);
	});
	test("upstream errors are not returned as an ordinary no-update response", async () => {
		checkResult = {
			...checkResult,
			updateAvailable: false,
			releaseInfo: undefined,
			error: "Try later",
			errorCode: "RATE_LIMITED",
			retryAfter: 120,
		};
		const response = await post({ source: "github" });
		expect(response.status).toBe(503);
		expect((await response.json()).retryAfter).toBe(120);
		expect(downloads.length).toBe(0);
	});
	test("check returns structured failure and selected origin", async () => {
		checkResult = {
			...checkResult,
			updateAvailable: false,
			releaseInfo: undefined,
			errorCode: "REPOSITORY_UNAVAILABLE",
			error: "Private repository",
		};
		const response = await app.request("/update/check");
		expect((await response.json()).errorCode).toBe("REPOSITORY_UNAVAILABLE");
	});
	for (const identity of ["", "user"]) {
		test(`non-admin ${identity || "anonymous"} cannot initiate external checks or downloads`, async () => {
			role = identity;
			expect((await app.request("/update/check")).status).toBe(identity ? 403 : 401);
			expect((await post({ releaseInfo: release })).status).toBe(identity ? 403 : 401);
			expect(checks.length).toBe(0);
			expect(downloads.length).toBe(0);
		});
	}
});
