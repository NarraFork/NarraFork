import { describe, expect, test } from "bun:test";
import {
	isUpdatedServerReadyForReload,
	waitForUpdatedServerAndReload,
} from "../../frontend/lib/pwa";

describe("isUpdatedServerReadyForReload", () => {
	test("waits when the server is unreachable", () => {
		expect(isUpdatedServerReadyForReload(null, "0.2.0")).toBe(false);
	});

	test("reloads a fully-ready server that matches the target version", () => {
		expect(isUpdatedServerReadyForReload({ status: "ok", version: "0.2.0" }, "0.2.0")).toBe(true);
	});

	test("tolerates a leading v on either side when matching versions", () => {
		expect(isUpdatedServerReadyForReload({ status: "ok", version: "v0.2.0" }, "0.2.0")).toBe(true);
		expect(isUpdatedServerReadyForReload({ status: "ok", version: "0.2.0" }, "v0.2.0")).toBe(true);
	});

	test("keeps waiting when a ready server still reports the old version", () => {
		expect(isUpdatedServerReadyForReload({ status: "ok", version: "0.1.0" }, "0.2.0")).toBe(false);
	});

	test("does not reload any server without an explicit target version", () => {
		expect(isUpdatedServerReadyForReload({ status: "ok", version: "0.1.0" }, undefined)).toBe(
			false,
		);
	});

	test("fails fast instead of polling indefinitely when target version is missing", async () => {
		await expect(waitForUpdatedServerAndReload()).rejects.toThrow(/target version is required/);
	});

	test("reloads a recovering server once it reports the target version", () => {
		// The replacement binds the port and reports the new version while startup narrator
		// recovery is still running (status: "recovering"). Recovery is a backend concern and must
		// not block loading the new frontend bundle, so this is reloadable.
		expect(
			isUpdatedServerReadyForReload(
				{ status: "recovering", version: "0.2.0", readiness: "recovering" },
				"0.2.0",
			),
		).toBe(true);
	});

	test("does not reload a recovering server that still reports the old version", () => {
		expect(
			isUpdatedServerReadyForReload(
				{ status: "recovering", version: "0.1.0", readiness: "recovering" },
				"0.2.0",
			),
		).toBe(false);
	});

	test("never reloads a recovering server without a target version to confirm the build", () => {
		// Without an explicit target we cannot prove the recovering server is the new build, so we
		// only trust a fully-ready server.
		expect(
			isUpdatedServerReadyForReload({ status: "recovering", version: "0.2.0" }, undefined),
		).toBe(false);
	});

	test("keeps waiting on a failed readiness so the update UI can surface the error", () => {
		expect(
			isUpdatedServerReadyForReload(
				{ status: "failed", version: "0.2.0", readiness: "failed" },
				"0.2.0",
			),
		).toBe(false);
	});
});
