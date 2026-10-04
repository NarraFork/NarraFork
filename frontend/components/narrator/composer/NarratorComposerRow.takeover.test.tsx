/**
 * Regression: a running subagent that is NOT taken over must keep the composer
 * input. Only the right-hand action button becomes「接管」.
 *
 * History: takeover (`930ee50c`) always painted the textarea; composer-row
 * extraction (`b028f5df`) early-returned the whole row on `canTakeover`, which
 * deleted the documented "queue a message at the next tool boundary" path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { NarratorComposerRowProps } from "./NarratorComposerRow";

mock.module("./NarratorComposer", () => ({
	NarratorComposer: (props: { ref?: unknown; narratorId?: string }) => (
		<div data-testid="composer-input" data-narrator-id={props.narratorId} />
	),
}));

const { NarratorComposerRow } = await import("./NarratorComposerRow");

let root: Root;
let host: HTMLElement;
let instance: i18n;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function baseProps(overrides: Partial<NarratorComposerRowProps> = {}): NarratorComposerRowProps {
	const noop = () => {};
	return {
		fileInputRef: createRef(),
		composerRef: createRef(),
		sendingRef: { current: false },
		appendInputRef: undefined,
		narratorId: "sub-1",
		isActive: true,
		composerHasText: false,
		composerHasAttachments: false,
		setComposerHasText: noop,
		effectiveFocusIndex: null,
		enterQueueMode: "turn",
		ctrlEnterQueueMode: "tool",
		onFileInputChange: noop,
		onComposerPasteImages: noop,
		onSendWithMode: noop,
		onSend: noop,
		onRetry: noop,
		onContinue: noop,
		onTakeover: noop,
		onStopTakeover: noop,
		queuedMessagesCount: 0,
		showCompactQueueChoice: false,
		canCutInLine: true,
		hasCutInMessage: false,
		canTakeover: false,
		isTakenOver: false,
		canRetryLastUserMessage: false,
		canContinueNarrator: false,
		retryRecoveryAllowsInterrupt: true,
		editingMessageState: null,
		isSending: false,
		takeoverMutationPending: false,
		stopTakeoverMutationPending: false,
		interruptMutationPending: false,
		interruptProgress: 0,
		queueHoldProgress: 0,
		startInterruptPress: noop,
		handleInterruptMouseUp: noop,
		clearInterruptTimer: noop,
		startQueueHold: noop,
		handleQueuePointerUp: noop,
		cancelQueueHold: noop,
		handleQueueClick: noop,
		onUpdateEnterQueueMode: noop,
		onUpdateCtrlEnterQueueMode: noop,
		...overrides,
	};
}

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		requestAnimationFrame: (callback: FrameRequestCallback): number => {
			queueMicrotask(() => callback(performance.now()));
			return 1;
		},
		cancelAnimationFrame: (): void => {},
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		getComputedStyle: (): Partial<CSSStyleDeclaration> => ({
			getPropertyValue: () => "0px",
			direction: "ltr",
			boxSizing: "border-box",
		}),
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	instance = i18next.createInstance();
	await instance.use(initReactI18next).init({
		lng: "en",
		resources: {
			en: {
				narrator: {
					takeover: "Take over",
					stopTakeover: "Stop takeover",
					stopTakeoverHint: "hand result back",
					attachFile: "Attach",
					interrupt: "Interrupt",
					queue: "Queue",
					send: "Send",
				},
				common: { send: "Send" },
			},
		},
		react: { useSuspense: false },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

async function renderRow(props: NarratorComposerRowProps) {
	await act(async () => {
		root.render(
			<I18nextProvider i18n={instance}>
				<MantineProvider>
					<NarratorComposerRow {...props} />
				</MantineProvider>
			</I18nextProvider>,
		);
	});
}

describe("NarratorComposerRow idle send label", () => {
	for (const mode of ["turn", "tool", "interrupt"] as const) {
		for (const canCutInLine of [false, true]) {
			test(`idle input shows Send for ${mode} preference, cut-in=${canCutInLine}`, async () => {
				const send = mock(() => {});
				const queueClick = mock(() => {});
				await renderRow(
					baseProps({
						isActive: false,
						composerHasText: true,
						enterQueueMode: mode,
						canCutInLine,
						onSend: send,
						handleQueueClick: queueClick,
					}),
				);
				const button = Array.from(host.querySelectorAll("button")).find(
					(element) => element.textContent?.trim() === "Send",
				);
				expect(button).toBeDefined();
				expect(host.textContent).not.toContain(`queueMode_${mode}`);
				await act(async () => button?.dispatchEvent(new Event("click", { bubbles: true })));
				expect(canCutInLine ? queueClick : send).toHaveBeenCalledTimes(1);
			});
		}
	}

	test("finishing work changes the primary label from the queue mode to Send", async () => {
		await renderRow(baseProps({ isActive: true, composerHasText: true }));
		expect(host.textContent).toContain("queueMode_turn");
		await renderRow(baseProps({ isActive: false, composerHasText: true, canCutInLine: false }));
		expect(host.textContent).toContain("Send");
		expect(host.textContent).not.toContain("queueMode_turn");
	});

	test("idle attachment-only input shows Send, including background compaction", async () => {
		for (const compacting of [false, true]) {
			await renderRow(
				baseProps({
					isActive: false,
					composerHasAttachments: true,
					canCutInLine: false,
					showCompactQueueChoice: compacting,
				}),
			);
			const button = Array.from(host.querySelectorAll("button")).find(
				(element) => element.textContent?.trim() === "Send",
			);
			expect(button).toBeDefined();
			expect(button?.disabled).toBe(false);
		}
	});
});

describe("NarratorComposerRow takeover input visibility", () => {
	test("canTakeover empty subagent keeps the input and paints Take over", async () => {
		await renderRow(baseProps({ canTakeover: true, isActive: true }));
		expect(host.querySelector("[data-testid='composer-input']")).not.toBeNull();
		expect(host.textContent).toContain("Take over");
	});

	test("canTakeover with typed text swaps action to primary (queue/send path)", async () => {
		await renderRow(
			baseProps({
				canTakeover: true,
				isActive: true,
				composerHasText: true,
			}),
		);
		expect(host.querySelector("[data-testid='composer-input']")).not.toBeNull();
		expect(host.textContent).not.toContain("Take over");
		// Active + canCutInLine → queue cluster, not takeover-only row.
		expect(host.textContent).toContain("queueMode_turn");
	});

	test("taken-over subagent keeps input and shows stop-takeover", async () => {
		await renderRow(baseProps({ isTakenOver: true, canTakeover: false, isActive: true }));
		expect(host.querySelector("[data-testid='composer-input']")).not.toBeNull();
		expect(host.textContent).toContain("Stop takeover");
	});

	for (const hasText of [false, true]) {
		test(`send menu has three fixed actions with draft=${hasText}, shortcuts stay separate`, async () => {
			const send = mock(() => {});
			const configure = mock(() => {});
			await renderRow(
				baseProps({
					composerHasText: hasText,
					onSendWithMode: send,
					onUpdateEnterQueueMode: configure,
				}),
			);
			const trigger = document.querySelector('button[aria-label="sendOptions"]');
			if (!trigger) throw new Error("Send menu missing");
			await act(async () => trigger.dispatchEvent(new Event("click", { bubbles: true })));
			const items = () => Array.from(document.querySelectorAll('[role="menuitem"]'));
			expect(items().filter((item) => item.textContent?.startsWith("queueMode_"))).toHaveLength(3);
			expect(document.body.textContent).not.toContain("enterKeySection");
			const shortcuts = items().find((item) => item.textContent === "sendKeySettings");
			if (!shortcuts) throw new Error("Shortcut settings missing");
			await act(async () => shortcuts.dispatchEvent(new Event("click", { bubbles: true })));
			expect(document.body.textContent).toContain("enterKeySection");
			expect(document.body.textContent).toContain("ctrlEnterKeySection");
			expect(send).not.toHaveBeenCalled();
			expect(configure).not.toHaveBeenCalled();
			const back = items().find((item) => item.textContent === "sendCurrentInputSection");
			if (!back) throw new Error("Back to send actions missing");
			await act(async () => back.dispatchEvent(new Event("click", { bubbles: true })));
			const guidance = items().find((item) => item.textContent?.startsWith("queueMode_tool"));
			if (!guidance) throw new Error("Guidance action missing");
			await act(async () => guidance.dispatchEvent(new Event("click", { bubbles: true })));
			expect(send).toHaveBeenCalledWith("tool");
			expect(configure).not.toHaveBeenCalled();
		});
	}

	test("primary action uses custom Enter mode and compaction retains wait/run choices", async () => {
		await renderRow(baseProps({ composerHasText: true, enterQueueMode: "tool" }));
		expect(host.textContent).toContain("queueMode_tool");
		await renderRow(
			baseProps({ composerHasText: true, showCompactQueueChoice: true, canCutInLine: false }),
		);
		const trigger = document.querySelector('button[aria-label="sendOptions"]');
		if (!trigger) throw new Error("Send menu missing");
		await act(async () => trigger.dispatchEvent(new Event("click", { bubbles: true })));
		expect(document.body.textContent).toContain("compactQueueMode_wait");
		expect(document.body.textContent).toContain("compactQueueMode_now");
		expect(document.body.textContent).not.toContain("queueMode_tool_desc");
	});
});
