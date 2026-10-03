import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	createFocusChatDockView,
	type FocusChatChrome,
	FocusChatHost,
	FocusChatSlot,
} from "./FocusChatHost";
import { NarratorDockProvider, useNarratorDockContext } from "./NarratorDockContext";

let root: Root;
let host: HTMLDivElement;
let mounts: number;
let unmounts: number;
let fallbackMounts: number;
let desktopMounts: number;
let desktopUnmounts: number;
let active: HTMLElement | null;
let moves: number;
let selected: {
	anchorNode: Node | null;
	anchorOffset: number;
	focusNode: Node | null;
	focusOffset: number;
};
const originals = new Map<string, PropertyDescriptor | undefined>();
let restoreAppend: () => void;

function Chat({
	narratorId,
	compact,
	onHeaderPointerDown,
	onViewSubagentSession,
}: FocusChatChrome & { narratorId: string }) {
	const dock = useNarratorDockContext();
	const [draft, setDraft] = useState("");
	useEffect(() => {
		mounts++;
		return () => {
			unmounts++;
		};
	}, []);
	return (
		<div
			data-chat
			data-narrator={narratorId}
			data-dock={dock?.narratorId ?? "mobile"}
			data-compact={String(compact)}
		>
			<button type="button" onClick={() => setDraft("unsent draft")}>
				edit
			</button>
			<button type="button" data-header onPointerDown={onHeaderPointerDown}>
				header
			</button>
			<button
				type="button"
				data-subagent
				onClick={() => onViewSubagentSession?.("child", "message")}
			>
				child
			</button>
			<textarea value={draft} readOnly />
			<div data-pretext-exact-message-list>
				<span>Markdown text selection</span>
			</div>
		</div>
	);
}

function Fallback() {
	useEffect(() => {
		fallbackMounts++;
	}, []);
	return <div data-fallback />;
}

const drag = () => {};
function DesktopProbe({ compact }: { compact: boolean }) {
	useEffect(() => {
		desktopMounts++;
		return () => {
			desktopUnmounts++;
		};
	}, []);
	return (
		<div data-desktop-tools>
			<FocusChatSlot compact={compact} onHeaderPointerDown={drag}>
				<Fallback />
			</FocusChatSlot>
		</div>
	);
}

function Harness({
	narratorId = "first",
	mobile = true,
	slots = mobile ? [] : ["desktop"],
	compact = true,
	trackDesktopTools = false,
}: {
	narratorId?: string;
	mobile?: boolean;
	slots?: string[];
	compact?: boolean;
	trackDesktopTools?: boolean;
}) {
	return (
		<NarratorDockProvider key={narratorId} narratorId={narratorId}>
			<FocusChatHost
				narratorId={narratorId}
				isMobile={mobile}
				renderChat={(chrome) => <Chat narratorId={narratorId} {...chrome} />}
			>
				{trackDesktopTools && !mobile && <DesktopProbe compact={compact} />}
				{!trackDesktopTools &&
					slots.map((id) => (
						<div key={id} data-desktop={id}>
							<FocusChatSlot compact={compact} onHeaderPointerDown={drag}>
								<Fallback />
							</FocusChatSlot>
						</div>
					))}
			</FocusChatHost>
		</NarratorDockProvider>
	);
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
	mounts = 0;
	unmounts = 0;
	fallbackMounts = 0;
	desktopMounts = 0;
	desktopUnmounts = 0;
	moves = 0;
	active = null;
	selected = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 };
	Object.defineProperty(document, "activeElement", {
		configurable: true,
		get: () => active ?? document.body,
	});
	Object.defineProperty(document, "getSelection", {
		configurable: true,
		value: () => ({
			...selected,
			setBaseAndExtent(
				anchorNode: Node,
				anchorOffset: number,
				focusNode: Node,
				focusOffset: number,
			) {
				selected = { anchorNode, anchorOffset, focusNode, focusOffset };
			},
		}),
	});
	// Simulate browsers that clear focus, selection and scroll on appendChild.
	// This makes state restoration observable even though linkedom has no layout.
	const prototype = window.HTMLElement.prototype;
	const original = prototype.appendChild;
	prototype.appendChild = function <T extends Node>(node: T): T {
		const element = node as unknown as HTMLElement;
		if (element.hasAttribute?.("data-focus-chat-container") && element.parentElement) {
			moves++;
			if (active && element.contains(active)) active = null;
			selected = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 };
			for (const scrollport of element.querySelectorAll<HTMLElement>(
				"[data-pretext-exact-message-list], textarea",
			)) {
				scrollport.scrollTop = 0;
				scrollport.scrollLeft = 0;
			}
		}
		return original.call(this, node) as T;
	};
	restoreAppend = () => {
		prototype.appendChild = original;
	};
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	restoreAppend();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(props: Parameters<typeof Harness>[0] = {}) {
	await act(async () => root.render(<Harness {...props} />));
}

