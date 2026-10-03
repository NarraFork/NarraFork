import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import {
	act,
	type ComponentProps,
	type ComponentType,
	createContext,
	createElement,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";

// Only replace the expensive original bodies. The memo boundary under test is
// imported from production AFTER these mocks; no test-side memo/comparator exists.
// Run with --isolate: mock.module replacements belong to this test's registry.
// These probes test React boundary/lifecycle semantics, not Mantine animations,
// actual compact retry/WS effects, or the original dialogs' draft-reset policies.
const SessionContext = createContext("initial");
let renders: number;
let parentRenders: number;
let mounts: number;
let unmounts: number;
let latestProps: object;
let setDraft: (value: string) => void;
let querySnapshot = 0;
const queryListeners = new Set<() => void>();
let callbackArgs: Record<string, readonly unknown[]>;

function subscribeQuery(listener: () => void) {
	queryListeners.add(listener);
	return () => queryListeners.delete(listener);
}
function getQuerySnapshot() {
	return querySnapshot;
}

function createProbe(name: string) {
	return function DialogBodyProbe(props: object) {
		renders++;
		latestProps = props;
		const session = useContext(SessionContext);
		const [draft, updateDraft] = useState("");
		setDraft = updateDraft;
		const query = useSyncExternalStore(subscribeQuery, getQuerySnapshot);
		useEffect(() => {
			mounts++;
			return () => {
				unmounts++;
			};
		}, []);
		return (
			<section data-dialog={name} data-session={session} data-query={query}>
				<textarea value={draft} readOnly />
				{Object.entries(props).map(([key, value]) =>
					typeof value === "function" ? (
						<button
							key={key}
							type="button"
							data-callback={key}
							onClick={() => Reflect.apply(value, undefined, callbackArgs[key] ?? [])}
						>
							{key}
						</button>
					) : null,
				)}
			</section>
		);
	};
}

mock.module("../compact/compact-summary-modal", () => ({
	CompactSummaryModal: createProbe("CompactSummaryModal"),
}));
mock.module("../context-management/ContextThresholdSettingsModal", () => ({
	ContextThresholdSettingsModal: createProbe("ContextThresholdSettingsModal"),
}));
mock.module("../interaction/SetGlobalModelModal", () => ({
	SetGlobalModelModal: createProbe("SetGlobalModelModal"),
}));
mock.module("../permission/LeakedToolCallModal", () => ({
	LeakedToolCallModal: createProbe("LeakedToolCallModal"),
}));
mock.module("../permission/RevertScopeConfirmModal", () => ({
	RevertActionConfirmModal: createProbe("RevertActionConfirmModal"),
}));
const dialogs = await import("./memoized-dialogs");

let root: Root;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
	renders = parentRenders = mounts = unmounts = querySnapshot = 0;
	queryListeners.clear();
	callbackArgs = {};
});

afterEach(async () => {
	try {
		await act(async () => root.unmount());
		expect(queryListeners.size).toBe(0);
	} finally {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
		originals.clear();
	}
});

const noop = () => {};
type DialogName = keyof typeof dialogs;

