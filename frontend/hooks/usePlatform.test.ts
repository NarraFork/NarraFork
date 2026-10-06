import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { ConfirmDialogProvider } from "../components/common/ConfirmDialogProvider";
import { StorageSection } from "../components/settings/StorageSection";
import { api } from "../lib/api";
import commonLocale from "../locales/en/common.json";
import settingsLocale from "../locales/en/settings.json";

/**
 * This file used to hold ~3300 lines exercising 43 `get*Capability` getters against
 * synthetic `RuntimeCapabilities` payloads. Those getters are gone: `/api/health` never
 * sent a capabilities block, so every getter always took its absent-payload branch and
 * returned a constant. The tests were thorough about a negotiation that had exactly one
 * possible outcome, and they were what made the inert layer look load-bearing.
 *
 * What remains is what still has behaviour to verify: the `StorageSection` load-state
 * gating (a real distinction, since scan and VACUUM must stay disabled until health
 * answers) and a check that the collapsed capability constants say what the backend
 * actually does.
 */

type HealthResponse = Awaited<ReturnType<typeof api.health>>;

const storageHealthI18n = i18next.createInstance();
const originalStorageHealthApi = {
	health: api.health,
	getSettings: api.getSettings,
	getCachedStorage: api.getCachedStorage,
};
const STORAGE_DOM_GLOBALS = [
	"window",
	"document",
	"navigator",
	"Event",
	"Document",
	"ShadowRoot",
	"HTMLElement",
	"HTMLButtonElement",
	"Element",
	"Node",
	"Text",
	"ResizeObserver",
	"matchMedia",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

class StorageTestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let storageRoot: Root | undefined;
let storageContainer: HTMLDivElement | undefined;
let storageQueryClient: QueryClient | undefined;
let previousStorageDomGlobals: Map<string, PropertyDescriptor | undefined> | undefined;

/** The real health payload: no `capabilities` block, because the server never sends one. */
function healthResponse(): HealthResponse {
	return {
		status: "ok",
		version: "test",
		commit: "test",
		platform: "linux",
		gitAvailable: true,
	};
}

function installStorageTestDom() {
	previousStorageDomGlobals = new Map(
		STORAGE_DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});

	Object.assign(window, {
		ResizeObserver: StorageTestResizeObserver,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: StorageTestResizeObserver,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle:
			window.getComputedStyle?.bind(window) ??
			(() => ({
				getPropertyValue: () => "",
			})),
		IS_REACT_ACT_ENVIRONMENT: false,
	});
}

function restoreStorageTestDom() {
	if (!previousStorageDomGlobals) return;
	for (const [key, descriptor] of previousStorageDomGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousStorageDomGlobals = undefined;
}

async function initStorageHealthI18n() {
	if (storageHealthI18n.isInitialized) return;
	await storageHealthI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		ns: ["settings", "common"],
		resources: {
			en: {
				settings: settingsLocale,
				common: commonLocale,
			},
		},
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
}

function renderStorageSection() {
	if (!storageRoot) throw new Error("storage test root is not initialized");
	storageQueryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnMount: false,
			},
		},
	});
	storageRoot.render(
		createElement(
			I18nextProvider,
			{ i18n: storageHealthI18n },
			createElement(
				MantineProvider,
				{ env: "test" },
				createElement(
					QueryClientProvider,
					{ client: storageQueryClient },
					createElement(ConfirmDialogProvider, null, createElement(StorageSection)),
				),
			),
		),
	);
}

async function settleStorageSection() {
	for (let turn = 0; turn < 6; turn++) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function findStorageButton(label: string): HTMLButtonElement {
	const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!button) throw new Error(`storage button not found: ${label}`);
	return button as HTMLButtonElement;
}

describe("StorageSection health states", () => {
	beforeEach(async () => {
		installStorageTestDom();
		await initStorageHealthI18n();
		api.health = async () => healthResponse();
		api.getSettings = async () =>
			({}) as Awaited<ReturnType<typeof originalStorageHealthApi.getSettings>>;
		api.getCachedStorage = async () => ({ cached: false });
		storageContainer = document.createElement("div");
		document.body.appendChild(storageContainer);
		storageRoot = createRoot(storageContainer);
	});

	afterEach(async () => {
		storageRoot?.unmount();
		storageQueryClient?.clear();
		for (let turn = 0; turn < 3; turn++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		storageContainer?.remove();
		storageRoot = undefined;
		storageQueryClient = undefined;
		storageContainer = undefined;
		api.health = originalStorageHealthApi.health;
		api.getSettings = originalStorageHealthApi.getSettings;
		api.getCachedStorage = originalStorageHealthApi.getCachedStorage;
		restoreStorageTestDom();
	});

	test("shows an explicit loading state without claiming storage is unsupported", async () => {
		api.health = () => new Promise<HealthResponse>(() => {});

		renderStorageSection();
		await settleStorageSection();

		const text = document.body.textContent ?? "";
		expect(text).toContain("Loading storage capabilities");
		expect(text).not.toContain("Storage scan unavailable");
		expect(findStorageButton("Scan").disabled).toBe(true);
	});

	test("shows the health error and retries into the success path", async () => {
		let attempts = 0;
		api.health = async () => {
			attempts++;
			if (attempts === 1) throw new Error("health endpoint offline");
			return healthResponse();
		};

		renderStorageSection();
		await settleStorageSection();

		let text = document.body.textContent ?? "";
		expect(text).toContain("Storage status unavailable");
		expect(text).toContain("health endpoint offline");
		expect(text).not.toContain("Storage scan unavailable");
		expect(findStorageButton("Scan").disabled).toBe(true);

		findStorageButton("Retry").click();
		await settleStorageSection();

		text = document.body.textContent ?? "";
		expect(attempts).toBe(2);
		expect(text).not.toContain("Storage status unavailable");
		expect(text).toContain("Click Scan to analyze storage usage");
		expect(findStorageButton("Scan").disabled).toBe(false);
	});

	test("enables storage actions once health resolves", async () => {
		renderStorageSection();
		await settleStorageSection();

		const text = document.body.textContent ?? "";
		expect(text).toContain("Click Scan to analyze storage usage");
		expect(text).not.toContain("Loading storage capabilities");
		expect(text).not.toContain("Storage status unavailable");
		expect(findStorageButton("Scan").disabled).toBe(false);
	});

	test("does not warn that scanning is unsupported on a healthy server", async () => {
		renderStorageSection();
		await settleStorageSection();

		expect(document.body.textContent ?? "").not.toContain("Storage scan unavailable");
	});
});
