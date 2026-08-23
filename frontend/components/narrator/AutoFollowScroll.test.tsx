/**
 * AutoFollowScroll.test.tsx — tail-following semantics, and above all the
 * `followOnMount={false}` mode the vlist tool OUTPUT boxes use:
 *
 *  - a COMPLETED body still opens at its head (mount never pins it to the tail,
 *    so the truncated-body auto-fetch keeps gating on the reader's own scroll);
 *  - a GROWING (streaming) body follows its own growth to the tail;
 *  - a reader scrolling up detaches the follow and gets a jump-to-bottom button;
 *    scrolling back to the tail (or pressing it) re-arms the follow.
 *
 * linkedom has no layout, so scroll geometry is stubbed per element (or on the
 * HTMLElement prototype for the mount-time case, where the element does not
 * exist yet when the first follow runs). i18n is a REAL instance (the
 * I18nextProvider pattern) — a `mock.module("react-i18next")` here leaks into
 * every later file of the same bun invocation (they share one module
 * registry), which once broke CodexQuotaIndicator's suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import narratorLocale from "../../locales/en/narrator.json";
import { AutoFollowScroll } from "./AutoFollowScroll";

/** The en translation of narrator.scrollToBottom ("Scroll to bottom"). */
const RESUME_LABEL: string = narratorLocale.scrollToBottom;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let testI18n: i18n;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
	// Run rAF callbacks SYNCHRONOUSLY: the effect's extra `requestAnimationFrame(followNow)`
	// pass would otherwise land on a macrotask AFTER the surrounding act() closed,
	// and its setState shows up as an "update not wrapped in act" warning. The
	// callback never re-schedules, so a synchronous stub cannot recurse.
	const requestAnimationFrame = (callback: FrameRequestCallback) => {
		callback(0);
		return 0;
	};
	const cancelAnimationFrame = (_id: number) => {};
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

