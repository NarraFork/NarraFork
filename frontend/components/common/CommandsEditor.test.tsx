import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import settingsLocale from "../../locales/en/settings.json";

/**
 * `useAllModels` reaches for the settings query (and thus a QueryClientProvider plus
 * a fetch layer). The model picker is irrelevant to the index bookkeeping under test,
 * so stub the hook module instead of standing up that whole tree.
 */
const realUseModels = { ...(await import("../../hooks/useModels")) };
const stubUseModels = () => ({ ...realUseModels, useAllModels: () => ({ groupedModels: [] }) });
mock.module("../../hooks/useModels", stubUseModels);
mock.module("@frontend/hooks/useModels", stubUseModels);

const { CommandsEditor } = await import("./CommandsEditor");
type CommandDef = import("./CommandsEditor").CommandDef;

afterAll(() => {
	mock.module("../../hooks/useModels", () => realUseModels);
	mock.module("@frontend/hooks/useModels", () => realUseModels);
	mock.restore();
});

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root;
let container: HTMLDivElement;
let testI18n: i18n;
let setNativeValue: (input: HTMLInputElement | HTMLTextAreaElement, value: string) => void;
let makeEvent: (type: string, init?: EventInit) => Event;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	makeEvent = (type, init) => new (window as unknown as { Event: typeof Event }).Event(type, init);
	const inputProto = window.HTMLInputElement.prototype;
	const textareaProto = window.HTMLTextAreaElement.prototype;
	const inputSetter = Object.getOwnPropertyDescriptor(inputProto, "value")?.set;
	const textareaSetter = Object.getOwnPropertyDescriptor(textareaProto, "value")?.set;
	if (!inputSetter || !textareaSetter) throw new Error("value setters missing");
	setNativeValue = (el, value) => {
		const setter = el.tagName === "TEXTAREA" ? textareaSetter : inputSetter;
		setter.call(el, value);
	};
	// linkedom returns null for an unset `type` attribute, which stops react-dom from
	// treating Mantine's TextInput as a text input at all.
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
	// Mantine's autosize Textarea subscribes to font loading; linkedom has no FontFaceSet.
	(window.document as unknown as Record<string, unknown>).fonts = {
		addEventListener() {},
		removeEventListener() {},
	};
	for (const proto of [inputProto, textareaProto]) {
		Object.defineProperties(proto, {
			attachEvent: { value: () => {}, configurable: true },
			detachEvent: { value: () => {}, configurable: true },
			select: { value: () => {}, configurable: true },
			setSelectionRange: { value: () => {}, configurable: true },
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
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
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

async function renderEditor(props: {
	commands: CommandDef[];
	onChange: (commands: CommandDef[]) => void;
}) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={testI18n}>
				<MantineProvider>
					<CommandsEditor {...props} />
				</MantineProvider>
			</I18nextProvider>,
		);
	});
}

function buttonsByText(text: string): HTMLElement[] {
	return Array.from(container.querySelectorAll("button")).filter(
		(b) => b.textContent?.trim() === text,
	) as unknown as HTMLElement[];
}

async function click(el: HTMLElement) {
	await act(async () => {
		el.dispatchEvent(makeEvent("click", { bubbles: true }));
	});
}

/** The name field is the only input carrying the command-name placeholder. */
function nameInput(): HTMLInputElement {
	const placeholder = testI18n.t("commandNamePlaceholder");
	const field = Array.from(container.querySelectorAll("input")).find(
		(i) => i.getAttribute("placeholder") === placeholder,
	);
	if (!field) throw new Error("command name input not rendered");
	return field as unknown as HTMLInputElement;
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
	await act(async () => {
		el.dispatchEvent(makeEvent("focusin", { bubbles: true }));
		setNativeValue(el, value);
		el.dispatchEvent(makeEvent("input", { bubbles: true }));
		el.dispatchEvent(makeEvent("keyup", { bubbles: true }));
	});
}

/** `/name` labels of the collapsed summary rows, in DOM order. */
function renderedNames(): string[] {
	return Array.from(container.querySelectorAll("*"))
		.filter((el) => /^\/[a-zA-Z0-9_-]+$/.test(el.textContent?.trim() ?? ""))
		.map((el) => (el.textContent as string).trim());
}

const alpha: CommandDef = { name: "alpha", prompt: "prompt alpha" };
const beta: CommandDef = { name: "beta", prompt: "prompt beta" };
const gamma: CommandDef = { name: "gamma", prompt: "prompt gamma" };

describe("CommandsEditor", () => {
	test("edit form replaces the clicked row instead of appearing after the whole list", async () => {
		await renderEditor({ commands: [alpha, beta, gamma], onChange: () => {} });

		// Editing the first row must remove /alpha's summary and keep the other two.
		await click(buttonsByText(testI18n.t("commandEdit"))[0]);

		const names = renderedNames();
		expect(names).not.toContain("/alpha");
		expect(names).toEqual(["/beta", "/gamma"]);
		// The form is positioned before the remaining rows, i.e. where /alpha was.
		const formValue = nameInput().value;
		expect(formValue).toBe("alpha");
		const bodyText = container.textContent ?? "";
		expect(bodyText.indexOf("/beta")).toBeGreaterThan(bodyText.indexOf("prompt alpha"));
	});

	test("saving an edit writes back to the same command, not a shifted index", async () => {
		let saved: CommandDef[] | null = null;
		await renderEditor({
			commands: [alpha, beta, gamma],
			onChange: (cmds) => {
				saved = cmds;
			},
		});

		await click(buttonsByText(testI18n.t("commandEdit"))[1]);
		await typeInto(nameInput(), "beta-renamed");
		await click(buttonsByText(testI18n.t("commandSave"))[0]);

		expect(saved).not.toBeNull();
		expect((saved as unknown as CommandDef[]).map((c) => c.name)).toEqual([
			"alpha",
			"beta-renamed",
			"gamma",
		]);
	});

	test("deleting an earlier row keeps the open editor pointed at its own command", async () => {
		const onChange = mock((_cmds: CommandDef[]) => {});
		await renderEditor({ commands: [alpha, beta, gamma], onChange });

		// Open /gamma (index 2), then delete /alpha (index 0). Rows shift down by one,
		// so an un-adjusted editIndex would now address /gamma's old slot -> writes to
		// the wrong command on save.
		await click(buttonsByText(testI18n.t("commandEdit"))[2]);
		expect(nameInput().value).toBe("gamma");

		const deleteButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
			b.querySelector("svg"),
		) as unknown as HTMLElement[];
		await click(deleteButtons[0]);

		// The parent re-renders with the shortened list.
		await renderEditor({ commands: [beta, gamma], onChange });
		expect(nameInput().value).toBe("gamma");

		await typeInto(nameInput(), "gamma-renamed");
		await click(buttonsByText(testI18n.t("commandSave"))[0]);

		const lastCall = onChange.mock.calls.at(-1)?.[0] as CommandDef[];
		expect(lastCall.map((c) => c.name)).toEqual(["beta", "gamma-renamed"]);
	});
});
