import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { RuntimeModelSummary } from "@shared/model-runtime";
import type { QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import {
	defaultScheduler,
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useNugQuota } from "../components/narrator/model/use-nug-quota";
import { confirmAuthUser, getAuthSnapshot, setToken } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { modelCatalogKeys, useModelOptions, useRuntimeModel } from "./useModelCatalog";
import {
	invalidateQuotaSnapshotRead,
	quotaSnapshotsOptions,
	quotaSnapshotsReadKey,
} from "./useQuotaSnapshots";
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
let pendingNotifications: number;
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
const nugScope = (generation = 1) => ({
	groupId: "second",
	cachedOnly: true,
	expectedGeneration: generation,
});
const nugResult = (balance = 5): QuotaSnapshotsResponse => ({
	entries: [
		{
			groupId: "second",
			prefix: "b",
			templateId: "nug",
			credentialId: "second-key",
			source: "probe",
			snapshot: {
				scope: "wallet",
				fetchedAt: 1,
				windows: [],
				balances: [{ unit: "", remaining: balance, total: 10 }],
			},
		},
	],
});
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
	pendingNotifications = 0;
	// Keep observer deliveries inside act's microtask lifetime. The default timer
	// can otherwise retain a React callback past restoration of the test's window.
	notifyManager.setScheduler((callback) => {
		pendingNotifications++;
		queueMicrotask(() => {
			try {
				callback();
			} finally {
				pendingNotifications--;
			}
		});
	});
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = new Map<string, string>();
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
			if (String(url).includes("/quota-snapshots?"))
				return Promise.resolve(Response.json(nugResult()));
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
	setToken("actor-one");
	qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root = createRoot(document.createElement("div"));
});
afterEach(async () => {
	try {
		await act(async () => {
			root.unmount();
			await qc.cancelQueries();
			qc.clear();
		});
		expect(pendingNotifications).toBe(0);
	} finally {
		notifyManager.setScheduler(defaultScheduler);
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
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
	const invalidator = createRuntimeProjectionInvalidator(qc, getAuthSnapshot().generation);
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
	const first = createRuntimeProjectionInvalidator(qc, getAuthSnapshot().generation);
	first.schedule(true, 2);
	first.dispose();
	const second = createRuntimeProjectionInvalidator(qc, getAuthSnapshot().generation);
	second.schedule(true, 3);
	setToken("actor-two");
	setToken("actor-one");
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
	expect(quotaUrl.pathname).toBe("/api/quota-snapshots");
	expect(quotaUrl.searchParams.get("groupId")).toBe("second");
	expect(quotaUrl.searchParams.get("cachedOnly")).toBe("true");
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
	const refreshed = invalidateQuotaSnapshotRead(qc, nugScope(), getAuthSnapshot().generation);
	await flush();
	expect(requests).toHaveLength(1);
	expect(requests[0].signal?.aborted).toBe(false);
	await act(async () => requests[0].finish(Response.json(nugResult(1))));
	await flush();
	expect(requests).toHaveLength(2);
	await act(async () => {
		requests[1].finish(Response.json(nugResult(7)));
		await refreshed;
	});
	await flush();
	expect(currentNugQuota?.entries[0]?.snapshot?.balances[0]?.remaining).toBe(7);
	expect(requests).toHaveLength(2);
});
test("quota push bursts share bounded cached HTTP reads without cancelling the active read", async () => {
	nugEnabled = true;
	nugModel = "b:x";
	await render();
	const requests: Array<{ finish: (response: Response) => void; signal?: AbortSignal | null }> = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
		new Promise<Response>((finish) => {
			requests.push({ finish, signal: init?.signal });
		})) as unknown as typeof fetch;
	const authGeneration = getAuthSnapshot().generation;
	const first = invalidateQuotaSnapshotRead(qc, nugScope(), authGeneration);
	const duplicate = invalidateQuotaSnapshotRead(qc, nugScope(), authGeneration);
	await flush();
	expect(requests).toHaveLength(1);
	expect(requests[0].signal?.aborted).toBe(false);
	await act(async () => requests[0].finish(Response.json(nugResult(6))));
	await flush();
	expect(requests).toHaveLength(2);
	await act(async () => {
		requests[1].finish(Response.json(nugResult(7)));
		await Promise.all([first, duplicate]);
	});
	await flush();
	expect(currentNugQuota?.entries[0]?.snapshot?.balances[0]?.remaining).toBe(7);
	expect(requests.every((request) => !request.signal?.aborted)).toBe(true);
});
test("a late settings PATCH cannot write administrator data or notify callbacks after A→B→A", async () => {
	await render();
	const oldKey = runtimeSettingsQueryOptions().queryKey;
	const onSettled = spyOn({ callback() {} }, "callback");
	let finish!: (response: Response) => void;
	let sentSignal: AbortSignal | null | undefined;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		sentSignal = init?.signal;
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	}) as unknown as typeof fetch;
	let pending!: Promise<unknown>;
	await act(async () => {
		pending = updateRuntimeSettings
			.mutateAsync({ agent: { defaultModel: "admin:x" } }, { onSettled })
			.catch((error: unknown) => error);
	});
	await flush();
	await act(async () => {
		confirmAuthUser(getAuthSnapshot().generation, "user-one");
		expect(sentSignal?.aborted).toBe(false);
		setToken("actor-two");
		setToken("actor-one");
	});
	await act(async () => {
		finish(Response.json({ ...settingsProjection, update: { serverUrl: "admin-only" } }));
		await pending;
	});
	await flush();
	expect(sentSignal?.aborted).toBe(true);
	expect(onSettled).not.toHaveBeenCalled();
	const currentKey = runtimeSettingsQueryOptions().queryKey;
	expect(currentKey).not.toEqual(oldKey);
	expect(qc.getQueryData(oldKey)).toBeUndefined();
	expect(qc.getQueryData(currentKey)).toBeUndefined();
	expect(qc.getQueryData(["settings"])).toBeUndefined();
});
test("quota invalidation cannot touch another auth or provider generation after A→B→A", async () => {
	const firstAuthGeneration = getAuthSnapshot().generation;
	const older = quotaSnapshotsReadKey(nugScope(1), firstAuthGeneration);
	const current = quotaSnapshotsReadKey(nugScope(2), firstAuthGeneration);
	qc.setQueryData(older, nugResult(1));
	qc.setQueryData(current, nugResult(2));
	await invalidateQuotaSnapshotRead(qc, nugScope(1), firstAuthGeneration);
	expect(qc.getQueryState(older)?.isInvalidated).toBe(true);
	expect(qc.getQueryState(current)?.isInvalidated).toBe(false);
	setToken("actor-two");
	const nextAuthGeneration = setToken("actor-one");
	const otherActor = quotaSnapshotsReadKey(nugScope(2), nextAuthGeneration);
	qc.setQueryData(otherActor, nugResult(3));
	await invalidateQuotaSnapshotRead(qc, nugScope(2), firstAuthGeneration);
	expect(qc.getQueryState(otherActor)?.isInvalidated).toBe(false);
	expect(qc.getQueryState(current)?.isInvalidated).toBe(false);
	await invalidateQuotaSnapshotRead(qc, nugScope(2), nextAuthGeneration);
	expect(qc.getQueryState(otherActor)?.isInvalidated).toBe(true);
});
test.each([
	200, 409,
])("a late scoped quota HTTP %s after A→B→A cannot populate data or invalidate runtime projections", async (status) => {
	await render();
	const oldGeneration = getAuthSnapshot().generation;
	const oldKey = quotaSnapshotsReadKey(nugScope(), oldGeneration);
	const oldSettings = runtimeSettingsQueryOptions(oldGeneration).queryKey;
	qc.setQueryData(oldSettings, settingsProjection);
	let finish!: (response: Response) => void;
	let sentSignal: AbortSignal | null | undefined;
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		sentSignal = init?.signal;
		return new Promise<Response>((resolve) => {
			finish = resolve;
		});
	}) as unknown as typeof fetch;
	// No observer cancellation: exercise the generation guard on the real HTTP path.
	const pending = qc
		.fetchQuery(quotaSnapshotsOptions(true, qc, nugScope()))
		.catch((error: unknown) => error);
	await flush();
	await act(async () => {
		setToken("actor-two");
		setToken("actor-one");
	});
	const currentSettings = runtimeSettingsQueryOptions().queryKey;
	const currentRuntime = modelCatalogKeys.runtime(getAuthSnapshot().generation, "auto:x");
	await act(async () => {
		qc.setQueryData(currentSettings, settingsProjection);
		qc.setQueryData(currentRuntime, summary);
	});
	expect(sentSignal?.aborted).toBe(false);
	await act(async () => {
		finish(
			Response.json(
				status === 200 ? nugResult(99) : { error: "stale", code: "MODEL_RUNTIME_STALE" },
				{ status },
			),
		);
		await pending;
	});
	await flush();
	expect(qc.getQueryData(oldKey)).toBeUndefined();
	expect(currentNugQuota).toBeNull();
	for (const key of [oldSettings, currentSettings, currentRuntime])
		expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
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
	const authGeneration = getAuthSnapshot().generation;
	expect(modelCatalogKeys.options(authGeneration, { q: "x" })).toEqual([
		"model-catalog",
		"options",
		authGeneration,
		"all",
		"x",
		"",
		"",
		"",
		40,
	]);
});