function input() {
	return host.querySelector("textarea") as HTMLTextAreaElement;
}

function viewport() {
	return host.querySelector("[data-pretext-exact-message-list]") as HTMLElement;
}

async function draftAndFocus() {
	await act(async () => {
		host.querySelector("button")?.click();
	});
	const textarea = input();
	textarea.focus = () => {
		active = textarea;
	};
	Object.assign(textarea, { selectionStart: 2, selectionEnd: 6, selectionDirection: "backward" });
	textarea.setSelectionRange = (start, end, direction) => {
		Object.assign(textarea, {
			selectionStart: start,
			selectionEnd: end,
			selectionDirection: direction,
		});
	};
	textarea.focus();
	viewport().scrollTop = 487;
	viewport().scrollLeft = 31;
	textarea.scrollTop = 15;
	const text = viewport().querySelector("span")?.firstChild ?? null;
	selected = { anchorNode: text, anchorOffset: 3, focusNode: text, focusOffset: 9 };
}

describe("focus chat stable portal owner", () => {
	test("mobile → desktop → mobile retains the chat DOM, draft, scroll, focus and selection", async () => {
		await render();
		await draftAndFocus();
		const chat = host.querySelector("[data-chat]");
		const textarea = input();
		const scrollport = viewport();
		const container = host.querySelector("[data-focus-chat-container]");
		const selection = { ...selected };
		for (const mobile of [false, true, false, true]) {
			await render({ mobile });
			expect(host.querySelector("[data-chat]")).toBe(chat);
			expect(host.querySelector("[data-focus-chat-container]")).toBe(container);
			expect(input()).toBe(textarea);
			expect(input().value).toBe("unsent draft");
			expect(viewport()).toBe(scrollport);
			expect(scrollport.scrollTop).toBe(487);
			expect(scrollport.scrollLeft).toBe(31);
			expect(textarea.scrollTop).toBe(15);
			expect(active).toBe(textarea);
			expect(textarea.selectionStart).toBe(2);
			expect(textarea.selectionEnd).toBe(6);
			expect(textarea.selectionDirection).toBe("backward");
			expect(selected).toEqual(selection);
			expect(chat?.getAttribute("data-dock")).toBe(mobile ? "mobile" : "first");
			expect(
				container?.parentElement?.hasAttribute(
					mobile ? "data-focus-chat-mobile-slot" : "data-focus-chat-slot",
				),
			).toBe(true);
		}
		expect(moves).toBeGreaterThan(0);
		expect(mounts).toBe(1);
		expect(unmounts).toBe(0);
		expect(fallbackMounts).toBe(0);
	});

	test("a real narrator identity change remounts chat and resets its draft and container", async () => {
		await render({ mobile: false });
		await draftAndFocus();
		const oldChat = host.querySelector("[data-chat]");
		const oldContainer = host.querySelector("[data-focus-chat-container]");
		await render({ narratorId: "second", mobile: false });
		expect(mounts).toBe(2);
		expect(unmounts).toBe(1);
		expect(host.querySelector("[data-chat]")).not.toBe(oldChat);
		expect(host.querySelector("[data-focus-chat-container]")).not.toBe(oldContainer);
		expect(input().value).toBe("");
		expect(host.querySelector("[data-chat]")?.getAttribute("data-dock")).toBe("second");
	});

	test("compact/header updates do not move the container or recreate chat", async () => {
		await render({ mobile: false });
		const initialMoves = moves;
		await render({ mobile: false, compact: false });
		expect(host.querySelector("[data-chat]")?.getAttribute("data-compact")).toBe("false");
		expect(moves).toBe(initialMoves);
		expect(mounts).toBe(1);
	});

	test("replacing a dock slot preserves chat; stale old-slot cleanup cannot evict the newer slot", async () => {
		await render({ mobile: false, slots: ["old"] });
		await draftAndFocus();
		await render({ mobile: false, slots: ["old", "new"] });
		const current = host.querySelector<HTMLElement>('[data-desktop="new"] [data-focus-chat-slot]');
		expect(host.querySelector("[data-focus-chat-container]")?.parentElement).toBe(current);
		await render({ mobile: false, slots: ["new"] });
		expect(host.querySelector("[data-focus-chat-container]")?.parentElement).toBe(current);
		expect(mounts).toBe(1);
		expect(unmounts).toBe(0);
		expect(input().value).toBe("unsent draft");
		expect(viewport().scrollTop).toBe(487);
		expect(active).toBe(input());
	});

	test("chat remains alive through a desktop slot gap and can attach to a new slot", async () => {
		await render({ mobile: false, slots: ["old"] });
		await draftAndFocus();
		const oldInput = input();
		await render({ mobile: false, slots: [] });
		expect(input()).toBe(oldInput);
		await render({ mobile: false, slots: ["replacement"] });
		expect(input()).toBe(oldInput);
		expect(document.activeElement).toBe(oldInput);
		expect(viewport().scrollTop).toBe(487);
		expect(mounts).toBe(1);
	});

	test("a delayed desktop slot retains the snapshot before hiding the mobile slot", async () => {
		await render();
		await draftAndFocus();
		const oldInput = input();
		const selection = { ...selected };
		await render({ mobile: false, slots: [] });
		// CSS display:none can blur a parked subtree before dockview is ready.
		active = null;
		selected = { anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0 };
		await render({ mobile: false, slots: ["late"] });
		expect(input()).toBe(oldInput);
		expect(document.activeElement).toBe(oldInput);
		expect(selected).toEqual(selection);
		expect(viewport().scrollTop).toBe(487);
		expect(mounts).toBe(1);
	});

	test("desktop tools unmount on mobile while chat, draft, scroll and focus remain alive", async () => {
		await render({ mobile: false, trackDesktopTools: true });
		await draftAndFocus();
		const chat = host.querySelector("[data-chat]");
		const textarea = input();
		const scrollport = viewport();
		const container = host.querySelector("[data-focus-chat-container]");
		for (const [index, mobile] of [true, false, true, false].entries()) {
			await render({ mobile, trackDesktopTools: true });
			expect(host.querySelector("[data-desktop-tools]") === null).toBe(mobile);
			expect(host.querySelector("[data-focus-chat-slot]") === null).toBe(mobile);
			expect(host.querySelector("[data-chat]")).toBe(chat);
			expect(host.querySelector("[data-focus-chat-container]")).toBe(container);
			expect(input()).toBe(textarea);
			expect(input().value).toBe("unsent draft");
			expect(viewport()).toBe(scrollport);
			expect(viewport().scrollTop).toBe(487);
			expect(active).toBe(textarea);
			expect(chat?.getAttribute("data-dock")).toBe(mobile ? "mobile" : "first");
			expect(desktopMounts).toBe(1 + Math.floor((index + 1) / 2));
			expect(desktopUnmounts).toBe(1 + Math.floor(index / 2));
		}
		expect(mounts).toBe(1);
		expect(unmounts).toBe(0);
		expect(fallbackMounts).toBe(0);
	});

	test("mobile-first does not mount desktop tools and later mobile visits release them", async () => {
		await render({ trackDesktopTools: true });
		await draftAndFocus();
		const textarea = input();
		expect(desktopMounts).toBe(0);
		expect(host.querySelector("[data-desktop-tools]")).toBeNull();
		await render({ trackDesktopTools: true });
		expect(desktopMounts).toBe(0);
		await render({ mobile: false, trackDesktopTools: true });
		expect(desktopMounts).toBe(1);
		await render({ mobile: true, trackDesktopTools: true });
		expect(desktopUnmounts).toBe(1);
		expect(host.querySelector("[data-desktop-tools]")).toBeNull();
		expect(input()).toBe(textarea);
		expect(input().value).toBe("unsent draft");
		expect(active).toBe(textarea);
		expect(mounts).toBe(1);
	});

	test("latest slot cleanup clears its registration; an older slot cannot reclaim chat", async () => {
		await render({ mobile: false, slots: ["old", "new"] });
		await draftAndFocus();
		const textarea = input();
		const container = host.querySelector("[data-focus-chat-container]");
		const parking = host.querySelector<HTMLElement>("[data-focus-chat-mobile-slot]");
		await render({ mobile: false, slots: ["old"] });
		expect(container?.parentElement).toBe(parking);
		expect(host.querySelector('[data-desktop="old"] [data-chat]')).toBeNull();
		await render({ mobile: true, slots: [] });
		expect(container?.parentElement).toBe(parking);
		expect(input()).toBe(textarea);
		expect(active).toBe(textarea);
		await render({ mobile: false, slots: ["replacement"] });
		expect(container?.parentElement).toBe(
			host.querySelector<HTMLElement>('[data-desktop="replacement"] [data-focus-chat-slot]'),
		);
		expect(input()).toBe(textarea);
		expect(input().value).toBe("unsent draft");
		expect(viewport().scrollTop).toBe(487);
		expect(active).toBe(textarea);
		expect(mounts).toBe(1);
	});

	test("without an external focus host the dock slot mounts its legacy fallback", async () => {
		await act(async () =>
			root.render(
				<FocusChatSlot compact>
					<Fallback />
				</FocusChatSlot>,
			),
		);
		expect(host.querySelector("[data-fallback]")).not.toBeNull();
		expect(fallbackMounts).toBe(1);
		expect(mounts).toBe(0);
	});
});

