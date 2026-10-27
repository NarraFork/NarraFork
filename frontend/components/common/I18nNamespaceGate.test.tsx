import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { Component, type ReactNode, StrictMode, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Namespace } from "../../lib/i18n";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

type ResourceModule = { default: Record<string, unknown> };
const loaders = new Map<string, () => Promise<ResourceModule>>();
const loadCalls = new Map<string, number>();
const localeLoaders = new Proxy(
	{},
	{
		get: (_target, key: string) => loaders.get(key),
	},
);
mock.module("../../lib/i18n-locale-loaders", () => ({ localeLoaders }));

const { default: i18n, ensureI18nNamespaces } = await import("../../lib/i18n");
await i18n.init({ lng: "en", fallbackLng: "en", resources: {} });
const { I18nNamespaceGate } = await import("./I18nNamespaceGate");

function resourceKey(language: string, namespace: string): string {
	return `../locales/${language}/${namespace}.json`;
}

function setLoader(language: string, namespace: string, result: Deferred<ResourceModule>): void {
	const key = resourceKey(language, namespace);
	loaders.set(key, () => {
		loadCalls.set(key, (loadCalls.get(key) ?? 0) + 1);
		return result.promise;
	});
}

function resource(value = "ready"): ResourceModule {
	return { default: { value } };
}

class TestErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null };
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	render() {
		if (this.state.error) {
			return <div data-error>{(this.state.error as Error).message}</div>;
		}
		return this.props.children;
	}
}

let root: Root | undefined;
let container: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	loaders.clear();
	loadCalls.clear();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: false,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});

afterEach(async () => {
	root?.unmount();
	root = undefined;
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for i18n gate");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function render(namespaces: readonly Namespace[], strict = false): void {
	const content = (
		<TestErrorBoundary>
			<Suspense fallback={<div data-pending>Loading translations</div>}>
				<I18nNamespaceGate namespaces={namespaces}>
					<div data-ready>translated.content</div>
				</I18nNamespaceGate>
			</Suspense>
		</TestErrorBoundary>
	);
	root?.render(strict ? <StrictMode>{content}</StrictMode> : content);
}

test("pending hides children and StrictMode shares one resource load until resolve", async () => {
	const loading = deferred<ResourceModule>();
	setLoader("en", "common", loading);
	render(["common"], true);
	await waitFor(() => !!container.querySelector("[data-pending]"));
	expect(container.querySelector("[data-ready]")).toBeNull();
	expect(container.textContent).not.toContain("translated.content");
	expect(loadCalls.get(resourceKey("en", "common"))).toBe(1);
	loading.resolve(resource());
	await waitFor(() => !!container.querySelector("[data-ready]"));
	expect(container.querySelector("[data-pending]")).toBeNull();
	expect(loadCalls.get(resourceKey("en", "common"))).toBe(1);
});

test("rejected resources reach the existing error boundary", async () => {
	const loading = deferred<ResourceModule>();
	setLoader("en", "errors", loading);
	render(["errors"]);
	await waitFor(() => !!container.querySelector("[data-pending]"));
	loading.reject(new Error("locale request failed"));
	await waitFor(() => !!container.querySelector("[data-error]"));
	expect(container.querySelector("[data-ready]")).toBeNull();
	expect(container.querySelector("[data-error]")?.textContent).toBe("locale request failed");
});

test("a rejected set and resource clear both caches so retry can succeed", async () => {
	const first = deferred<ResourceModule>();
	setLoader("en", "git", first);
	const rejected = ensureI18nNamespaces(["git"], "en");
	first.reject(new Error("temporary failure"));
	await expect(rejected).rejects.toThrow("temporary failure");

	const retry = deferred<ResourceModule>();
	setLoader("en", "git", retry);
	const retried = ensureI18nNamespaces(["git"], "en");
	expect(retried).not.toBe(rejected);
	retry.resolve(resource());
	await retried;
	expect(loadCalls.get(resourceKey("en", "git"))).toBe(2);
});

test("language plus sorted namespace set has a stable promise identity", async () => {
	const nav = deferred<ResourceModule>();
	const settings = deferred<ResourceModule>();
	setLoader("en", "nav", nav);
	setLoader("en", "settings", settings);
	const first = ensureI18nNamespaces(["nav", "settings"], "en");
	const reordered = ensureI18nNamespaces(["settings", "nav"], "en");
	expect(reordered).toBe(first);
	expect(loadCalls.get(resourceKey("en", "nav"))).toBe(1);
	expect(loadCalls.get(resourceKey("en", "settings"))).toBe(1);
	nav.resolve(resource());
	settings.resolve(resource());
	await first;
});

test("different languages isolate set promises while preserving fallback loading", async () => {
	const english = deferred<ResourceModule>();
	const chinese = deferred<ResourceModule>();
	setLoader("en", "dashboard", english);
	setLoader("zh-CN", "dashboard", chinese);
	const en = ensureI18nNamespaces(["dashboard"], "en");
	const zh = ensureI18nNamespaces(["dashboard"], "zh-CN");
	expect(zh).not.toBe(en);
	expect(loadCalls.get(resourceKey("en", "dashboard"))).toBe(1);
	expect(loadCalls.get(resourceKey("zh-CN", "dashboard"))).toBe(1);
	english.resolve(resource());
	chinese.resolve(resource());
	await Promise.all([en, zh]);
});
