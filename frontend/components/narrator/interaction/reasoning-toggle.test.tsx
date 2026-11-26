import { afterEach, beforeEach, expect, test } from "bun:test";
import { MantineProvider, Menu, NativeSelect } from "@mantine/core";
import type { RuntimeModelSummary } from "@shared/model-runtime";
import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InlineOverrideActions } from "./InlineOverrideActions";
import { ReasoningEffortMenuItems } from "./ReasoningEffortMenuItems";
import {
	displayReasoningEffort,
	runtimeReasoningEffortSupport,
	useModelSelection,
} from "./use-model-selection";

let root: Root;
let host: HTMLDivElement;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		},
		cancelAnimationFrame: () => {},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = window.document.createElement("div") as unknown as HTMLDivElement;
	window.document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousGlobals.clear();
});

const summary: RuntimeModelSummary = {
	selection: { value: "relay:fixed", label: "Fixed" },
	state: "observed",
	revision: "one",
	settingsRevision: 1,
	concreteValue: "relay:fixed",
	resolvedProvider: "relay",
	resolvedBareModel: "fixed",
	reasoning: { supported: true, mode: "fixed", canDisable: true, levels: [] },
};
const t = (key: string) => key;

test.each([
	"fixed",
	"empty",
])("%s intensity renders an off-only menu without highlighting off while enabled", async (kind) => {
	const modelSummary = {
		...summary,
		reasoning: {
			...summary.reasoning,
			mode: kind === "fixed" ? ("fixed" as const) : undefined,
			levels: kind === "fixed" ? undefined : [],
		},
	};
	const mutations: Array<string | null> = [];
	function Harness() {
		const [override, setOverride] = useState<string | null>(null);
		const mutation = {
			mutate: (input: { id: string; reasoningEffort: string | null }) => {
				mutations.push(input.reasoningEffort);
				setOverride(input.reasoningEffort);
			},
		};
		const selection = useModelSelection({
			narratorId: "n",
			resolvedModel: "relay:fixed",
			resolvedBareModel: "fixed",
			resolvedModelOption: undefined,
			narratorReasoningEffort: override,
			settingsData: { agent: { defaultReasoningEffort: "max" } },
			modelSummary,
			reasoningEffortMutation: mutation,
			updateSettingsMutation: { mutate: () => {} },
		});
		// The same controls and conditional follow-default path used by both status-bar layouts.
		return (
			selection.supportsReasoningEffort && (
				<Menu opened>
					<NativeSelect
						data={[
							{
								value: selection.displayedReasoningEffort,
								label: t(`reasoning_${selection.displayedReasoningEffort}`),
							},
						]}
						value={selection.displayedReasoningEffort}
						onChange={() => {}}
					/>
					<ReasoningEffortMenuItems
						currentEffort={selection.displayedReasoningEffort}
						options={selection.reasoningEffortOptions}
						onSelect={(effort) => mutation.mutate({ id: "n", reasoningEffort: effort })}
						t={t}
					/>
					<InlineOverrideActions
						visible={!selection.reasoningFollowsDefault}
						disabled={false}
						onFollowDefault={selection.handleFollowDefaultReasoning}
						onSetAsDefault={selection.handleSetReasoningAsDefault}
						t={t}
					/>
				</Menu>
			)
		);
	}
	await act(async () =>
		root.render(
			<MantineProvider env="test">
				<Harness />
			</MantineProvider>,
		),
	);
	const off = () =>
		[...host.querySelectorAll("button")].find((button) => button.textContent === "reasoning_none");
	expect(host.querySelector("select")?.textContent).toBe("reasoning_enabled");
	expect(off()?.querySelector("svg")?.getAttribute("style")).toContain("visibility:hidden");
	expect(host.textContent).not.toContain("reasoning_low");
	expect(host.textContent).not.toContain("override_followDefault");
	await act(async () => off()?.click());
	expect(mutations).toEqual(["none"]);
	expect(host.querySelector("select")?.textContent).toBe("reasoning_none");
	expect(off()?.querySelector("svg")?.getAttribute("style")).toContain("visibility:visible");
	const follow = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "override_followDefault",
	);
	expect(follow).toBeDefined();
	await act(async () => follow?.click());
	expect(mutations).toEqual(["none", null]);
	expect(host.querySelector("select")?.textContent).toBe("reasoning_enabled");
	expect(off()?.querySelector("svg")?.getAttribute("style")).toContain("visibility:hidden");
});

test("fixed mandatory, unsupported and unresolved models still hide the control", () => {
	for (const modelSummary of [
		{ ...summary, reasoning: { ...summary.reasoning, canDisable: false } },
		{ ...summary, reasoning: { ...summary.reasoning, supported: false } },
		{ ...summary, state: "not-observed" as const },
	])
		expect(runtimeReasoningEffortSupport(modelSummary).supportsReasoningEffort).toBe(false);
	// The draft composer uses the same display-only state, never a clamp to off.
	expect(displayReasoningEffort("max", ["none"])).toBe("enabled");
	expect(displayReasoningEffort("none", ["none"])).toBe("none");
});
