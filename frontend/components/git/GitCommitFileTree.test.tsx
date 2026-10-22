import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { GitCommitFile } from "@shared/git-commit-preview";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import gitLocale from "../../locales/en/git.json";
import { GitCommitFileTree } from "./GitCommitFileTree";

const FILES: GitCommitFile[] = [
	{ path: "src/one.ts", status: "modified", linesAdded: 1, linesRemoved: 1, binary: false },
	{ path: "docs/readme.md", status: "modified", linesAdded: 1, linesRemoved: 0, binary: false },
];

const i18n = i18next.createInstance();
let root: Root;
let host: HTMLDivElement;
let restoreDom: () => void;

function rect(top: number, bottom: number) {
	return {
		top,
		bottom,
		left: 0,
		right: 200,
		width: 200,
		height: bottom - top,
		x: 0,
		y: top,
		toJSON() {},
	};
}

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const restore: Array<() => void> = [];
	const patch = (object: object, descriptors: PropertyDescriptorMap) => {
		const saved = Object.keys(descriptors).map(
			(key) => [key, Object.getOwnPropertyDescriptor(object, key)] as const,
		);
		Object.defineProperties(object, descriptors);
		restore.push(() => {
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(object, key, descriptor);
				else Reflect.deleteProperty(object, key);
			}
		});
	};
	const positions = new WeakMap<object, number>();
	patch(window.HTMLElement.prototype, {
		scrollTop: {
			configurable: true,
			get() {
				return positions.get(this) ?? 0;
			},
			set(value: number) {
				positions.set(this, value);
			},
		},
		getBoundingClientRect: {
			configurable: true,
			value() {
				const element = this as HTMLElement;
				if (element.hasAttribute("data-commit-file")) return rect(400, 424);
				if (element.hasAttribute("data-commit-file-list")) return rect(0, 120);
				return rect(0, 0);
			},
		},
	});
	patch(globalThis, {
		window: { configurable: true, writable: true, value: window },
		document: { configurable: true, writable: true, value: window.document },
		HTMLElement: { configurable: true, writable: true, value: window.HTMLElement },
		Element: { configurable: true, writable: true, value: window.Element },
		Node: { configurable: true, writable: true, value: window.Node },
		Event: { configurable: true, writable: true, value: window.Event },
		requestAnimationFrame: {
			configurable: true,
			writable: true,
			value: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		},
		cancelAnimationFrame: {
			configurable: true,
			writable: true,
			value: (id: number) => clearTimeout(id),
		},
		IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: false },
	});
	restoreDom = () => {
		for (const undo of restore.reverse()) undo();
	};
}

function renderUi(content: ReactNode) {
	root.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider env="test">{content}</MantineProvider>
		</I18nextProvider>,
	);
}

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean, description: string) {
	for (let attempt = 0; attempt < 40; attempt++) {
		if (predicate()) return;
		await flush();
	}
	throw new Error(`Timed out waiting for ${description}`);
}

function click(selector: string) {
	const found = document.body.querySelector<HTMLElement>(selector);
	if (!found) throw new Error(`Element not found: ${selector}`);
	found.dispatchEvent(new Event("click", { bubbles: true }));
}

function Harness() {
	const [path, setPath] = useState("docs/readme.md");
	return (
		<div data-commit-file-list>
			<button type="button" data-select-one onClick={() => setPath("src/one.ts")}>
				select one
			</button>
			<GitCommitFileTree files={FILES} selectedPath={path} onSelect={setPath} />
		</div>
	);
}

describe("GitCommitFileTree reveal", () => {
	beforeEach(async () => {
		installDom();
		if (!i18n.isInitialized) {
			await i18n.use(initReactI18next).init({
				lng: "en",
				fallbackLng: "en",
				defaultNS: "git",
				ns: ["git"],
				resources: { en: { git: gitLocale } },
				interpolation: { escapeValue: false },
				react: { useSuspense: false },
			});
		}
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(async () => {
		root.unmount();
		await flush();
		host.remove();
		restoreDom();
	});

	test("opens a collapsed ancestor and scrolls the newly selected file into view", async () => {
		renderUi(<Harness />);
		await waitFor(() => !!document.body.querySelector('[data-commit-file="src/one.ts"]'), "tree");
		click('[data-commit-folder="src"]');
		await waitFor(
			() => document.body.querySelector('[data-commit-file="src/one.ts"]') == null,
			"collapsed src",
		);
		const list = document.body.querySelector<HTMLElement>("[data-commit-file-list]");
		if (!list) throw new Error("file list missing");
		list.scrollTop = 0;

		click("[data-select-one]");
		await waitFor(
			() => !!document.body.querySelector('[data-commit-file="src/one.ts"]'),
			"revealed file",
		);
		expect(
			document.body.querySelector('[data-commit-folder="src"]')?.getAttribute("aria-expanded"),
		).toBe("true");
		expect(list.scrollTop).toBeGreaterThan(0);

		click('[data-commit-folder="src"]');
		await waitFor(
			() => document.body.querySelector('[data-commit-file="src/one.ts"]') == null,
			"selection stays collapsible",
		);
	});
});
