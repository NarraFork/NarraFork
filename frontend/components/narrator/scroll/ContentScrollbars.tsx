import {
	type KeyboardEvent,
	type MouseEvent,
	memo,
	type PointerEvent,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ContentViewportSnapshot } from "./AutoFollowScroll";

export type ContentScrollbarAxis = "x" | "y";
export interface ContentScrollbarsProps {
	getSnapshot: () => ContentViewportSnapshot;
	subscribe: (listener: (value: ContentViewportSnapshot) => void) => () => void;
	onScroll: (axis: ContentScrollbarAxis, value: number) => void;
	onStart: () => void;
	/** The host's actual viewport id, when supplied for the ARIA relationship. */
	controlsId?: string;
}

const HIT_SIZE = 8;
const MIN_THUMB_LENGTH = 18;
const ARROW_STEP = 40;

export interface ContentScrollbarGeometry {
	axis: ContentScrollbarAxis;
	viewport: number;
	maximum: number;
	value: number;
	trackLength: number;
	thumbLength: number;
	thumbTravel: number;
	thumbPosition: number;
	/** The cross-axis position is explicit, including inside a zero-height sticky layer. */
	crossOffset: number;
}

const finiteSize = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);
const clamp = (value: number, maximum: number) =>
	Math.max(0, Math.min(maximum, Number.isFinite(value) ? value : 0));

/** Pure arithmetic over the supplied model, including the shared corner. */
export function contentScrollbarGeometry(
	snapshot: ContentViewportSnapshot,
): Record<ContentScrollbarAxis, ContentScrollbarGeometry | null> {
	const width = finiteSize(snapshot.viewportWidth);
	const height = finiteSize(snapshot.viewportHeight);
	const scrollWidth = finiteSize(snapshot.scrollWidth);
	const scrollHeight = finiteSize(snapshot.scrollHeight);
	const horizontal = width > 0 && height > 0 && scrollWidth > width;
	const vertical = width > 0 && height > 0 && scrollHeight > height;
	const axis = (
		name: ContentScrollbarAxis,
		visible: boolean,
		viewport: number,
		extent: number,
		position: number,
		corner: boolean,
	): ContentScrollbarGeometry | null => {
		if (!visible) return null;
		const trackLength = Math.max(0, viewport - (corner ? HIT_SIZE : 0));
		if (trackLength === 0) return null;
		const maximum = extent - viewport;
		const value = clamp(position, maximum);
		// Even a tiny viewport retains some travel; a large document stays grabbable.
		const thumbLength = Math.min(
			trackLength,
			Math.max(Math.min(MIN_THUMB_LENGTH, trackLength / 2), (trackLength * viewport) / extent),
		);
		const thumbTravel = trackLength - thumbLength;
		return {
			axis: name,
			viewport,
			maximum,
			value,
			trackLength,
			thumbLength,
			thumbTravel,
			thumbPosition: (value / maximum) * thumbTravel,
			crossOffset: Math.max(0, (name === "x" ? height : width) - HIT_SIZE),
		};
	};
	return {
		x: axis("x", horizontal, width, scrollWidth, snapshot.scrollLeft, vertical),
		y: axis("y", vertical, height, scrollHeight, snapshot.scrollTop, horizontal),
	};
}

function sameGeometry(a: ContentViewportSnapshot, b: ContentViewportSnapshot): boolean {
	return (
		a.scrollTop === b.scrollTop &&
		a.scrollLeft === b.scrollLeft &&
		a.viewportWidth === b.viewportWidth &&
		a.viewportHeight === b.viewportHeight &&
		a.scrollWidth === b.scrollWidth &&
		a.scrollHeight === b.scrollHeight
	);
}

