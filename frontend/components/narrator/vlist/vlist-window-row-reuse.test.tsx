import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	act,
	createContext,
	createElement,
	type ReactElement,
	StrictMode,
	Suspense,
	useContext,
	useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExactRowProps } from "./ExactRow";
import { mergePinnedRowIndices, resolvePinnedRowIndices } from "./vlist-virtualization";
import {
	buildWindowRowElementFrame,
	sameWindowRowProps,
	type WindowRowProjection,
} from "./vlist-window-row-reuse";

const noop = () => {};
function row(key: string): ExactRowProps {
	return {
		item: {
			spec: { key, kind: "markdown", data: { text: key } },
			measured: {},
		} as ExactRowProps["item"],
		top: 0,
		height: 40,
		hitHeight: 44,
		contentWidth: 640,
		itemId: key,
		sourceIds: [key],
		interactionSig: "settled",
		toggles: {
			onToggle: noop,
			onToggleItems: noop,
			onToggleEarlier: noop,
			onToggleRow: noop,
			onToggleTranslation: noop,
			onTogglePrompt: noop,
			onToggleFileChanges: noop,
		},
		renderLabels: {} as ExactRowProps["renderLabels"],
		narratorId: "n1",
	};
}
const factory = (key: string, props: ExactRowProps) => createElement(ProbeRow, { ...props, key });
const projections = (rows: readonly ExactRowProps[]) => rows.map((props) => ({ props }));

// Type-checked coverage: a future ExactRow prop cannot silently escape these tests.
const PROP_KEYS = {
	item: true,
	top: true,
	height: true,
	hitHeight: true,
	contentWidth: true,
	itemId: true,
	sourceIds: true,
	interactionSig: true,
	toggles: true,
	renderLabels: true,
	interaction: true,
	rowInteraction: true,
	closingRowKeys: true,
	narratorId: true,
	onOpenFilePanel: true,
	openAttachmentLabel: true,
	injectionNoteLabel: true,
	reviewTruncatedLabel: true,
	injectionNavigation: true,
	currentUserId: true,
	permissionSlot: true,
	traceRowPermissionSlots: true,
	onPermissionFormHeight: true,
	editorSlot: true,
	onUnknownHeight: true,
	onTerminate: true,
	resolveUpdateTimeout: true,
	onReflectionTakeOver: true,
	getReflectionTakeOver: true,
	onTogglePromptForKey: true,
	resolveRowToolActions: true,
	onResumeSubagentRecovery: true,
	specCarryoverActions: true,
	errorNoticeActions: true,
	injectionGuardActions: true,
	reviewFeedbackActions: true,
	compactActions: true,
	compactCancelTitle: true,
	askInPassingPending: true,
	onOpenAskInPassingTarget: true,
	viewControls: true,
	animateStreaming: true,
	streamAnimMountEpoch: true,
	streamAnimSnapshotEpoch: true,
	specTaskLive: true,
} satisfies Record<keyof ExactRowProps, true>;

