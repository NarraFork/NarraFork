import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { api } from "../lib/api";
import { type UpdateSourceSettings, updateSettingsKey } from "../lib/update-source";
import common from "../locales/en/common.json";

mock.module("./common/confirm-dialog-context", () => ({
	useConfirmDialog: () => async () => true,
}));
mock.module("./narrator/markdown/MarkdownContent", () => ({
	MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
}));
const { UpdateModal } = await import("./UpdateModal");
const { UpdateBadge } = await import("./UpdateBadge");
const originalCheck = api.checkUpdate;
const originalGetSettings = api.getSettings;
const originalStatus = api.getUpdateStatus;
const originalApply = api.applyUpdate;
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
let container: HTMLElement;
let client: QueryClient;
let ready = false;
let appliedVersion: string | undefined;
const translation = i18next.createInstance();
await translation
	.use(initReactI18next)
	.init({ lng: "en", resources: { en: { common } }, interpolation: { escapeValue: false } });

function install(key: string, value: unknown) {
	globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const key of [
		"window",
		"document",
		"navigator",
		"HTMLElement",
		"Element",
		"Node",
		"Document",
		"ShadowRoot",
		"Event",
	])
		install(key, key === "window" ? window : window[key as keyof typeof window]);
	install("IS_REACT_ACT_ENVIRONMENT", true);
	install("requestAnimationFrame", (callback: FrameRequestCallback) =>
		setTimeout(() => callback(Date.now()), 0),
	);
	install("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
	install("matchMedia", () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	}));
	install(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	install("getComputedStyle", () => ({ getPropertyValue: () => "", overflowY: "visible" }));
	install("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
	ready = false;
	appliedVersion = undefined;
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(["health"], { status: "ok", version: "1.0.0", platform: "linux" });
	client.setQueryData(["settings"], {
		update: { source: "github", githubRepository: "fork/project" },
	});
	api.getUpdateStatus = async () => ({
		ready,
		version: "1.1.0",
		canAutoRestart: true,
		newBinaryPath: "/binary",
		instructions: { manual: false, message: "ready" },
	});
	api.applyUpdate = async (version) => {
		appliedVersion = version;
		return { success: false, error: "test stops before restart" };
	};
	container = window.document.createElement("div") as unknown as HTMLElement;
	window.document.body.appendChild(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	client.clear();
	container.remove();
	api.getUpdateStatus = originalStatus;
	api.applyUpdate = originalApply;
	api.checkUpdate = originalCheck;
	api.getSettings = originalGetSettings;
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => mock.restore());

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

async function render(
	strategy: "full" | "zstd" = "full",
	update: UpdateSourceSettings = { source: "github", githubRepository: "fork/project" },
) {
	root = createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={translation}>
					<QueryClientProvider client={client}>
						<UpdateModal
							opened
							onClose={() => {}}
							data={{
								latestVersion: "1.1.0",
								releaseNotes: "Old recommendation notes",
								strategy,
								downloadSize: strategy === "zstd" ? 128 : 1024,
								totalSize: 1024,
								settingsKey: updateSettingsKey(update),
								releaseInfo: {
									version: "1.1.0",
									source: update.source ?? "github",
									repository: update.githubRepository ?? "fork/project",
									releaseDate: "2026-01-01",
									path: "unused",
									sha512: "hash",
									files: [],
								},
							}}
						/>
					</QueryClientProvider>
				</I18nextProvider>
			</MantineProvider>,
		),
	);
	await settle();
}

async function changeSavedSource() {
	await act(async () => {
		client.setQueryData(["settings"], {
			update: { source: "update-server", githubRepository: "fork/project" },
		});
	});
	await settle();
}

function findButton(text: string) {
	return [...document.querySelectorAll("button")].find((button) =>
		button.textContent?.includes(text),
	);
}

async function renderBadge() {
	root ??= createRoot(container);
	await act(async () =>
		root?.render(
			<MantineProvider env="test">
				<I18nextProvider i18n={translation}>
					<QueryClientProvider client={client}>
						<UpdateBadge />
					</QueryClientProvider>
				</I18nextProvider>
			</MantineProvider>,
		),
	);
	await settle();
}

async function openBadge() {
	const badge = document.querySelector<HTMLElement>(".mantine-Badge-root");
	expect(badge).not.toBeNull();
	await act(async () => badge?.click());
	await settle();
}