test("chat command context avoids outbound publication feedback but reads live data", async () => {
	const { memo } = await import("react");
	let raw: ReturnType<typeof useNarratorDockContext> | undefined;
	let chat: ReturnType<typeof useNarratorDockContext> | undefined;
	let chatRenders = 0;
	function CaptureRaw() {
		raw = useNarratorDockContext();
		return null;
	}
	const ChatProbe = memo(() => {
		chat = useNarratorDockContext();
		chatRenders++;
		return <div data-command-chat />;
	});
	await act(async () =>
		root.render(
			<NarratorDockProvider narratorId="first">
				<CaptureRaw />
				<FocusChatHost narratorId="first" isMobile={false} renderChat={() => <ChatProbe />}>
					<DesktopProbe compact />
				</FocusChatHost>
			</NarratorDockProvider>,
		),
	);
	if (!raw || !chat) throw new Error("Missing test dock context");
	const initialChat = chat;
	const initialRenders = chatRenders;
	await act(async () => raw?.setBrowserInfo({ sessionCount: 4, visualChange: null }));
	expect(chat).toBe(initialChat);
	expect(chatRenders).toBe(initialRenders);
	expect(chat.browserInfo.sessionCount).toBe(4);
	expect(raw.browserInfo.sessionCount).toBe(4);

	const read = createFocusChatDockView();
	const baseline = read(raw);
	const dataOnly = { ...raw, browserInfo: { sessionCount: 8, visualChange: null } };
	expect(read(dataOnly)).toBe(baseline);
	expect(baseline?.browserInfo.sessionCount).toBe(8);
	const commands = { ...dataOnly, onBack: () => {}, openToolTypes: new Set(["spec" as const]) };
	const next = read(commands);
	expect(next).not.toBe(baseline);
	expect(next?.onBack).toBe(commands.onBack);
	expect(next?.openToolTypes).toBe(commands.openToolTypes);
	expect(read(null)).toBeNull();
});