beforeEach(async () => {
	installDom();
	testI18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "narrator",
		ns: ["narrator"],
		resources: { en: { narrator: narratorLocale } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	const el = window.document.createElement("div");
	window.document.body.appendChild(el);
	container = el as unknown as HTMLDivElement;
	root = createRoot(el as unknown as Element);
});

afterEach(async () => {
	// React 19 wants the unmount itself inside act, same as any other update.
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

/** Render (or re-render) the follow wrapper around ONE scrollable child. */
async function renderFollow(opts: {
	dep: string;
	followKey?: string;
	followOnMount?: boolean;
}): Promise<void> {
	await act(async () => {
		root?.render(
			<MantineProvider>
				<I18nextProvider i18n={testI18n}>
					<AutoFollowScroll
						asChild
						deps={[opts.dep]}
						{...(opts.followKey !== undefined ? { followKey: opts.followKey } : {})}
						{...(opts.followOnMount !== undefined ? { followOnMount: opts.followOnMount } : {})}
					>
						<div data-testid="scroll" style={{ overflowY: "auto" }}>
							{opts.dep}
						</div>
					</AutoFollowScroll>
				</I18nextProvider>
			</MantineProvider>,
		);
	});
}

function scrollBox(): HTMLElement {
	const box = container?.querySelector("[data-testid='scroll']");
	if (!box) throw new Error("scroll box not found");
	return box as unknown as HTMLElement;
}

/** The 1000px body in a 200px viewport; the tail sits at scrollTop 800+. */
function stubGeometry(
	box: HTMLElement,
	geom: { scrollHeight?: number; clientHeight?: number; scrollTop?: number } = {},
): void {
	Object.defineProperties(box, {
		scrollHeight: { configurable: true, writable: true, value: geom.scrollHeight ?? 1000 },
		clientHeight: { configurable: true, writable: true, value: geom.clientHeight ?? 200 },
		scrollTop: { configurable: true, writable: true, value: geom.scrollTop ?? 0 },
	});
}

function setScrollTop(box: HTMLElement, value: number): void {
	Object.defineProperty(box, "scrollTop", { configurable: true, writable: true, value });
}

async function dispatch(box: HTMLElement, type: string): Promise<void> {
	await act(async () => {
		box.dispatchEvent(new (globalThis.Event as typeof Event)(type, { bubbles: true }));
	});
}

function resumeButton(): Element | null {
	return container?.querySelector(`button[aria-label='${RESUME_LABEL}']`) ?? null;
}

describe("AutoFollowScroll — mount behaviour", () => {
	test("pins to the tail on mount by default", async () => {
		// The element does not exist before the first render, so the geometry has
		// to live on the prototype for the mount-time follow to read.
		const proto = (globalThis.HTMLElement as unknown as { prototype: object })
			.prototype as HTMLElement;
		const prev = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
		Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1000 });
		try {
			await renderFollow({ dep: "a" });
			expect(scrollBox().scrollTop).toBe(1000);
		} finally {
			if (prev) Object.defineProperty(proto, "scrollHeight", prev);
			else Reflect.deleteProperty(proto, "scrollHeight");
		}
	});

	test("followOnMount={false} leaves a completed body at its head", async () => {
		await renderFollow({ dep: "a", followOnMount: false });
		stubGeometry(scrollBox());
		// No deps change → no follow pass → the box stays exactly where it opened.
		expect(scrollBox().scrollTop).toBe(0);
	});

	test("a followKey change follows at once even with followOnMount={false}", async () => {
		await renderFollow({ dep: "a", followKey: "s1", followOnMount: false });
		stubGeometry(scrollBox());
		expect(scrollBox().scrollTop).toBe(0);
		// A new streaming session starts: the reader wants its tail immediately.
		await renderFollow({ dep: "a", followKey: "s2", followOnMount: false });
		expect(scrollBox().scrollTop).toBe(1000);
	});
});

describe("AutoFollowScroll — followOnMount={false} growth following", () => {
	test("follows while the content grows", async () => {
		await renderFollow({ dep: "a", followOnMount: false });
		stubGeometry(scrollBox());
		await renderFollow({ dep: "ab", followOnMount: false });
		expect(scrollBox().scrollTop).toBe(1000);
		await renderFollow({ dep: "abc", followOnMount: false });
		expect(scrollBox().scrollTop).toBe(1000);
	});

	test("a reader scrolling up detaches the follow and gets a jump button", async () => {
		await renderFollow({ dep: "a", followOnMount: false });
		const box = scrollBox();
		stubGeometry(box);
		await dispatch(box, "wheel");
		setScrollTop(box, 100);
		await dispatch(box, "scroll");
		expect(resumeButton()).not.toBeNull();
		// Growth no longer yanks the reader back to the tail.
		await renderFollow({ dep: "ab", followOnMount: false });
		expect(scrollBox().scrollTop).toBe(100);
	});

	test("scrolling back to the tail re-arms the follow", async () => {
		await renderFollow({ dep: "a", followOnMount: false });
		const box = scrollBox();
		stubGeometry(box);
		await dispatch(box, "wheel");
		setScrollTop(box, 100);
		await dispatch(box, "scroll");
		expect(resumeButton()).not.toBeNull();
		setScrollTop(box, 1000);
		await dispatch(box, "scroll");
		expect(resumeButton()).toBeNull();
		await renderFollow({ dep: "ab", followOnMount: false });
		expect(scrollBox().scrollTop).toBe(1000);
	});

	test("the jump button returns to the tail and re-arms the follow", async () => {
		await renderFollow({ dep: "a", followOnMount: false });
		const box = scrollBox();
		stubGeometry(box);
		await dispatch(box, "wheel");
		setScrollTop(box, 100);
		await dispatch(box, "scroll");
		const button = resumeButton();
		if (!button) throw new Error("resume button not found");
		await act(async () => {
			button.dispatchEvent(new (globalThis.Event as typeof Event)("click", { bubbles: true }));
		});
		expect(scrollBox().scrollTop).toBe(1000);
		expect(resumeButton()).toBeNull();
	});
});
