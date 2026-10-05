import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import type { HeaderToolbarProps } from "./HeaderToolbar";

// Install a DOM before importing Mantine/ReactDOM: native input event detection is module-time.
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
class TestObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}
const matchMedia = (query: string) => ({
	matches: false,
	media: query,
	addListener() {},
	removeListener() {},
	addEventListener() {},
	removeEventListener() {},
});
Object.assign(window, { matchMedia, ResizeObserver: TestObserver, MutationObserver: TestObserver });
for (const [name, value] of Object.entries({
	window,
	document: window.document,
	Document: window.Document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	Element: window.Element,
	Node: window.Node,
	ShadowRoot: window.ShadowRoot,
	Event: window.Event,
	MouseEvent: window.MouseEvent ?? window.Event,
	ResizeObserver: TestObserver,
	MutationObserver: TestObserver,
	matchMedia,
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr", display: "block" }),
	localStorage: { getItem: () => "fixture-session-token" },
	IS_REACT_ACT_ENVIRONMENT: true,
})) {
	previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
Object.defineProperty(window.document, "oninput", { value: null, configurable: true });
Object.defineProperty(window.document, "fonts", {
	value: { addEventListener() {}, removeEventListener() {} },
	configurable: true,
});
const { MantineProvider } = await import("@mantine/core");
const { createRoot } = await import("react-dom/client");
const { HeaderToolbar } = await import("./HeaderToolbar");
const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	defaultNS: "narrator",
	resources: { en: { narrator: en } },
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});
let root: ReturnType<typeof createRoot>;
let qc: QueryClient;
let status: "running" | "completed";
const requests: Array<{ path: string; body: unknown }> = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
	document.body.replaceChildren();
	status = "running";
	requests.length = 0;
	qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	qc.setQueryData(["auth", "me"], { id: "owner", role: "user" });
	qc.setQueryData(["narrators", "source"], {
		id: "source",
		ownerUserId: "owner",
		variant: "primary",
	});
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		const path = new URL(url, "http://fixture").pathname;
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ path, body });
		if (path.endsWith("/plan"))
			return Response.json({
				profile: "conversation-state-v1",
				narratorIds: ["source"],
				productionDiskRestoreAllowed: false,
				exclusions: [],
			});
		if (path.endsWith("/exports"))
			return Response.json({ jobId: "persistent-job", status: "running" });
		if (path.endsWith("/jobs/persistent-job"))
			return Response.json({
				jobId: "persistent-job",
				status,
				...(status === "completed" ? { artifactId: "owned-artifact" } : {}),
			});
		if (path.endsWith("/preview"))
			return Response.json({
				artifactId: "typed-artifact",
				profile: "conversation-state-v1",
				narratorIds: ["missing"],
				verifiedSameInstance: false,
				sameInstanceStateRestoreAllowed: false,
				crossInstanceApplySupported: false,
				productionDiskRestoreAllowed: false,
				blockers: [],
				exclusions: [],
				manualActivationRequired: true,
			});
		throw new Error(`Unexpected real test request: ${path}`);
	}) as typeof fetch;
	root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	globalThis.fetch = originalFetch;
});
afterAll(() => {
	for (const [name, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});
async function flush() {
	await act(async () => {
		await Bun.sleep(5);
	});
}
function textButton(label: string): HTMLElement {
	const element = [...document.querySelectorAll("button,[role=menuitem]")].find(
		(item) => item.textContent?.trim() === label,
	);
	if (!element) throw new Error(`Missing ${label}: ${document.body.textContent}`);
	return element as HTMLElement;
}
async function click(element: HTMLElement) {
	await act(async () => {
		element.dispatchEvent(new Event("mousedown", { bubbles: true }));
		element.dispatchEvent(new Event("mouseup", { bubbles: true }));
		element.dispatchEvent(new Event("click", { bubbles: true }));
	});
	await flush();
}
async function open() {
	const trigger = document.querySelector<HTMLElement>(`[aria-label="${en.toolbar.more}"]`);
	if (!trigger) throw new Error("Missing real overflow trigger");
	await click(trigger);
	await click(textButton(en.backup.exportTitle));
	await flush();
}
function artifactInput(): HTMLInputElement {
	const label = [...document.querySelectorAll("label")].find(
		(item) => item.textContent === en.backup.artifact,
	);
	const input = label ? document.getElementById(label.getAttribute("for") ?? "") : undefined;
	if (!input) throw new Error("Missing real artifact input");
	return input as HTMLInputElement;
}

describe("real Mantine backup menu lifetime", () => {
	test("outside clicks from modal input/export do not unmount workflow; status and input survive close/reopen", async () => {
		const props = {
			narratorId: "source",
			controller: {
				toolbarEntries: [],
				toolbarSurfacedDefs: [],
				toolbarTuckedDefs: [],
				saveToolbarLayout() {},
				activateToolbarEntry() {},
				renderToolbarInlineOptions() {},
			},
			inlineControls: {},
			toolbarBadgeCounts: {},
			headerHostCapabilities: [],
			openArchiveConfirm() {},
			archiveMutation: { isPending: false },
			dock: null,
			mockStreamEnabled: false,
			visibleToolCount: 0,
			t: (key: string) => instance.t(key),
		} as unknown as HeaderToolbarProps;
		await act(async () =>
			root.render(
				<MantineProvider env="test">
					<QueryClientProvider client={qc}>
						<I18nextProvider i18n={instance}>
							<HeaderToolbar {...props} />
						</I18nextProvider>
					</QueryClientProvider>
				</MantineProvider>,
			),
		);
		await flush();
		await open();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		const input = artifactInput();
		await click(input); // real Menu outside-click listener closes/unmounts the Dropdown.
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		// linkedom has no default text input type; cover React's native and legacy
		// change pipelines without mocking Mantine controls or invoking their callbacks.
		input.setAttribute("type", "text");
		Object.assign(input, { attachEvent() {}, detachEvent() {} });
		await act(async () => {
			input.dispatchEvent(new Event("focusin", { bubbles: true }));
			const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
			setter?.call(input, "typed-artifact");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("keyup", { bubbles: true }));
		});
		await flush();
		await click(textButton(en.backup.preview));
		expect(requests.find((entry) => entry.path.endsWith("/preview"))?.body).toEqual({
			artifactId: "typed-artifact",
		});
		await click(textButton(en.backup.export));
		expect(document.body.textContent).toContain("persistent-job");
		status = "completed";
		await act(async () =>
			qc.invalidateQueries({ queryKey: ["narrator-backup-job", "persistent-job"] }),
		);
		await flush();
		expect(textButton(en.backup.download)).toBeTruthy();
		const close = document.querySelector<HTMLElement>(".mantine-Modal-close");
		if (!close) throw new Error("Missing real Modal close");
		await click(close);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await open();
		expect(artifactInput().value).toBe("typed-artifact");
		expect(document.body.textContent).toContain("persistent-job");
		expect(textButton(en.backup.download)).toBeTruthy();
		expect(requests.filter((entry) => entry.path.endsWith("/exports"))).toHaveLength(1);
	});
});