function modified(event: {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}): boolean {
	return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

interface Drag {
	pointerId: number;
	node: HTMLDivElement;
	coordinate: number;
	value: number;
	scale: number;
}

function release(drag: Drag | null) {
	if (!drag) return;
	try {
		drag.node.releasePointerCapture(drag.pointerId);
	} catch {
		/* Capture may already be lost on removal/cancel. */
	}
}

const AxisScrollbar = memo(function AxisScrollbar({
	geometry,
	getSnapshot,
	onStart,
	onScroll,
	controlsId,
}: Pick<ContentScrollbarsProps, "getSnapshot" | "onStart" | "onScroll" | "controlsId"> & {
	geometry: ContentScrollbarGeometry;
}) {
	const { t } = useTranslation("common");
	const drag = useRef<Drag | null>(null);
	const track = useRef<HTMLDivElement>(null);
	const axis = geometry.axis;
	const vertical = axis === "y";
	const coordinate = (event: PointerEvent) => (vertical ? event.pageY : event.pageX);
	const current = () => contentScrollbarGeometry(getSnapshot())[axis];
	const end = () => {
		const previous = drag.current;
		drag.current = null;
		release(previous);
	};

	useLayoutEffect(
		() => () => {
			release(drag.current);
			drag.current = null;
		},
		[],
	);

	const start = (event: PointerEvent<HTMLDivElement>, thumb: boolean) => {
		if (modified(event) || event.button !== 0 || event.isPrimary === false) return;
		const model = current();
		if (!model || model.thumbTravel <= 0) return;
		event.preventDefault();
		event.stopPropagation();
		onStart();
		track.current?.focus({ preventScroll: true });
		const position = vertical ? event.nativeEvent.offsetY : event.nativeEvent.offsetX;
		const value = thumb
			? model.value
			: clamp(
					((position - model.thumbLength / 2) / model.thumbTravel) * model.maximum,
					model.maximum,
				);
		end();
		drag.current = {
			pointerId: event.pointerId,
			node: event.currentTarget,
			coordinate: coordinate(event),
			value,
			scale: model.maximum / model.thumbTravel,
		};
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			/* Synthetic tests and cancelled pointers may lack capture. */
		}
		if (!thumb) onScroll(axis, value);
	};

	const move = (event: PointerEvent<HTMLDivElement>) => {
		if (modified(event)) {
			end();
			return;
		}
		event.stopPropagation();
		const active = drag.current;
		if (!active || active.pointerId !== event.pointerId) return;
		const model = current();
		if (!model) {
			end();
			return;
		}
		event.preventDefault();
		onScroll(
			axis,
			clamp(active.value + (coordinate(event) - active.coordinate) * active.scale, model.maximum),
		);
	};

	const finish = (event: PointerEvent<HTMLDivElement>) => {
		if (!modified(event)) event.stopPropagation();
		if (drag.current?.pointerId === event.pointerId) end();
	};
	const stopClick = (event: MouseEvent<HTMLDivElement>) => {
		if (!modified(event)) event.stopPropagation();
	};
	const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (modified(event)) return;
		const model = current();
		if (!model) return;
		let next: number;
		switch (event.key) {
			case "Home":
				next = 0;
				break;
			case "End":
				next = model.maximum;
				break;
			case "PageUp":
				next = model.value - model.viewport;
				break;
			case "PageDown":
				next = model.value + model.viewport;
				break;
			case "ArrowUp":
				if (!vertical) return;
				next = model.value - ARROW_STEP;
				break;
			case "ArrowDown":
				if (!vertical) return;
				next = model.value + ARROW_STEP;
				break;
			case "ArrowLeft":
				if (vertical) return;
				next = model.value - ARROW_STEP;
				break;
			case "ArrowRight":
				if (vertical) return;
				next = model.value + ARROW_STEP;
				break;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
		onStart();
		onScroll(axis, clamp(next, model.maximum));
	};

	return (
		<div
			ref={track}
			role="scrollbar"
			tabIndex={0}
			aria-label={
				vertical
					? t("scrollbar.vertical", { defaultValue: "Vertical scrollbar" })
					: t("scrollbar.horizontal", { defaultValue: "Horizontal scrollbar" })
			}
			aria-controls={controlsId}
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-valuemin={0}
			aria-valuemax={geometry.maximum}
			aria-valuenow={geometry.value}
			data-content-scrollbar={axis}
			style={{
				position: "absolute",
				zIndex: 6,
				...(vertical
					? { top: 0, left: geometry.crossOffset, width: HIT_SIZE, height: geometry.trackLength }
					: { top: geometry.crossOffset, left: 0, height: HIT_SIZE, width: geometry.trackLength }),
				borderRadius: 4,
				userSelect: "none",
				touchAction: "pinch-zoom",
				cursor: "pointer",
				outlineOffset: -1,
			}}
			onPointerDown={(event) => start(event, false)}
			onPointerMove={move}
			onPointerUp={finish}
			onPointerCancel={finish}
			onLostPointerCapture={finish}
			onClick={stopClick}
			onDoubleClick={stopClick}
			onKeyDown={keyDown}
		>
			<div
				data-content-scrollbar-thumb={axis}
				style={{
					position: "absolute",
					...(vertical
						? {
								top: geometry.thumbPosition,
								left: 0,
								width: HIT_SIZE,
								height: geometry.thumbLength,
							}
						: {
								left: geometry.thumbPosition,
								top: 0,
								height: HIT_SIZE,
								width: geometry.thumbLength,
							}),
					cursor: "grab",
					touchAction: "pinch-zoom",
				}}
				onPointerDown={(event) => start(event, true)}
				onPointerMove={move}
				onPointerUp={finish}
				onPointerCancel={finish}
				onLostPointerCapture={finish}
			>
				<div
					aria-hidden="true"
					style={{
						position: "absolute",
						...(vertical
							? { left: 2.5, top: 0, bottom: 0, width: 3 }
							: { top: 3, left: 0, right: 0, height: 2 }),
						borderRadius: 4,
						backgroundColor: "var(--mantine-color-dimmed)",
						opacity: 0.7,
						pointerEvents: "none",
					}}
				/>
			</div>
		</div>
	);
});

/** Only these small overlay nodes rerender on scroll; the host and painter do not. */
export const ContentScrollbars = memo(function ContentScrollbars(props: ContentScrollbarsProps) {
	const { getSnapshot, subscribe, onScroll, onStart, controlsId } = props;
	const [snapshot, setSnapshot] = useState(getSnapshot);
	useLayoutEffect(() => {
		const update = (value: ContentViewportSnapshot) =>
			setSnapshot((previous) => (sameGeometry(previous, value) ? previous : value));
		update(getSnapshot());
		return subscribe(update);
	}, [getSnapshot, subscribe]);
	const geometry = contentScrollbarGeometry(snapshot);
	return (
		<>
			{(["x", "y"] as const).map((axis) =>
				geometry[axis] ? (
					<AxisScrollbar
						key={axis}
						geometry={geometry[axis]}
						getSnapshot={getSnapshot}
						onScroll={onScroll}
						onStart={onStart}
						controlsId={controlsId}
					/>
				) : null,
			)}
		</>
	);
});
