import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "./client";

const calls: Array<{ path: string; options?: RequestInit & { maxResponseBytes?: number } }> = [];
const realClient = { ...(await import("./client")) };

mock.module("./client", () => ({
	...realClient,
	request: async <T>(path: string, options?: RequestInit & { maxResponseBytes?: number }) => {
		calls.push({ path, options });
		if (options?.method === "PUT")
			throw new ApiError("conflict", 409, { code: "PROVIDER_SETTINGS_REVISION_CONFLICT" });
		return { schemaVersion: 1, schemaFingerprint: "a".repeat(64), revision: 5 } as T;
	},
}));

const { providerSettingsApi } = await import("./provider-settings");

beforeEach(() => calls.splice(0));
afterAll(() => mock.restore());

describe("provider settings API contract", () => {
	test("isolates list requests by stable target identity", async () => {
		await providerSettingsApi.list({ kind: "custom-api", id: "custom-1" });
		await providerSettingsApi.list({ kind: "custom-api", id: "custom-2" });
		expect(calls.map((call) => call.path)).toEqual([
			"/provider-settings?kind=custom-api&id=custom-1",
			"/provider-settings?kind=custom-api&id=custom-2",
		]);
	});

	test("sends every binding field for an explicit rebind confirmation", async () => {
		await providerSettingsApi.rebind(
			{ kind: "platform", id: "codex:pool" },
			"com.example.quota",
			"quota",
			{
				expectedRevision: 4,
				schemaFingerprint: "a".repeat(64),
				expectedBindingRevision: "b".repeat(64),
			},
		);
		const call = calls[0];
		expect(call.path).toBe(
			"/provider-settings/com.example.quota/quota/rebind?kind=platform&id=codex%3Apool",
		);
		expect(JSON.parse(String(call.options?.body))).toEqual({
			expectedRevision: 4,
			schemaFingerprint: "a".repeat(64),
			expectedBindingRevision: "b".repeat(64),
		});
	});

	test("preserves a revision conflict for the UI to reload", async () => {
		await expect(
			providerSettingsApi.save({ kind: "nug", id: "nug-1" }, "com.example.quota", "quota", {
				schemaVersion: 1,
				schemaFingerprint: "a".repeat(64),
				expectedRevision: 4,
				expectedBindingRevision: "b".repeat(64),
				values: {},
				secrets: {},
			}),
		).rejects.toMatchObject({ status: 409, data: { code: "PROVIDER_SETTINGS_REVISION_CONFLICT" } });
	});
});
