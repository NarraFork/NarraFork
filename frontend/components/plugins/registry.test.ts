import { afterEach, describe, expect, test } from "bun:test";
import { pluginContributionStore } from "./PluginContributionStore";
import type { PluginDockPanelParams } from "./protocol";
import {
	applyPluginUiContributionItems,
	clearPluginUiContributions,
	hasPluginUiContribution,
	invalidatePluginUiContributions,
	registerPluginUiContribution,
	resolvePluginUiContribution,
	resolvePluginUiContributionDetailed,
	syncPluginUiContributions,
} from "./registry";

const params: PluginDockPanelParams = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "com.example.review",
	contributionId: "dashboard",
	panelInstanceId: "pui_review",
	binding: { kind: "global" },
};

const g = globalThis as typeof globalThis & {
	localStorage?: Storage;
	fetch?: typeof fetch;
};
const originalLocalStorage = g.localStorage;
const originalFetch = g.fetch;

afterEach(() => {
	clearPluginUiContributions();
	if (originalLocalStorage === undefined) {
		Reflect.deleteProperty(g, "localStorage");
	} else {
		Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
	}
	if (originalFetch === undefined) {
		Reflect.deleteProperty(g, "fetch");
	} else {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
	}
});

function installMapLocalStorage(): Map<string, string> {
	const store = new Map<string, string>();
	Object.defineProperty(g, "localStorage", {
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
		},
		configurable: true,
	});
	return store;
}

function installFetch(
	handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
	Object.defineProperty(g, "fetch", { value: handler, configurable: true });
}

describe("registry resolvePluginUiContribution", () => {
	test("returns undefined for missing contributions", () => {
		expect(resolvePluginUiContribution(params)).toBeUndefined();
		expect(resolvePluginUiContributionDetailed(params)).toEqual({
			contribution: undefined,
			missing: true,
		});
		expect(hasPluginUiContribution(params.pluginId, params.contributionId)).toBe(false);
	});

	test("resolves a registered contribution with full identity fields", () => {
		const unregister = registerPluginUiContribution({
			pluginId: params.pluginId,
			contributionId: params.contributionId,
			version: "1.0.0",
			title: "Review Dashboard",
			pluginName: "Review Plugin",
			contentHash: "hash-1",
			packageHash: "hash-1",
			entryPath: "ui/entry.js",
			stylePath: "ui/style.css",
			entryUrl: "/api/plugin-assets/com.example.review/1/hash-1/entry.js",
			styleUrl: "/api/plugin-assets/com.example.review/1/hash-1/style.css",
			status: "available",
		});
		const contribution = resolvePluginUiContribution(params);
		expect(contribution).toEqual({
			pluginId: params.pluginId,
			contributionId: params.contributionId,
			version: "1.0.0",
			title: "Review Dashboard",
			pluginName: "Review Plugin",
			contentHash: "hash-1",
			packageHash: "hash-1",
			entryPath: "ui/entry.js",
			stylePath: "ui/style.css",
			entryUrl: "/api/plugin-assets/com.example.review/1/hash-1/entry.js",
			styleUrl: "/api/plugin-assets/com.example.review/1/hash-1/style.css",
			status: "available",
			unavailableReason: undefined,
		});
		expect(resolvePluginUiContributionDetailed(params).missing).toBe(false);
		unregister();
		expect(resolvePluginUiContribution(params)).toBeUndefined();
	});

	test("maps non-available statuses through the store", () => {
		registerPluginUiContribution({
			pluginId: params.pluginId,
			contributionId: params.contributionId,
			version: "1.0.0",
			title: "Review Dashboard",
			entryUrl: "",
			status: "denied",
			unavailableReason: "grant revoked",
		});
		expect(resolvePluginUiContribution(params)?.status).toBe("denied");
		expect(resolvePluginUiContribution(params)?.unavailableReason).toBe("grant revoked");
	});
});

describe("syncPluginUiContributions", () => {
	test("does nothing when no token is present", async () => {
		installMapLocalStorage();
		let fetchCalls = 0;
		installFetch(async () => {
			fetchCalls += 1;
			return new Response("[]", { status: 200 });
		});
		expect(await syncPluginUiContributions()).toBe(0);
		expect(fetchCalls).toBe(0);
	});

	test("replaces the store with the backend snapshot", async () => {
		const storage = installMapLocalStorage();
		storage.set("narrafork_token", "token-1");
		installFetch(async (input) => {
			expect(String(input)).toBe("/api/plugins/ui/contributions");
			return new Response(
				JSON.stringify([
					{
						pluginId: "p1",
						contributionId: "v1",
						version: "1.0.0",
						hash: "h1",
						title: "View 1",
						entryPath: "e1.js",
						stylePath: "s1.css",
						status: "available",
					},
					{
						pluginId: "p2",
						contributionId: "v2",
						version: "2.0.0",
						hash: "h2",
						title: "View 2",
						status: "disabled",
					},
				]),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});
		expect(await syncPluginUiContributions()).toBe(2);
		expect(pluginContributionStore.get("p1", "v1")?.availability).toBe("available");
		expect(pluginContributionStore.get("p2", "v2")?.availability).toBe("disabled");
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
	});

	test("keeps previous records and records an error when the backend fails", async () => {
		const storage = installMapLocalStorage();
		storage.set("narrafork_token", "token-1");
		pluginContributionStore.applySnapshot([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "View 1",
				status: "available",
			},
		]);
		installFetch(async () => new Response("Server Error", { status: 500 }));
		expect(await syncPluginUiContributions()).toBe(0);
		expect(pluginContributionStore.get("p1", "v1")).toBeDefined();
		expect(pluginContributionStore.getSnapshot().status).toBe("error");
	});
});

describe("invalidatePluginUiContributions", () => {
	test("marks the store stale so the next sync refetches", () => {
		pluginContributionStore.applySnapshot([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1",
				hash: "h1",
				title: "View 1",
				status: "available",
			},
		]);
		invalidatePluginUiContributions();
		expect(pluginContributionStore.getSnapshot().synced).toBe(false);
		expect(pluginContributionStore.get("p1", "v1")).toBeDefined();
	});
});

describe("applyPluginUiContributionItems", () => {
	test("applies typed API items directly", () => {
		applyPluginUiContributionItems([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1.0.0",
				hash: "h1",
				title: "View 1",
				entryPath: "e.js",
				stylePath: "s.css",
				status: "available",
			},
		]);
		expect(resolvePluginUiContribution(params)).toBeUndefined();
		expect(pluginContributionStore.get("p1", "v1")).toEqual({
			pluginId: "p1",
			contributionId: "v1",
			version: "1.0.0",
			hash: "h1",
			title: "View 1",
			entryPath: "e.js",
			stylePath: "s.css",
			availability: "available",
			unavailableReason: undefined,
		});
	});
});
