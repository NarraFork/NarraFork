import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { NodeFilter, parseHTML } from "linkedom";
import { act, memo, StrictMode, useContext, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../../lib/api";
import { MessageSelectionCtx, type MessageSelectionResolver } from "../message/MessageSelectionCtx";
import type { NarratorMsg } from "../narrator-panel-types";
import { getGlobalOnSelectionRange } from "../scroll/swipeState";
import { type UseMessageSelectionOptions, useMessageSelection } from "./use-message-selection";

// The vlist remains a dynamically loaded surface, including in test fixtures
// outside its module boundary. Only this test needs the real index builder.
const {
	buildSelectionIndex,
	computeSelectedRange,
	entriesToBlockMeta,
	entriesToMessageIds,
	entriesToText,
} = await import("../vlist/vlist-selection");

type Selection = ReturnType<typeof useMessageSelection>;
let root: Root | null;
let selection: Selection;
let options: UseMessageSelectionOptions;
let parentRenders: number;
let consumerRenders: number;
let writeText: ReturnType<typeof mock<(text: string) => Promise<void>>>;
let restoreSpies: () => void;
let deleteBlocks: ReturnType<typeof spyOn<typeof api, "deleteMessageBlocks">>;
let forkMessages: ReturnType<typeof spyOn<typeof api, "forkFromMessages">>;
let compactMessages: ReturnType<typeof spyOn<typeof api, "triggerSegmentCompact">>;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Row = memo(() => {
	consumerRenders++;
	const value = useContext(MessageSelectionCtx);
	return (
		<button
			type="button"
			data-selection-mode={value.selectionMode}
			data-selection-count={value.selectedBlockIds.size}
			onClick={() => value.toggleBlock("msg-a-0")}
		>
			Toggle
		</button>
	);
});

function Publisher({
	publish,
	resolver,
}: {
	publish: Selection["setChunkSelectionResolver"];
	resolver: MessageSelectionResolver | null;
}) {
	useEffect(() => {
		publish(resolver);
		return () => publish(null);
	}, [publish, resolver]);
	return null;
}

function Probe({ resolver }: { resolver?: MessageSelectionResolver | null }) {
	parentRenders++;
	selection = useMessageSelection(options);
	return (
		<MessageSelectionCtx.Provider value={selection.selectionCtxValue}>
			<Row />
			{resolver !== undefined && (
				<Publisher publish={selection.setChunkSelectionResolver} resolver={resolver} />
			)}
		</MessageSelectionCtx.Provider>
	);
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	writeText = mock(async (_text: string) => {});
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		Node: window.Node,
		NodeFilter,
		getComputedStyle: () => ({ display: "block", visibility: "visible" }),
		navigator: { clipboard: { writeText } },
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	parentRenders = 0;
	consumerRenders = 0;
	const content = document.createElement("div");
	for (const [id, text] of [
		["a", "DOM A"],
		["dom-middle", "DOM middle"],
		["c", "DOM C"],
	]) {
		const block = content.appendChild(document.createElement("div"));
		block.setAttribute("data-block-id", `msg-${id}-0`);
		block.setAttribute("data-message-id", id);
		block.setAttribute("data-block-index", "0");
		block.textContent = text;
	}
	options = {
		narratorId: "narrator-a",
		contentRef: { current: content },
		// This test exercises selection, not layout; no shared HTMLElement geometry stubs.
		viewportRef: { current: null },
		chunkListRef: {
			current: { detachFromBottom: mock(() => {}), refreshStructure: mock(() => {}) },
		},
		navigate: mock(async () => {}),
		t: (key) => key,
		confirm: mock(async () => true),
		compactSupported: true,
		compactUnsupportedReason: "",
		compactUsesFallbackSummary: false,
		compactFallbackSummaryReason: "",
	};
	const show = spyOn(notifications, "show").mockReturnValue("notification");
	deleteBlocks = spyOn(api, "deleteMessageBlocks").mockResolvedValue({
		ok: true,
		deleted: 1,
		failed: 0,
	});
	forkMessages = spyOn(api, "forkFromMessages").mockResolvedValue({ id: "forked" });
	compactMessages = spyOn(api, "triggerSegmentCompact").mockResolvedValue({ ok: true });
	restoreSpies = () => {
		show.mockRestore();
		deleteBlocks.mockRestore();
		forkMessages.mockRestore();
		compactMessages.mockRestore();
	};
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	restoreSpies();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(
	narratorId = "narrator-a",
	resolver?: MessageSelectionResolver | null,
	strict = false,
) {
	options = { ...options, narratorId };
	await act(async () => {
		const probe = <Probe resolver={resolver} />;
		root?.render(strict ? <StrictMode>{probe}</StrictMode> : probe);
	});
}

async function publish(resolver: MessageSelectionResolver | null) {
	await act(async () => selection.setChunkSelectionResolver(resolver));
}

async function clickToggle() {
	await act(async () => document.querySelector<HTMLButtonElement>("button")?.click());
}

function indexedResolver(ids: string[], prefix = "index"): MessageSelectionResolver {
	const messages = ids.map(
		(id, seq) =>
			({
				id,
				seq: seq + 1,
				role: "user",
				contentText: `${prefix} ${id}`,
				contentJson: [{ type: "text", text: `${prefix} ${id}` }],
				children: [],
			}) as unknown as NarratorMsg,
	);
	const index = buildSelectionIndex(messages);
	return {
		resolveRange: (anchorId, targetId) => {
			const anchor = index.byBlockId.get(anchorId);
			const target = index.byBlockId.get(targetId);
			return anchor && target ? computeSelectedRange(index, anchor, target) : null;
		},
		resolveSelectedMeta: (ids) => entriesToBlockMeta(index.entries, ids),
		resolveSelectedMessageIds: (ids) => entriesToMessageIds(index.entries, ids),
		collectSelectedText: (ids) => entriesToText(index.entries, ids),
	};
}

function deferredRange() {
	let resolve!: (value: Set<string> | null) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Set<string> | null>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("selection resolver publication", () => {
	test("five idle publications add zero parent or memoized context-consumer renders", async () => {
		await render();
		expect(selection.selectionMode).toBe(false);
		expect(selection.selectedBlockIds.size).toBe(0);
		const before = { parent: parentRenders, consumer: consumerRenders };
		const context = selection.selectionCtxValue;
		const setter = selection.setChunkSelectionResolver;
		for (let i = 0; i < 5; i++) {
			// Match the list's effect cleanup + registration when its index changes.
			await act(async () => {
				setter(null);
				setter(indexedResolver(["a", `middle-${i}`, "c"]));
			});
		}
		expect({
			parent: parentRenders - before.parent,
			consumer: consumerRenders - before.consumer,
		}).toEqual({ parent: 0, consumer: 0 });
		expect(selection.selectionCtxValue).toBe(context);
		expect(selection.setChunkSelectionResolver).toBe(setter);
	});

	test("publication stays silent while selected, but actual toggles still notify the row", async () => {
		await render();
		await clickToggle();
		expect(selection.selectionMode).toBe(true);
		const before = { parent: parentRenders, consumer: consumerRenders };
		const context = selection.selectionCtxValue;
		for (let i = 0; i < 5; i++) await publish(indexedResolver(["a", "c"]));
		await publish(null);
		expect({
			parent: parentRenders - before.parent,
			consumer: consumerRenders - before.consumer,
		}).toEqual({ parent: 0, consumer: 0 });
		expect(selection.selectionCtxValue).toBe(context);
		await clickToggle();
		expect(consumerRenders).toBeGreaterThan(before.consumer);
		expect(document.querySelector("button")?.getAttribute("data-selection-mode")).toBe("false");
		expect(document.querySelector("button")?.getAttribute("data-selection-count")).toBe("0");
		await clickToggle();
		expect(document.querySelector("button")?.getAttribute("data-selection-count")).toBe("1");
	});

	test("existing range and copy handlers query the newest index, including off-screen blocks", async () => {
		await render();
		await publish(indexedResolver(["a", "c"], "old"));
		await clickToggle();
		const range = selection.selectionCtxValue.rangeSelectTo;
		await publish(indexedResolver(["a", "offscreen", "c"], "latest"));
		await act(async () => range("msg-c-0"));
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0", "msg-offscreen-0", "msg-c-0"]);
		const copy = selection.handleBatchCopy;
		await publish(indexedResolver(["a", "offscreen", "c"], "updated"));
		await act(async () => copy());
		expect(writeText).toHaveBeenCalledWith("updated a\n\nupdated offscreen\n\nupdated c");
		expect(selection.selectionMode).toBe(false);
	});

	test.each([
		"delete",
		"fork",
		"compact",
	] as const)("existing %s handler queries the current resolver at event time", async (action) => {
		await render();
		await publish(indexedResolver(["a"]));
		await clickToggle();
		const handler = {
			delete: selection.handleBatchDelete,
			fork: selection.handleBatchFork,
			compact: selection.handleSegmentCompact,
		}[action];
		await publish({
			resolveSelectedMeta: () => [
				{ blockId: "msg-a-0", messageId: "latest-message", blockIndex: 2 },
			],
			resolveSelectedMessageIds: () => ["latest-message"],
		});
		await act(async () => handler());
		if (action === "delete") {
			expect(deleteBlocks).toHaveBeenCalledWith("narrator-a", [
				{ messageId: "latest-message", blockIndex: 2 },
			]);
		} else if (action === "fork") {
			expect(forkMessages).toHaveBeenCalledWith("narrator-a", ["latest-message"]);
		} else {
			expect(compactMessages).toHaveBeenCalledWith("narrator-a", ["latest-message"]);
		}
	});

	test.each([
		["cleared resolver", null],
		["missing methods", {}],
		[
			"empty results",
			{ resolveRange: () => null, collectSelectedText: () => ({ text: "", truncated: false }) },
		],
		["async null", { resolveRange: async () => null }],
		["async rejection", { resolveRange: () => Promise.reject(new Error("unavailable")) }],
	] satisfies [
		string,
		MessageSelectionResolver | null,
	][])("%s preserves real DOM range and copy fallback", async (_name, resolver) => {
		await render();
		await publish(indexedResolver(["a", "stale", "c"]));
		await clickToggle();
		const range = selection.selectionCtxValue.rangeSelectTo;
		await publish(resolver);
		await act(async () => range("msg-c-0"));
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0", "msg-dom-middle-0", "msg-c-0"]);
		await act(async () => selection.handleBatchCopy());
		expect(writeText).toHaveBeenCalledWith("DOM A\n\nDOM middle\n\nDOM C");
	});

	test("new narrator owns child-effect registration; old cleanup and registration cannot overwrite it", async () => {
		await render("narrator-a", indexedResolver(["a", "old", "c"]));
		const oldPublish = selection.setChunkSelectionResolver;
		await clickToggle();
		await render("narrator-b", indexedResolver(["a", "new", "c"]));
		expect(selection.selectionMode).toBe(false);
		expect(selection.setChunkSelectionResolver).not.toBe(oldPublish);
		await act(async () => {
			oldPublish(null);
			oldPublish(indexedResolver(["a", "obsolete", "c"]));
			getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0");
		});
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0", "msg-new-0", "msg-c-0"]);
		await render("narrator-a", indexedResolver(["a", "returned", "c"]));
		await act(async () => {
			oldPublish(null);
			getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0");
		});
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0", "msg-returned-0", "msg-c-0"]);
	});

	test("a narrator without a new registration falls back to DOM rather than the previous owner", async () => {
		await render();
		// No Publisher cleanup: switching owners must retire this registration itself.
		await publish(indexedResolver(["a", "old", "c"]));
		await render("narrator-b");
		await act(async () => getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0"));
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0", "msg-dom-middle-0", "msg-c-0"]);
	});

	test("StrictMode effect replay retains the current child resolver", async () => {
		await render("narrator-a", indexedResolver(["a", "strict", "c"]), true);
		await act(async () => getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0"));
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0", "msg-strict-0", "msg-c-0"]);
	});
});

describe("pending selection ranges", () => {
	test.each([
		"range",
		"null",
		"rejection",
	] as const)("late %s from the previous narrator cannot change its successor selection", async (result) => {
		const pending = deferredRange();
		await render("narrator-a", { resolveRange: () => pending.promise });
		await act(async () => getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0"));
		await render("narrator-b", indexedResolver(["a", "c"]));
		await clickToggle();
		const context = selection.selectionCtxValue;
		const renders = consumerRenders;
		await act(async () => {
			if (result === "range") pending.resolve(new Set(["obsolete"]));
			else if (result === "null") pending.resolve(null);
			else pending.reject(new Error("obsolete"));
		});
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0"]);
		expect(selection.selectionCtxValue).toBe(context);
		expect(consumerRenders).toBe(renders);
	});

	test("index cleanup and republication do not cancel an in-flight same-owner range", async () => {
		const pending = deferredRange();
		await render("narrator-a", { resolveRange: () => pending.promise });
		await act(async () => getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0"));
		await publish(null);
		await publish(indexedResolver(["a", "refreshed", "c"]));
		await act(async () => pending.resolve(new Set(["msg-a-0", "loaded-offscreen", "msg-c-0"])));
		expect([...selection.selectedBlockIds]).toEqual(["msg-a-0", "loaded-offscreen", "msg-c-0"]);
	});

	test.each([
		"exit",
		"toggle",
		"new range",
	] as const)("a late range cannot overwrite a newer %s interaction", async (interaction) => {
		const pending = deferredRange();
		await render("narrator-a", { resolveRange: () => pending.promise });
		await act(async () => getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0"));
		if (interaction === "exit") await act(async () => selection.exitSelection());
		else if (interaction === "toggle") await clickToggle();
		else {
			await publish(indexedResolver(["a", "newest", "c"]));
			await act(async () => getGlobalOnSelectionRange()?.("msg-a-0", "msg-c-0"));
		}
		const context = selection.selectionCtxValue;
		await act(async () => pending.resolve(new Set(["obsolete"])));
		expect(selection.selectionCtxValue).toBe(context);
	});

	test("unmount retires registration and late event callbacks without touching their targets", async () => {
		const pending = deferredRange();
		const resolveRange = mock(() => pending.promise);
		await render("narrator-a", { resolveRange });
		await clickToggle();
		const previous = selection;
		const range = getGlobalOnSelectionRange();
		await act(async () => range?.("msg-a-0", "msg-c-0"));
		await act(async () => root?.unmount());
		root = null;
		const detach = options.chunkListRef.current?.detachFromBottom;
		const detachCalls = (detach as ReturnType<typeof mock>).mock.calls.length;
		await act(async () => {
			previous.setChunkSelectionResolver({ resolveRange });
			range?.("msg-a-0", "msg-c-0");
			await previous.handleBatchCopy();
			pending.resolve(new Set(["obsolete"]));
		});
		expect(resolveRange).toHaveBeenCalledTimes(1);
		expect(writeText).not.toHaveBeenCalled();
		expect(detach).toHaveBeenCalledTimes(detachCalls);
		expect(getGlobalOnSelectionRange()).toBeNull();
	});
});