describe("window row element frames", () => {
	test("a 20-row window moving one row creates only the entering element", () => {
		const rows = Array.from({ length: 21 }, (_, i) => row(`r${i}`));
		const create = mock(factory);
		const first = buildWindowRowElementFrame(null, "n1", projections(rows.slice(0, 20)), create);
		const next = buildWindowRowElementFrame(first, "n1", projections(rows.slice(1, 21)), create);
		expect(first.created).toBe(20);
		expect(next.created).toBe(1);
		expect(next.reused).toBe(19);
		expect(create).toHaveBeenCalledTimes(21);
		for (let i = 0; i < 19; i++) expect(next.elements[i]).toBe(first.elements[i + 1]);
		expect(next.entries.size).toBe(20);
		expect(next.entries.has("r0")).toBe(false);
	});

	test("every supplied prop participates in invalidation, including future optional props", () => {
		const input = row("r");
		const complete = Object.fromEntries(Object.keys(PROP_KEYS).map((key) => [key, undefined]));
		const before = { ...complete, ...input } as ExactRowProps;
		for (const key of Object.keys(PROP_KEYS) as (keyof ExactRowProps)[]) {
			const replacement = key === "sourceIds" ? ["different-source"] : {};
			expect(sameWindowRowProps(before, { ...before, [key]: replacement } as ExactRowProps)).toBe(
				false,
			);
		}
		expect(sameWindowRowProps(before, { ...before, futureProp: true } as ExactRowProps)).toBe(
			false,
		);
	});

	test("equal source-id arrays reuse, but reordering or replacing ids invalidates", () => {
		const props = { ...row("r"), sourceIds: ["a", "b"] };
		const first = buildWindowRowElementFrame(null, "n1", [{ props }], factory);
		const same = buildWindowRowElementFrame(
			first,
			"n1",
			[{ props: { ...props, sourceIds: ["a", "b"] } }],
			factory,
		);
		expect(same.elements[0]).toBe(first.elements[0]);
		for (const sourceIds of [["b", "a"], ["a", "c"], ["a"]]) {
			const changed = buildWindowRowElementFrame(
				first,
				"n1",
				[{ props: { ...props, sourceIds } }],
				factory,
			);
			expect(changed.created).toBe(1);
			expect(changed.elements[0]).not.toBe(first.elements[0]);
		}
	});

	test("captures caller-mutable props and source ids instead of retaining their alias", () => {
		const ids = ["a"];
		const props = { ...row("r"), sourceIds: ids, currentUserId: "old" };
		const first = buildWindowRowElementFrame(null, "n1", [{ props }], factory);
		props.currentUserId = "new";
		ids.push("b");
		expect(first.elements[0]?.props.currentUserId).toBe("old");
		expect(first.elements[0]?.props.sourceIds).toEqual(["a"]);
		const next = buildWindowRowElementFrame(first, "n1", [{ props }], factory);
		expect(next.created).toBe(1);
		expect(next.elements[0]?.props.sourceIds).toEqual(["a", "b"]);
	});

	test("new item wrappers conservatively invalidate even with identical measured data", () => {
		const props = row("r");
		const first = buildWindowRowElementFrame(null, "n1", [{ props }], factory);
		const next = buildWindowRowElementFrame(
			first,
			"n1",
			[{ props: { ...props, item: { ...props.item } } }],
			factory,
		);
		expect(next.created).toBe(1);
	});

	test("scope changes and empty windows release old entries", () => {
		const rows = projections([row("r")]);
		const first = buildWindowRowElementFrame(null, "n1", rows, factory);
		const switched = buildWindowRowElementFrame(first, "n2", rows, factory);
		expect(switched.created).toBe(1);
		expect(switched.elements[0]).not.toBe(first.elements[0]);
		const empty = buildWindowRowElementFrame(switched, "n2", [], factory);
		expect(empty.entries.size).toBe(0);
		expect(empty.elements).toEqual([]);
		expect(buildWindowRowElementFrame(empty, "n2", rows, factory).created).toBe(1);
	});

	test("a discarded frame cannot publish speculative callbacks or evict committed rows", () => {
		const oldCallback = mock(noop);
		const newCallback = mock(noop);
		const props = { ...row("r"), onTerminate: oldCallback };
		const first = buildWindowRowElementFrame(null, "n1", [{ props }], factory);
		const discarded = buildWindowRowElementFrame(
			first,
			"n1",
			projections([row("other"), { ...props, onTerminate: newCallback }]),
			factory,
		);
		expect(discarded.entries.has("other")).toBe(true);
		expect(first.entries.has("other")).toBe(false);
		const resumed = buildWindowRowElementFrame(first, "n1", [{ props }], factory);
		expect(resumed.reused).toBe(1);
		resumed.elements[0]?.props.onTerminate?.();
		expect(oldCallback).toHaveBeenCalledTimes(1);
		expect(newCallback).not.toHaveBeenCalled();
	});

	test("cache retention follows only the mounted window and merged pins", () => {
		const rows = Array.from({ length: 100 }, (_, i) => row(`r${i}`));
		let previous = buildWindowRowElementFrame(null, "n1", projections(rows.slice(0, 10)), factory);
		for (let start = 10; start < 90; start += 10) {
			const visible = { start, end: start + 10 };
			const pins = mergePinnedRowIndices(
				resolvePinnedRowIndices(visible, 1),
				resolvePinnedRowIndices(visible, 1),
			);
			const mounted = [
				...rows.slice(start, start + 10),
				...pins.flatMap((index) => (rows[index] ? [rows[index]] : [])),
			];
			previous = buildWindowRowElementFrame(previous, "n1", projections(mounted), factory);
			expect(previous.entries.size).toBe(11);
			expect(previous.elements.filter((element) => element.key === "r1").length).toBe(1);
		}
	});

	test("live, form, editor, unknown-height and closing rows never reuse cached elements", () => {
		const props = row("r");
		const variants: WindowRowProjection[] = [
			{ props, skipReuse: true },
			{
				props: {
					...props,
					item: { ...props.item, spec: { ...props.item.spec, opts: { streamingContent: true } } },
				},
			},
			{ props: { ...props, animateStreaming: true } },
			{ props: { ...props, permissionSlot: <input /> } },
			{ props: { ...props, editorSlot: <input /> } },
			{ props: { ...props, onUnknownHeight: noop } },
			{ props: { ...props, traceRowPermissionSlots: new Map([["q", <input />]]) } },
			{ props: { ...props, closingRowKeys: new Set(["nested"]) } },
			{ props: { ...props, askInPassingPending: {} as ExactRowProps["askInPassingPending"] } },
		];
		for (const variant of variants) {
			const first = buildWindowRowElementFrame(null, "n1", [variant], factory);
			const next = buildWindowRowElementFrame(first, "n1", [variant], factory);
			expect(next.created).toBe(1);
			expect(next.reused).toBe(0);
			expect(next.entries.size).toBe(0);
		}
	});
});

