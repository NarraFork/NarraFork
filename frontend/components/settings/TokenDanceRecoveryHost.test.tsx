import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TokenDanceRecoveryAction } from "@shared/tokendance";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import errorsEn from "../../locales/en/errors.json";
import errorsZhCn from "../../locales/zh-CN/errors.json";

const original = new Map<string, PropertyDescriptor | undefined>();
const { window } = parseHTML("<!doctype html><html><body></body></html>");
const globals = {
	window,
	document: window.document,
	navigator: window.navigator,
	HTMLElement: window.HTMLElement,
	Element: window.Element,
	Node: window.Node,
	Event: window.Event,
	ShadowRoot: window.ShadowRoot ?? class {},
	getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
	matchMedia: () => ({
		matches: false,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
	}),
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
	original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { I18nextProvider } = await import("react-i18next");
const { TokenDanceRecoveryPrompt } = await import("./TokenDanceRecoveryHost");
const i18n = createInstance();
await i18n.init({
	lng: "en",
	defaultNS: "errors",
	initImmediate: false,
	resources: {
		en: {
			errors: {
				tokendanceRecoveryTitle: "TokenDance needs attention",
				tokendanceRecoveryTopUp: "Top up your balance. This key remains valid.",
				tokendanceRecoveryReauthorize: "Authorize a new key.",
				tokendanceRecoveryQuota: "Wait for the quota to reset or authorize a new key.",
				tokendanceRecoveryAdminRequired: "Contact your administrator.",
				tokendanceRecoveryOpenWebsite: "Open TokenDance",
				tokendanceRecoveryManage: "Manage connection",
				tokendanceRecoveryDismiss: "Later",
			},
		},
	},
});
let root: Root;
let container: HTMLElement;
let managed = 0;
let closed = 0;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	managed = 0;
	closed = 0;
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
});
afterAll(() => {
	for (const [key, descriptor] of original) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function render(action: TokenDanceRecoveryAction, admin = true) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">
					<TokenDanceRecoveryPrompt
						action={action}
						admin={admin}
						onManage={() => managed++}
						onClose={() => closed++}
					/>
				</MantineProvider>
			</I18nextProvider>,
		);
	});
}
function button(text: string) {
	const found = [...container.querySelectorAll("button")].find(
		(element) => element.textContent === text,
	);
	expect(found).toBeDefined();
	if (!found) throw new Error(`Missing button: ${text}`);
	return found;
}
describe("TokenDance recovery UI", () => {
	it("ships every recovery label in both supported translation bundles", () => {
		for (const key of [
			"tokendanceRecoveryTitle",
			"tokendanceRecoveryTopUp",
			"tokendanceRecoveryReauthorize",
			"tokendanceRecoveryQuota",
			"tokendanceRecoveryAdminRequired",
			"tokendanceRecoveryOpenWebsite",
			"tokendanceRecoveryManage",
			"tokendanceRecoveryDismiss",
		] as const) {
			expect(errorsEn[key]).toBeTruthy();
			expect(errorsZhCn[key]).toBeTruthy();
		}
	});
	it("offers a fixed official top-up link without initiating payment or authorization", async () => {
		await render("top_up_balance");
		const link = container.querySelector("a");
		expect(link?.getAttribute("href")).toBe("https://tokendance.space/");
		expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(container.textContent).toContain("This key remains valid.");
		expect(managed).toBe(0);
		expect(closed).toBe(0);
		await act(() => button("Manage connection").click());
		expect(managed).toBe(1);
	});
	it.each([
		"reauthorize_api_key",
		"api_key_quota",
	] as const)("makes %s a user-driven settings action", async (action) => {
		await render(action);
		expect(container.querySelector("a")).toBeNull();
		expect(managed).toBe(0);
		await act(() => button("Manage connection").click());
		expect(managed).toBe(1);
		await act(() => button("Later").click());
		expect(closed).toBe(1);
	});
	it("does not offer credential or payment controls to a non-administrator", async () => {
		await render("top_up_balance", false);
		expect(container.textContent).toContain("Contact your administrator.");
		expect(container.querySelector("a")).toBeNull();
		expect(container.textContent).not.toContain("Manage connection");
		await act(() => button("Later").click());
		expect(closed).toBe(1);
	});
});
