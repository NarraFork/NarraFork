import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	consumeStartupRecoveryFailure,
	isUpdatedServerReadyForReload,
	stashStartupRecoveryFailure,
	waitForUpdatedServerAndReload,
} from "../../frontend/lib/pwa";

// bun test has no DOM, so the hand-off store needs a stub. Without one the helpers would fall
// into their own catch blocks and return null, making the round-trip assertions vacuous.
const globalObject = globalThis as typeof globalThis & { sessionStorage?: Storage };
const originalSessionStorage = globalObject.sessionStorage;
let storedValues = new Map<string, string>();

beforeEach(() => {
	storedValues = new Map();
	Object.defineProperty(globalObject, "sessionStorage", {
		configurable: true,
		value: {
			get length() {
				return storedValues.size;
			},
			clear: () => storedValues.clear(),
			getItem: (key: string) => storedValues.get(key) ?? null,
			key: (index: number) => [...storedValues.keys()][index] ?? null,
			removeItem: (key: string) => storedValues.delete(key),
			setItem: (key: string, value: string) => storedValues.set(key, value),
		} satisfies Storage,
	});
});

afterAll(() => {
	if (originalSessionStorage === undefined) {
		Reflect.deleteProperty(globalObject, "sessionStorage");
	} else {
		Object.defineProperty(globalObject, "sessionStorage", {
			configurable: true,
			value: originalSessionStorage,
		});
	}
});

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

	test("reloads into the new build even when startup recovery failed", () => {
		// A failed recovery does NOT make the replacement unusable: the server keeps serving every
		// route (`shouldServeRequests` is unconditionally true) precisely so the settings UI can
		// repair whatever broke it. Blocking here pinned the user to the old bundle, which is the
		// one place that repair UI does not exist.
		expect(
			isUpdatedServerReadyForReload(
				{ status: "failed", version: "0.2.0", readiness: "failed" },
				"0.2.0",
			),
		).toBe(true);
	});

	test("still refuses a failed server that is not the target build", () => {
		// Version identity remains the only gate: a failed OLD process must never be reloaded into.
		expect(
			isUpdatedServerReadyForReload(
				{ status: "failed", version: "0.1.0", readiness: "failed" },
				"0.2.0",
			),
		).toBe(false);
	});
});

describe("startup recovery failure hand-off across the reload", () => {
	test("round-trips a reason and clears it so it is announced only once", () => {
		stashStartupRecoveryFailure('Provider "muyuan" is not configured.');
		expect(consumeStartupRecoveryFailure()).toBe('Provider "muyuan" is not configured.');
		// A manual refresh must not re-announce a failure the user already saw.
		expect(consumeStartupRecoveryFailure()).toBeNull();
	});

	test("distinguishes a reasonless failure from no failure at all", () => {
		// An empty string still means "recovery failed", so the banner must render; null means
		// nothing failed. Collapsing the two would silently hide the failure.
		stashStartupRecoveryFailure(undefined);
		expect(consumeStartupRecoveryFailure()).toBe("");
		expect(consumeStartupRecoveryFailure()).toBeNull();
	});

	test("treats a blank reason as reasonless rather than reporting whitespace", () => {
		stashStartupRecoveryFailure("   ");
		expect(consumeStartupRecoveryFailure()).toBe("");
	});
});