const Context = createContext("initial-context");
const setters = new Map<string, (value: string) => void>();
function ProbeRow(props: ExactRowProps) {
	const context = useContext(Context);
	const [draft, setDraft] = useState("");
	if ((props.item.spec.data as { suspend?: boolean }).suspend) throw new Promise(() => {});
	setters.set(props.item.spec.key, setDraft);
	return (
		<div data-row={props.item.spec.key}>
			<span>
				{props.interactionSig}|{props.openAttachmentLabel}|{context}|{draft}
			</span>
			<button type="button" onClick={props.onTerminate}>
				action
			</button>
			{props.editorSlot ?? props.permissionSlot}
		</div>
	);
}
const realRowModule = { ...(await import("./ExactRow")) };
mock.module("./ExactRow", () => ({ ...realRowModule, ExactRow: ProbeRow }));
const { useVListWindowRows } = await import("./useVListWindowRows");
let root: Root;
let container: HTMLElement;
let rendered: readonly ReactElement<ExactRowProps>[];
const globals = new Map<string, PropertyDescriptor | undefined>();
function Host({
	owner = "n1",
	rows,
	suspend = false,
}: {
	owner?: string;
	rows: WindowRowProjection[];
	suspend?: boolean;
}) {
	rendered = useVListWindowRows(owner, rows);
	if (suspend) throw new Promise(() => {});
	return <>{rendered}</>;
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	setters.clear();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
afterAll(() => {
	mock.module("./ExactRow", () => realRowModule);
	mock.restore();
});

describe("committed window hook behavior", () => {
	test("reused row nodes keep their own state while context still updates", async () => {
		const props = row("r");
		const rows = projections([props]);
		const tree = (context: string) => (
			<Context.Provider value={context}>
				<Host rows={rows} />
			</Context.Provider>
		);
		await act(async () => root.render(tree("first")));
		const element = rendered[0];
		const node = container.querySelector("[data-row=r]");
		await act(async () => setters.get("r")?.("draft text"));
		await act(async () => root.render(tree("second")));
		expect(rendered[0]).toBe(element);
		expect(container.querySelector("[data-row=r]")).toBe(node);
		expect(container.textContent).toContain("second|draft text");
	});

	test("latest callbacks, labels and height-neutral signatures reach a mounted row", async () => {
		const old = mock(noop);
		const next = mock(noop);
		const props = { ...row("r"), onTerminate: old, openAttachmentLabel: "old label" };
		await act(async () => root.render(<Host rows={projections([props])} />));
		const element = rendered[0];
		await act(async () =>
			root.render(
				<Host
					rows={projections([
						{
							...props,
							onTerminate: next,
							openAttachmentLabel: "new label",
							interactionSig: "live-tail-200|closing",
						},
					])}
				/>,
			),
		);
		expect(rendered[0]).not.toBe(element);
		expect(container.textContent).toContain("live-tail-200|closing|new label");
		container.querySelector("button")?.click();
		expect(next).toHaveBeenCalledTimes(1);
		expect(old).not.toHaveBeenCalled();
	});

	test("StrictMode reuse preserves pinned draft state when the visible band moves", async () => {
		const rows = [row("a"), row("b"), row("pinned")] as const;
		await act(async () =>
			root.render(
				<StrictMode>
					<Host rows={projections(rows)} />
				</StrictMode>,
			),
		);
		const pinned = container.querySelector("[data-row=pinned]");
		await act(async () => setters.get("pinned")?.("saved draft"));
		await act(async () =>
			root.render(
				<StrictMode>
					<Host rows={projections([rows[1], row("entering"), rows[2]])} />
				</StrictMode>,
			),
		);
		expect(container.querySelector("[data-row=pinned]")).toBe(pinned);
		expect(pinned?.textContent).toContain("saved draft");
		expect(container.querySelector("[data-row=a]")).toBeNull();
	});

	test.each([
		"permissionSlot",
		"editorSlot",
	] as const)("updates a dynamic %s without losing its draft when the window moves", async (slot) => {
		let setDraft: (value: string) => void = noop;
		function Form({ label }: { label: string }) {
			const [draft, updateDraft] = useState("");
			setDraft = updateDraft;
			return (
				<div>
					<span>{label}</span>
					<input value={draft} readOnly />
				</div>
			);
		}
		const props = row("pinned-form");
		await act(async () =>
			root.render(
				<Host rows={projections([row("leaving"), { ...props, [slot]: <Form label="old" /> }])} />,
			),
		);
		await act(async () => setDraft("saved input"));
		const input = container.querySelector("input");
		await act(async () =>
			root.render(
				<Host rows={projections([row("entering"), { ...props, [slot]: <Form label="new" /> }])} />,
			),
		);
		expect(container.textContent).toContain("new");
		expect(container.querySelector("input")).toBe(input);
		expect(input?.value).toBe("saved input");
	});
	test("a suspending child cannot publish speculative row elements", async () => {
		const props = row("r");
		const tree = (input: ExactRowProps) => (
			<Suspense fallback={<span>fallback</span>}>
				<Host rows={projections([input])} />
			</Suspense>
		);
		await act(async () => root.render(tree(props)));
		const element = rendered[0];
		const pending = {
			...props,
			item: { ...props.item, spec: { ...props.item.spec, data: { suspend: true } } },
			interactionSig: "uncommitted-child",
		};
		await act(async () => root.render(tree(pending)));
		expect(rendered[0]).not.toBe(element);
		await act(async () => root.render(tree(props)));
		expect(rendered[0]).toBe(element);
		expect(container.textContent).not.toContain("uncommitted-child");
	});
	test("a suspended render does not replace the committed element cache", async () => {
		const props = row("r");
		const tree = (suspend: boolean, input = props) => (
			<Suspense fallback={<span>fallback</span>}>
				<Host rows={projections([input])} suspend={suspend} />
			</Suspense>
		);
		await act(async () => root.render(tree(false)));
		const element = rendered[0];
		await act(async () => root.render(tree(true, { ...props, interactionSig: "uncommitted" })));
		expect(rendered[0]).not.toBe(element);
		await act(async () => root.render(tree(false)));
		expect(rendered[0]).toBe(element);
		expect(container.textContent).not.toContain("uncommitted");
	});
});
