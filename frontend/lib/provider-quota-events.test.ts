import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidatePluginQueries } from "../hooks/usePlugins";
import { narratorWSManager } from "./narrator-ws-manager";
import {
	dispatchProviderQuotaChanged,
	invalidateProviderQuotaQueries,
	subscribeProviderQuotaEvents,
} from "./provider-quota-events";

let client: QueryClient;
let previousWindow: PropertyDescriptor | undefined;
beforeEach(() => {
	client = new QueryClient();
	previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
	for (const key of [
		["provider-quotas", "provider", "p", "A"],
		["provider-quotas", "provider", "q", "B"],
		["provider-quotas", "list", [["p", "A"]]],
		["quota-snapshots", null, 1],
		["quota-snapshots", { groupId: "nug", cachedOnly: true, expectedGeneration: 1 }, 1],
		["provider-settings", "custom-api", "p"],
		["settings"],
		["admin", "settings"],
		["nug", "quotas"],
		["codex", "quota"],
		["commandcode", "usage"],
		["tokendance", "balance"],
	])
		client.setQueryData(key, {});
});
afterEach(() => {
	client.clear();
	mock.restore();
	if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
	else Reflect.deleteProperty(globalThis, "window");
});

test("quota changes invalidate Custom API identities and unified reads without cached-only platform reads", async () => {
	invalidateProviderQuotaQueries(client, ["p"]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(client.getQueryState(["quota-snapshots", null, 1])?.isInvalidated).toBe(true);
	expect(
		client.getQueryState([
			"quota-snapshots",
			{ groupId: "nug", cachedOnly: true, expectedGeneration: 1 },
			1,
		])?.isInvalidated,
	).toBe(false);
	expect(client.getQueryState(["provider-quotas", "provider", "p", "A"])?.isInvalidated).toBe(true);
	expect(client.getQueryState(["provider-quotas", "list", [["p", "A"]]])?.isInvalidated).toBe(true);
	expect(client.getQueryState(["provider-quotas", "provider", "q", "B"])?.isInvalidated).toBe(
		false,
	);
	for (const key of [
		["nug", "quotas"],
		["codex", "quota"],
		["commandcode", "usage"],
		["tokendance", "balance"],
	])
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
});

test("only bounded identity/version hints are dispatched, never snapshots or credentials", () => {
	const events: unknown[] = [];
	window.addEventListener("narrafork:provider-quota-changed", (event) =>
		events.push((event as CustomEvent).detail),
	);
	expect(
		dispatchProviderQuotaChanged({
			type: "provider_quota_changed",
			providerIds: ["p"],
			version: 3,
			data: { secret: "do not forward" },
		}),
	).toBe(true);
	expect(events).toEqual([{ providerIds: ["p"], version: 3 }]);
	dispatchProviderQuotaChanged({
		type: "provider_quota_changed",
		providerIds: [false],
		version: 4,
	});
	dispatchProviderQuotaChanged({
		type: "provider_quota_changed",
		providerIds: Array(1_025).fill("p"),
		version: 4,
	});
	expect(events).toHaveLength(1);
});

test("mounted quota queries share lifecycle listeners and release them on last unmount", () => {
	let frame!: (data: Record<string, unknown>) => void;
	let connection!: (connected: boolean, reconnect: boolean) => void;
	const remove = spyOn(narratorWSManager, "removeListener").mockImplementation(() => {});
	const add = spyOn(narratorWSManager, "addListener").mockImplementation((_options, callback) => {
		frame = callback;
		return { _id: 1 };
	});
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
		connection = callback;
		return () => {};
	});
	const disposeA = subscribeProviderQuotaEvents(client);
	const disposeB = subscribeProviderQuotaEvents(client);
	try {
		expect(add).toHaveBeenCalledTimes(1);
		frame({ type: "provider_quota_changed", providerIds: ["p"], version: 1 });
		expect(client.getQueryState(["provider-quotas", "provider", "p", "A"])?.isInvalidated).toBe(
			true,
		);
		expect(client.getQueryState(["provider-quotas", "provider", "q", "B"])?.isInvalidated).toBe(
			false,
		);
		window.dispatchEvent(
			new CustomEvent("narrafork:plugin-event", {
				detail: { type: "plugin:contributions_changed", kind: "quotaSources" },
			}),
		);
		expect(client.getQueryState(["provider-quotas", "provider", "q", "B"])?.isInvalidated).toBe(
			true,
		);
		expect(client.getQueryState(["settings"])?.isInvalidated).toBe(true);
		expect(client.getQueryState(["admin", "settings"])?.isInvalidated).toBe(true);
		client.setQueryData(["settings"], {});
		client.setQueryData(["admin", "settings"], {});
		client.setQueryData(["provider-quotas", "provider", "q", "B"], {});
		connection(true, true);
		expect(client.getQueryState(["provider-quotas", "provider", "q", "B"])?.isInvalidated).toBe(
			true,
		);
		expect(client.getQueryState(["nug", "quotas"])?.isInvalidated).toBe(false);
		expect(client.getQueryState(["settings"])?.isInvalidated).toBe(true);
		expect(client.getQueryState(["admin", "settings"])?.isInvalidated).toBe(true);
		disposeA();
		expect(remove).not.toHaveBeenCalled();
	} finally {
		disposeA();
		disposeB();
	}
	expect(remove).toHaveBeenCalledTimes(1);
});

test("public quota hints recover a disabled capability without requiring admin plugin events", () => {
	client.setQueryData(["settings"], { providerBalanceCapability: { enabled: false } });
	let frame!: (data: Record<string, unknown>) => void;
	spyOn(narratorWSManager, "addListener").mockImplementation((_options, callback) => {
		frame = callback;
		return { _id: 1 };
	});
	spyOn(narratorWSManager, "removeListener").mockImplementation(() => {});
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation(() => () => {});
	const dispose = subscribeProviderQuotaEvents(client);
	try {
		frame({ type: "provider_quota_changed", providerIds: ["p"], version: 2 });
		expect(client.getQueryState(["settings"])?.isInvalidated).toBe(true);
		expect(client.getQueryState(["admin", "settings"])?.isInvalidated).toBe(true);
		expect(client.getQueryState(["provider-quotas", "provider", "p", "A"])?.isInvalidated).toBe(
			true,
		);
		expect(client.getQueryState(["nug", "quotas"])?.isInvalidated).toBe(false);
	} finally {
		dispose();
	}
});

test("quotaSources lifecycle mutations invalidate data-only contributions without platform caches", () => {
	invalidatePluginQueries(client);
	expect(client.getQueryState(["settings"])?.isInvalidated).toBe(true);
	expect(client.getQueryState(["admin", "settings"])?.isInvalidated).toBe(true);
	expect(client.getQueryState(["provider-quotas", "provider", "p", "A"])?.isInvalidated).toBe(true);
	expect(client.getQueryState(["quota-snapshots", null, 1])?.isInvalidated).toBe(true);
	expect(client.getQueryState(["provider-settings", "custom-api", "p"])?.isInvalidated).toBe(true);
	for (const key of [
		["nug", "quotas"],
		["codex", "quota"],
		["commandcode", "usage"],
		["tokendance", "balance"],
	])
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
});
