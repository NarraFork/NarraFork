import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConfigViewInput } from "./config-form-state";
import { SECRET_PLACEHOLDER } from "./config-form-state";
import type { JsonValue, SchemaNode } from "./config-schema";

/**
 * DOM-level checks for the things a pure-logic test cannot see:
 *
 * - a secret renders as a masked input showing the placeholder, not the value;
 * - Save stays disabled until something actually changes;
 * - an unsupported field still gets an editor rather than disappearing.
 */

const realReactI18nextModule = { ...(await import("react-i18next")) };
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const { PluginConfigForm } = await import("./PluginConfigForm");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let makeEvent: (type: string, init?: EventInit) => Event;
/**
 * Write through the prototype setter rather than the instance property.
 *
 * React's `_valueTracker` caches the last value it saw; assigning `element.value`
 * updates that cache too, so the following `input` event looks like a no-op and
 * `onChange` never fires. Going through the prototype setter bypasses the tracker,
 * which is how testing-library simulates real typing. See ProxyOverrideField.test.tsx
 * for the full write-up of the linkedom/React gaps this works around.
 */
let setNativeValue: (element: HTMLInputElement | HTMLTextAreaElement, value: string) => void;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	makeEvent = (type, init) => new (window as unknown as { Event: typeof Event }).Event(type, init);
	const inputProto = window.HTMLInputElement.prototype;
	const inputValueSetter = Object.getOwnPropertyDescriptor(inputProto, "value")?.set;
	const areaProto = window.HTMLTextAreaElement.prototype;
	const areaValueSetter = Object.getOwnPropertyDescriptor(areaProto, "value")?.set;
	if (!inputValueSetter || !areaValueSetter) throw new Error("value setters unavailable");
	setNativeValue = (element, value) => {
		const setter =
			element instanceof window.HTMLTextAreaElement ? areaValueSetter : inputValueSetter;
		setter.call(element, value);
	};
	// linkedom returns null for an unset `type`, but React only runs its change pipeline
	// for known text types — and Mantine's TextInput renders no type attribute.
	const typeDescriptor = Object.getOwnPropertyDescriptor(inputProto, "type");
	if (typeDescriptor?.get) {
		const nativeGet = typeDescriptor.get;
		Object.defineProperty(inputProto, "type", {
			...typeDescriptor,
			get(this: HTMLInputElement) {
				return nativeGet.call(this) ?? "text";
			},
		});
	}
	(window.document as unknown as Record<string, unknown>).oninput = null;
	// When react-dom's `oninput` probe loses (the module registry is shared across test
	// files, so this is not ours to control) it falls back to the legacy IE value
	// watcher, which arms via attachEvent. Stub both so either path works.
	for (const proto of [inputProto, areaProto]) {
		Object.defineProperties(proto, {
			attachEvent: { value: () => {}, configurable: true },
			detachEvent: { value: () => {}, configurable: true },
		});
	}
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
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	Object.assign(window, {
		requestAnimationFrame,
		cancelAnimationFrame,
		matchMedia,
		innerWidth: 1024,
		innerHeight: 768,
	});
	// Mantine's autosize Textarea subscribes to font-loading events; linkedom has no
	// FontFaceSet, so a no-op stub keeps the component mountable.
	if (!window.document.fonts) {
		Object.defineProperty(window.document, "fonts", {
			configurable: true,
			value: { addEventListener() {}, removeEventListener() {} },
		});
	}
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		// Mantine's Select walks up to the shadow/document root, so both constructors
		// must exist as globals or the combobox throws on first render.
		Document: window.Document,
		ShadowRoot: window.ShadowRoot ?? class ShadowRoot {},
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.restore();
});

const schema: SchemaNode = {
	type: "object",
	properties: {
		apiMode: { type: "string", enum: ["balanced", "fast"] },
		apiKey: { type: "string", format: "password" },
		label: { type: "string" },
		nested: { type: "object", properties: { deep: { type: "string" } } },
	},
	required: ["apiMode"],
};

async function renderForm(
	view: ConfigViewInput,
	onSubmit: (config: Record<string, JsonValue>) => void = () => {},
	overrides: { schema?: SchemaNode } = {},
) {
	await act(async () => {
		root?.render(
			<MantineProvider>
				<PluginConfigForm schema={overrides.schema ?? schema} view={view} onSubmit={onSubmit} />
			</MantineProvider>,
		);
	});
}

function inputs(): HTMLInputElement[] {
	return [...(container?.querySelectorAll("input") ?? [])] as HTMLInputElement[];
}

/**
 * Find a text input by its rendered label.
 *
 * linkedom reports `input.type` as `"null"` when the attribute is absent, so selecting
 * by type is unreliable; going through the label is both stable and closer to what a
 * user actually sees.
 */
