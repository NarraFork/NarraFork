import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { ProxyOverride } from "../../lib/proxy";
import settingsLocale from "../../locales/en/settings.json";
import { ProxyOverrideField } from "./ProxyOverrideField";

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root;
let container: HTMLDivElement;
let testI18n: i18n;
/** linkedom ships no KeyboardEvent, so keydown events are synthesized. */
let makeEvent: (type: string, init?: EventInit) => Event;
/**
 * The prototype `value` setter. React installs its own tracked `value` property
 * on each input instance, so a plain `input.value = x` updates React's bookkeeping
 * too and the subsequent `input` event looks like a no-op change — onChange never
 * fires. Writing through the prototype setter bypasses the tracker, which is how
 * testing-library simulates real typing.
 */
let setNativeValue: (input: HTMLInputElement, value: string) => void;

/**
 * A KeyboardEvent that actually carries `key`.
 *
 * linkedom implements no KeyboardEvent at all, so the old `window.KeyboardEvent ??
 * window.Event` fallback published a plain `Event` as the global `KeyboardEvent`.
 * That global is process-wide: because `mock.restore()` does not undo global
 * assignment and nothing here restored it, every later-loaded suite that does
 * `new KeyboardEvent("keydown", { key: "Enter" })` silently got an event with NO
 * `key` — so React's onKeyDown saw `key === undefined` and Enter/Space handlers
 * never fired (see vlist-ask-in-passing-interaction). Subclassing Event and
 * assigning `key` keeps the global honest for whoever loads next.
 */
function makeKeyboardEventClass(EventCtor: typeof Event): typeof KeyboardEvent {
	return class TestKeyboardEvent extends EventCtor {
		key: string;

		constructor(type: string, init?: KeyboardEventInit) {
			super(type, init);
			this.key = init?.key ?? "";
		}
	} as unknown as typeof KeyboardEvent;
}

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	makeEvent = (type, init) => new (window as unknown as { Event: typeof Event }).Event(type, init);
	const inputProto = window.HTMLInputElement.prototype;
	const valueSetter = Object.getOwnPropertyDescriptor(inputProto, "value")?.set;
	if (!valueSetter) throw new Error("HTMLInputElement.prototype.value has no setter");
	setNativeValue = (input, value) => valueSetter.call(input, value);
	// Three linkedom gaps break React's change-event pipeline, and typeUpUrl() below
	// works around them without caring which one is active:
	//  1. `input.type` returns null when the attribute is unset, but React only
	//     treats an element as a text input when `type` is a known text type —
	//     and Mantine's TextInput renders no type attribute at all.
	//  2. `"oninput" in document` fails react-dom's feature probe. That probe runs
	//     ONCE when react-dom is evaluated, and `bun test` shares the module
	//     registry across files, so whether the shim lands first is not ours to
	//     control. Set it anyway — it helps when this file runs alone.
	//  3. When the probe loses, React uses its legacy value watcher, which arms on
	//     `focusin` via attachEvent and re-reads the value on keyup.
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
	Object.defineProperties(inputProto, {
		attachEvent: { value: () => {}, configurable: true },
		detachEvent: { value: () => {}, configurable: true },
	});
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
	Object.defineProperties(window.HTMLInputElement.prototype, {
		select: { value: () => {}, configurable: true },
		setSelectionRange: { value: () => {}, configurable: true },
	});
	// Mantine's ScrollArea resize observer reads these off `window` directly.
	Object.assign(window, {
		requestAnimationFrame: (cb: FrameRequestCallback) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number,
		cancelAnimationFrame: (handle: number) => clearTimeout(handle as unknown as Timer),
	});
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		KeyboardEvent:
			window.KeyboardEvent ?? makeKeyboardEventClass(window.Event as unknown as typeof Event),
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		// Mantine's Combobox (used by Select) probes the shadow-DOM root; linkedom
		// exposes neither global, so provide inert stand-ins.
		Document: window.Document ?? class Document {},
		ShadowRoot: class ShadowRoot {},
		matchMedia,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		ResizeObserver: TestResizeObserver,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

beforeEach(async () => {
	installDom();
	testI18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "settings",
		resources: { en: { settings: settingsLocale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function renderField(props: {
	value: ProxyOverride | undefined;
	onChange: (next: ProxyOverride | undefined) => void;
	disabled?: boolean;
}) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider>
					<ProxyOverrideField {...props} />
				</MantineProvider>
			</I18nextProvider>,
		);
	});
}

function urlInput(): HTMLInputElement {
	const inputs = Array.from(container.querySelectorAll("input"));
	// The mode Select renders its own combobox input; the URL field is the only
	// one carrying the proxy placeholder.
	const field = inputs.find((i) => i.getAttribute("placeholder")?.includes("127.0.0.1"));
	if (!field) throw new Error("proxy URL input not rendered");
	return field as unknown as HTMLInputElement;
}

/**
 * Type into the URL field the way a user does. Drives BOTH of React's change
 * pipelines (the modern `input` listener and the legacy focusin/keyup value
 * watcher) so the gesture works regardless of which one react-dom picked when it
 * was evaluated — see the probe notes in installDom().
 */
async function typeUrl(text: string) {
	const field = urlInput();
	await act(async () => {
		field.dispatchEvent(makeEvent("focusin", { bubbles: true }));
	});
	await act(async () => {
		setNativeValue(field, text);
		field.dispatchEvent(makeEvent("input", { bubbles: true }));
		field.dispatchEvent(makeEvent("keyup", { bubbles: true }));
	});
}

