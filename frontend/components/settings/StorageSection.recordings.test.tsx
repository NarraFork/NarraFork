import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import {
	api,
	type BlockBackfillStatus,
	type DatabaseCleanupPreviewResult,
	type DatabaseStorageBreakdown,
	type StorageScanResult,
} from "../../lib/api";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";
import { BlockBackfillCard } from "./BlockBackfillCard";

let databaseSupported = false;

mock.module("../../hooks/usePlatform", () => ({
	useDatabaseCapability: () => ({ supported: databaseSupported }),
	useStorageCapability: () => ({
		scanSupported: false,
		cachedSupported: true,
		vacuumSupported: false,
		healthState: "ready",
		healthReady: true,
		healthFetching: false,
		refetchHealth: async () => {},
	}),
	useStorageCleanupOperationCapabilities: () =>
		Object.fromEntries(
			["uploads", "chatAttachments", "shares", "worktrees", "containers"].map((key) => [
				key,
				{ supported: true },
			]),
		),
	useStorageDatabaseCleanupCapabilities: () =>
		Object.fromEntries(
			["archivedSessions", "staleSessions", "toolCallPayloads"].map((key) => [
				key,
				{ supported: databaseSupported },
			]),
		),
	useStorageDatabasePreviewCapability: () => ({ supported: databaseSupported }),
}));
mock.module("../common/confirm-dialog-context", () => ({
	useConfirmDialog: () => async () => true,
}));
const { StorageSection } = await import("./StorageSection");

const result: StorageScanResult = {
	totalBytes: 3072,
	scannedAt: 1_760_000_000_000,
	categories: [
		{ key: "requestRecordings", sizeBytes: 1024, details: { fileCount: 3 } },
		{ key: "savedRequestRecordings", sizeBytes: 2048, details: { fileCount: 7 } },
	],
};
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let client: QueryClient;
let cached: ReturnType<typeof spyOn<typeof api, "getCachedStorage">>;
let status: ReturnType<typeof spyOn<typeof api, "getStorageScanStatus">>;
let cleanup: ReturnType<typeof spyOn<typeof api, "cleanupStorage">>;

class TestObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: TestObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		matchMedia,
		localStorage: { getItem: () => null },
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	databaseSupported = false;
	root = createRoot(document.body.appendChild(document.createElement("div")));
	client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(["settings"], {});
	cached = spyOn(api, "getCachedStorage").mockResolvedValue({ cached: true, data: result });
	status = spyOn(api, "getStorageScanStatus").mockResolvedValue({
		state: {
			status: "idle",
			progressMessage: null,
			progressDetail: null,
			categories: [],
			result: null,
			error: null,
			startedAt: null,
			finishedAt: null,
			categoryJobs: [],
		},
	});
	cleanup = spyOn(api, "cleanupStorage");
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	for (const spy of [cached, status, cleanup]) spy.mockRestore();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => mock.restore());