function installPersistentDownload() {
	const signals: AbortSignal[] = [];
	const bodies: Array<{ retry: boolean }> = [];
	const previousFetch = globalThis.fetch;
	install(
		"fetch",
		Object.assign(
			async (_url: unknown, init?: RequestInit) => {
				const signal = init?.signal;
				if (!signal) throw new Error("missing download signal");
				signals.push(signal);
				bodies.push(JSON.parse(String(init?.body)));
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'event: progress\ndata: {"phase":"downloading","bytesDownloaded":1,"totalBytes":100,"percent":1}\n\n',
								),
							);
							signal.addEventListener("abort", () =>
								controller.error(new DOMException("cancelled", "AbortError")),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
			{ preconnect: previousFetch.preconnect },
		),
	);
	return { signals, bodies };
}

const githubSettings: UpdateSourceSettings = {
	source: "github",
	githubRepository: "fork/project",
};
const serverSettings: UpdateSourceSettings = {
	source: "update-server",
	serverUrl: "https://updates.example/base",
	githubRepository: "fork/project",
};

function successfulCheck() {
	return {
		updateAvailable: true,
		currentVersion: "1.0.0",
		latestVersion: "1.1.0",
		source: "github" as const,
		repository: "fork/project",
		releaseInfo: {
			version: "1.1.0",
			source: "github" as const,
			repository: "fork/project",
			releaseDate: "2026-01-01",
			path: "unused",
			sha512: "hash",
			files: [],
		},
	};
}

