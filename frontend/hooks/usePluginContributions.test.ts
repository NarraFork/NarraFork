import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { pluginContributionStore } from "../components/plugins/PluginContributionStore";
import { PluginOverlayHost } from "../components/plugins/PluginOverlayHost";
import {
	clearPluginUiContributions,
	invalidatePluginUiContributions,
	syncPluginUiContributions,
} from "../components/plugins/registry";
import type { PluginUiContributionItem } from "../lib/api/plugins";
import { toPluginContributionRecords, usePluginContributions } from "./usePluginContributions";
import { pluginKeys } from "./usePlugins";

const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
let client: QueryClient | undefined;
afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	client?.clear();
	client = undefined;
	clearPluginUiContributions();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

async function mountOverlay(read: () => Promise<PluginUiContributionItem[]>, withAppOwner = false) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const storage = new Map<string, string>([["narrafork_token", "plugin-query-test"]]);
	Object.defineProperty(window, "location", {
		value: new URL("http://localhost/"),
		configurable: true,
	});
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (input: RequestInfo | URL) => {
			if (String(input) === "/api/plugins/ui/contributions") return Response.json(await read());
			if (String(input) === "/api/auth/me")
				return Response.json({ id: "plugin-user", username: "plugin-test", role: "user" });
			throw new Error(`Unexpected plugin fixture request: ${String(input)}`);
		},
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: 5_000, retry: false, gcTime: Infinity } },
	});
	client = queryClient;
	const i18n = createInstance();
	await i18n.init({ lng: "en", resources: { en: { plugins: {} } } });
	root = createRoot(document.body.appendChild(document.createElement("div")));
	function AppOwner() {
		usePluginContributions();
		return null;
	}
	await act(async () =>
		root?.render(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(
					QueryClientProvider,
					{ client: queryClient },
					createElement(
						Fragment,
						null,
						withAppOwner ? createElement(AppOwner) : null,
						createElement(PluginOverlayHost),
					),
				),
			),
		),
	);
	return queryClient;
}

async function flushQueryEffects() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function queryContribution(
	title = "View 1",
	status: PluginUiContributionItem["status"] = "available",
): PluginUiContributionItem {
	return {
		pluginId: "com.example.query",
		contributionId: "settings",
		version: "1.0.0",
		hash: "query-hash",
		title,
		entryPath: "ui/entry.js",
		surfaces: ["settings"],
		status,
	};
}

