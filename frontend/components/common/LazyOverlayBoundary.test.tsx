import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, lazy, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const exits: Array<() => void> = [];
const overlayMounts = { modal: 0, drawer: 0 };
const showNotification = mock(() => {});

interface TestOverlayProps {
	opened: boolean;
	children?: ReactNode;
	onExitTransitionEnd?: () => void;
	title?: ReactNode;
}

function testOverlay(type: "modal" | "drawer") {
	return ({ opened, children, onExitTransitionEnd, title }: TestOverlayProps) => {
		overlayMounts[type] += 1;
		exits.push(onExitTransitionEnd ?? (() => {}));
		return (
			<section role="dialog" data-type={type} data-opened={opened}>
				{title}
				{children}
			</section>
		);
	};
}

mock.module("@mantine/core", () => ({
	Modal: testOverlay("modal"),
	Drawer: testOverlay("drawer"),
	Group: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	Loader: () => <span>Loading</span>,
}));
mock.module("@mantine/notifications", () => ({
	notifications: { show: showNotification },
}));
mock.module("../../lib/i18n", () => ({
	default: { t: (key: string) => key },
}));

const { LazyOverlayShell } = await import("./LazyOverlayBoundary");

let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	exits.length = 0;
	overlayMounts.modal = 0;
	overlayMounts.drawer = 0;
	showNotification.mockClear();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});

async function render(ui: ReactNode) {
	await act(async () => root.render(ui));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("LazyOverlayShell", () => {
	test("shows one modal shell before a lazy body resolves and retains it through exit", async () => {
		const bodyModule = deferred<{ default: ({ opened }: { opened: boolean }) => ReactNode }>();
		const Body = lazy(() => bodyModule.promise);
		const view = (opened: boolean) => (
			<LazyOverlayShell type="modal" opened={opened} onClose={() => {}} title="Create">
				<Body opened={opened} />
			</LazyOverlayShell>
		);
		await render(view(true));
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		expect(container.textContent).toContain("Create");
		expect(container.textContent).toContain("Loading");
		expect(overlayMounts.modal).toBe(1);

		await act(async () => {
			bodyModule.resolve({ default: ({ opened }) => <p>Body {String(opened)}</p> });
			await bodyModule.promise;
		});
		expect(container.textContent).toContain("Body true");
		expect(overlayMounts.modal).toBe(1);

		await render(view(false));
		expect(container.textContent).toContain("Body false");
		await act(async () => exits.at(-1)?.());
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	test("ignores a late exit after rapid reopen", async () => {
		const view = (opened: boolean) => (
			<LazyOverlayShell type="modal" opened={opened} onClose={() => {}}>
				<p>Body {String(opened)}</p>
			</LazyOverlayShell>
		);
		await render(view(true));
		await render(view(false));
		const oldExit = exits.at(-1);
		await render(view(true));
		await act(async () => oldExit?.());
		expect(container.textContent).toContain("Body true");
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
	});

	test("keeps busy bodies unmounted and supports drawer shells", async () => {
		const importer = mock(() => new Promise<never>(() => {}));
		const Body = lazy(importer);
		const view = (busy: boolean) => (
			<LazyOverlayShell type="drawer" opened onClose={() => {}} busy={busy}>
				<Body />
			</LazyOverlayShell>
		);
		await render(view(true));
		expect(importer).not.toHaveBeenCalled();
		expect(document.querySelector('[data-type="drawer"]')).not.toBeNull();
		expect(container.textContent).toContain("Loading");
		await render(view(false));
		expect(importer).toHaveBeenCalledTimes(1);
	});

	test("an import failure does not rethrow while closing, and resets only on reopen", async () => {
		const Body = lazy(() =>
			Promise.reject(new Error("Failed to fetch dynamically imported module")),
		);
		const view = (opened: boolean) => (
			<LazyOverlayShell type="modal" opened={opened} onClose={() => {}} title="Safe shell">
				<Body />
			</LazyOverlayShell>
		);
		await render(view(true));
		await act(async () => {
			await Promise.resolve();
		});
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(container.textContent).toContain("Safe shell");
		expect(showNotification).toHaveBeenCalledTimes(1);

		await render(view(false));
		await act(async () => {
			await Promise.resolve();
		});
		expect(showNotification).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Safe shell");
		await act(async () => exits.at(-1)?.());
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		await render(view(true));
		await act(async () => {
			await Promise.resolve();
		});
		expect(showNotification).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Safe shell");
	});
});