describe("UpdateModal saved source changes", () => {
	test("the badge waits for saved settings, then opens a downloadable recommendation", async () => {
		client.removeQueries({ queryKey: ["settings"] });
		client.setQueryData(["auth", "me"], { id: "admin", username: "admin", role: "admin" });
		let resolveSettings!: (value: Awaited<ReturnType<typeof api.getSettings>>) => void;
		let checkCalls = 0;
		api.getSettings = () =>
			new Promise((resolve) => {
				resolveSettings = resolve;
			});
		api.checkUpdate = async () => {
			checkCalls++;
			return successfulCheck();
		};
		const { signals } = installPersistentDownload();
		await renderBadge();
		expect(resolveSettings).toBeDefined();
		expect(checkCalls).toBe(0);
		expect(document.querySelector(".mantine-Badge-root")).toBeNull();
		await act(async () =>
			resolveSettings({
				update: { ...githubSettings, serverUrl: "https://narrafork-update.b.domexie.cn" },
			}),
		);
		await settle();
		expect(checkCalls).toBe(1);
		await openBadge();
		expect(findButton("Download")).toBeDefined();
		expect(document.body.textContent).not.toContain(common.updateSourceChanged);
		await act(async () => findButton("Download")?.click());
		await settle();
		expect(signals).toHaveLength(1);
		expect(signals[0].aborted).toBe(false);
	});

	test.each([
		{
			name: "GitHub ignores server URL and product",
			initial: githubSettings,
			next: { ...githubSettings, serverUrl: "https://other.example", product: "other" },
		},
		{
			name: "GitHub repository case",
			initial: githubSettings,
			next: { ...githubSettings, githubRepository: "FORK/Project" },
		},
		{
			name: "server ignores GitHub repository",
			initial: serverSettings,
			next: { ...serverSettings, githubRepository: "another/project" },
		},
		{
			name: "server URL normalization",
			initial: serverSettings,
			next: { ...serverSettings, serverUrl: "https://UPDATES.example:443/base/" },
		},
		{
			name: "empty server uses built-in URL",
			initial: { ...serverSettings, serverUrl: "" },
			next: {
				...serverSettings,
				serverUrl: "https://narrafork-update.b.domexie.cn/",
				product: "narrafork",
			},
		},
	])("inactive or equivalent settings keep download usable: $name", async ({ initial, next }) => {
		client.setQueryData(["settings"], { update: initial });
		await render("full", initial);
		await act(async () => client.setQueryData(["settings"], { update: next }));
		await settle();
		expect(document.body.textContent).not.toContain(common.updateSourceChanged);
		expect(findButton("Download")).toBeDefined();
		const { signals } = installPersistentDownload();
		await act(async () => findButton("Download")?.click());
		await settle();
		expect(signals).toHaveLength(1);
	});

	test.each([
		{ name: "source", initial: githubSettings, next: serverSettings },
		{
			name: "GitHub repository",
			initial: githubSettings,
			next: { ...githubSettings, githubRepository: "another/project" },
		},
		{
			name: "GitHub channel",
			initial: githubSettings,
			next: { ...githubSettings, channel: "beta" as const },
		},
		{
			name: "server URL",
			initial: serverSettings,
			next: { ...serverSettings, serverUrl: "https://another.example" },
		},
		{
			name: "server product",
			initial: serverSettings,
			next: { ...serverSettings, product: "other" },
		},
		{
			name: "server channel",
			initial: serverSettings,
			next: { ...serverSettings, channel: "beta" as const },
		},
	])("active settings invalidate permanently: $name", async ({ initial, next }) => {
		client.setQueryData(["settings"], { update: initial });
		await render("full", initial);
		await act(async () => client.setQueryData(["settings"], { update: next }));
		await settle();
		expect(document.body.textContent).toContain(common.updateSourceChanged);
		expect(findButton("Download")).toBeUndefined();
		await act(async () => client.setQueryData(["settings"], { update: initial }));
		await settle();
		expect(findButton("Download")).toBeUndefined();
	});

	test.each([
		"reset",
		"unmount",
	])("badge download aborts on %s and can retry after remount", async (action) => {
		client.setQueryData(["auth", "me"], { id: "admin", username: "admin", role: "admin" });
		api.checkUpdate = async () => successfulCheck();
		const { signals, bodies } = installPersistentDownload();
		await renderBadge();
		await openBadge();
		await act(async () => findButton("Download")?.click());
		await settle();
		expect(signals).toHaveLength(1);
		expect(signals[0].aborted).toBe(false);
		// Closing only hides the dialog; it keeps the hook and cancellation handle alive.
		const close = document.querySelector<HTMLButtonElement>(".mantine-Modal-close");
		expect(close).not.toBeNull();
		await act(async () => close?.click());
		await settle();
		expect(signals[0].aborted).toBe(false);
		await openBadge();
		expect(findButton("Cancel")).toBeDefined();
		if (action === "reset") {
			api.checkUpdate = async () => ({ updateAvailable: false, currentVersion: "1.0.0" });
			await act(async () => {
				client.setQueryData(["settings"], { update: serverSettings });
				await client.resetQueries({ queryKey: ["update-check"] });
			});
		} else await act(async () => root?.render(null));
		await settle();
		expect(signals[0].aborted).toBe(true);
		expect(signals).toHaveLength(1);
		// Re-mount with a fresh recommendation, then cancel and retry a new request.
		await act(async () => {
			client.setQueryData(["settings"], { update: githubSettings });
			client.setQueryData(["update-check"], {
				...successfulCheck(),
				settingsKey: updateSettingsKey(githubSettings),
			});
		});
		await renderBadge();
		await openBadge();
		await act(async () => findButton("Download")?.click());
		await settle();
		expect(signals).toHaveLength(2);
		expect(signals[1].aborted).toBe(false);
		await act(async () => findButton("Cancel")?.click());
		await settle();
		expect(signals[1].aborted).toBe(true);
		expect(findButton("Download")).toBeDefined();
		await act(async () => findButton("Download")?.click());
		await settle();
		expect(signals).toHaveLength(3);
		expect(signals[2].aborted).toBe(false);
		expect(bodies[2].retry).toBe(false);
	});

	test("GitHub incremental recommendations show patch size and update to full on fallback", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		});
		const previousFetch = globalThis.fetch;
		install(
			"fetch",
			Object.assign(
				async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
				{ preconnect: previousFetch.preconnect },
			),
		);
		const encoder = new TextEncoder();
		try {
			await render("zstd");
			expect(document.body.textContent).toContain(common.updateStrategyZstd);
			expect(document.body.textContent).toContain("Incremental update: 128 B / 1.0 KB");
			await act(async () => findButton("Download")?.click());
			await settle();
			await act(async () =>
				controller?.enqueue(
					encoder.encode(
						'event: progress\ndata: {"phase":"downloading","strategy":"full","fallback":true,"bytesDownloaded":1,"totalBytes":1024,"percent":0}\n\n',
					),
				),
			);
			await settle();
			expect(document.body.textContent).toContain(common.updateDeltaFallback);
			expect(document.body.textContent).toContain(common.updateStrategyFull);
			expect(document.body.textContent).not.toContain("Incremental update: 128 B / 1.0 KB");
			await act(async () => {
				controller?.enqueue(
					encoder.encode('event: complete\ndata: {"success":true,"version":"1.1.0"}\n\n'),
				);
				controller?.close();
				controller = undefined;
			});
			await settle();
			expect(document.body.textContent).toContain(common.updateDeltaFallback);
			expect(document.body.textContent).toContain(common.updateStrategyFull);
		} finally {
			try {
				controller?.close();
			} catch {
				/* The hook may already have cancelled its reader. */
			}
		}
	});
	test.each([
		"sse-error",
		"stream-error",
	])("failed full fallback keeps its actual strategy and warning: %s", async (failure) => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(value) {
				controller = value;
			},
		});
		const previousFetch = globalThis.fetch;
		install(
			"fetch",
			Object.assign(
				async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
				{ preconnect: previousFetch.preconnect },
			),
		);
		const encoder = new TextEncoder();
		try {
			await render("zstd");
			await act(async () => findButton("Download")?.click());
			await settle();
			await act(async () =>
				controller?.enqueue(
					encoder.encode(
						'event: progress\ndata: {"phase":"downloading","strategy":"full","fallback":true,"bytesDownloaded":1,"totalBytes":1024,"percent":0}\n\n',
					),
				),
			);
			await settle();
			await act(async () => {
				if (failure === "sse-error") {
					controller?.enqueue(
						encoder.encode(
							'event: error\ndata: {"phase":"error","error":"Full download failed"}\n\n',
						),
					);
					controller?.close();
				} else controller?.error(new Error("Full download failed"));
				controller = undefined;
			});
			await settle();
			expect(document.body.textContent).toContain("Full download failed");
			expect(document.body.textContent).toContain(common.updateDeltaFallback);
			expect(document.body.textContent).toContain(common.updateStrategyFull);
			expect(document.body.textContent).not.toContain(common.updateStrategyZstd);
		} finally {
			try {
				controller?.close();
			} catch {
				/* Already closed or cancelled. */
			}
		}
	});
	test("the header keeps the prepared target when a new source recommends a different version", async () => {
		ready = true;
		client.setQueryData(["auth", "me"], { id: "admin", username: "admin", role: "admin" });
		client.setQueryData(["update-check"], {
			updateAvailable: true,
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
		});
		api.checkUpdate = async () => ({
			updateAvailable: true,
			currentVersion: "1.0.0",
			latestVersion: "2.0.0",
			source: "update-server",
		});
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<MantineProvider env="test">
					<I18nextProvider i18n={translation}>
						<QueryClientProvider client={client}>
							<UpdateBadge />
						</QueryClientProvider>
					</I18nextProvider>
				</MantineProvider>,
			),
		);
		await settle();
		await changeSavedSource();
		await act(async () => {
			await client.resetQueries({ queryKey: ["update-check"] });
		});
		await settle();
		expect(document.body.textContent).toContain("Ready: v1.1.0");
		const badge = [...document.querySelectorAll<HTMLElement>(".mantine-Badge-root")].find(
			(element) => element.textContent === "Ready: v1.1.0",
		);
		expect(badge).toBeDefined();
		await act(async () => badge?.click());
		await settle();
		expect(document.body.textContent).toContain("Update v1.1.0");
		const schedule = findButton(common.updateSchedule);
		expect(schedule).toBeDefined();
		await act(async () => schedule?.click());
		await settle();
		expect(appliedVersion).toBe("1.1.0");
	});

	test("shows source and full strategy, then removes stale notes and download action", async () => {
		await render();
		expect(document.body.textContent).toContain("GitHub: fork/project");
		expect(document.body.textContent).toContain("Full download");
		expect(document.body.textContent).toContain("Old recommendation notes");
		expect(findButton("Download")).toBeDefined();
		await changeSavedSource();
		expect(document.body.textContent).toContain(common.updateSourceChanged);
		expect(document.body.textContent).not.toContain("Old recommendation notes");
		expect(findButton("Download")).toBeUndefined();
		await act(async () => {
			client.setQueryData(["settings"], {
				update: { source: "github", githubRepository: "fork/project" },
			});
		});
		await settle();
		expect(findButton("Download")).toBeUndefined();
	});

	test("a prepared binary remains applicable after the source changes", async () => {
		ready = true;
		await render();
		await changeSavedSource();
		const schedule = findButton(common.updateSchedule);
		expect(schedule).toBeDefined();
		await act(async () => schedule?.click());
		await settle();
		expect(appliedVersion).toBe("1.1.0");
	});
});