function testDialog<P extends object>(
	name: DialogName,
	Dialog: ComponentType<P>,
	initialProps: P,
	changes: Partial<P>[],
	closedProps: Partial<P>,
	args: Record<string, readonly unknown[]> = {},
) {
	function ViewportParent({ props, compact }: { props: P; compact?: boolean }) {
		parentRenders++;
		return <main data-compact={String(compact)}>{createElement(Dialog, props)}</main>;
	}
	async function render(props = initialProps, compact?: boolean, session = "initial") {
		await act(async () => {
			root.render(
				<SessionContext.Provider value={session}>
					<ViewportParent props={props} compact={compact} />
				</SessionContext.Provider>,
			);
		});
	}
	async function clickCallback(key: string) {
		const button = host.querySelector<HTMLButtonElement>(`[data-callback="${key}"]`);
		expect(button).not.toBeNull();
		await act(async () => button?.click());
	}

	describe(name, () => {
		test("viewport-only parent rerenders skip the mounted body, both open and closed", async () => {
			for (const props of [initialProps, { ...initialProps, ...closedProps }]) {
				await render(props);
				const count = renders;
				const parentCount = parentRenders;
				for (const compact of [true, false, true, false, undefined]) {
					// Fresh props container, but every dialog prop remains shallow equal.
					await render({ ...props }, compact);
					expect(host.querySelector("main")?.getAttribute("data-compact")).toBe(String(compact));
					expect(renders).toBe(count);
				}
				expect(parentRenders).toBe(parentCount + 5);
			}
			expect(mounts).toBe(1);
			expect(unmounts).toBe(0);
		});

		test("each real payload/flag change reaches the body, including while closed", async () => {
			let props = initialProps;
			await render(props);
			for (const change of changes) {
				const count = renders;
				props = { ...props, ...change };
				await render(props);
				expect(renders).toBe(count + 1);
				for (const [key, value] of Object.entries(change)) {
					expect(Reflect.get(latestProps, key)).toBe(value);
				}
				await render({ ...props });
				expect(renders).toBe(count + 1);
			}
			expect(mounts).toBe(1);
			expect(unmounts).toBe(0);
		});

		test("every callback identity is compared and actions use the newest callback when closed", async () => {
			callbackArgs = args;
			let props = { ...initialProps, ...closedProps };
			await render(props);
			for (const [key, value] of Object.entries(initialProps)) {
				if (typeof value !== "function") continue;
				const oldCalls: unknown[][] = [];
				const newCalls: unknown[][] = [];
				const oldCallback = (...values: unknown[]) => oldCalls.push(values);
				const newCallback = (...values: unknown[]) => newCalls.push(values);
				let count = renders;
				props = { ...props, [key]: oldCallback };
				await render(props);
				expect(renders).toBe(count + 1);
				await clickCallback(key);
				expect(oldCalls).toEqual([[...(args[key] ?? [])]]);
				count = renders;
				props = { ...props, [key]: newCallback };
				await render(props);
				expect(renders).toBe(count + 1);
				expect(Reflect.get(latestProps, key)).toBe(newCallback);
				await clickCallback(key);
				expect(newCalls).toEqual([[...(args[key] ?? [])]]);
				expect(oldCalls).toHaveLength(1);
			}
		});

		test("close/reopen preserves the probe instance, DOM and local draft without unmounting", async () => {
			await render();
			await act(async () => setDraft("unsaved probe draft"));
			const textarea = host.querySelector("textarea");
			const section = host.querySelector("section");
			for (const props of [{ ...initialProps, ...closedProps }, initialProps]) {
				await render(props);
				expect(host.querySelector("section")).toBe(section);
				expect(host.querySelector("textarea")).toBe(textarea);
				expect(textarea?.value).toBe("unsaved probe draft");
				expect(mounts).toBe(1);
				expect(unmounts).toBe(0);
				expect(queryListeners.size).toBe(1);
			}
		});

		test("own state, consumed context and query-like subscriptions still update a closed memo body", async () => {
			const props = { ...initialProps, ...closedProps };
			await render(props);
			let count = renders;
			await act(async () => setDraft("local update"));
			expect(renders).toBe(count + 1);
			expect(host.querySelector("textarea")?.value).toBe("local update");
			count = renders;
			await render(props, true, "new session");
			expect(renders).toBe(count + 1);
			expect(host.querySelector("section")?.getAttribute("data-session")).toBe("new session");
			count = renders;
			await act(async () => {
				querySnapshot++;
				for (const listener of queryListeners) listener();
			});
			expect(renders).toBe(count + 1);
			expect(host.querySelector("section")?.getAttribute("data-query")).toBe("1");
			expect(mounts).toBe(1);
			expect(unmounts).toBe(0);
		});
	});
}

const compactProps: ComponentProps<typeof dialogs.CompactSummaryModal> = {
	target: { kind: "context", narratorId: "narrator", messageId: "compact-1" },
	onClose: noop,
};
testDialog(
	"CompactSummaryModal",
	dialogs.CompactSummaryModal,
	compactProps,
	[
		{
			target: {
				...compactProps.target,
				kind: "context",
				narratorId: "narrator",
				messageId: "compact-1",
			},
		},
		{ target: null },
		{
			target: {
				kind: "segment",
				narratorId: "other",
				messageId: "compact-2",
				autoEdit: true,
				onDelete: noop,
			},
		},
	],
	{ target: null },
);

const thresholdProps: ComponentProps<typeof dialogs.ContextThresholdSettingsModal> = {
	opened: true,
	current: {
		contextThresholds: { standard: { compactStart: 80 }, large: { compactStart: 90 } },
		autoCompactKeepPairs: 2,
	},
	saving: false,
	canSave: true,
	onClose: noop,
	onSave: noop,
	onOpenGlobalSettings: noop,
};
testDialog(
	"ContextThresholdSettingsModal",
	dialogs.ContextThresholdSettingsModal,
	thresholdProps,
	[
		{ opened: false },
		{ saving: true },
		{ canSave: false },
		{ current: { ...thresholdProps.current } },
		{ current: { ...thresholdProps.current, autoCompactKeepPairs: 3 } },
		{ opened: true },
	],
	{ opened: false },
	{ onSave: [thresholdProps.current] },
);

