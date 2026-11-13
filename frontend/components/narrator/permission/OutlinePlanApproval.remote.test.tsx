import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../../../locales/en/narrator.json";
import type { PendingPermission } from "../../../types/narrator";

mock.module("@frontend/lib/build-target", () => ({ REMOTE_BUILD: true }));
const requests: Array<{ path: string; init?: RequestInit }> = [];
let respond: () => Response;
mock.module("@frontend/lib/business-transport", () => ({
	businessTransport: {
		request: async (path: string, init?: RequestInit) => {
			requests.push({ path, init });
			return respond();
		},
	},
}));
const { OutlinePlanApproval } = await import("../../outline/plan/OutlinePlanApproval");
const instance = createInstance();
await instance.init({
	lng: "en",
	resources: { en: { narrator: en } },
	interpolation: { escapeValue: false },
});
const originalFetch = globalThis.fetch;
const globals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let container: HTMLElement;
let client: QueryClient;
let nativeRequests = 0;
const permission: PendingPermission = {
	id: "approval",
	toolName: "ExitPlanMode",
	toolUseId: "exit-plan",
	ownerNarratorId: "owner",
	inputJson: {
		mode: "outline",
		_planRoot: {
			blockId: "plan",
			pageId: "page",
			spaceId: "space",
			address: "space/plan",
			title: "Plan",
			round: 3,
		},
		_planSeq: 42,
		_planBaseSeq: 30,
		_planDiff: { counts: { added: 1, removed: 0, text: 1, task: 0, moved: 0 } },
	},
};

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	Object.assign(window, { matchMedia });
	Object.defineProperty(window.document, "fonts", {
		value: { addEventListener() {}, removeEventListener() {} },
		configurable: true,
	});
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		matchMedia,
		getComputedStyle: () => ({ getPropertyValue: () => "", fontSize: "14px" }),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(performance.now()), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
		localStorage: { getItem: () => "test-token" },
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	requests.length = 0;
	nativeRequests = 0;
	globalThis.fetch = Object.assign(
		async () => {
			nativeRequests++;
			throw new Error("native bypass");
		},
		{ preconnect: originalFetch.preconnect },
	);
	respond = () => Response.json({ ok: true });
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	expect(nativeRequests).toBe(0);
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
async function render(readOnly = false) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={instance}>
					<MantineProvider
						env="test"
						theme={{
							components: {
								Modal: {
									defaultProps: {
										withinPortal: false,
										trapFocus: false,
										lockScroll: false,
										transitionProps: { duration: 0 },
									},
								},
							},
						}}
					>
						<OutlinePlanApproval permission={permission} readOnly={readOnly} />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
}
async function click(label: string) {
	const button = [...container.querySelectorAll("button")].find(
		(node) => node.textContent === label,
	);
	expect(button).toBeDefined();
	await act(async () => button?.click());
}
function expectNoOutlineEntrypoints() {
	expect(container.querySelector('[data-testid="outline-plan-view-changes"]')).toBeNull();
	expect(container.querySelector('[data-testid="outline-plan-open"]')).toBeNull();
	expect(container.querySelector('[data-testid="outline-plan-delegate"]')).toBeNull();
	expect(container.querySelector('a[href*="outline"], [role=combobox]')).toBeNull();
}
function expectDecision(action: "draft" | "lock" | "return") {
	expect(requests).toHaveLength(1);
	const { path, init } = requests[0];
	expect(path).toBe("/api/narrators/permissions/approval/plan");
	expect(init?.method).toBe("POST");
	expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
	expect(JSON.parse(String(init?.body))).toEqual({
		action,
		seenSeq: 42,
		...(action === "lock" ? { delegate: null } : {}),
	});
}

test.each([
	"draft",
	"return",
] as const)("remote %s approval retains seenSeq and never reads outline data", async (action) => {
	await render();
	expectNoOutlineEntrypoints();
	expect(requests).toHaveLength(0);
	await click(en.outlinePlan[action]);
	expectDecision(action);
	expectNoOutlineEntrypoints();
});
test("opening and confirming a remote lock preserves approval without delegate discovery", async () => {
	await render();
	await click(en.outlinePlan.lock);
	expect(container.querySelector('[data-testid="outline-plan-lock-modal"]')).not.toBeNull();
	expectNoOutlineEntrypoints();
	expect(requests).toHaveLength(0);
	const confirm = container.querySelector<HTMLButtonElement>(
		'[data-testid="outline-plan-lock-confirm"]',
	);
	expect(confirm).not.toBeNull();
	await act(async () => confirm?.click());
	expectDecision("lock");
});
test("a version conflict stays visible without fetching a diff or opening the outline", async () => {
	respond = () =>
		Response.json({ error: "Plan changed", code: "OUTLINE_PLAN_CHANGED" }, { status: 409 });
	await render();
	await click(en.outlinePlan.draft);
	expectDecision("draft");
	expect(container.textContent).toContain(en.outlinePlan.changed);
	expectNoOutlineEntrypoints();
	await act(async () => {
		await client.invalidateQueries();
	});
	expect(requests).toHaveLength(1);
});
test("read-only approval remains a record and performs no reads or decisions", async () => {
	await render(true);
	expect(container.querySelector('[data-testid="outline-plan-approval"]')).not.toBeNull();
	expect(
		container.querySelector('[data-testid="outline-plan-feedback"]')?.hasAttribute("disabled"),
	).toBe(true);
	expectNoOutlineEntrypoints();
	expect(requests).toHaveLength(0);
	expect(
		[...container.querySelectorAll("button")].some(
			(button) => button.textContent === en.outlinePlan.draft,
		),
	).toBe(false);
});