async function flush() {
	await act(async () => {
		for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function render(node: ReactNode = <StorageSection />, language = "en") {
	const i18n = createInstance();
	await i18n.init({
		lng: language,
		resources: { en: { settings: en }, "zh-CN": { settings: zh } },
		react: { useSuspense: false },
	});
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
	return i18n;
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
	const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === text);
	if (!element) throw new Error(`Missing button ${text}`);
	return element;
}

async function click(element: HTMLElement | null | undefined) {
	if (!element) throw new Error("Missing click target");
	await act(async () => element.click());
	await flush();
}

test.each([
	"en",
	"zh-CN",
])("actual storage cards show service recording categories and never expose generic cleanup in %s", async (language) => {
	const labels = language === "en" ? en : zh;
	const i18n = await render(<StorageSection />, language);
	expect(cached).toHaveBeenCalledTimes(1);
	expect(document.querySelectorAll("[data-storage-category]")).toHaveLength(10);
	const checks = [
		[
			"requestRecordings",
			labels.storageRequestRecordings,
			labels.storageRequestRecordingsDesc,
			"1.0 KB",
			3,
		],
		[
			"savedRequestRecordings",
			labels.storageSavedRequestRecordings,
			labels.storageSavedRequestRecordingsDesc,
			"2.0 KB",
			7,
		],
	] as const;
	for (const [key, label, description, size, count] of checks) {
		const card = document.querySelector(`[data-storage-category="${key}"]`);
		expect(card).not.toBeNull();
		expect(card?.textContent).toContain(label);
		expect(card?.textContent).toContain(description);
		expect(card?.textContent).toContain(size);
		expect(card?.textContent).toContain(
			i18n.t("storageRequestDumpFileCount", { ns: "settings", count }),
		);
		expect(card?.querySelector("svg")).not.toBeNull();
		expect(card?.querySelector("button")).toBeNull();
	}
	expect(document.querySelector('[data-storage-category="savedRequestDumps"]')).toBeNull();
	expect(document.body.textContent).not.toContain("storageSavedRequestRecordings");
	expect(cleanup).not.toHaveBeenCalled();
});

function sessionPreview(
	target: "archivedSessions" | "staleSessions",
): DatabaseCleanupPreviewResult {
	return {
		target,
		approxBytes: 2048,
		oldestAt: "2025-01-01T00:00:00.000Z",
		counts: {
			sessions: 2,
			narrators: 3,
			descendantNarrators: 1,
			messages: 5,
			toolCalls: 7,
			apiRequests: 4,
		},
		blockedCount: 0,
		warningCodes: [],
		samples: [
			{
				type: "narrator",
				id: target,
				title: `${target} sample`,
				descendantNarratorCount: 1,
			},
		],
		blocked: [],
	};
}

async function showSessionMaintenance(supported = true) {
	databaseSupported = supported;
	const summary = { count: 2, approxBytes: 2048, blockedCount: 0, oldestAt: null };
	const details = {
		mainBytes: 4096,
		walBytes: 0,
		shmBytes: 0,
		cleanupCandidates: {
			archivedSessions: summary,
			staleSessions: { ...summary, retentionDays: 90 },
			toolCallPayloads: { ...summary, count: 7, retentionDays: 180 },
		},
	} satisfies DatabaseStorageBreakdown;
	cached.mockResolvedValue({
		cached: true,
		data: {
			...result,
			categories: [{ key: "database", sizeBytes: 4096, details }],
		},
	});
	await render();
	await click(button(en.storageDatabase));
	await click(button(en.storageRetentionSessionMaintenance));
	const previewButtons = [...document.querySelectorAll("button")].filter(
		(item) => item.textContent === en.storageDatabasePreview,
	);
	expect(previewButtons).toHaveLength(2);
	expect(document.body.textContent).toContain(en.storageDatabaseTarget_archivedSessions);
	expect(document.body.textContent).toContain(en.storageDatabaseTarget_staleSessions);
	expect(document.body.textContent).not.toContain(en.storageDatabaseTarget_toolCallPayloads);
	return previewButtons;
}

test.each([
	"archivedSessions",
	"staleSessions",
] as const)("session maintenance previews and cleans %s without tool-payload UI", async (target) => {
	const response = sessionPreview(target);
	const preview = spyOn(api, "previewDatabaseCleanup").mockResolvedValue(response);
	const execute = spyOn(api, "cleanupDatabase").mockResolvedValue({
		...response,
		ok: true,
		beforeBytes: 4096,
		afterBytes: 2048,
		freedBytes: 2048,
		vacuumRan: false,
		changed: true,
	});
	try {
		const previewButtons = await showSessionMaintenance();
		await click(previewButtons[target === "archivedSessions" ? 0 : 1]);
		expect(preview).toHaveBeenCalledWith({
			target,
			olderThanDays: target === "staleSessions" ? 90 : undefined,
			sampleLimit: 8,
		});
		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		if (!dialog) throw new Error("Missing session cleanup dialog");
		expect(dialog?.textContent).toContain(`${target} sample`);
		expect(dialog?.textContent).toContain(en.storageDatabaseSampleSessions);
		expect(dialog?.textContent).not.toContain(en.storageDatabaseSampleToolCalls);
		expect(dialog?.querySelector("input") !== null).toBe(target === "staleSessions");
		const cleanupButton = button(en.storageDatabaseCleanupAction, dialog);
		expect(cleanupButton.disabled).toBe(false);
		await click(cleanupButton);
		expect(execute).toHaveBeenCalledWith({
			target,
			olderThanDays: target === "staleSessions" ? 90 : undefined,
		});
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	} finally {
		preview.mockRestore();
		execute.mockRestore();
	}
});

test("session maintenance retains preview capability checks", async () => {
	const preview = spyOn(api, "previewDatabaseCleanup");
	try {
		const previewButtons = await showSessionMaintenance(false);
		for (const item of previewButtons) {
			expect(item.disabled).toBe(true);
			await click(item);
		}
		expect(preview).not.toHaveBeenCalled();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	} finally {
		preview.mockRestore();
	}
});

test("closing a session preview ignores its late response after opening another target", async () => {
	let finish!: (preview: DatabaseCleanupPreviewResult) => void;
	const preview = spyOn(api, "previewDatabaseCleanup")
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		)
		.mockResolvedValue(sessionPreview("archivedSessions"));
	try {
		const previewButtons = await showSessionMaintenance();
		await click(previewButtons[1]);
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
			en.storageDatabasePreviewLoading,
		);
		const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button');
		expect(close).not.toBeNull();
		await click(close);
		await click(previewButtons[0]);
		await act(async () => finish(sessionPreview("staleSessions")));
		await flush();
		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("archivedSessions sample");
		expect(dialog?.textContent).not.toContain("staleSessions sample");
		expect(dialog?.querySelector("input")).toBeNull();
	} finally {
		preview.mockRestore();
	}
});

