import { afterEach, beforeEach, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useWcoTitlebarRows, WCO_TITLEBAR_PAGE_ATTRIBUTE } from "./wco-titlebar";

let originals: Map<string, PropertyDescriptor | undefined>;
let host: HTMLElement;
let root: Root;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = {
		window,
		document: window.document,
		HTMLElement: window.HTMLElement,
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	originals = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	Object.assign(globalThis, values);
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function Page({ titlebar }: { titlebar: boolean }) {
	const ref = useWcoTitlebarRows(titlebar);
	return <div ref={ref} data-nf-wco-titlebar={titlebar || undefined} />;
}

const flagged = () => document.documentElement.hasAttribute(WCO_TITLEBAR_PAGE_ATTRIBUTE);

test("<html> carries the title-bar page flag exactly while such a root is mounted", () => {
	act(() => root.render(<Page titlebar />));
	expect(flagged()).toBe(true);
	// The workspace drops the root attribute in place when it becomes a window.
	act(() => root.render(<Page titlebar={false} />));
	expect(flagged()).toBe(false);
	act(() => root.render(<Page titlebar />));
	expect(flagged()).toBe(true);
	act(() => root.render(<span />));
	expect(flagged()).toBe(false);
});

test("two title-bar roots keep the flag until the last one unmounts", () => {
	act(() =>
		root.render(
			<>
				<Page titlebar />
				<Page titlebar />
			</>,
		),
	);
	expect(flagged()).toBe(true);
	act(() => root.render(<Page titlebar />));
	expect(flagged()).toBe(true);
	act(() => root.render(null));
	expect(flagged()).toBe(false);
});