/** Leave the field. React maps `onBlur` to the native `focusout`, not `blur`. */
async function blurUrl() {
	const field = urlInput();
	await act(async () => {
		field.dispatchEvent(makeEvent("focusout", { bubbles: true }));
	});
}

async function pressKey(key: string) {
	const field = urlInput();
	await act(async () => {
		const event = makeEvent("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: key, configurable: true });
		field.dispatchEvent(event);
	});
}

describe("ProxyOverrideField", () => {
	test("stays editable while a save is in flight", async () => {
		const calls: (ProxyOverride | undefined)[] = [];
		await renderField({
			value: { mode: "custom", url: "http://127.0.0.1:1080" },
			onChange: (next) => calls.push(next),
			disabled: true,
		});

		// `disabled` narrows the mode selector only. Disabling the URL input would
		// make the browser drop keyboard focus every time a save round-trips.
		expect(urlInput().hasAttribute("disabled")).toBe(false);
		// Rendering alone must never persist anything.
		expect(calls).toEqual([]);
	});

	test("renders the commit hint so the deferred save is discoverable", async () => {
		await renderField({
			value: { mode: "custom", url: "http://127.0.0.1:1080" },
			onChange: () => {},
		});

		expect(container.textContent).toContain(settingsLocale.proxyOverrideUrlCommitHint);
	});

	test("shows the persisted URL and no error for a valid override", async () => {
		await renderField({
			value: { mode: "custom", url: "http://127.0.0.1:1080" },
			onChange: () => {},
		});

		expect(urlInput().value).toBe("http://127.0.0.1:1080");
		expect(container.textContent).not.toContain(settingsLocale.proxyInvalidUrl);
	});

	test("does not flag an empty custom URL as invalid", async () => {
		await renderField({ value: { mode: "custom", url: "" }, onChange: () => {} });

		// An empty field is "not finished yet", not an error to shout about.
		expect(container.textContent).not.toContain(settingsLocale.proxyInvalidUrl);
	});

	test("typing persists nothing until blur", async () => {
		const calls: (ProxyOverride | undefined)[] = [];
		await renderField({
			value: { mode: "custom", url: "http://127.0.0.1:1080" },
			onChange: (next) => calls.push(next),
		});

		await typeUrl("127.0.0.1:789");
		await typeUrl("127.0.0.1:7890");
		// The whole point of the deferred commit: no save per keystroke.
		expect(calls).toEqual([]);
		expect(urlInput().value).toBe("127.0.0.1:7890");

		await blurUrl();
		expect(calls).toEqual([{ mode: "custom", url: "http://127.0.0.1:7890" }]);
		// The normalized form lands in the field so blur causes no visual jump.
		expect(urlInput().value).toBe("http://127.0.0.1:7890");
	});

	test("Enter commits without waiting for blur", async () => {
		const calls: (ProxyOverride | undefined)[] = [];
		await renderField({ value: { mode: "custom", url: "" }, onChange: (next) => calls.push(next) });

		await typeUrl("proxy.example.test:8080");
		await pressKey("Enter");

		expect(calls).toEqual([{ mode: "custom", url: "http://proxy.example.test:8080" }]);
	});

	test("committing an unchanged URL skips the save round-trip", async () => {
		const calls: (ProxyOverride | undefined)[] = [];
		await renderField({
			value: { mode: "custom", url: "http://127.0.0.1:1080" },
			onChange: (next) => calls.push(next),
		});

		// Same address, just typed without the scheme: nothing to persist, so no
		// settings refetch can yank focus back out of the field.
		await typeUrl("127.0.0.1:1080");
		await blurUrl();
		expect(calls).toEqual([]);
	});

	test("keeps an unusable URL as a draft instead of persisting it", async () => {
		const calls: (ProxyOverride | undefined)[] = [];
		await renderField({
			value: { mode: "custom", url: "http://127.0.0.1:1080" },
			onChange: (next) => calls.push(next),
		});

		await typeUrl("socks5://proxy.example.test:1080");
		await blurUrl();

		expect(calls).toEqual([]);
		// The text survives the blur, and only now is it worth flagging.
		expect(urlInput().value).toBe("socks5://proxy.example.test:1080");
		expect(container.textContent).toContain(settingsLocale.proxyInvalidUrl);
	});

	test("a prop change mid-typing does not overwrite the draft", async () => {
		const onChange = () => {};
		await renderField({ value: { mode: "custom", url: "http://127.0.0.1:1080" }, onChange });

		await typeUrl("127.0.0.1:78");
		// A settings refetch resolving while the user types (the focus-stealing bug).
		await renderField({ value: { mode: "custom", url: "http://127.0.0.1:3128" }, onChange });

		expect(urlInput().value).toBe("127.0.0.1:78");
	});

	test("re-syncs from props once the URL field is gone", async () => {
		const onChange = () => {};
		await renderField({ value: { mode: "custom", url: "http://127.0.0.1:1080" }, onChange });

		await typeUrl("127.0.0.1:78");
		// Switching away unmounts the input, so React fires no blur. The typing flag
		// must still clear, or the draft below would stay stale forever.
		await renderField({ value: { mode: "system" }, onChange });
		await renderField({ value: { mode: "custom", url: "http://127.0.0.1:3128" }, onChange });

		expect(urlInput().value).toBe("http://127.0.0.1:3128");
	});
});
