/**
 * The Spec panel's import banner (outline P2 PR 12b): what it shows for each state, who gets the
 * button, and that a click starts the import and shows it running. The API is spied; React Query
 * and the component are real. Both languages hold every string.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { OutlineSpecImportReason, OutlineSpecImportStatus } from "@shared/outline-spec-import";
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
	reason: null,
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

test("a failed attempt shows its reason in the reader's language and a retry; one needing attention says so", async () => {
	await mount({
		state: "failed",
		error: "The session's Dynamic Spec changed during the import",
		reason: { code: "changed" },
	});
	await waitFor(() => banner() !== null);
	expect(banner()?.getAttribute("data-state")).toBe("failed");
	expect(banner()?.textContent).toContain(en.spec.specImportFailed);
	expect(host.querySelector('[data-testid="spec-import-error"]')?.textContent).toContain(
		en.spec.specImportReason.changed,
	);
	expect(button()?.textContent).toBe(en.spec.specImportRetry);
	await act(async () => root?.unmount());
	host.remove();
	await mount({
		state: "attention",
		error: "The session holds more than 200 Dynamic Spec files",
		reason: { code: "too_many_files", count: 200 },
	});
	await waitFor(() => banner() !== null);
	expect(banner()?.textContent).toContain(en.spec.specImportAttention);
	expect(banner()?.textContent).not.toContain("administrator");
	expect(host.querySelector('[data-testid="spec-import-error"]')?.textContent).toContain(
		en.spec.specImportReason.too_many_files.replace("{{n}}", "200"),
	);
	expect(button()?.textContent).toBe(en.spec.specImportRetry);
	await act(async () => root?.unmount());
	host.remove();
	// A reason the panel does not know a code for is said generically, never in English only.
	await mount({ state: "failed", error: "database is locked", reason: null });
	await waitFor(() => banner() !== null);
	expect(host.querySelector('[data-testid="spec-import-error"]')?.textContent).toContain(
		en.spec.specImportReason.other,
	);
});

test("a busy outcome of the button is remembered: the banner says the session was busy", async () => {
	await mount({});
	await waitFor(() => banner() !== null);
	const spy = spyOn(api, "startSpecImport").mockImplementation(async () => {
		starts++;
		status = { ...status, state: "busy" };
		return status;
	});
	restores.push(() => spy.mockRestore());
	await act(async () => button()?.click());
	await waitFor(() => banner()?.getAttribute("data-state") === "busy");
	expect(banner()?.textContent).toContain(en.spec.specImportBusy);
	expect(button()?.textContent).toBe(en.spec.specImportNow);
	// Read again later (another tab, a reload): still busy, from the server's record.
	await act(async () => root?.unmount());
	host.remove();
	await mount({ state: "busy" });
	await waitFor(() => banner() !== null);
	expect(banner()?.getAttribute("data-state")).toBe("busy");
	expect(banner()?.textContent).toContain(en.spec.specImportBusy);
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
	const keys = Object.keys(en.spec).filter(
		(key) => key.startsWith("specImport") && key !== "specImportReason",
	);
	expect(keys.length).toBeGreaterThanOrEqual(9);
	for (const key of keys) {
		expect((zh.spec as unknown as Record<string, string>)[key]).toBeTruthy();
		expect((zh.spec as unknown as Record<string, string>)[key]).not.toBe(
			(en.spec as unknown as Record<string, string>)[key],
		);
	}
	// Every reason code the server sends (shared/outline-spec-import.ts), in both languages.
	const codes: OutlineSpecImportReason["code"][] = [
		"too_many_files",
		"too_large",
		"broken_tasks",
		"task_mismatch",
		"kept_blocks",
		"fence_too_large",
		"sop_too_large",
		"not_started",
		"changed",
		"moved_elsewhere",
		"off",
		"other",
	];
	const enReasons = en.spec.specImportReason as Record<string, string>;
	const zhReasons = zh.spec.specImportReason as Record<string, string>;
	expect(Object.keys(enReasons).sort()).toEqual([...codes].sort());
	expect(Object.keys(zhReasons).sort()).toEqual([...codes].sort());
	for (const code of codes) {
		expect(zhReasons[code]).toBeTruthy();
		expect(zhReasons[code]).not.toBe(enReasons[code]);
	}
	// No tool for an administrator exists yet: nothing sends the reader to one.
	const imports = [en.spec, zh.spec].map((spec) =>
		Object.entries(spec).filter(([key]) => key.startsWith("specImport")),
	);
	expect(JSON.stringify(imports)).not.toMatch(/administrator|管理员/);
});