test.each([
	"en",
	"zh-CN",
])("automatic optimization shows only one brief running status in %s", async (language) => {
	const labels = language === "en" ? en : zh;
	const job = {
		cursor: 20,
		complete: false,
		paused: false,
		processed: 20,
		updatedAt: "2026-01-01",
	};
	const status: BlockBackfillStatus = {
		available: true,
		convert: job,
		verify: job,
		reindex: job,
		clear: job,
		restore: job,
		blocked: { clear: null, restore: null },
		rowsOnly: true,
		projectionRunning: false,
		maxRowid: 100,
		diagnostics: 0,
		running: true,
	};
	const backfill = spyOn(api, "getBlockBackfillStatus").mockResolvedValue({ status });
	try {
		await render(<BlockBackfillCard />, language);
		expect(backfill).toHaveBeenCalledTimes(1);
		for (const flags of [
			{ available: true, running: true, projectionRunning: false },
			{ available: true, running: false, projectionRunning: true },
			{ available: true, running: true, projectionRunning: true },
			{ available: true, running: false, projectionRunning: false },
			{ available: false, running: true, projectionRunning: true },
		]) {
			await act(async () =>
				client.setQueryData(["storage", "block-backfill"], { ...status, ...flags }),
			);
			await flush();
			const card = document.querySelector("[data-storage-blocks]");
			if (!flags.available || (!flags.running && !flags.projectionRunning)) {
				expect(card).toBeNull();
				continue;
			}
			expect(card?.textContent).toBe(labels.storageBlocksOptimizing);
			expect(card?.querySelectorAll(".mantine-Loader-root")).toHaveLength(1);
			expect(card?.querySelectorAll('button, input, [role="progressbar"]')).toHaveLength(0);
		}
	} finally {
		backfill.mockRestore();
	}
});
