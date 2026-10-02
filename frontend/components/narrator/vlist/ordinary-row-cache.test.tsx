import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, memo, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NarratorMsg } from "../narrator-panel-types";
import { toolDetailRequestFromData } from "./useVListToolDetails";
import * as blockTargets from "./vlist-block-target";
import * as editTargets from "./vlist-edit-target";
import { type RowInteraction, sameRowInteraction } from "./vlist-exact-row-state";
import type { VListRowHandlers } from "./vlist-row-actions";
import * as rowActions from "./vlist-row-actions";
import * as payloadReuse from "./vlist-row-payload-reuse";
import { buildSelectionIndex } from "./vlist-selection";
import { buildToolMetaIndex } from "./vlist-tool-meta";

// Exercise the shell's real builder, not a copied dependency list. Its query/WS
// shell cannot be mounted here; extracting this small hook also makes boundary
// changes fail loudly instead of testing an obsolete copy of the implementation.
const source = await Bun.file(new URL("./PretextExactMessageList.tsx", import.meta.url)).text();
const start = source.indexOf("const interactionReuseRef =");
const end = source.indexOf("// System cards (compact markers included)", start);
if (start < 0 || end < 0) throw new Error("Ordinary row builder boundary not found");
const dependencies = {
	useMemo,
	useRef,
	...blockTargets,
	...editTargets,
	...rowActions,
	...payloadReuse,
	sameRowInteraction,
	toolDetailRequestFromData,
};
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`
function useBindings({ narratorId, selectionIndex, rowHandlers, openEditor,
	messagesById, rowToolMetaIndex, manifestItems, renderItems, setOriginalModalMessageId,
	messageSelectedIds, onToggleMessageSelect }) {
	${source.slice(start, end)}
	return interactionsByKey;
}`);
interface Input {
	narratorId: string;
	messages: NarratorMsg[];
	handlers: VListRowHandlers;
}
const useBindings = new Function(...Object.keys(dependencies), `${code}\nreturn useBindings;`)(
	...Object.values(dependencies),
) as (input: Record<string, unknown>) => Map<string, RowInteraction>;

