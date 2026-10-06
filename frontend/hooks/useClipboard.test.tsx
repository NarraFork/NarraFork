import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useClipboard } from "./useClipboard";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function installDom(execCommand: () => boolean) {
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
		value: execCommand,
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
		IS_REACT_ACT_ENVIRONMENT: true,
	});
}

function ClipboardHarness({ timeout = 1000 }: { timeout?: number }) {
	const clipboard = useClipboard({ timeout });
	return (
		<div>
			<button type="button" onClick={() => clipboard.copy("copy me")}>
				copy
			</button>
			<span data-testid="copied">{clipboard.copied ? "yes" : "no"}</span>
			<span data-testid="error">{clipboard.error?.message ?? ""}</span>
		</div>
	);
}

async function renderHarness(execCommand: () => boolean, timeout?: number) {
	installDom(execCommand);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root?.render(<ClipboardHarness timeout={timeout} />));
	const button = container.querySelector("button");
	await act(async () => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
	root = undefined;
	container = undefined;
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

describe("useClipboard", () => {
	test("sets and resets copied state after a successful fallback", async () => {
		await renderHarness(() => true, 10);
		expect(container?.querySelector('[data-testid="copied"]')?.textContent).toBe("yes");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(container?.querySelector('[data-testid="copied"]')?.textContent).toBe("no");
	});

	test("exposes an error when both clipboard paths fail", async () => {
		await renderHarness(() => false);
		expect(container?.querySelector('[data-testid="copied"]')?.textContent).toBe("no");
		expect(container?.querySelector('[data-testid="error"]')?.textContent).toContain(
			"Clipboard copy command failed",
		);
	});
});