describe("overlay contribution query ownership", () => {
	test("a standalone overlay bootstraps its real contribution query", async () => {
		let reads = 0;
		await mountOverlay(async () => {
			reads++;
			return [];
		});
		await flushQueryEffects();
		expect(reads).toBe(1);
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
	});

	test("App and overlay share one pending read and one invalidation read", async () => {
		let reads = 0;
		let release: ((items: PluginUiContributionItem[]) => void) | undefined;
		const pending = new Promise<PluginUiContributionItem[]>((resolve) => {
			release = resolve;
		});
		const qc = await mountOverlay(async () => {
			reads++;
			return reads === 1 ? pending : [];
		}, true);
		expect(reads).toBe(1);
		expect(pluginContributionStore.getSnapshot().synced).toBe(false);
		await act(async () => release?.([]));
		await flushQueryEffects();
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
		await act(async () => {
			invalidatePluginUiContributions();
			await qc?.invalidateQueries({ queryKey: pluginKeys.uiContributions });
		});
		await flushQueryEffects();
		expect(reads).toBe(2);
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
	});

	test("real invalidation replaces changed view availability for both subscribers", async () => {
		let reads = 0;
		const qc = await mountOverlay(
			async () => [queryContribution("View 1", ++reads === 1 ? "available" : "disabled")],
			true,
		);
		await flushQueryEffects();
		expect(pluginContributionStore.get("com.example.query", "settings")?.availability).toBe(
			"available",
		);
		await act(async () => {
			invalidatePluginUiContributions();
			await qc.invalidateQueries({ queryKey: pluginKeys.uiContributions });
		});
		await flushQueryEffects();
		expect(reads).toBe(2);
		expect(pluginContributionStore.get("com.example.query", "settings")?.availability).toBe(
			"disabled",
		);
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
	});

	test("the existing reconnect sync updates an already-mounted Query-owned overlay", async () => {
		let reads = 0;
		await mountOverlay(
			async () => [queryContribution(++reads === 1 ? "Before reconnect" : "After reconnect")],
			true,
		);
		await flushQueryEffects();
		expect(reads).toBe(1);
		await act(async () => {
			await syncPluginUiContributions();
		});
		await flushQueryEffects();
		expect(reads).toBe(2);
		expect(pluginContributionStore.get("com.example.query", "settings")?.title).toBe(
			"After reconnect",
		);
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
	});

	test("a failed invalidation keeps old records unsynced until an equal successful reread", async () => {
		let reads = 0;
		let fail = false;
		const qc = await mountOverlay(async () => {
			reads++;
			if (fail) throw Object.assign(new Error("plugin snapshot unavailable"), { status: 503 });
			return [queryContribution()];
		}, true);
		await flushQueryEffects();
		const data = qc.getQueryData(pluginKeys.uiContributions);
		fail = true;
		await act(async () => {
			invalidatePluginUiContributions();
			await qc.invalidateQueries({ queryKey: pluginKeys.uiContributions });
		});
		await flushQueryEffects();
		expect(reads).toBe(2);
		expect(pluginContributionStore.get("com.example.query", "settings")?.title).toBe("View 1");
		expect(pluginContributionStore.getSnapshot()).toMatchObject({ synced: false, status: "error" });
		fail = false;
		await act(async () => {
			await qc.invalidateQueries({ queryKey: pluginKeys.uiContributions });
		});
		await flushQueryEffects();
		expect(reads).toBe(3);
		expect(qc.getQueryData(pluginKeys.uiContributions)).toBe(data);
		expect(pluginContributionStore.getSnapshot()).toMatchObject({
			synced: true,
			status: "ready",
			error: undefined,
		});
	});
});

describe("toPluginContributionRecords", () => {
	test("maps backend items to host-owned records with availability", () => {
		const items: PluginUiContributionItem[] = [
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
			{
				pluginId: "p2",
				contributionId: "v2",
				version: "2.0.0",
				hash: "h2",
				title: "View 2",
				status: "disabled",
			},
		];
		expect(toPluginContributionRecords(items)).toEqual([
			{
				pluginId: "p1",
				contributionId: "v1",
				version: "1.0.0",
				hash: "h1",
				title: "View 1",
				entryPath: "e.js",
				stylePath: "s.css",
				availability: "available",
				unavailableReason: undefined,
			},
			{
				pluginId: "p2",
				contributionId: "v2",
				version: "2.0.0",
				hash: "h2",
				title: "View 2",
				entryPath: undefined,
				stylePath: undefined,
				availability: "disabled",
				unavailableReason: "Plugin UI package is not enabled",
			},
		]);
	});
});

describe("pluginKeys.uiContributions", () => {
	test("uses the shared React Query key for contribution snapshots", () => {
		expect(pluginKeys.uiContributions).toEqual(["plugins", "ui-contributions"]);
	});
});

describe("usePluginContributions store integration contract", () => {
	test("records applied through the store become resolvable contributions", () => {
		const items: PluginUiContributionItem[] = [
			{
				pluginId: "com.example.review",
				contributionId: "dashboard",
				version: "1.0.0",
				hash: "abc",
				title: "Dashboard",
				entryPath: "ui/entry.js",
				status: "available",
			},
		];
		pluginContributionStore.applyRecords(toPluginContributionRecords(items));
		const record = pluginContributionStore.get("com.example.review", "dashboard");
		expect(record?.availability).toBe("available");
		expect(record?.entryPath).toBe("ui/entry.js");
		expect(pluginContributionStore.getSnapshot().synced).toBe(true);
	});
});
