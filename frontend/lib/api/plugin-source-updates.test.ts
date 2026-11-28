import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { api } from "./index";
import { miscApi } from "./misc";
import { pluginsApi } from "./plugins";

let originalStorage: PropertyDescriptor | undefined;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let response: unknown;
const calls: { url: string; method: string; body: unknown; signal?: AbortSignal | null }[] = [];
beforeEach(() => {
	originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null },
	});
	response = {};
	calls.length = 0;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					method: init?.method ?? "GET",
					body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
					signal: init?.signal,
				});
				return Response.json(response);
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
});
afterEach(() => {
	fetchSpy.mockRestore();
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

test("source reads and writes encode the plugin ID and preserve optimistic revision and optional homepage", async () => {
	const controller = new AbortController();
	await pluginsApi.pluginGetSource("io.example/plugin", { signal: controller.signal });
	const source = {
		type: "github" as const,
		owner: "owner",
		repo: "repo",
		assetName: "plugin-{version}.nfplugin",
	};
	await pluginsApi.pluginSetSource("io.example/plugin", { source, expectedRevision: 4 });
	await pluginsApi.pluginSetSource("io.example/plugin", { source: null, expectedRevision: 5 });
	expect(calls.map((call) => [call.url, call.method, call.body])).toEqual([
		["/api/plugins/io.example%2Fplugin/source", "GET", undefined],
		["/api/plugins/io.example%2Fplugin/source", "PUT", { source, expectedRevision: 4 }],
		["/api/plugins/io.example%2Fplugin/source", "PUT", { source: null, expectedRevision: 5 }],
	]);
	expect(calls[0]?.signal).toBe(controller.signal);
	expect(source).not.toHaveProperty("homepage");
});

test("release operations use cache reads, explicit check/apply jobs and exact preferences body", async () => {
	await pluginsApi.pluginGetUpdates("io.example.plugin");
	await pluginsApi.pluginCheckUpdates("io.example.plugin");
	await pluginsApi.pluginApplyUpdate("io.example.plugin", {
		candidateId: "candidate-1",
		expectedRevision: 7,
	});
	await pluginsApi.pluginApplyUpdate("io.example.plugin", {
		candidateId: "candidate-2",
		expectedRevision: 7,
		allowTrustChange: true,
	});
	await pluginsApi.pluginSetUpdatePreferences("io.example.plugin", {
		autoUpdate: true,
		expectedRevision: 7,
	});
	expect(calls.map((call) => [call.url, call.method, call.body])).toEqual([
		["/api/plugins/io.example.plugin/updates", "GET", undefined],
		["/api/plugins/io.example.plugin/updates/check", "POST", {}],
		[
			"/api/plugins/io.example.plugin/updates/apply",
			"POST",
			{ candidateId: "candidate-1", expectedRevision: 7 },
		],
		[
			"/api/plugins/io.example.plugin/updates/apply",
			"POST",
			{ candidateId: "candidate-2", expectedRevision: 7, allowTrustChange: true },
		],
		[
			"/api/plugins/io.example.plugin/updates/preferences",
			"PUT",
			{ autoUpdate: true, expectedRevision: 7 },
		],
	]);
	expect(api.applyUpdate).toBe(miscApi.applyUpdate);
});

test("builtin directory, explicit install and job cancellation use their own endpoints", async () => {
	await pluginsApi.pluginListBuiltins();
	await pluginsApi.pluginInstallBuiltin("io.narrafork.provider-quota");
	await pluginsApi.pluginGetUpdateJob("job /1");
	await pluginsApi.pluginCancelUpdateJob("job /1");
	expect(calls.map((call) => [call.url, call.method])).toEqual([
		["/api/plugins/builtins", "GET"],
		["/api/plugins/builtins/io.narrafork.provider-quota/install", "POST"],
		["/api/plugins/update-jobs/job%20%2F1", "GET"],
		["/api/plugins/update-jobs/job%20%2F1/cancel", "POST"],
	]);
});
