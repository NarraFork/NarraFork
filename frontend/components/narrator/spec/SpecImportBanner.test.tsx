/**
 * The Spec panel's import banner (outline P2 PR 12b): what it shows for each state, who gets the
 * button, and that a click starts the import and shows it running. The API is spied; React Query
 * and the component are real. Both languages hold every string.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OutlineSpecImportStatus } from "@shared/outline-spec-import";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../../lib/api";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import { SpecImportBanner } from "./SpecImportBanner";

const NARRATOR = "narrator-1";
const i18n = i18next.createInstance();
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const restores: (() => void)[] = [];
let root: Root | undefined;
let host: HTMLDivElement;
let queryClient: QueryClient;
let status: OutlineSpecImportStatus;
let reads = 0;
let starts = 0;

const base: OutlineSpecImportStatus = {
	mode: "auto",
	importable: true,
	canImport: true,
	state: "idle",
	error: null,
	at: null,
};

async function waitFor(ready: () => boolean) {
	for (let i = 0; i < 50 && !ready(); i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	if (!ready()) throw new Error(`Timed out: ${host.innerHTML.slice(0, 300)}`);
}

const banner = () => host.querySelector<HTMLElement>('[data-testid="spec-import-banner"]');
const button = () => host.querySelector<HTMLButtonElement>('[data-testid="spec-import-now"]');

async function mount(initial: Partial<OutlineSpecImportStatus>, outline = true) {
	status = { ...base, ...initial };
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClient.setQueryData(["settings"], { outline: { enabled: outline } });
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<QueryClientProvider client={queryClient}>
						<SpecImportBanner narratorId={NARRATOR} />
					</QueryClientProvider>
				</MantineProvider>
			</I18nextProvider>,
		),
	);
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const overrides = {
		window,
		document: window.document,
		navigator: { ...window.navigator, platform: "Linux", userAgent: "test" },
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		MutationObserver: window.MutationObserver,
		Event: window.Event,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		matchMedia: (media: string) => ({
			media,
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(overrides)) {
		originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	if (!i18n.isInitialized)
		await i18n.init({
			lng: "en",
			resources: { en: { narrator: en } },
			react: { useSuspense: false },
		});
	reads = 0;
	starts = 0;
	const spies = [
		spyOn(api, "getSpecImportStatus").mockImplementation(async () => {
			reads++;
			return status;
		}),
		spyOn(api, "startSpecImport").mockImplementation(async () => {
			starts++;
			status = { ...status, state: "running", error: null };
			return status;
		}),
	];
	for (const spy of spies) restores.push(() => spy.mockRestore());
});

afterEach(async () => {
	try {
		await act(async () => root?.unmount());
		host?.remove();
		queryClient?.clear();
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		root = undefined;
		for (const restore of restores.splice(0)) restore();
		for (const [key, descriptor] of originalGlobals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originalGlobals.clear();
	}
});

test("a session to import: says so and offers the button; a click starts it and shows it running", async () => {
	await mount({});
	await waitFor(() => banner() !== null);
	expect(banner()?.getAttribute("data-state")).toBe("idle");
	expect(banner()?.textContent).toContain(en.spec.specImportAuto);
	expect(button()?.textContent).toBe(en.spec.specImportNow);
	await act(async () => button()?.click());
	await waitFor(() => banner()?.getAttribute("data-state") === "running");
	expect(starts).toBe(1);
	expect(banner()?.textContent).toContain(en.spec.specImportRunning);
	// No second start while one runs.
	expect(button()).toBeNull();
});

test("manual mode words it as an offer; a reader without write access gets no button", async () => {
	await mount({ mode: "manual", canImport: false });
	await waitFor(() => banner() !== null);
	expect(banner()?.textContent).toContain(en.spec.specImportManual);
	expect(button()).toBeNull();
});

test("a failed attempt shows its reason and a retry; one needing attention says so", async () => {
	await mount({ state: "failed", error: "The session's Dynamic Spec changed during the import" });
	await waitFor(() => banner() !== null);
	expect(banner()?.getAttribute("data-state")).toBe("failed");
	expect(banner()?.textContent).toContain(en.spec.specImportFailed);
	expect(host.querySelector('[data-testid="spec-import-error"]')?.textContent).toContain(
		"changed during the import",
	);
	expect(button()?.textContent).toBe(en.spec.specImportRetry);
	await act(async () => root?.unmount());
	host.remove();
	await mount({ state: "attention", error: "too many files" });
	await waitFor(() => banner() !== null);
	expect(banner()?.textContent).toContain(en.spec.specImportAttention);
	expect(button()?.textContent).toBe(en.spec.specImportRetry);
});

test("nothing is drawn for a session that is not to be imported, with imports off, or the outline off", async () => {
	await mount({ importable: false });
	await waitFor(() => reads > 0);
	expect(banner()).toBeNull();
	await act(async () => root?.unmount());
	host.remove();
	await mount({ mode: "off" });
	await waitFor(() => reads > 1);
	expect(banner()).toBeNull();
	await act(async () => root?.unmount());
	host.remove();
	const before = reads;
	await mount({}, false);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	// The outline's routes answer 404 then: the state is not even read.
	expect(reads).toBe(before);
	expect(banner()).toBeNull();
});

test("every string exists in both languages", () => {
	const keys = Object.keys(en.spec).filter((key) => key.startsWith("specImport"));
	expect(keys.length).toBeGreaterThanOrEqual(9);
	for (const key of keys) {
		expect((zh.spec as unknown as Record<string, string>)[key]).toBeTruthy();
		expect((zh.spec as unknown as Record<string, string>)[key]).not.toBe(
			(en.spec as unknown as Record<string, string>)[key],
		);
	}
});
