import { afterAll } from "bun:test";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { ConfirmDialogContext } from "../../frontend/components/common/confirm-dialog-context";
import en from "../../frontend/locales/en/settings.json";
import zh from "../../frontend/locales/zh-CN/settings.json";

const original = new Map<string, PropertyDescriptor | undefined>();
const { window } = parseHTML("<!doctype html><html><body></body></html>");
const matchMedia = () => ({
	matches: false,
	addListener() {},
	removeListener() {},
	addEventListener() {},
	removeEventListener() {},
});
Object.assign(window, { matchMedia });
Object.assign(window.document, { fonts: { addEventListener() {}, removeEventListener() {} } });
const inputType = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "type");
if (inputType?.get)
	Object.defineProperty(window.HTMLInputElement.prototype, "type", {
		...inputType,
		get(this: HTMLInputElement) {
			return inputType.get?.call(this) ?? "text";
		},
	});
for (const [key, value] of Object.entries({
	window,
	document: window.document,
	navigator: { userAgent: "Desktop" },
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	HTMLElement: window.HTMLElement,
	HTMLInputElement: window.HTMLInputElement,
	Element: window.Element,
	Node: window.Node,
	Event: window.Event,
	ShadowRoot: window.ShadowRoot ?? class {},
	matchMedia,
	getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "visible" }),
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	IS_REACT_ACT_ENVIRONMENT: true,
})) {
	original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
(window.document as unknown as Record<string, unknown>).oninput = null;
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { I18nextProvider } = await import("react-i18next");
const i18n = createInstance();
await i18n.init({
	lng: "en",
	defaultNS: "settings",
	initImmediate: false,
	resources: { en: { settings: en }, "zh-CN": { settings: zh } },
});

afterAll(() => {
	if (inputType) Object.defineProperty(window.HTMLInputElement.prototype, "type", inputType);
	for (const [key, descriptor] of original) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

export function createHarness(confirm = async () => true) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	const render = async (children: ReactNode) => {
		await act(async () =>
			root.render(
				<MantineProvider env="test">
					<I18nextProvider i18n={i18n}>
						<QueryClientProvider client={client}>
							<ConfirmDialogContext.Provider value={{ confirm }}>
								{children}
							</ConfirmDialogContext.Provider>
						</QueryClientProvider>
					</I18nextProvider>
				</MantineProvider>,
			),
		);
		await settle();
	};
	return {
		container,
		client,
		render,
		async close() {
			await act(() => root.unmount());
			await client.cancelQueries();
			client.clear();
			container.remove();
		},
	};
}
export async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
export async function click(container: HTMLElement, label: string) {
	const button = [...container.querySelectorAll("button")].find(
		(node) => node.textContent === label || node.getAttribute("aria-label") === label,
	);
	if (!button) throw new Error(`Missing button: ${label}. ${container.textContent}`);
	await act(async () => {
		button.click();
		// linkedom has no default form submission behavior.
		if (button.type === "submit" && !button.disabled)
			button
				.closest("form")
				?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	await settle();
}
export async function input(container: HTMLElement, name: string, value: string) {
	const field = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
	if (!field) throw new Error(`Missing field: ${name}`);
	await act(() => {
		const prototype =
			field.tagName === "TEXTAREA"
				? window.HTMLTextAreaElement.prototype
				: window.HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value);
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
		field.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
}
