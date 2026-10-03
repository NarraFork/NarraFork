import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("./useInstanceSettings", () => ({
	useInstanceSettings: () => ({ promptOptimizeContextMaxMessages: 10 }),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { usePromptOptimize } = await import("./usePromptOptimize");
const { narratorsApi } = await import("../lib/api/narrators");
const { notifications } = await import("@mantine/notifications");
let root: Root;
let result: ReturnType<typeof usePromptOptimize>;
let applied: string[];
let requests: {
	signal: AbortSignal;
	resolve: (value: { text: string }) => void;
	reject: (error: Error) => void;
}[];
const originals = new Map<string, PropertyDescriptor | undefined>();
let restore: (() => void)[];
function Probe() {
	result = usePromptOptimize({
		narratorId: "n",
		textareaRef: {
			current: {
				value: "original",
				focus() {},
				setSelectionRange() {},
			} as unknown as HTMLTextAreaElement,
		},
		onOptimized: (text) => applied.push(text),
	});
	return null;
}
beforeEach(async () => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Object.assign(document, { execCommand: () => false });
	applied = [];
	requests = [];
	const api = spyOn(narratorsApi, "optimizePrompt").mockImplementation(
		(_id, _text, _style, options) =>
			new Promise((resolve, reject) =>
				requests.push({
					signal: options?.signal as AbortSignal,
					resolve: (value) => resolve({ ...value, model: "test" }),
					reject,
				}),
			),
	);
	const notify = spyOn(notifications, "show").mockImplementation(() => "id");
	restore = [() => api.mockRestore(), () => notify.mockRestore()];
	root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const fn of restore) fn();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});
test("cancel immediately clears loading and ignores a late successful response", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	expect(result.loading).toBe(true);
	await act(async () => result.cancelOptimize());
	expect(requests[0].signal.aborted).toBe(true);
	expect(result.loading).toBe(false);
	await act(async () => {
		requests[0].resolve({ text: "late" });
		await pending;
	});
	expect(applied).toEqual([]);
	expect(notifications.show).not.toHaveBeenCalled();
});
test("old request rejection cannot clear a newer request's loading", async () => {
	let first!: Promise<void>;
	let second!: Promise<void>;
	await act(async () => {
		first = result.handleOptimize("clarify");
	});
	await act(async () => {
		second = result.handleOptimize("concise");
	});
	await act(async () => {
		requests[0].reject(new Error("late failure"));
		await first;
	});
	expect(result.loading).toBe(true);
	expect(notifications.show).not.toHaveBeenCalled();
	await act(async () => {
		requests[1].resolve({ text: "new" });
		await second;
	});
	expect(applied).toEqual(["new"]);
	expect(result.loading).toBe(false);
});
test("unmount aborts and suppresses late text and notifications", async () => {
	let pending!: Promise<void>;
	await act(async () => {
		pending = result.handleOptimize("clarify");
	});
	await act(async () => root.unmount());
	expect(requests[0].signal.aborted).toBe(true);
	requests[0].resolve({ text: "late" });
	await pending;
	expect(applied).toEqual([]);
	expect(notifications.show).not.toHaveBeenCalled();
});
