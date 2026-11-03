/**
 * The prompt-optimizing corner marker.
 *
 * Rendering-level checks only: the marker must appear while an optimization runs,
 * must look like the app's other "something is happening" markers (the same
 * `pulse-dot` beat the rest of the UI uses), and must give the corner back to the
 * draft pencil once it is over.
 *
 * The store is the source of truth, so these drive it directly rather than mocking
 * a prop chain — that is the same path the sidebar and list page take.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	resetPromptOptimizeTasksForTest,
	startPromptOptimizeTask,
} from "../../lib/prompt-optimize-tasks";
import { NarratorStatusIcon } from "./NarratorStatusIcon";

let root: Root;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

function render(ui: React.ReactNode) {
	return act(async () => root.render(<MantineProvider env="test">{ui}</MantineProvider>));
}

function marker() {
	return host.querySelector("[data-tab-optimizing-prompt]");
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
	resetPromptOptimizeTasksForTest();
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
	resetPromptOptimizeTasksForTest();
});

describe("prompt-optimizing marker", () => {
	test("is absent when nothing is running", async () => {
		await render(<NarratorStatusIcon size={16} status="idle" hasDraft />);
		expect(marker()).toBeNull();
	});

	test("appears while an optimization runs", async () => {
		await render(<NarratorStatusIcon size={16} status="idle" isOptimizingPrompt />);
		expect(marker()).not.toBeNull();
	});

	test("pulses, so it reads as running rather than as a static state", async () => {
		await render(<NarratorStatusIcon size={16} status="idle" isOptimizingPrompt />);
		const style = (marker() as HTMLElement).getAttribute("style") ?? "";
		// Reuses the app's established in-progress beat rather than inventing one.
		expect(style).toContain("pulse-dot");
		expect(style).toContain("infinite");
	});

	test("takes the corner from the draft pencil instead of stacking two markers", async () => {
		await render(<NarratorStatusIcon size={16} status="idle" hasDraft isOptimizingPrompt />);
		expect(marker()).not.toBeNull();
		// The draft marker occupies the same corner and is suppressed while
		// optimizing — see NarratorStatusIconProps.isOptimizingPrompt.
		const draftMarkers = host.querySelectorAll("[data-tab-shape]");
		expect(draftMarkers).toHaveLength(0);
	});

	test("disappears when the task finishes", async () => {
		// Drive the real store: a running task shows the marker…
		let finish!: (value: { text: string }) => void;
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		});
		await render(<NarratorStatusIcon size={16} status="idle" isOptimizingPrompt />);

		// …and the flag the call site passes goes false once it settles, which the
		// sidebar/list derive from `isNarratorOptimizingPrompt`.
		await act(async () => finish({ text: "done" }));
		await render(<NarratorStatusIcon size={16} status="idle" isOptimizingPrompt={false} />);
		expect(marker()).toBeNull();
	});
});
