import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { copyTextToClipboard } from "./clipboard";

const g = globalThis as typeof globalThis & {
	document?: Document;
	window?: Window & typeof globalThis;
	navigator?: Navigator;
	HTMLInputElement?: typeof HTMLInputElement;
	HTMLTextAreaElement?: typeof HTMLTextAreaElement;
	HTMLElement?: typeof HTMLElement;
};

const originals = {
	document: g.document,
	window: g.window,
	navigator: g.navigator,
	HTMLInputElement: g.HTMLInputElement,
	HTMLTextAreaElement: g.HTMLTextAreaElement,
	HTMLElement: g.HTMLElement,
};

function setGlobal(key: keyof typeof originals, value: unknown) {
	Object.defineProperty(g, key, { value, configurable: true, writable: true });
}

function installDom({ secure = false }: { secure?: boolean } = {}) {
	const { window } = parseHTML("<!doctype html><html><body><button>before</button></body></html>");
	Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
	Object.defineProperties(window.HTMLInputElement.prototype, {
		select: { value: () => {}, configurable: true },
		setSelectionRange: { value: () => {}, configurable: true },
	});
	Object.defineProperties(window.HTMLTextAreaElement.prototype, {
		select: { value: () => {}, configurable: true },
		setSelectionRange: { value: () => {}, configurable: true },
	});
	setGlobal("window", window);
	setGlobal("document", window.document);
	setGlobal("navigator", window.navigator);
	setGlobal("HTMLInputElement", window.HTMLInputElement);
	setGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
	setGlobal("HTMLElement", window.HTMLElement);
	return window;
}

beforeEach(() => {
	installDom();
});

afterEach(() => {
	for (const [key, value] of Object.entries(originals)) {
		if (value === undefined) Reflect.deleteProperty(g, key);
		else setGlobal(key as keyof typeof originals, value);
	}
	mock.restore();
});

describe("copyTextToClipboard", () => {
	test("uses a selected input immediately on plain HTTP", async () => {
		let copiedValue = "";
		const execCommand = mock(() => {
			copiedValue = (document.body.querySelector("input") as HTMLInputElement | null)?.value ?? "";
			return true;
		});
		Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

		const copyPromise = copyTextToClipboard("plain text");
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(copiedValue).toBe("plain text");
		expect(document.body.querySelector("input")).toBeNull();
		await copyPromise;
	});

	test("uses a textarea for multiline text", async () => {
		let copiedValue = "";
		Object.defineProperty(document, "execCommand", {
			value: () => {
				copiedValue =
					(document.body.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? "";
				return true;
			},
			configurable: true,
		});

		await copyTextToClipboard("first\nsecond");
		expect(copiedValue).toBe("first\nsecond");
		expect(document.body.querySelector("textarea")).toBeNull();
	});

	test("prefers Clipboard API in a secure context", async () => {
		const window = installDom({ secure: true });
		const writeText = mock(async () => {});
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const execCommand = mock(() => true);
		Object.defineProperty(window.document, "execCommand", {
			value: execCommand,
			configurable: true,
		});

		await copyTextToClipboard("secure text");
		expect(writeText).toHaveBeenCalledWith("secure text");
		expect(execCommand).not.toHaveBeenCalled();
	});

	test("falls back when Clipboard API rejects", async () => {
		const window = installDom({ secure: true });
		const writeText = mock(async () => {
			throw new Error("denied");
		});
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		const execCommand = mock(() => true);
		Object.defineProperty(window.document, "execCommand", {
			value: execCommand,
			configurable: true,
		});

		await copyTextToClipboard("fallback text");
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(execCommand).toHaveBeenCalledWith("copy");
	});

	test("throws and cleans up when the legacy command fails", async () => {
		Object.defineProperty(document, "execCommand", {
			value: () => false,
			configurable: true,
		});

		await expect(copyTextToClipboard("cannot copy")).rejects.toThrow(
			"Clipboard copy command failed",
		);
		expect(document.body.querySelector("input, textarea")).toBeNull();
	});
});