function inputByLabel(labelText: string): HTMLInputElement | undefined {
	const labels = [...(container?.querySelectorAll("label") ?? [])] as HTMLLabelElement[];
	const label = labels.find((item) => item.textContent?.includes(labelText));
	const id = label?.getAttribute("for");
	if (!id) return undefined;
	return (container?.querySelector(`#${id}`) as HTMLInputElement | null) ?? undefined;
}

function saveButton(): HTMLButtonElement {
	const buttons = [...(container?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
	const button = buttons.at(-1);
	if (!button) throw new Error("save button not rendered");
	return button;
}

/**
 * Type into a field the way a user does, driving both of React's change pipelines
 * (the modern `input` listener and the legacy focusin/keyup value watcher) so the
 * gesture works regardless of which one react-dom selected at evaluation time.
 */
async function typeInto(
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string,
): Promise<void> {
	await act(async () => {
		element.dispatchEvent(makeEvent("focusin", { bubbles: true }));
	});
	await act(async () => {
		setNativeValue(element, value);
		element.dispatchEvent(makeEvent("input", { bubbles: true }));
		element.dispatchEvent(makeEvent("keyup", { bubbles: true }));
	});
}

describe("PluginConfigForm rendering", () => {
	test("renders a masked input for a secret and shows the placeholder, not a value", async () => {
		await renderForm({
			config: { apiKey: SECRET_PLACEHOLDER },
			secretFields: ["apiKey"],
			secretsSet: ["apiKey"],
		});

		const password = inputs().find((input) => input.type === "password");
		expect(password).toBeDefined();
		expect(password?.value).toBe(SECRET_PLACEHOLDER);
		// Nothing in the DOM should ever contain a real credential; the server never sent one.
		expect(container?.innerHTML ?? "").not.toContain("sk-");
	});

	test("shows an empty secret input when no secret is stored", async () => {
		await renderForm({ config: {}, secretFields: ["apiKey"], secretsSet: [] });
		const password = inputs().find((input) => input.type === "password");
		expect(password?.value).toBe("");
	});

	test("keeps Save disabled until a field changes", async () => {
		await renderForm({ config: { apiMode: "fast" }, secretFields: ["apiKey"], secretsSet: [] });
		expect(saveButton().disabled).toBe(true);

		const label = inputByLabel("label");
		expect(label).toBeDefined();
		if (label) await typeInto(label, "changed");
		expect(saveButton().disabled).toBe(false);
	});

	test("submits the assembled payload including the keep placeholder", async () => {
		const submitted: Array<Record<string, JsonValue>> = [];
		await renderForm(
			{ config: { apiMode: "fast" }, secretFields: ["apiKey"], secretsSet: ["apiKey"] },
			(config) => submitted.push(config),
		);

		const label = inputByLabel("label");
		expect(label).toBeDefined();
		if (label) await typeInto(label, "hello");
		await act(async () => {
			saveButton().click();
		});

		expect(submitted).toHaveLength(1);
		expect(submitted[0]?.label).toBe("hello");
		expect(submitted[0]?.apiMode).toBe("fast");
		// The stored secret is preserved by echoing the placeholder, never the value.
		expect(submitted[0]?.apiKey).toBe(SECRET_PLACEHOLDER);
	});

	test("still renders an editor for an unsupported field", async () => {
		await renderForm({
			config: { nested: { deep: "x" } },
			secretFields: ["apiKey"],
			secretsSet: [],
		});
		const textareas = [...(container?.querySelectorAll("textarea") ?? [])] as HTMLTextAreaElement[];
		// The nested object falls back to a JSON editor rather than vanishing.
		expect(textareas.some((area) => area.value.includes("deep"))).toBe(true);
	});

	test("renders a single JSON editor when the schema has no structure", async () => {
		await renderForm({ config: { anything: 1 }, secretFields: [], secretsSet: [] }, () => {}, {
			schema: true,
		});
		const textareas = [...(container?.querySelectorAll("textarea") ?? [])] as HTMLTextAreaElement[];
		expect(textareas).toHaveLength(1);
		expect(textareas[0]?.value).toContain("anything");
	});

	test("re-seeds the draft when the server view changes", async () => {
		const view: ConfigViewInput = {
			config: { apiMode: "fast", label: "first" },
			secretFields: ["apiKey"],
			secretsSet: [],
		};
		await renderForm(view);
		expect(inputs().some((input) => input.value === "first")).toBe(true);

		// A successful save returns a new view; the form must reflect it rather than
		// keeping a stale draft on screen.
		await renderForm({ ...view, config: { apiMode: "fast", label: "second" } });
		expect(inputs().some((input) => input.value === "second")).toBe(true);
		expect(saveButton().disabled).toBe(true);
	});
});
