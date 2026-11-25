import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { RuntimeModelSummary } from "@shared/model-runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	invalidateNugQuotaForIdentity,
	nugQuotaKey,
	useNugQuota,
} from "../components/narrator/model/use-nug-quota";
import { setToken } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { modelCatalogKeys, useModelOptions, useRuntimeModel } from "./useModelCatalog";
import {
	createRuntimeProjectionInvalidator,
	useRuntimeProjectionSync,
} from "./useRuntimeProjectionSync";
import { runtimeSettingsQueryOptions, useRuntimeSettings } from "./useRuntimeSettings";
import { useUpdateRuntimeSettings } from "./useUpdateRuntimeSettings";

const summary: RuntimeModelSummary = {
	selection: { value: "auto:x", label: "X" },
	state: "observed",
	concreteValue: "second:x",
	resolvedProvider: "second",
	resolvedBareModel: "x",
	revision: "one",
	settingsRevision: 1,
	observedAt: 1,
	reasoning: { supported: true, levels: ["low", "high"] },
};
let originals: Map<string, PropertyDescriptor | undefined>;
let qc: QueryClient;
let root: Root;
let model: string | undefined;
let narratorSummary: RuntimeModelSummary | undefined;
let revision: string | undefined;
let serverSummary: RuntimeModelSummary;
let opened: boolean;
let cursor: string | undefined;
let q: string;
let runtime: ReturnType<typeof useRuntimeModel>;
let options: ReturnType<typeof useModelOptions>;
let calls: string[];
let signals: Array<AbortSignal | null | undefined>;
let answer: ((value: Response) => void) | undefined;
let delay: boolean;
let updateRuntimeSettings: ReturnType<typeof useUpdateRuntimeSettings>;
let runtimeSettingsEnabled: boolean;
let syncEnabled: boolean;
let firstSettings: ReturnType<typeof useRuntimeSettings>;
let secondSettings: ReturnType<typeof useRuntimeSettings>;
const settingsProjection = {
	revision: 1,
	agent: { defaultModel: "auto:x", summaryModel: "auto:x" },
	outline: { enabled: false },
	requestEvidence: { autoPin: "off" as const },
	summaryModelAvailable: null,
};
let nugEnabled: boolean;
let nugModel: string | undefined;
let currentNugQuota: ReturnType<typeof useNugQuota>;
const nugProviders = [
	{ id: "first", prefix: "a", generation: 1 },
	{ id: "second", prefix: "b", generation: 1 },
];
function Harness() {
	useRuntimeProjectionSync(syncEnabled);
	useRuntimeModel({ model, narratorId: "session", summary: narratorSummary, revision });
	firstSettings = useRuntimeSettings(runtimeSettingsEnabled);
	secondSettings = useRuntimeSettings(runtimeSettingsEnabled);
	updateRuntimeSettings = useUpdateRuntimeSettings();
	currentNugQuota = useNugQuota(nugModel, nugProviders, nugEnabled);
	runtime = useRuntimeModel({ model, narratorId: "session", summary: narratorSummary, revision });
	options = useModelOptions({ q, cursor }, opened);
	return null;
}
async function flush() {
	await act(async () => {
		for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function render() {
	await act(async () =>
		root.render(
			<StrictMode>
				<QueryClientProvider client={qc}>
					<Harness />
				</QueryClientProvider>
			</StrictMode>,
		),
	);
	await flush();
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = new Map<string, string>([["narrafork_token", "actor-one"]]);
	model = undefined;
	narratorSummary = undefined;
	revision = undefined;
	serverSummary = summary;
	opened = false;
	cursor = undefined;
	q = "";
	calls = [];
	signals = [];
	delay = false;
	nugEnabled = false;
	runtimeSettingsEnabled = false;
	syncEnabled = false;
	nugModel = undefined;
	answer = undefined;
	const replacements = {
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		},
		fetch: (url: unknown, init?: RequestInit) => {
			calls.push(String(url));
			signals.push(init?.signal);
			if (String(url).includes("/settings/runtime"))
				return Promise.resolve(Response.json(settingsProjection));
			if (String(url).includes("/nug/quotas?"))
				return Promise.resolve(
					Response.json({
						generation: 1,
						quota: { balance: 5, totalGranted: 10, detailedQuotaBalance: null, fetchedAt: 1 },
					}),
				);
			if (delay)
				return new Promise<Response>((resolve) => {
					answer = resolve;
				});
			return Promise.resolve(
				Response.json(
					String(url).includes("/options")
						? {
								revision: "one",
								items: [{ value: "auto:x", label: "X", modelId: "x", sourceCount: 2 }],
								hasMore: true,
								nextCursor: "next",
							}
						: serverSummary,
				),
			);
		},
	};
	originals = new Map();
	for (const [key, value] of Object.entries(replacements)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root = createRoot(document.createElement("div"));
});
afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
test("a real settings marker retires the initial HTTP read and burst refreshes keep closed options idle", async () => {
	await render();
	const requests: Array<{ finish: (response: Response) => void; signal?: AbortSignal | null }> = [];
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		calls.push(String(url));
		return new Promise<Response>((finish) => requests.push({ finish, signal: init?.signal }));
	}) as unknown as typeof fetch;
	runtimeSettingsEnabled = true;
	syncEnabled = true;
	await render();
	expect(requests).toHaveLength(1);
	await act(async () => {
		for (let i = 0; i < 10; i++)
			narratorWSManager.dispatchLocalFrame({ type: "settings_runtime_changed", revision: 2 });
	});
	await flush();
	expect(requests).toHaveLength(2);
	expect(requests[0].signal?.aborted).toBe(true);
	requests[1].finish(Response.json({ ...settingsProjection, revision: 2 }));
	await flush();
	requests[0].finish(Response.json({ ...settingsProjection, revision: 1 }));
	await flush();
	expect(firstSettings.data?.revision).toBe(2);
	expect(calls.every((url) => url === "/api/settings/runtime")).toBe(true);
});
test("an initial WS revision reconciles a pending HTTP without a duplicate when it already satisfies the floor", async () => {
	await render();
	let finish!: (response: Response) => void;
	let signal: AbortSignal | null | undefined;
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		calls.push(String(url));
		signal = init?.signal;
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	}) as unknown as typeof fetch;
	runtimeSettingsEnabled = true;
	syncEnabled = true;
	await render();
	narratorWSManager.dispatchLocalFrame({
		type: "settings_runtime_changed",
		revision: 1,
		initial: true,
	});
	await flush();
	expect(calls).toHaveLength(1);
	expect(signal?.aborted).toBe(false);
	finish(Response.json(settingsProjection));
	await flush();
	expect(calls).toHaveLength(1);
	expect(firstSettings.data?.revision).toBe(1);
});
test("an initial WS revision newer than HTTP performs one bounded repair", async () => {
	await render();
	const requests: Array<(response: Response) => void> = [];
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return new Promise<Response>((resolve) => {
			requests.push(resolve);
		});
	}) as unknown as typeof fetch;
	runtimeSettingsEnabled = true;
	syncEnabled = true;
	await render();
	narratorWSManager.dispatchLocalFrame({
		type: "settings_runtime_changed",
		revision: 2,
		initial: true,
	});
	await flush();
	expect(calls).toHaveLength(1);
	requests[0](Response.json(settingsProjection));
	await flush();
	expect(calls).toHaveLength(2);
	requests[1](Response.json({ ...settingsProjection, revision: 2 }));
	await flush();
	expect(firstSettings.data?.revision).toBe(2);
});
test("reconnect resets revision floors so a restarted server may publish revision zero", async () => {
	await render();
	runtimeSettingsEnabled = true;
	await render();
	qc.setQueryData(runtimeSettingsQueryOptions().queryKey, { ...settingsProjection, revision: 100 });
	const invalidator = createRuntimeProjectionInvalidator(qc, "actor-one");
	invalidator.schedule(true, 100, true);
	let serverRevision = 0;
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		return Response.json({ ...settingsProjection, revision: serverRevision });
	}) as unknown as typeof fetch;
	invalidator.resetEpoch();
	invalidator.schedule(true);
	await flush();
	expect(firstSettings.data?.revision).toBe(0);
	serverRevision = 1;
	invalidator.schedule(true, 1);
	await flush();
	expect(firstSettings.data?.revision).toBe(1);
	expect(calls).toHaveLength(3);
	invalidator.dispose();
});
test("disposed or replaced-principal invalidation queues cannot start a read", async () => {
	const first = createRuntimeProjectionInvalidator(qc, "actor-one");
	first.schedule(true, 2);
	first.dispose();
	const second = createRuntimeProjectionInvalidator(qc, "actor-one");
	second.schedule(true, 3);
	setToken("actor-two");
	await flush();
	second.dispose();
	expect(calls).toHaveLength(0);
});
test("runtime source markers refresh one exact narrator selection and reject the old HTTP source", async () => {
	model = "auto:x";
	narratorSummary = {
		...summary,
		state: "not-observed",
		concreteValue: null,
		resolvedProvider: null,
		resolvedBareModel: null,
		observedAt: undefined,
	};
	await render();
	expect(calls).toHaveLength(0);
	serverSummary = { ...summary, observedAt: 2 };
	narratorWSManager.dispatchLocalFrame({
		type: "runtime_model_changed",
		narratorId: "other-session",
	});
	await flush();
	expect(calls).toHaveLength(0);
	narratorWSManager.dispatchLocalFrame({ type: "runtime_model_changed", narratorId: "session" });
	await flush();
	expect(calls).toHaveLength(1);
	expect(runtime.data?.concreteValue).toBe("second:x");
	await flush();
	expect(calls).toHaveLength(1); // unchanged B has no server marker
	delay = true;
	void qc.invalidateQueries({ queryKey: ["model-catalog", "runtime"] });
	await flush();
	const staleAnswer = answer;
	const staleSignal = signals.at(-1);
	narratorWSManager.dispatchLocalFrame({ type: "runtime_model_changed", narratorId: "session" });
	await flush();
	expect(staleSignal?.aborted).toBe(true);
	const freshAnswer = answer;
	freshAnswer?.(
		Response.json({
			...summary,
			concreteValue: "third:x",
			resolvedProvider: "third",
			observedAt: 3,
		}),
	);
	await flush();
	staleAnswer?.(Response.json(summary));
	await flush();
	expect(runtime.data?.concreteValue).toBe("third:x");
	expect(calls).toHaveLength(3);
	expect(calls.every((url) => url.includes("/model-catalog/runtime?"))).toBe(true);
});
test("same-principal runtime settings observers share one request and never read full settings/auto/card", async () => {
	await render();
	model = "auto:x";
	narratorSummary = summary;
	runtimeSettingsEnabled = true;
	await render();
	expect(calls).toEqual(["/api/settings/runtime"]);
	expect(firstSettings.data).toEqual(settingsProjection);
	expect(secondSettings.data).toEqual(settingsProjection);
	expect(runtime.data?.concreteValue).toBe("second:x");
});
test("ordinary UI settings writes request the runtime response without replacing full settings", async () => {
	const complete = { systemPrompt: "management-only", providerSecrets: { unrelated: true } };
	qc.setQueryData(["settings"], complete);
	await render();
	const saved = {
		revision: 2,
		agent: { defaultModel: "b:x", summaryModel: "b:x" },
		outline: { enabled: false },
		requestEvidence: { autoPin: "off" as const },
		summaryModelAvailable: true,
	};
	let sent = "";
	globalThis.fetch = (async (url: unknown) => {
		sent = String(url);
		return Response.json(saved);
	}) as unknown as typeof fetch;
	await act(async () => {
		await updateRuntimeSettings.mutateAsync({ agent: { defaultModel: "b:x" } });
	});
	expect(sent).toBe("/api/settings?view=runtime");
	expect(qc.getQueryData(["settings"])).toEqual(complete);
	expect(qc.getQueryData(runtimeSettingsQueryOptions().queryKey)).toEqual(saved);
});
test("NUG quotas read only the current provider, and unknown auto reads none", async () => {
	nugEnabled = true;
	await render();
	expect(calls).toHaveLength(0);
	nugModel = "auto:x";
	await render();
	expect(calls).toHaveLength(0);
	nugModel = "b:x";
	await render();
	expect(calls).toHaveLength(1);
	const quotaUrl = new URL(calls[0], "http://test");
	expect(quotaUrl.pathname).toBe("/api/nug/quotas");
	expect(quotaUrl.searchParams.get("providerId")).toBe("second");
	expect(quotaUrl.searchParams.get("expectedGeneration")).toBe("1");
	expect(calls.some((url) => url.includes("/providers/second/quota"))).toBe(false);
});
test("one quota marker during the hook's initial read waits and performs one fresh tail read", async () => {
	await render();
	const requests: Array<{ finish: (response: Response) => void; signal?: AbortSignal | null }> = [];
	globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
		calls.push(String(url));
		return new Promise<Response>((finish) => {
			requests.push({ finish, signal: init?.signal });
		});
	}) as unknown as typeof fetch;
	nugEnabled = true;
	nugModel = "b:x";
	await render();
	expect(requests).toHaveLength(1);
	const refreshed = invalidateNugQuotaForIdentity(qc, {
		providerId: "second",
		generation: 1,
		token: "actor-one",
	});
	await flush();
	expect(requests).toHaveLength(1);
	expect(requests[0].signal?.aborted).toBe(false);
	requests[0].finish(
		Response.json({
			generation: 1,
			quota: { balance: 1, totalGranted: 1, detailedQuotaBalance: null, fetchedAt: 1 },
		}),
	);
	await flush();
	expect(requests).toHaveLength(2);
	requests[1].finish(
		Response.json({
			generation: 1,
			quota: { balance: 7, totalGranted: 7, detailedQuotaBalance: null, fetchedAt: 2 },
		}),
	);
	await refreshed;
	await flush();
	expect(currentNugQuota?.quotaBalance).toBe("7");
	expect(requests).toHaveLength(2);
});
test("quota push bursts coalesce without cancelling the current cached read", async () => {
	let finish!: () => void;
	const invalidate = spyOn(qc, "invalidateQueries").mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const identity = { providerId: "second", generation: 1, token: "actor-one" };
	try {
		const first = invalidateNugQuotaForIdentity(qc, identity);
		const duplicate = invalidateNugQuotaForIdentity(qc, identity);
		await flush();
		expect(invalidate).toHaveBeenCalledTimes(1);
		const tail = invalidateNugQuotaForIdentity(qc, identity);
		void invalidateNugQuotaForIdentity(qc, identity);
		await flush();
		expect(invalidate).toHaveBeenCalledTimes(1);
		finish();
		await flush();
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(invalidate.mock.calls[0]?.[1]).toEqual({ cancelRefetch: false });
		finish();
		await Promise.all([first, duplicate, tail]);
		expect(invalidate).toHaveBeenCalledTimes(2);
	} finally {
		invalidate.mockRestore();
	}
});
test("a late settings PATCH cannot write administrator data into the replacement token cache", async () => {
	await render();
	let finish!: (response: Response) => void;
	let sentSignal: AbortSignal | null | undefined;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		sentSignal = init?.signal;
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	}) as unknown as typeof fetch;
	const pending = updateRuntimeSettings
		.mutateAsync({ agent: { defaultModel: "admin:x" } })
		.catch((error: unknown) => error);
	await flush();
	await act(async () => setToken("actor-two"));
	finish(Response.json({ ...settingsProjection, update: { serverUrl: "admin-only" } }));
	await pending;
	await flush();
	expect(sentSignal?.aborted).toBe(true);
	expect(qc.getQueryData(runtimeSettingsQueryOptions().queryKey)).toBeUndefined();
	expect(qc.getQueryData(["settings"])).toBeUndefined();
});
test("quota invalidation cannot touch another token or generation", async () => {
	const older = nugQuotaKey("second", 1, "actor-one");
	const current = nugQuotaKey("second", 2, "actor-one");
	qc.setQueryData(older, { balance: 1 });
	qc.setQueryData(current, { balance: 2 });
	await invalidateNugQuotaForIdentity(qc, {
		providerId: "second",
		generation: 1,
		token: "actor-one",
	});
	expect(qc.getQueryState(older)?.isInvalidated).toBe(true);
	expect(qc.getQueryState(current)?.isInvalidated).toBe(false);
	setToken("actor-two");
	const otherActor = nugQuotaKey("second", 2, "actor-two");
	qc.setQueryData(otherActor, { balance: 3 });
	await invalidateNugQuotaForIdentity(qc, {
		providerId: "second",
		generation: 2,
		token: "actor-one",
	});
	expect(qc.getQueryState(otherActor)?.isInvalidated).toBe(false);
	expect(qc.getQueryState(current)?.isInvalidated).toBe(false);
	await invalidateNugQuotaForIdentity(qc, {
		providerId: "second",
		generation: 2,
		token: "actor-two",
	});
	expect(qc.getQueryState(otherActor)?.isInvalidated).toBe(true);
});
test("an unloaded narrator and closed menu cause no model requests", async () => {
	await render();
	expect(calls).toEqual([]);
});
test("the authorized narrator summary supplies the first screen, including StrictMode", async () => {
	model = "auto:x";
	narratorSummary = summary;
	await render();
	expect(calls).toEqual([]);
	expect(runtime.data?.concreteValue).toBe("second:x");
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["model-catalog", "runtime"] });
	});
	await flush();
	expect(calls).toHaveLength(1);
	expect(new URL(calls[0], "http://test").searchParams.get("narratorId")).toBe("session");
});
test("opening reads one bounded page, never drains nextCursor automatically", async () => {
	await render();
	opened = true;
	await render();
	expect(calls).toHaveLength(1);
	expect(options.data?.hasMore).toBe(true);
	await flush();
	expect(calls).toHaveLength(1);
	cursor = "next";
	await render();
	expect(calls).toHaveLength(2);
	expect(calls[1]).toContain("cursor=next");
	opened = false;
	await render();
	await qc.invalidateQueries({ queryKey: ["model-catalog", "options"] });
	await flush();
	expect(calls).toHaveLength(2);
});
test("a replaced narrator summary retires the older HTTP source", async () => {
	model = "auto:x";
	narratorSummary = summary;
	await render();
	delay = true;
	void qc.invalidateQueries({ queryKey: ["model-catalog", "runtime"] });
	await flush();
	const oldAnswer = answer;
	expect(signals.at(-1)?.aborted).toBe(false);
	narratorSummary = {
		...summary,
		revision: "two",
		observedAt: 2,
		concreteValue: "third:x",
		resolvedProvider: "third",
	};
	await render();
	expect(signals.at(-1)?.aborted).toBe(true);
	oldAnswer?.(Response.json(summary));
	await flush();
	expect(runtime.data?.concreteValue).toBe("third:x");
});
test("an older narrator GET cannot replace a later observed runtime response", async () => {
	model = "auto:x";
	narratorSummary = summary;
	await render();
	serverSummary = { ...summary, concreteValue: "latest:x", observedAt: 3 };
	await act(async () => {
		await qc.invalidateQueries({ queryKey: ["model-catalog", "runtime"] });
	});
	await flush();
	narratorSummary = { ...summary, concreteValue: "old:x", observedAt: 2 };
	await render();
	expect(runtime.data?.concreteValue).toBe("latest:x");
});
test("settings generation changes cannot reseed the old configured summary", async () => {
	model = "auto:x";
	narratorSummary = summary;
	revision = "1";
	await render();
	expect(calls).toHaveLength(0);
	serverSummary = { ...summary, settingsRevision: 2, concreteValue: "new-default:x" };
	revision = "2";
	await render();
	expect(calls).toHaveLength(1);
	expect(runtime.data?.concreteValue).toBe("new-default:x");
});
test("an unchanged summary object cannot become another principal's initial data", async () => {
	model = "auto:x";
	narratorSummary = summary;
	await render();
	delay = true;
	await act(async () => setToken("actor-two"));
	await flush();
	expect(runtime.data).toBeUndefined();
});
test("changing identity hides and aborts the old options response", async () => {
	await render();
	delay = true;
	opened = true;
	await render();
	const oldAnswer = answer;
	const oldSignal = signals.at(-1);
	await act(async () => setToken("actor-two"));
	await flush();
	expect(oldSignal?.aborted).toBe(true);
	expect(options.data).toBeUndefined();
	oldAnswer?.(
		Response.json({
			revision: "private",
			items: [{ value: "private:x", label: "private" }],
			nextCursor: null,
			hasMore: false,
		}),
	);
	await flush();
	expect(options.data).toBeUndefined();
	expect(modelCatalogKeys.options("actor-two", { q: "x" }).length).toBeLessThan(10);
});
