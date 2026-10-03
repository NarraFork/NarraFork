import {
	createContext,
	type PointerEvent,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { NarratorDockContext, useNarratorDockContext } from "./NarratorDockContext";

export interface FocusChatChrome {
	compact: boolean;
	onHeaderPointerDown?: (event: PointerEvent) => void;
	onViewSubagentSession?: (narratorId: string, messageId?: string) => void;
}

interface ChatSlot extends FocusChatChrome {
	element: HTMLDivElement;
}

interface ChatSlotBridge {
	register: (slot: ChatSlot) => () => void;
	update: (slot: ChatSlot) => void;
}

const FocusChatSlotContext = createContext<ChatSlotBridge | null>(null);

// Outbound publications are read by sibling tool panels, not by the chat that
// published them. Keep commands/selection reactive without feeding those state
// publications back through the whole chat. Getters still expose the latest data.
const CHAT_OUTBOUND_FIELDS = new Set(["fileModProps", "detailsProps", "browserInfo"]);

export function createFocusChatDockView() {
	let source: ReturnType<typeof useNarratorDockContext> = null;
	let view: ReturnType<typeof useNarratorDockContext> = null;
	return (dock: ReturnType<typeof useNarratorDockContext>) => {
		const previous = source;
		source = dock;
		if (!dock) {
			view = null;
			return null;
		}
		const keys = Object.keys(dock) as (keyof typeof dock)[];
		if (
			view &&
			previous &&
			keys.length === Object.keys(previous).length &&
			keys.every((key) => CHAT_OUTBOUND_FIELDS.has(key) || Object.is(previous[key], dock[key]))
		)
			return view;
		const initial = dock;
		view = {
			...dock,
			get fileModProps() {
				return source?.fileModProps ?? null;
			},
			get detailsProps() {
				return source?.detailsProps ?? null;
			},
			get browserInfo() {
				return source?.browserInfo ?? initial.browserInfo;
			},
		};
		return view;
	};
}

// Read only scrollports, never the geometry of every Markdown node on a mode switch.
const SCROLLPORTS =
	"[data-pretext-exact-message-list], .mantine-ScrollArea-viewport, [data-content-scrollport], textarea";

function captureDomState(container: HTMLElement) {
	const document = container.ownerDocument;
	const active = document.activeElement as HTMLElement | null;
	const focused = active && container.contains(active) ? active : null;
	const input = focused as HTMLInputElement | HTMLTextAreaElement | null;
	const caret =
		input && typeof input.selectionStart === "number"
			? {
					start: input.selectionStart,
					end: input.selectionEnd ?? input.selectionStart,
					direction: input.selectionDirection ?? "none",
				}
			: null;
	const selection = document.getSelection?.();
	const selected =
		selection?.anchorNode &&
		selection.focusNode &&
		container.contains(selection.anchorNode) &&
		container.contains(selection.focusNode)
			? {
					anchor: selection.anchorNode,
					anchorOffset: selection.anchorOffset,
					focus: selection.focusNode,
					focusOffset: selection.focusOffset,
				}
			: null;
	const scroll = [...container.querySelectorAll<HTMLElement>(SCROLLPORTS)].map((element) => ({
		element,
		top: element.scrollTop,
		left: element.scrollLeft,
	}));
	return () => {
		if (focused?.isConnected && document.activeElement !== focused) {
			focused.focus({ preventScroll: true });
		}
		if (
			caret &&
			input?.isConnected &&
			(input.selectionStart !== caret.start ||
				input.selectionEnd !== caret.end ||
				input.selectionDirection !== caret.direction)
		) {
			input.setSelectionRange(caret.start, caret.end, caret.direction);
		}
		const currentSelection = document.getSelection?.();
		if (
			selected?.anchor.isConnected &&
			selected.focus.isConnected &&
			(currentSelection?.anchorNode !== selected.anchor ||
				currentSelection.anchorOffset !== selected.anchorOffset ||
				currentSelection.focusNode !== selected.focus ||
				currentSelection.focusOffset !== selected.focusOffset)
		) {
			currentSelection?.setBaseAndExtent(
				selected.anchor,
				selected.anchorOffset,
				selected.focus,
				selected.focusOffset,
			);
		}
		for (const { element, top, left } of scroll) {
			if (element.scrollTop !== top) element.scrollTop = top;
			if (element.scrollLeft !== left) element.scrollLeft = left;
		}
	};
}

function moveContainer(container: HTMLElement, target: HTMLElement) {
	// moveBefore preserves browser-managed focus/selection when supported. The
	// snapshot also covers appendChild on older browsers and a disappearing dock.
	const parent = target as HTMLElement & {
		moveBefore?: (node: Node, child: Node | null) => void;
	};
	if (parent.moveBefore && container.isConnected && target.isConnected) {
		parent.moveBefore(container, null);
	} else {
		target.appendChild(container);
	}
}

/** The dock adapter is just a slot on focus pages; other surfaces retain their own chat. */
export function FocusChatSlot({
	compact,
	onHeaderPointerDown,
	children,
}: FocusChatChrome & { children: ReactNode }) {
	const bridge = useContext(FocusChatSlotContext);
	const ref = useRef<HTMLDivElement>(null);
	const chrome = useRef({ compact, onHeaderPointerDown });
	chrome.current = { compact, onHeaderPointerDown };
	useLayoutEffect(() => {
		if (bridge && ref.current) return bridge.register({ element: ref.current, ...chrome.current });
	}, [bridge]);
	useLayoutEffect(() => {
		if (bridge && ref.current)
			bridge.update({ element: ref.current, compact, onHeaderPointerDown });
	}, [bridge, compact, onHeaderPointerDown]);
	return (
		<div ref={ref} data-focus-chat-slot style={{ height: "100%", overflow: "hidden" }}>
			{bridge ? null : children}
		</div>
	);
}

export function FocusChatHost({
	narratorId,
	...props
}: {
	narratorId: string;
	isMobile: boolean;
	children: ReactNode;
	renderChat: (chrome: FocusChatChrome) => ReactNode;
}) {
	// The narrator is the only identity boundary, not the viewport or dock group.
	return <StableFocusChatHost key={narratorId} {...props} />;
}

function StableFocusChatHost({
	isMobile,
	children,
	renderChat,
}: {
	isMobile: boolean;
	children: ReactNode;
	renderChat: (chrome: FocusChatChrome) => ReactNode;
}) {
	const dock = useNarratorDockContext();
	const [readChatDock] = useState(createFocusChatDockView);
	const chatDock = readChatDock(dock);
	const [container] = useState(() => {
		const element = document.createElement("div");
		element.dataset.focusChatContainer = "";
		element.style.cssText = "height:100%;width:100%;overflow:hidden";
		return element;
	});
	const mobileRef = useRef<HTMLDivElement>(null);
	const initialMobile = useRef(isMobile);
	const currentSlot = useRef<ChatSlot | null>(null);
	const pendingRestore = useRef<(() => void) | null>(null);
	const [slot, setSlot] = useState<ChatSlot | null>(null);
	const bridge = useMemo<ChatSlotBridge>(
		() => ({
			register(next) {
				currentSlot.current = next;
				setSlot(next);
				return () => {
					// A replaced slot's late cleanup must not evict its successor.
					if (currentSlot.current !== next) return;
					currentSlot.current = null;
					setSlot(null);
					if (container.parentElement === next.element && mobileRef.current) {
						pendingRestore.current ??= captureDomState(container);
						moveContainer(container, mobileRef.current);
					}
				};
			},
			update(next) {
				if (currentSlot.current?.element !== next.element) return;
				setSlot((previous) =>
					previous?.compact === next.compact &&
					previous.onHeaderPointerDown === next.onHeaderPointerDown
						? previous
						: next,
				);
			},
		}),
		[container],
	);
	const target = !isMobile && slot ? slot.element : null;
	useLayoutEffect(() => {
		const parent = target ?? mobileRef.current;
		if (!parent) return;
		const willHideMobileSlot = !isMobile && !target && mobileRef.current?.style.display !== "none";
		if (container.parentElement !== parent || willHideMobileSlot) {
			pendingRestore.current ??= captureDomState(container);
		}
		if (container.parentElement !== parent) moveContainer(container, parent);
		// Hide the mobile slot only AFTER capturing/moving its focused subtree.
		// A React-controlled display:none during mutation would blur it too early.
		if (mobileRef.current) mobileRef.current.style.display = isMobile ? "block" : "none";
		// Keep the snapshot across the hidden parking interval while dockview mounts.
		if (isMobile || target) {
			pendingRestore.current?.();
			pendingRestore.current = null;
		}
	}, [container, isMobile, target]);

	return (
		<FocusChatSlotContext.Provider value={bridge}>
			{children}
			<div
				ref={mobileRef}
				data-focus-chat-mobile-slot
				style={{
					display: initialMobile.current ? "block" : "none",
					flex: 1,
					minHeight: 0,
					overflow: "hidden",
				}}
			/>
			{createPortal(
				<NarratorDockContext.Provider value={isMobile ? null : chatDock}>
					{renderChat(
						isMobile
							? { compact: false }
							: { ...(slot ?? { compact: true }), onViewSubagentSession: dock?.openSubagentPanel },
					)}
				</NarratorDockContext.Provider>,
				container,
			)}
		</FocusChatSlotContext.Provider>
	);
}