let root: Root;
let bindings: Map<string, RowInteraction>;
let renders: Map<string, number>;
const openEditor = mock((_key: string, _messageId: string, _role: string) => {});
const openOriginal = mock((_messageId: string) => {});
const originals = new Map<string, PropertyDescriptor | undefined>();
const Row = memo(({ id, payload }: { id: string; payload: RowInteraction }) => {
	renders.set(id, (renders.get(id) ?? 0) + 1);
	return <span data-row={id}>{payload.copyText}</span>;
});
function Probe({ narratorId, messages, handlers }: Input) {
	const renderItems = messages.map((message) => ({
		spec: {
			key: `${message.id}-b0`,
			kind: "markdown",
			data: { role: message.role },
		},
	}));
	bindings = useBindings({
		narratorId,
		selectionIndex: buildSelectionIndex(messages),
		rowToolMetaIndex: buildToolMetaIndex(messages),
		messagesById: new Map(messages.map((message) => [message.id, message])),
		rowHandlers: handlers,
		openEditor,
		setOriginalModalMessageId: openOriginal,
		renderItems,
		manifestItems: messages.map((message) => ({
			itemKey: `${message.id}-b0`,
			sourceMessageIds: [message.id],
		})),
	});
	return [...bindings].map(([id, payload]) => <Row key={id} id={id} payload={payload} />);
}
function message(id: string, text: string): NarratorMsg {
	return {
		id,
		narratorId: "owner",
		seq: 0,
		role: "assistant",
		contentJson: [{ type: "text", text }],
		contentText: text,
		children: [],
		toolCalls: [],
	} as unknown as NarratorMsg;
}
async function render(messages: NarratorMsg[], handlers: VListRowHandlers, narratorId = "owner") {
	await act(async () => root.render(<Probe {...{ narratorId, messages, handlers }} />));
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	renders = new Map();
	openEditor.mockClear();
	openOriginal.mockClear();
	root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

describe("ordinary row semantic cache", () => {
	test("tail updates rebuild all indices without rerendering unchanged historical rows", async () => {
		const history = Array.from({ length: 19 }, (_, i) => message(`m${i}`, `history ${i}`));
		const handlers = { onForkFromMessage: mock((_id: string) => {}) };
		await render([...history, message("tail", "initial")], handlers);
		const first = bindings.get("m0-b0");
		for (let i = 0; i < 5; i++) {
			await render([...history, message("tail", `latest ${i}`)], { ...handlers });
		}
		for (const item of history) expect(renders.get(`${item.id}-b0`)).toBe(1);
		expect(renders.get("tail-b0")).toBe(6);
		expect(bindings.get("m0-b0")).toBe(first);
		expect(document.querySelector('[data-row="tail-b0"]')?.textContent).toBe("latest 4");
		bindings.get("m0-b0")?.actions.onForkFromMessage?.();
		expect(handlers.onForkFromMessage).toHaveBeenCalledWith("m0");
	});

	test("changed handlers, edit capability and owner cannot reuse stale actions", async () => {
		const messages = [message("m", "text")];
		const oldFork = mock((_id: string) => {});
		const newFork = mock((_id: string) => {});
		await render(messages, { onForkFromMessage: oldFork });
		const first = bindings.get("m-b0");
		await render(messages, { onForkFromMessage: newFork, onEditAssistantMessage: () => {} });
		expect(bindings.get("m-b0")).not.toBe(first);
		bindings.get("m-b0")?.actions.onForkFromMessage?.();
		expect(oldFork).not.toHaveBeenCalled();
		expect(newFork).toHaveBeenCalledWith("m");
		bindings.get("m-b0")?.actions.onEditMessage?.();
		expect(openEditor).toHaveBeenCalledWith("m-b0", "m", "assistant");
		const handlers = { onForkFromMessage: newFork };
		await render(messages, handlers);
		expect(bindings.get("m-b0")?.actions.onEditMessage).toBeUndefined();
		const beforeOwnerChange = bindings.get("m-b0");
		await render(messages, handlers, "new-owner");
		expect(bindings.get("m-b0")).not.toBe(beforeOwnerChange);
	});

	test("snapshots queued callbacks even when a resolver mutates its result in place", async () => {
		const queued = { onEdit: mock(() => {}), onCancel: mock(() => {}) };
		const handlers = { resolveQueuedMessage: () => queued };
		const messages = [message("queued", "draft")];
		await render(messages, handlers);
		const previous = bindings.get("queued-b0");
		const oldCancel = queued.onCancel;
		queued.onCancel = mock(() => {});
		await render(messages, handlers);
		expect(bindings.get("queued-b0")).not.toBe(previous);
		bindings.get("queued-b0")?.actions.onCancelQueued?.();
		expect(queued.onCancel).toHaveBeenCalledTimes(1);
		expect(oldCancel).not.toHaveBeenCalled();
	});
	test("queued controls update independently and removed rows leave the cache", async () => {
		let queued = { onEdit: mock(() => {}), onCancel: mock(() => {}), onRetry: mock(() => {}) };
		const handlers = {
			resolveQueuedMessage: (id: string) => (id === "queued" ? queued : undefined),
		};
		const messages = [message("old", "old"), message("queued", "draft")];
		await render(messages, handlers);
		const previous = bindings.get("queued-b0");
		const oldControls = queued;
		queued = { onEdit: mock(() => {}), onCancel: mock(() => {}), onRetry: mock(() => {}) };
		await render(messages, handlers);
		expect(renders.get("old-b0")).toBe(1);
		expect(bindings.get("queued-b0")).not.toBe(previous);
		bindings.get("queued-b0")?.actions.onEditMessage?.();
		bindings.get("queued-b0")?.actions.onCancelQueued?.();
		bindings.get("queued-b0")?.actions.onRetryQueued?.();
		expect(queued.onEdit).toHaveBeenCalledTimes(1);
		expect(queued.onCancel).toHaveBeenCalledTimes(1);
		expect(queued.onRetry).toHaveBeenCalledTimes(1);
		expect(oldControls.onEdit).not.toHaveBeenCalled();
		await render(messages.slice(1), handlers);
		expect(bindings.has("old-b0")).toBe(false);
	});
});

describe("captured inputs remain part of row equality", () => {
	const base: RowInteraction = {
		blockId: "m",
		messageId: "m",
		blockIndex: 0,
		actions: { messageId: "m", onEditMessage: () => {} },
	};
	test("an editor role change is not hidden by identical action keys", () => {
		expect(
			sameRowInteraction({ ...base, editRole: "user" }, { ...base, editRole: "assistant" }),
		).toBe(false);
	});
	test("same-key queued closures must not retain the previous target", () => {
		expect(
			sameRowInteraction(
				{ ...base, queuedActions: { onEdit: () => {}, onCancel: () => {} } },
				{ ...base, queuedActions: { onEdit: () => {}, onCancel: () => {} } },
			),
		).toBe(false);
	});
	test("question identity and sequence changes remain visible to bindings", () => {
		expect(
			sameRowInteraction(
				{ ...base, toolMeta: { awaitQuestionId: "q1", awaitQuestionSeq: 1 } },
				{ ...base, toolMeta: { awaitQuestionId: "q2", awaitQuestionSeq: 1 } },
			),
		).toBe(false);
		expect(
			sameRowInteraction(
				{ ...base, toolMeta: { awaitQuestionId: "q1", awaitQuestionSeq: 1 } },
				{ ...base, toolMeta: { awaitQuestionId: "q1", awaitQuestionSeq: 2 } },
			),
		).toBe(false);
	});
});
