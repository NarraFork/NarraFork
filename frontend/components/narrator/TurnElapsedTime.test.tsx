import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import narratorEn from "../../locales/en/narrator.json";
import { RetryCountdownText, TurnElapsedTime } from "./interaction/TurnElapsedTime";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	initImmediate: false,
	interpolation: { escapeValue: false },
	resources: { en: { narrator: narratorEn } },
});

let root: Root;
let container: HTMLDivElement;
let restoreGlobals: () => void;

beforeEach(() => {
	const { window } = parseHTML("<html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		// floating-ui's platform sniffing expects these fields on a real navigator.
		navigator: { platform: "test", userAgent: "test", maxTouchPoints: 0 },
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		ShadowRoot: window.ShadowRoot,
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		getComputedStyle: () => ({ getPropertyValue: () => "", boxSizing: "border-box" }),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const descriptors = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	restoreGlobals = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	restoreGlobals();
});

async function render(node: ReactNode) {
	await act(async () =>
		root.render(
			<I18nextProvider i18n={i18n}>
				<MantineProvider env="test">{node}</MantineProvider>
			</I18nextProvider>,
		),
	);
}

function text() {
	return container.textContent ?? "";
}

describe("TurnElapsedTime", () => {
	test("each 1Hz tick updates only the clock leaf, never parent siblings", async () => {
		let siblingRenders = 0;
		const SiblingProbe = () => {
			siblingRenders++;
			return <span>idle</span>;
		};
		const startedAt = new Date(Date.now() - 1500).toISOString();
		await render(
			<div>
				<TurnElapsedTime
					turnStartedAt={startedAt}
					endAt={undefined}
					running
					substatus={[]}
					isMobile={false}
				/>
				<SiblingProbe />
			</div>,
		);
		const firstText = text();
		expect(firstText).toContain("0:01");
		expect(firstText).toContain("idle");
		expect(siblingRenders).toBe(1);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 2200));
		});

		// Two timer ticks later the leaf shows a later duration while the parent
		// subtree (the probe) never re-rendered.
		expect(siblingRenders).toBe(1);
		expect(text()).not.toContain(firstText.match(/0:0[12]/)?.[0] ?? "");
		expect(text()).toMatch(/0:0[234]/);
	});

	test("stopping freezes at updatedAt and switching to another turn resets immediately", async () => {
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		const updatedAt = new Date(Date.now() - 30_000).toISOString();
		await render(
			<TurnElapsedTime
				turnStartedAt={startedAt}
				endAt={updatedAt}
				running={false}
				substatus={[]}
				isMobile={false}
			/>,
		);
		expect(text()).toContain("0:30");

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1200));
		});
		// No interval is armed for a finished turn: the frozen value must not drift.
		expect(text()).toContain("0:30");

		// A new turn must not show the previous turn's elapsed value for a commit.
		await render(
			<TurnElapsedTime
				turnStartedAt={new Date().toISOString()}
				endAt={undefined}
				running
				substatus={[]}
				isMobile={false}
			/>,
		);
		expect(text()).toContain("0:00");
		expect(text()).not.toContain("0:30");
	});
});

describe("RetryCountdownText", () => {
	test("counts down inside the leaf without re-rendering siblings", async () => {
		let siblingRenders = 0;
		const SiblingProbe = () => {
			siblingRenders++;
			return <span>list</span>;
		};
		const retryInfo = {
			message: "boom",
			retryCount: 1,
			maxRetries: 3,
			retryAt: Date.now() + 2500,
		};
		await render(
			<div>
				<RetryCountdownText retryInfo={retryInfo} color="yellow" />
				<SiblingProbe />
			</div>,
		);
		expect(text()).toContain("Retry 1/3");
		expect(siblingRenders).toBe(1);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1400));
		});
		expect(siblingRenders).toBe(1);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1600));
		});
		// After the deadline the leaf settles on the non-countdown label and the
		// interval is cleared (no more ticking after this assertion point).
		expect(text()).toContain("retrying…");
	});
});
