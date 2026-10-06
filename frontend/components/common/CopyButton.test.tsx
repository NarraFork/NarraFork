import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CopyButton } from "./CopyButton";

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
	Object.defineProperties(window.HTMLInputElement.prototype, {
		select: { value: () => {}, configurable: true },
		setSelectionRange: { value: () => {}, configurable: true },
	});
	Object.defineProperties(window.HTMLTextAreaElement.prototype, {
		select: { value: () => {}, configurable: true },
		setSelectionRange: { value: () => {}, configurable: true },
	});
	Object.defineProperty(window.document, "execCommand", {
		value: () => true,
		configurable: true,
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
		ResizeObserver: TestResizeObserver,
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

describe("CopyButton", () => {
	test("reports copied after the HTTP fallback succeeds", async () => {
		await act(async () => {
			root?.render(
				<CopyButton value="copy me">
					{({ copied, copy }) => (
						<button type="button" onClick={copy}>
							{copied ? "copied" : "copy"}
						</button>
					)}
				</CopyButton>,
			);
		});

		const button = container?.querySelector("button");
		await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(button?.textContent).toBe("copied");
	});
});
