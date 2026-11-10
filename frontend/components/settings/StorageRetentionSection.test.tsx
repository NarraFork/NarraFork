import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
	api,
	type StorageHistoryJob,
	type StorageHistoryJobs,
	type StorageHistoryPreview,
	type StorageRetentionSettings,
	type StorageRetentionTarget,
} from "@frontend/lib/api";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance, type i18n as I18nInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";
import { BlockBackfillCard } from "./BlockBackfillCard";
import {
	STORAGE_HISTORY_QUERY_KEY,
	StorageRetentionSection,
	storageHistoryCutoff,
} from "./StorageRetentionSection";

let root: Root;
let client: QueryClient;
let i18n: I18nInstance;
let server: { storageRetention: StorageRetentionSettings; providerReadiness: [] };
let jobs: StorageHistoryJobs;
const globals = new Map<string, PropertyDescriptor | undefined>();
let setNativeValue: (input: HTMLInputElement, value: string) => void;
let get: ReturnType<typeof spyOn<typeof api, "getStorageHistoryJobs">>;
let preview: ReturnType<typeof spyOn<typeof api, "previewStorageHistory">>;
let start: ReturnType<typeof spyOn<typeof api, "cleanupStorageHistory">>;
let cancel: ReturnType<typeof spyOn<typeof api, "cancelStorageHistory">>;
let settings: ReturnType<typeof spyOn<typeof api, "getSettings">>;
let save: ReturnType<typeof spyOn<typeof api, "updateSettings">>;
let scan: ReturnType<typeof spyOn<typeof api, "startStorageScan">>;
const settled = mock(() => {});