const modelProps: ComponentProps<typeof dialogs.SetGlobalModelModal> = {
	opened: true,
	mode: "default",
	groupedModels: [{ group: "provider", items: [{ value: "model-a", label: "Model A" }] }],
	currentValue: undefined,
	saving: false,
	onClose: noop,
	onConfirm: noop,
};
testDialog(
	"SetGlobalModelModal",
	dialogs.SetGlobalModelModal,
	modelProps,
	[
		{ opened: false },
		{ currentValue: null },
		{ currentValue: "model-b" },
		{ currentValue: undefined },
		{ mode: null },
		{ mode: "summary" },
		{ groupedModels: [...modelProps.groupedModels] },
		{ groupedModels: [] },
		{ saving: true },
		{ opened: true },
	],
	{ opened: false, mode: null },
	{ onConfirm: ["model-b"] },
);

const leakedProps: ComponentProps<typeof dialogs.LeakedToolCallModal> = {
	narratorId: "narrator",
	event: { phase: "recovered", apiRequestId: "request-1", toolNames: ["Read"] },
	onClose: noop,
};
testDialog(
	"LeakedToolCallModal",
	dialogs.LeakedToolCallModal,
	leakedProps,
	[
		{ event: null },
		{ narratorId: "other" },
		{ event: { phase: "unrecovered", apiRequestId: "request-2", snippet: "diagnostic" } },
		{ event: { phase: "unrecovered", apiRequestId: "request-2", snippet: "diagnostic" } },
	],
	{ event: null },
);

const revertProps: ComponentProps<typeof dialogs.RevertActionConfirmModal> = {
	narratorId: "narrator",
	action: "rollback_to_block",
	pending: { messageId: "message-1", blockIndex: 1 },
	onConfirm: noop,
	onCancel: noop,
};
testDialog(
	"RevertActionConfirmModal",
	dialogs.RevertActionConfirmModal,
	revertProps,
	[
		{ pending: null },
		{ submitting: undefined },
		{ submitting: true },
		{ submitting: false },
		{ narratorId: "other" },
		{ action: "delete_tool_block" },
		{ pending: { messageId: "message-2", blockIndex: 2 } },
		{ pending: { messageId: "message-2", blockIndex: 2 } },
	],
	{ pending: null },
	{ onConfirm: [{ skipRevert: true }] },
);

test("memo wrappers forward nullable/undefined values and optional prop presence unchanged", async () => {
	await act(async () => root.render(<dialogs.SetGlobalModelModal {...modelProps} />));
	expect(Object.hasOwn(latestProps, "currentValue")).toBe(true);
	expect(Reflect.get(latestProps, "currentValue")).toBeUndefined();
	await act(async () =>
		root.render(<dialogs.SetGlobalModelModal {...modelProps} mode={null} currentValue={null} />),
	);
	expect(Reflect.get(latestProps, "mode")).toBeNull();
	expect(Reflect.get(latestProps, "currentValue")).toBeNull();
	await act(async () => root.render(<dialogs.RevertActionConfirmModal {...revertProps} />));
	expect(Object.hasOwn(latestProps, "submitting")).toBe(false);
	await act(async () =>
		root.render(<dialogs.RevertActionConfirmModal {...revertProps} submitting={undefined} />),
	);
	expect(Object.hasOwn(latestProps, "submitting")).toBe(true);
	expect(Reflect.get(latestProps, "submitting")).toBeUndefined();
});

test("NarratorPanel imports the real memo shells and uses non-inline exit/navigation callbacks", () => {
	const source = readFileSync(new URL("../NarratorPanel.tsx", import.meta.url), "utf8");
	const importMatch = source.match(
		/import\s*\{([^}]+)\}\s*from\s*["']\.\/panels\/memoized-dialogs["']/,
	);
	expect(importMatch).not.toBeNull();
	for (const name of Object.keys(dialogs)) {
		expect(importMatch?.[1]).toMatch(new RegExp(`\\b${name}\\b`));
		const tags = [...source.matchAll(new RegExp(`<${name}\\b([\\s\\S]*?)\\/\\s*>`, "g"))];
		expect(tags.length).toBeGreaterThan(0);
		for (const tag of tags) {
			const callbacks = [
				...tag[1].matchAll(/\b(onClose|onCancel|onOpenGlobalSettings)\s*=\s*\{\s*([^}]+)\}/g),
			];
			expect(callbacks.length).toBeGreaterThan(0);
			for (const callback of callbacks) {
				expect(callback[2]).not.toMatch(/=>|\bfunction\b/);
			}
		}
	}
});
