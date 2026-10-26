import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	ConfirmDialogContext,
	type ConfirmOptions,
} from "@frontend/components/common/confirm-dialog-context";
import {
	TOKEN_RECALCULATION_QUERY_KEY,
	tokenRecalculationApi,
} from "@frontend/lib/token-recalculation-api";
import locale from "@frontend/locales/en/common.json";
import zhLocale from "@frontend/locales/zh-CN/common.json";
import { MantineProvider } from "@mantine/core";
import type { TokenRecalculationJob } from "@shared/token-recalculation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { TokenRecalculationPanel } from "./TokenRecalculationPanel";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const testI18n = i18next.createInstance();
const strings = locale.tokenRecalculation;
let getSpy: ReturnType<typeof spyOn<typeof tokenRecalculationApi, "get">>;
let startSpy: ReturnType<typeof spyOn<typeof tokenRecalculationApi, "start">>;
let cancelSpy: ReturnType<typeof spyOn<typeof tokenRecalculationApi, "cancel">>;
const confirm = mock(async (_options: ConfirmOptions) => true);
const runningJob: TokenRecalculationJob = {
	id: "job-1",
	status: "running",
	startedAt: "2026-09-01T00:00:00Z",
	finishedAt: null,
	scanned: 10,
	processed: 8,
	changed: 6,
	skipped: 2,
	fallback: 1,
	error: null,
};

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		localStorage: { getItem: () => "admin-token" },
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent: () => false,
		}),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	await testI18n.use(initReactI18next).init({
		lng: "en",
		defaultNS: "common",
		resources: { en: { common: locale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	client.setQueryData(["auth", "me"], { id: "admin-1", role: "admin" });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	confirm.mockReset();
	confirm.mockResolvedValue(true);
	getSpy = spyOn(tokenRecalculationApi, "get").mockResolvedValue({ job: null });
	startSpy = spyOn(tokenRecalculationApi, "start").mockResolvedValue({ job: runningJob });
	cancelSpy = spyOn(tokenRecalculationApi, "cancel").mockResolvedValue({
		job: { ...runningJob, status: "cancelled", finishedAt: "2026-09-01T00:01:00Z" },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	getSpy.mockRestore();
	startSpy.mockRestore();
	cancelSpy.mockRestore();
	for (const [key, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originalGlobals.clear();
});

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

async function renderPanel(open = true) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={testI18n}>
				<QueryClientProvider client={client}>
					<MantineProvider env="test">
						<ConfirmDialogContext.Provider value={{ confirm }}>
							<TokenRecalculationPanel />
						</ConfirmDialogContext.Provider>
					</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		);
	});
	await flush();
	if (
		open &&
		[...document.body.querySelectorAll("button")].some((node) => node.textContent === strings.open)
	) {
		await click(strings.open);
	}
}

function button(label: string): HTMLButtonElement {
	const result = [...document.body.querySelectorAll("button")].find(
		(node) => node.textContent === label,
	);
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

async function click(label: string) {
	await act(async () => button(label).click());
	await flush();
}

describe("historical token recalculation panel", () => {
	test("does not render or fetch admin operations for ordinary users", async () => {
		client.setQueryData(["auth", "me"], { id: "user-1", role: "user" });
		await renderPanel();
		expect(document.body.textContent).not.toContain(strings.title);
		expect(document.body.querySelectorAll("button")).toHaveLength(0);
		expect(getSpy).not.toHaveBeenCalled();
		expect(startSpy).not.toHaveBeenCalled();
	});

	test("warns about ambiguous old values and confirms the entire scope exactly once", async () => {
		await renderPanel();
		expect(document.body.textContent).toContain(strings.warning);
		expect(document.body.textContent).toContain(strings.scope);
		expect(document.body.textContent).toContain(strings.skipNote);
		expect(document.body.textContent).toContain(strings.allHistory);
		getSpy.mockResolvedValue({ job: runningJob });
		await click(strings.start);
		expect(confirm).toHaveBeenCalledTimes(1);
		const message = confirm.mock.calls[0][0].message;
		const markup = renderToStaticMarkup(<MantineProvider env="test">{message}</MantineProvider>);
		expect(markup).toContain(strings.allHistory);
		expect(markup).toContain(strings.warning);
		expect(startSpy).toHaveBeenCalledWith({});
		expect(document.body.textContent).toContain(strings.status.running);
		expect(button(strings.start).disabled).toBe(true);
	});

	test("does not start when confirmation is dismissed", async () => {
		confirm.mockResolvedValue(false);
		await renderPanel();
		await click(strings.start);
		expect(startSpy).not.toHaveBeenCalled();
	});

	test("shows counters, cancels a running job, and refreshes partial history changes", async () => {
		getSpy.mockResolvedValue({ job: runningJob });
		await renderPanel();
		expect(document.body.textContent).toContain("Processed: 8");
		expect(document.body.textContent).toContain("Changed: 6");
		expect(document.body.textContent).toContain("Skipped this run: 2");
		expect(document.body.textContent).toContain("Responses fallback: 1");
		client.setQueryData(["usage-history", "stats", {}], { inputTokens: 100 });
		getSpy.mockResolvedValue({ job: { ...runningJob, status: "cancelled" } });
		await click(strings.cancel);
		expect(cancelSpy).toHaveBeenCalledWith("job-1");
		expect(confirm).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(strings.status.cancelled);
		expect(client.getQueryState(["usage-history", "stats", {}])?.isInvalidated).toBe(true);
	});

	test("invalidates usage history on completed or failed jobs without repeatedly invalidating", async () => {
		await renderPanel();
		const invalidate = spyOn(client, "invalidateQueries");
		for (const status of ["completed", "failed"] as const) {
			await act(async () => {
				client.setQueryData(TOKEN_RECALCULATION_QUERY_KEY, {
					job: { ...runningJob, status, error: status === "failed" ? "Worker stopped" : null },
				});
			});
			await flush();
			expect(document.body.textContent).toContain(strings.status[status]);
		}
		expect(invalidate.mock.calls).toEqual([
			[{ queryKey: ["usage-history"] }],
			[{ queryKey: ["usage-history"] }],
		]);
		expect(document.body.textContent).toContain("Worker stopped");
		await flush();
		expect(invalidate).toHaveBeenCalledTimes(2);
		invalidate.mockRestore();
	});

	test("blocks starting when status cannot load and permits an explicit retry", async () => {
		getSpy.mockRejectedValue(new Error("offline"));
		await renderPanel();
		expect(document.body.textContent).toContain(strings.loadFailed);
		expect(button(strings.start).disabled).toBe(true);
		getSpy.mockResolvedValue({ job: null });
		await click(strings.retry);
		expect(button(strings.start).disabled).toBe(false);
	});

	test("shows start errors and discovers a job accepted before its response was lost", async () => {
		await renderPanel();
		startSpy.mockRejectedValue(new Error("Response lost"));
		getSpy.mockResolvedValue({ job: runningJob });
		await click(strings.start);
		expect(document.body.textContent).toContain(strings.operationFailed);
		expect(document.body.textContent).toContain("Response lost");
		expect(document.body.textContent).toContain(strings.status.running);
		expect(button(strings.start).disabled).toBe(true);
	});

	test("prevents duplicate starts while the single confirmation is open", async () => {
		let resolveConfirmation: (value: boolean) => void = () => {};
		confirm.mockImplementation(
			() =>
				new Promise<boolean>((resolve) => {
					resolveConfirmation = resolve;
				}),
		);
		await renderPanel();
		await click(strings.start);
		await click(strings.start);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(startSpy).not.toHaveBeenCalled();
		getSpy.mockResolvedValue({ job: runningJob });
		await act(async () => resolveConfirmation(true));
		await flush();
		expect(startSpy).toHaveBeenCalledTimes(1);
	});

	test("continues tracking cancellation accepted before the worker has stopped", async () => {
		getSpy.mockResolvedValue({ job: runningJob });
		cancelSpy.mockResolvedValue({ job: runningJob });
		await renderPanel();
		await click(strings.cancel);
		expect(document.body.textContent).toContain(strings.cancelling);
		expect(button(strings.cancelling).disabled).toBe(true);
		await click(strings.cancelling);
		expect(cancelSpy).toHaveBeenCalledTimes(1);
		getSpy.mockResolvedValue({ job: { ...runningJob, status: "cancelled" } });
		await act(async () => {
			await client.refetchQueries({ queryKey: TOKEN_RECALCULATION_QUERY_KEY });
		});
		await flush();
		expect(document.body.textContent).toContain(strings.status.cancelled);
	});

	test("a failed cancellation stays visible and can be retried", async () => {
		getSpy.mockResolvedValue({ job: runningJob });
		cancelSpy.mockRejectedValue(new Error("Cancellation unavailable"));
		await renderPanel();
		await click(strings.cancel);
		expect(document.body.textContent).toContain("Cancellation unavailable");
		expect(document.body.textContent).toContain(strings.status.running);
		expect(button(strings.cancel).disabled).toBe(false);
	});

	test("keeps English and Chinese operation copy in sync", () => {
		expect(Object.keys(zhLocale.tokenRecalculation).sort()).toEqual(Object.keys(strings).sort());
		expect(Object.keys(zhLocale.tokenRecalculation.counts).sort()).toEqual(
			Object.keys(strings.counts).sort(),
		);
		expect(Object.keys(zhLocale.tokenRecalculation.status).sort()).toEqual(
			Object.keys(strings.status).sort(),
		);
	});
});

describe("on-demand recalculation window", () => {
	test("only shows the small entry button until opened, even with a previous completed job", async () => {
		client.setQueryData(TOKEN_RECALCULATION_QUERY_KEY, {
			job: { ...runningJob, status: "completed" },
		});
		await renderPanel(false);
		expect(document.body.querySelectorAll("button")).toHaveLength(1);
		expect(button(strings.open)).toBeDefined();
		expect(document.body.textContent).not.toContain(strings.warning);
		expect(document.body.textContent).not.toContain(strings.status.completed);
		expect(getSpy).not.toHaveBeenCalled();
	});

	test("closing stops observing without cancelling the job, reopening fetches its result", async () => {
		getSpy.mockResolvedValue({ job: runningJob });
		await renderPanel();
		expect(document.body.textContent).toContain(strings.status.running);
		const close = document.body.querySelector<HTMLButtonElement>(
			`button[aria-label="${strings.close}"]`,
		);
		expect(close).not.toBeNull();
		await act(async () => close?.click());
		await flush();
		expect(document.body.textContent).not.toContain(strings.warning);
		expect(document.body.textContent).not.toContain(strings.status.running);
		expect(cancelSpy).not.toHaveBeenCalled();
		expect(
			client.getQueryCache().find({ queryKey: TOKEN_RECALCULATION_QUERY_KEY })?.getObserversCount(),
		).toBe(0);
		getSpy.mockResolvedValue({ job: { ...runningJob, status: "completed", processed: 10 } });
		await click(strings.open);
		expect(document.body.textContent).toContain(strings.status.completed);
		expect(document.body.textContent).toContain("Processed: 10");
		expect(startSpy).not.toHaveBeenCalled();
	});
});