function job(target: StorageRetentionTarget = "toolCallPayloads"): StorageHistoryJob {
	return {
		id: `job-${target}`,
		target,
		cutoffAt: "2026-01-01T00:00:00.000Z",
		source: "manual",
		status: "running",
		processed: 12,
		cleared: 10,
		retained: 2,
		approxBytes: 2048,
		startedAt: "2026-01-02T00:00:00.000Z",
		finishedAt: null,
		error: null,
	};
}
function candidate(
	target: StorageRetentionTarget,
	cutoffAt: string,
	count = 42,
): StorageHistoryPreview {
	return {
		target,
		cutoffAt,
		count,
		approxBytes: 2048,
	};
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	setNativeValue = (input, value) => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		if (!setter) throw new Error("Missing input value setter");
		setter.call(input, value);
	};
	for (const name of ["attachEvent", "detachEvent", "select", "setSelectionRange"]) {
		const proto = window.HTMLInputElement.prototype;
		globals.set(`input:${name}`, Object.getOwnPropertyDescriptor(proto, name));
		Object.defineProperty(proto, name, { configurable: true, value: () => {} });
	}
	const matchMedia = () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	const getComputedStyle = () =>
		new Proxy({}, { get: (_target, key) => (key === "getPropertyValue" ? () => "" : "") });
	Object.assign(window, { matchMedia, getComputedStyle });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		Element: window.Element,
		Node: window.Node,
		Document: window.Document,
		ShadowRoot: class {},
		getComputedStyle,
		matchMedia,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0),
		cancelAnimationFrame: (id: Timer) => clearTimeout(id),
		localStorage: { getItem: () => null },
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	server = {
		providerReadiness: [],
		storageRetention: {
			toolCallPayloads: { retentionDays: null, autoCleanup: false },
			messageHistory: { retentionDays: null, autoCleanup: false },
		},
	};
	jobs = { toolCallPayloads: null, messageHistory: null };
	client.setQueryData(["settings"], server);
	settings = spyOn(api, "getSettings").mockImplementation(async () => server);
	save = spyOn(api, "updateSettings").mockImplementation(async (patch) => {
		const changes = patch.storageRetention as Partial<StorageRetentionSettings>;
		for (const target of ["toolCallPayloads", "messageHistory"] as const) {
			if (changes[target])
				server = {
					...server,
					storageRetention: {
						...server.storageRetention,
						[target]: { ...server.storageRetention[target], ...changes[target] },
					},
				};
		}
		return server;
	});
	get = spyOn(api, "getStorageHistoryJobs").mockImplementation(async () => ({ jobs }));
	preview = spyOn(api, "previewStorageHistory").mockImplementation(async (input) => ({
		preview: candidate(input.target, input.cutoffAt),
	}));
	start = spyOn(api, "cleanupStorageHistory").mockImplementation(async (input) => {
		const current = { ...job(input.target), cutoffAt: input.cutoffAt };
		jobs = { ...jobs, [input.target]: current };
		return { job: current };
	});
	cancel = spyOn(api, "cancelStorageHistory").mockImplementation(async (target) => {
		const current = {
			...job(target),
			status: "cancelled" as const,
			finishedAt: "2026-01-02T00:01:00.000Z",
		};
		jobs = { ...jobs, [target]: current };
		return { job: current };
	});
	scan = spyOn(api, "startStorageScan");
	settled.mockClear();
	i18n = createInstance();
	await i18n.init({
		lng: "en",
		resources: { en: { settings: en }, "zh-CN": { settings: zh } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	for (const spy of [get, preview, start, cancel, settings, save, scan]) spy.mockRestore();
	for (const [key, descriptor] of globals) {
		const object = key.startsWith("input:") ? HTMLInputElement.prototype : globalThis;
		const name = key.startsWith("input:") ? key.slice(6) : key;
		if (descriptor) Object.defineProperty(object, name, descriptor);
		else Reflect.deleteProperty(object, name);
	}
	globals.clear();
});

async function flush(ms = 10) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}
async function render(node: ReactNode = <StorageRetentionSection onSettled={settled} />) {
	await act(async () =>
		root.render(
			<I18nextProvider i18n={i18n}>
				<QueryClientProvider client={client}>
					<MantineProvider env="test">{node}</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		),
	);
	await flush();
}
function row(target: StorageRetentionTarget) {
	const element = document.querySelector(`[data-retention-target="${target}"]`);
	if (!element) throw new Error(`Missing row ${target}`);
	return element;
}
function button(target: StorageRetentionTarget, text: string): HTMLButtonElement {
	const element = [...row(target).querySelectorAll("button")].find(
		(element) => element.textContent === text,
	);
	if (!element) throw new Error(`Missing button ${text}`);
	return element;
}
async function click(element: HTMLElement) {
	await act(async () => element.click());
	await flush();
}
async function choose(target: StorageRetentionTarget, value: string) {
	const input = row(target).querySelector("select");
	if (!input) throw new Error("Missing retention selector");
	await act(async () => {
		Object.defineProperty(input, "value", { configurable: true, value });
		input.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
	await flush();
}
async function type(input: HTMLInputElement, value: string) {
	await act(async () => input.dispatchEvent(new window.Event("focusin", { bubbles: true })));
	await act(async () => {
		setNativeValue(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
		input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
	});
	await flush();
}
async function commitDays(input: HTMLInputElement, via: "blur" | "enter" = "blur") {
	await act(async () => {
		const event = new window.Event(via === "blur" ? "focusout" : "keydown", { bubbles: true });
		if (via === "enter") Object.defineProperty(event, "key", { value: "Enter" });
		input.dispatchEvent(event);
	});
	await flush();
}

async function open(target: StorageRetentionTarget = "toolCallPayloads") {
	await click(button(target, en.storageRetentionManual));
}
function dateInput(target: StorageRetentionTarget = "toolCallPayloads") {
	const input = row(target).querySelector<HTMLInputElement>('input[type="date"]');
	if (!input) throw new Error("Missing date input");
	return input;
}
function clearButton(target: StorageRetentionTarget = "toolCallPayloads") {
	const result = row(target).querySelector<HTMLButtonElement>("[data-history-cleanup] button");
	if (!result) throw new Error("Missing cleanup button");
	return result;
}

test.each([
	"en",
	"zh-CN",
])("renders two equal keep-all areas without requiring a scan in %s", async (language) => {
	await i18n.changeLanguage(language);
	await render();
	const labels = language === "en" ? en : zh;
	expect(document.querySelectorAll("[data-retention-target]")).toHaveLength(2);
	for (const target of ["toolCallPayloads", "messageHistory"] as const) {
		expect(row(target).textContent).toContain(labels[`storageRetentionTarget_${target}`]);
		expect(row(target).textContent).toContain(labels.storageRetentionAll);
		expect(row(target).querySelector('input[type="checkbox"]')).toBeNull();
		expect(button(target, labels.storageRetentionManual).disabled).toBe(false);
	}
	expect(save).not.toHaveBeenCalled();
	expect(scan).not.toHaveBeenCalled();
});

test("saves only relevant fields of the changed target; automatic switches remain independent", async () => {
	await render();
	await choose("toolCallPayloads", "90");
	expect(save.mock.calls[0][0]).toEqual({
		storageRetention: { toolCallPayloads: { retentionDays: 90 } },
	});
	await choose("messageHistory", "365");
	const toggle = row("toolCallPayloads").querySelector<HTMLInputElement>('input[type="checkbox"]');
	if (!toggle) throw new Error("Missing automatic cleanup switch");
	await act(async () => {
		toggle.checked = true;
		toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
	await flush();
	expect(save.mock.calls.at(-1)?.[0]).toEqual({
		storageRetention: { toolCallPayloads: { autoCleanup: true } },
	});
	expect(server.storageRetention.messageHistory).toEqual({
		retentionDays: 365,
		autoCleanup: false,
	});
	expect(server.storageRetention.toolCallPayloads).toEqual({
		retentionDays: 90,
		autoCleanup: true,
	});
	await choose("toolCallPayloads", "all");
	expect(save.mock.calls.at(-1)?.[0]).toEqual({
		storageRetention: { toolCallPayloads: { retentionDays: null, autoCleanup: false } },
	});
	expect(row("toolCallPayloads").querySelector('input[type="checkbox"]')).toBeNull();
});

test("custom retention saves valid days on blur and restores a saved custom value", async () => {
	server.storageRetention.messageHistory.retentionDays = 47;
	await render();
	const existing = row("messageHistory").querySelector<HTMLInputElement>(
		'input:not([type="checkbox"])',
	);
	expect(existing?.value).toBe("47");
	await choose("toolCallPayloads", "custom");
	const input = row("toolCallPayloads").querySelector<HTMLInputElement>(
		'input:not([type="checkbox"])',
	);
	if (!input) throw new Error("Missing custom days field");
	expect(input.value).toBe("");
	expect(save).not.toHaveBeenCalled();
	await type(input, "57");
	await flush(270);
	expect(save).not.toHaveBeenCalled();
	await commitDays(input);
	expect(save.mock.calls.at(-1)?.[0]).toEqual({
		storageRetention: { toolCallPayloads: { retentionDays: 57 } },
	});
	expect(server.storageRetention.messageHistory.retentionDays).toBe(47);
});

test("keep-all disables only its own automation and opening custom never saves an implicit 30-day rule", async () => {
	server.storageRetention = {
		toolCallPayloads: { retentionDays: 90, autoCleanup: true },
		messageHistory: { retentionDays: 365, autoCleanup: true },
	};
	await render();
	await choose("toolCallPayloads", "all");
	expect(save.mock.calls[0][0]).toEqual({
		storageRetention: { toolCallPayloads: { retentionDays: null, autoCleanup: false } },
	});
	expect(server.storageRetention.toolCallPayloads).toEqual({
		retentionDays: null,
		autoCleanup: false,
	});
	await choose("toolCallPayloads", "custom");
	const input = row("toolCallPayloads").querySelector<HTMLInputElement>(
		'input:not([type="checkbox"])',
	);
	if (!input) throw new Error("Missing custom days field");
	expect(input.value).toBe("");
	await flush(270);
	expect(save).toHaveBeenCalledTimes(1);
	expect(server.storageRetention.toolCallPayloads).toEqual({
		retentionDays: null,
		autoCleanup: false,
	});
	expect(server.storageRetention.messageHistory).toEqual({ retentionDays: 365, autoCleanup: true });
	await type(input, "365");
	await flush(270);
	expect(save).toHaveBeenCalledTimes(1);
	await commitDays(input);
	expect(save.mock.calls.at(-1)?.[0]).toEqual({
		storageRetention: { toolCallPayloads: { retentionDays: 365 } },
	});
	expect(server.storageRetention.toolCallPayloads).toEqual({
		retentionDays: 365,
		autoCleanup: false,
	});
	expect(server.storageRetention.messageHistory).toEqual({ retentionDays: 365, autoCleanup: true });
});

test.each([
	"blur",
	"enter",
] as const)("editing an existing custom rule keeps intermediate digits local until %s", async (via) => {
	server.storageRetention.toolCallPayloads = { retentionDays: 470, autoCleanup: true };
	server.storageRetention.messageHistory = { retentionDays: 365, autoCleanup: true };
	await render();
	const input = row("toolCallPayloads").querySelector<HTMLInputElement>(
		'input:not([type="checkbox"])',
	);
	if (!input) throw new Error("Missing saved custom days field");
	expect(input.value).toBe("470");
	await type(input, "4");
	await flush(270);
	expect(save).not.toHaveBeenCalled();
	expect(server.storageRetention.toolCallPayloads).toEqual({
		retentionDays: 470,
		autoCleanup: true,
	});
	await type(input, "400");
	await flush(270);
	expect(save).not.toHaveBeenCalled();
	await commitDays(input, via);
	expect(save).toHaveBeenCalledTimes(1);
	expect(save.mock.calls[0][0]).toEqual({
		storageRetention: { toolCallPayloads: { retentionDays: 400 } },
	});
	expect(server.storageRetention.toolCallPayloads).toEqual({
		retentionDays: 400,
		autoCleanup: true,
	});
	expect(server.storageRetention.messageHistory).toEqual({ retentionDays: 365, autoCleanup: true });
	await commitDays(input, via);
	expect(save).toHaveBeenCalledTimes(1);
});

test("manual cleanup previews the local-day boundary and starts that exact cutoff without saving rules or confirming twice", async () => {
	await render();
	await open();
	expect(preview).not.toHaveBeenCalled();
	await type(dateInput(), "2026-02-15");
	await flush(270);
	const cutoffAt = new Date(2026, 1, 15).toISOString();
	expect(preview.mock.calls.at(-1)?.[0]).toEqual({ target: "toolCallPayloads", cutoffAt });
	expect(row("toolCallPayloads").textContent).toContain("Matching: 42");
	expect(row("toolCallPayloads").textContent).toContain("About 2.0 KB");
	await click(clearButton());
	expect(start).toHaveBeenCalledTimes(1);
	expect(start).toHaveBeenCalledWith({ target: "toolCallPayloads", cutoffAt });
	expect(save).not.toHaveBeenCalled();
	expect(document.querySelector("[data-history-cleanup]")).toBeNull();
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	expect(row("toolCallPayloads").textContent).toContain("Cleaning · 10 cleared");
});

test("aborts an expired preview and ignores a late response even if transport disregards abort", async () => {
	const pending: {
		input: { target: StorageRetentionTarget; cutoffAt: string };
		signal?: AbortSignal;
		resolve: (result: { preview: StorageHistoryPreview }) => void;
	}[] = [];
	preview.mockImplementation(
		(input, signal) => new Promise((resolve) => pending.push({ input, signal, resolve })),
	);
	await render();
	await open();
	await type(dateInput(), "2026-02-01");
	await flush(270);
	expect(pending).toHaveLength(1);
	await type(dateInput(), "2026-03-01");
	expect(pending[0].signal?.aborted).toBe(true);
	expect(clearButton().disabled).toBe(true);
	await flush(270);
	expect(pending).toHaveLength(2);
	await act(async () =>
		pending[1].resolve({ preview: candidate("toolCallPayloads", pending[1].input.cutoffAt, 7) }),
	);
	await flush();
	expect(row("toolCallPayloads").textContent).toContain("Matching: 7");
	await act(async () =>
		pending[0].resolve({ preview: candidate("toolCallPayloads", pending[0].input.cutoffAt, 99) }),
	);
	await flush();
	expect(row("toolCallPayloads").textContent).not.toContain("Matching: 99");
	await click(clearButton());
	expect(start.mock.calls[0][0].cutoffAt).toBe(pending[1].input.cutoffAt);
});

test("leaving only stops observation; reopening discovers progress and cancellation refreshes statistics once", async () => {
	jobs.toolCallPayloads = job();
	await render();
	expect(row("toolCallPayloads").textContent).toContain("Cleaning · 10 cleared");
	await render(null);
	expect(cancel).not.toHaveBeenCalled();
	const previousCalls = get.mock.calls.length;
	jobs.toolCallPayloads = { ...job(), cleared: 25 };
	await render();
	expect(get.mock.calls.length).toBeGreaterThan(previousCalls);
	expect(row("toolCallPayloads").textContent).toContain("Cleaning · 25 cleared");
	const invalidate = spyOn(client, "invalidateQueries");
	await click(button("toolCallPayloads", en.storageRetentionCancel));
	expect(cancel).toHaveBeenCalledWith("toolCallPayloads");
	expect(settled).toHaveBeenCalledTimes(1);
	expect(
		invalidate.mock.calls.some(
			([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(["storage"]),
		),
	).toBe(true);
	expect(row("toolCallPayloads").textContent).toContain("Cancelled · 10 cleared");
	await act(async () => client.setQueryData(STORAGE_HISTORY_QUERY_KEY, { jobs: { ...jobs } }));
	await flush();
	expect(settled).toHaveBeenCalledTimes(1);
	invalidate.mockRestore();
});

test("discovers a cleanup accepted before its start response was lost", async () => {
	await render();
	await open("messageHistory");
	await flush(270);
	start.mockImplementation(async () => {
		jobs.messageHistory = job("messageHistory");
		throw new Error("Response lost");
	});
	await click(clearButton("messageHistory"));
	expect(row("messageHistory").textContent).toContain("Response lost");
	expect(row("messageHistory").textContent).toContain("Cleaning · 10 cleared");
	expect(button("messageHistory", en.storageRetentionManual).disabled).toBe(true);
});

test("serializes independent saves so delayed settings responses cannot overwrite the other row", async () => {
	let resolveFirst: (value: typeof server) => void = () => {};
	save.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveFirst = resolve;
			}),
	);
	await render();
	await choose("toolCallPayloads", "90");
	await choose("messageHistory", "365");
	expect(save).toHaveBeenCalledTimes(1);
	server = {
		...server,
		storageRetention: {
			...server.storageRetention,
			toolCallPayloads: { retentionDays: 90, autoCleanup: false },
		},
	};
	await act(async () => resolveFirst(server));
	await flush();
	expect(save).toHaveBeenCalledTimes(2);
	expect(client.getQueryData(["settings"])).toEqual(server);
	expect(server.storageRetention.toolCallPayloads.retentionDays).toBe(90);
	expect(server.storageRetention.messageHistory.retentionDays).toBe(365);
});

test("a stale settings GET cannot replace a newly saved retention rule", async () => {
	const old = structuredClone(server);
	let resolveGet: (value: typeof server) => void = () => {};
	let signal: AbortSignal | undefined;
	settings.mockImplementation((options) => {
		signal = (options as { signal?: AbortSignal }).signal;
		return new Promise((resolve) => {
			resolveGet = resolve;
		});
	});
	await render();
	await choose("messageHistory", "90");
	expect(signal?.aborted).toBe(true);
	await act(async () => resolveGet(old));
	await flush();
	expect(
		(client.getQueryData(["settings"]) as typeof server).storageRetention.messageHistory
			.retentionDays,
	).toBe(90);
});

test("blocks empty previews and starts no second request while cleanup is being accepted", async () => {
	preview.mockImplementation(async (input) => ({
		preview: candidate(input.target, input.cutoffAt, 0),
	}));
	await render();
	await open();
	await flush(270);
	expect(clearButton().disabled).toBe(true);
	expect(start).not.toHaveBeenCalled();
	await click(button("toolCallPayloads", en.storageRetentionManual));
	preview.mockImplementation(async (input) => ({
		preview: candidate(input.target, input.cutoffAt),
	}));
	await open();
	await flush(270);
	let finish: (value: { job: StorageHistoryJob }) => void = () => {};
	start.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const buttonElement = clearButton();
	await act(async () => {
		buttonElement.click();
		buttonElement.click();
	});
	await flush();
	expect(start).toHaveBeenCalledTimes(1);
	jobs.toolCallPayloads = job();
	await act(async () => finish({ job: job() }));
	await flush();
});

test.each([
	"completed",
	"failed",
] as const)("refreshes statistics after discovering a %s job on reentry", async (status) => {
	jobs.messageHistory = {
		...job("messageHistory"),
		status,
		finishedAt: "2026-01-02T00:01:00.000Z",
	};
	await render();
	expect(settled).toHaveBeenCalledTimes(1);
	await act(async () => client.setQueryData(STORAGE_HISTORY_QUERY_KEY, { jobs: { ...jobs } }));
	await flush();
	expect(settled).toHaveBeenCalledTimes(1);
	expect(cancel).not.toHaveBeenCalled();
});

test.each([
	"en",
	"zh-CN",
])("automatic optimization has only brief progress and disappears when complete in %s", async (language) => {
	await i18n.changeLanguage(language);
	const labels = language === "en" ? en : zh;
	const status = {
		available: true,
		convert: null,
		verify: null,
		reindex: null,
		clear: { cursor: 20, complete: false, paused: false, processed: 20, updatedAt: "2026-01-01" },
		restore: null,
		blocked: { clear: null, restore: null },
		rowsOnly: true,
		projectionRunning: true,
		maxRowid: 100,
		diagnostics: 0,
		running: false,
	};
	const backfill = spyOn(api, "getBlockBackfillStatus").mockResolvedValue({ status });
	const projection = spyOn(api, "runBlockProjectionAction");
	try {
		await render(<BlockBackfillCard />);
		expect(document.body.textContent).toContain(labels.storageBlocksOptimizing);
		expect(document.querySelector("[data-storage-blocks] button")).toBeNull();
		expect(document.body.textContent).not.toContain(labels.storageBlocksNeedsCompactJson);
		await act(async () =>
			client.setQueryData(["storage", "block-backfill"], {
				...status,
				projectionRunning: false,
				clear: { ...status.clear, complete: true },
			}),
		);
		await flush();
		expect(document.querySelector("[data-storage-blocks]")).toBeNull();
		expect(projection).not.toHaveBeenCalled();
	} finally {
		backfill.mockRestore();
		projection.mockRestore();
	}
});

test.each([
	"en",
	"zh-CN",
])("terminal results briefly account for retained candidates in %s", async (language) => {
	await i18n.changeLanguage(language);
	jobs.toolCallPayloads = { ...job(), status: "completed", cleared: 0, retained: 42 };
	await render();
	expect(row("toolCallPayloads").textContent).toContain(
		language === "en" ? "Done · 0 cleared · 42 retained" : "已完成 · 清理 0 项 · 保留 42 项",
	);
	jobs = {
		...jobs,
		toolCallPayloads: { ...jobs.toolCallPayloads, retained: 0 } as StorageHistoryJob,
	};
	await act(async () => client.setQueryData(STORAGE_HISTORY_QUERY_KEY, { jobs }));
	await flush();
	expect(row("toolCallPayloads").textContent).not.toContain(
		language === "en" ? "retained" : "保留 0 项",
	);
});

test("validates calendar dates and preserves local midnight", () => {
	expect(storageHistoryCutoff("2026-02-30")).toBeNull();
	expect(storageHistoryCutoff("not-a-date")).toBeNull();
	expect(storageHistoryCutoff("2026-02-15")).toBe(new Date(2026, 1, 15).toISOString());
});
