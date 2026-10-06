import {
	type PointerEvent,
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { usePanelHeaderControls } from "../panels/panel-header-controls";
import {
	HEADER_LEADING_GAP_PX,
	HEADER_ROW_PADDING_PX,
	type HeaderAfterTitleInput,
	type HeaderAfterTitleLayout,
	resolveHeaderLayoutAfterTitle,
} from "./header-title-width";

/** Only fields the header actually paints; unused per-pixel slack is not state. */
export type NarratorHeaderLayoutSnapshot = Pick<
	HeaderAfterTitleLayout,
	"titleWidth" | "visibleToolCount" | "unmeasured"
>;

type Props = Omit<HeaderAfterTitleInput, "rowWidth" | "showPin"> & {
	children: (layout: NarratorHeaderLayoutSnapshot) => ReactNode;
	onHeaderPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
};

function snapshot(input: HeaderAfterTitleInput): NarratorHeaderLayoutSnapshot {
	const { titleWidth, visibleToolCount, unmeasured } = resolveHeaderLayoutAfterTitle(input);
	return { titleWidth, visibleToolCount, unmeasured };
}

function sameLayout(a: NarratorHeaderLayoutSnapshot, b: NarratorHeaderLayoutSnapshot): boolean {
	return (
		a.titleWidth === b.titleWidth &&
		a.visibleToolCount === b.visibleToolCount &&
		a.unmeasured === b.unmeasured
	);
}

/**
 * Keep header resize state out of NarratorPanel. Updating a pixel width there
 * re-rendered the composer, status controls and closed overlays on every drag
 * frame, even though the message list already deferred its width rebuild.
 *
 * Here capacity/title changes render only this header, and widths that paint the
 * same result do not schedule React at all. The title-first policy is unchanged.
 */
export function NarratorHeaderLayout({
	titleFullWidth,
	surfacedToolCount,
	showBack = false,
	showTitleActions = false,
	showClose = false,
	onHeaderPointerDown,
	children,
}: Props) {
	const controls = usePanelHeaderControls();
	const showPin = showClose && !!controls?.pinAction;
	// Dock adapters already consume host gestures in usePanelHeaderDrag. Only
	// fall back to the host callback when no adapter supplied a drag handler.
	const handleHeaderPointerDown = onHeaderPointerDown ?? controls?.onPointerDown;
	const rowRef = useRef<HTMLDivElement>(null);
	const lastWidth = useRef(0);
	const [layout, setLayout] = useState(() =>
		snapshot({
			rowWidth: 0,
			titleFullWidth,
			surfacedToolCount,
			showBack,
			showTitleActions,
			showClose,
			showPin,
		}),
	);
	const published = useRef(layout);
	const measure = useCallback(() => {
		const width = rowRef.current?.getBoundingClientRect().width ?? 0;
		// A hidden row must not discard its last usable width. On first mount 0
		// retains the original optimistic/unmeasured layout, not a false shortfall.
		if (width > 0) lastWidth.current = width;
		const next = snapshot({
			rowWidth: lastWidth.current,
			titleFullWidth,
			surfacedToolCount,
			showBack,
			showTitleActions,
			showClose,
			showPin,
		});
		if (sameLayout(published.current, next)) return;
		published.current = next;
		setLayout(next);
	}, [titleFullWidth, surfacedToolCount, showBack, showTitleActions, showClose, showPin]);

	useLayoutEffect(() => {
		const row = rowRef.current;
		if (!row) return;
		measure();
		// Unlike a ref inside a panel's skeleton early-return, this row is always
		// mounted when this component's effect runs. No readiness state is needed.
		let active = true;
		const read = () => {
			if (active) measure();
		};
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", read);
			return () => {
				active = false;
				window.removeEventListener("resize", read);
			};
		}
		const observer = new ResizeObserver(read);
		observer.observe(row);
		return () => {
			active = false;
			observer.disconnect();
		};
	}, [measure]);

	return (
		<div
			ref={rowRef}
			data-narrator-header-layout
			className={handleHeaderPointerDown ? "nf-panel-header" : undefined}
			style={{
				display: "flex",
				alignItems: "center",
				flexWrap: "nowrap",
				gap: HEADER_LEADING_GAP_PX,
				padding: `8px ${HEADER_ROW_PADDING_PX / 2}px`,
				borderBottom: "1px solid var(--mantine-color-default-border)",
				flexShrink: 0,
				overflow: "hidden",
				cursor: handleHeaderPointerDown ? "grab" : undefined,
			}}
			onPointerDown={
				handleHeaderPointerDown
					? (event) => {
							const target = event.target as HTMLElement;
							if (target.closest("button, a, input, select, textarea, [role='button']")) return;
							handleHeaderPointerDown(event);
						}
					: undefined
			}
		>
			{children(layout)}
		</div>
	);
}
