import { createSmoothFollower, type SmoothFollower } from "@frontend/lib/smooth-scroll";
import { ActionIcon, Box, type BoxProps } from "@mantine/core";
import { IconArrowDown, IconFocus2 } from "@tabler/icons-react";
import {
	type CSSProperties,
	createContext,
	type KeyboardEventHandler,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ContentScrollbars } from "./ContentScrollbars";

const EPSILON = 4;
const ROW_MARGIN = 16;
export interface ContentRowTarget {
	top: number;
	bottom: number;
}

/** Pixel dimensions owned by the layout model, not inferred from CSS or DOM boxes. */
export interface ContentViewportLayout {
	width: number;
	height: number;
}
export interface ContentViewportSnapshot {
	scrollTop: number;
	scrollLeft: number;
	viewportWidth: number;
	viewportHeight: number;
	contentWidth: number;
	contentOrigin: number;
	scrollWidth: number;
	scrollHeight: number;
	source: "layout" | "dom";
}

/** One viewport owns its reader state. Diff data never owns pixel or projection state. */
export interface ContentViewport {
	viewportRef: RefObject<HTMLElement | null>;
	layout?: ContentViewportLayout;
	contentPadding?: { x: number; y: number };
	live: boolean;
	following: boolean;
	isFollowing: () => boolean;
	/** Selection and explicit source navigation are reader intent, not follow corrections. */
	pauseFollowing: () => void;
	setRowTarget: (target: ContentRowTarget | null) => void;
	notifyLayout: () => void;
	/** Instant coordinate correction, recorded so its scroll echo cannot detach. */
	scrollTo: (top: number) => void;
	getSnapshot: () => ContentViewportSnapshot;
	setContentSize: (size: ContentViewportLayout) => void;
	subscribeViewport: (listener: (snapshot: ContentViewportSnapshot) => void) => () => void;
}
const ContentViewportContext = createContext<ContentViewport | null>(null);
export function useContentViewport(): ContentViewport | null {
	return useContext(ContentViewportContext);
}

export interface AutoFollowScrollProps extends Omit<BoxProps, "children" | "style"> {
	bodyId: string;
	live?: boolean;
	/** Source revision, not a collection of render-time dependencies. */
	revision?: string | number;
	followTarget?: "end" | "row";
	/** Declared client box. The painter must publish its extent with setContentSize; no native geometry fallback. */
	layout?: ContentViewportLayout;
	/** One owner for the painter's inset; never recovered with getComputedStyle. */
	contentPadding?: { x: number; y: number };
	viewportStyle?: CSSProperties;
	contentStyle?: CSSProperties;
	style?: CSSProperties;
	onReaderProgress?: (viewport: HTMLElement, snapshot: ContentViewportSnapshot) => void;
	onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
	children: ReactNode;
}

/** Identity alone creates a new session. A status/format/path change never replaces the DOM. */
export function AutoFollowScroll(props: AutoFollowScrollProps) {
	return <ContentScrollSession key={props.bodyId} {...props} />;
}

function ContentScrollSession({
	bodyId,
	live = false,
	revision,
	followTarget = "end",
	layout,
	contentPadding,
	viewportStyle,
	contentStyle,
	onReaderProgress,
	children,
	style,
	...boxProps
}: AutoFollowScrollProps) {
	const { t } = useTranslation("narrator");
	const viewportRef = useRef<HTMLElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const viewportId = useId();
	const modeled = layout !== undefined;
	const config = useRef({ live, revision, followTarget, onReaderProgress, layout, contentPadding });
	config.current = { live, revision, followTarget, onReaderProgress, layout, contentPadding };
	const extent = useRef<ContentViewportLayout>({ width: 0, height: 0 });
	const [contentSize, setContentSizeState] = useState(extent.current);
	const setContentSize = useCallback((size: ContentViewportLayout) => {
		if (extent.current.width === size.width && extent.current.height === size.height) return;
		extent.current = size;
		// Only a declared layout controls the box; CSS-owned bodies keep native sizing.
		if (config.current.layout) setContentSizeState(size);
	}, []);
	const getSnapshot = useCallback((): ContentViewportSnapshot => {
		const node = viewportRef.current;
		const { layout, contentPadding } = config.current;
		const x = contentPadding?.x ?? 0;
		const y = contentPadding?.y ?? 0;
		const viewportWidth = Math.max(0, layout ? layout.width : (node?.clientWidth ?? 0));
		const viewportHeight = Math.max(0, layout ? layout.height : (node?.clientHeight ?? 0));
		return {
			scrollTop: node?.scrollTop ?? 0,
			scrollLeft: node?.scrollLeft ?? 0,
			viewportWidth,
			viewportHeight,
			contentWidth: Math.max(1, viewportWidth - 2 * x),
			contentOrigin: y,
			scrollWidth: layout
				? Math.max(viewportWidth, extent.current.width + 2 * x)
				: (node?.scrollWidth ?? 0),
			scrollHeight: layout
				? Math.max(viewportHeight, extent.current.height + 2 * y)
				: (node?.scrollHeight ?? 0),
			source: layout ? "layout" : "dom",
		};
	}, []);
	const layoutChanged = useRef<(() => void) | null>(null);
	const followingRef = useRef(live);
	const [following, setFollowingState] = useState(live);
	const [showResume, setShowResume] = useState(false);
	const everLive = useRef(live);
	const detached = useRef(false);
	const mounted = useRef(true);
	const primed = useRef(false);
	const pendingFinal = useRef(false);
	const pendingResume = useRef(false);
	const rowTarget = useRef<ContentRowTarget | null>(null);
	const expectedTop = useRef<number | null>(null);
	const lastTop = useRef(0);
	const reader = useRef({ scrolling: false, direction: 0 });
	const follower = useRef<SmoothFollower | null>(null);
	const subscribers = useRef(new Set<(snapshot: ContentViewportSnapshot) => void>());
	const viewportFrame = useRef<number | null>(null);

	const getTarget = useCallback((): number | null => {
		if (!viewportRef.current) return null;
		const { scrollHeight, viewportHeight, scrollTop } = getSnapshot();
		const max = Math.max(0, scrollHeight - viewportHeight);
		if (config.current.followTarget === "end") return max;
		const row = rowTarget.current;
		if (!row || !Number.isFinite(row.top) || !Number.isFinite(row.bottom)) return null;
		const margin = Math.min(ROW_MARGIN, viewportHeight / 4);
		let top = scrollTop;
		if (row.bottom > top + viewportHeight) top = row.bottom + margin - viewportHeight;
		else if (row.top < top && row.bottom - row.top <= viewportHeight) top = row.top - margin;
		else if (row.bottom <= top) top = row.bottom + margin - viewportHeight;
		return Math.max(0, Math.min(max, top));
	}, [getSnapshot]);

	const write = useCallback(
		(top: number) => {
			const node = viewportRef.current;
			if (!node || !mounted.current || !Number.isFinite(top)) return;
			const { scrollHeight, viewportHeight } = getSnapshot();
			const next = Math.max(0, Math.min(top, scrollHeight - viewportHeight));
			if (Math.abs(node.scrollTop - next) < 0.01) return;
			reader.current.scrolling = false;
			node.scrollTop = next;
			expectedTop.current = node.scrollTop;
			lastTop.current = node.scrollTop;
		},
		[getSnapshot],
	);

	const getFollower = useCallback(() => {
		follower.current ??= createSmoothFollower({
			readCurrent: () => viewportRef.current?.scrollTop ?? 0,
			readTarget: () => getTarget() ?? viewportRef.current?.scrollTop ?? 0,
			getViewportHeight: () => getSnapshot().viewportHeight,
			writeInstant: write,
			writeChase: write,
		});
		return follower.current;
	}, [getSnapshot, getTarget, write]);

	const setFollowing = useCallback((next: boolean) => {
		followingRef.current = next;
		setFollowingState(next);
	}, []);

	const syncResume = useCallback(() => {
		const node = viewportRef.current;
		const target = getTarget();
		setShowResume(
			!followingRef.current &&
				everLive.current &&
				!!node &&
				(target === null || Math.abs(target - node.scrollTop) > EPSILON),
		);
	}, [getTarget]);

	const notifyViewport = useCallback(() => {
		if (!mounted.current || viewportFrame.current !== null || subscribers.current.size === 0)
			return;
		viewportFrame.current = requestAnimationFrame(() => {
			viewportFrame.current = null;
			if (viewportRef.current && mounted.current) {
				const snapshot = getSnapshot();
				for (const listener of subscribers.current) listener(snapshot);
			}
		});
	}, [getSnapshot]);

	const attemptFollow = useCallback(() => {
		const node = viewportRef.current;
		if (!node || !mounted.current || getSnapshot().viewportHeight <= 0) return;
		const target = getTarget();
		if (
			followingRef.current &&
			(config.current.live || pendingFinal.current || pendingResume.current) &&
			target !== null
		) {
			if (!primed.current) {
				write(target);
				primed.current = true;
			} else getFollower().ensure();
			pendingFinal.current = false;
			pendingResume.current = false;
		}
		syncResume();
	}, [getFollower, getSnapshot, getTarget, syncResume, write]);

	const notifyLayout = useCallback(() => {
		attemptFollow();
		notifyViewport();
	}, [attemptFollow, notifyViewport]);
	const setRowTarget = useCallback((target: ContentRowTarget | null) => {
		rowTarget.current = target;
	}, []);
	const subscribeViewport = useCallback(
		(listener: (snapshot: ContentViewportSnapshot) => void) => {
			subscribers.current.add(listener);
			if (viewportRef.current && mounted.current) listener(getSnapshot());
			return () => {
				subscribers.current.delete(listener);
			};
		},
		[getSnapshot],
	);

	const pause = useCallback(() => {
		detached.current = true;
		pendingResume.current = false;
		pendingFinal.current = false;
		follower.current?.cancel();
		expectedTop.current = null;
		setFollowing(false);
		syncResume();
	}, [setFollowing, syncResume]);
	const scrollByReader = useCallback(
		(axis: "x" | "y", value: number) => {
			const node = viewportRef.current;
			if (!node || !Number.isFinite(value)) return;
			const snapshot = getSnapshot();
			const max =
				axis === "y"
					? snapshot.scrollHeight - snapshot.viewportHeight
					: snapshot.scrollWidth - snapshot.viewportWidth;
			const next = Math.max(0, Math.min(max, value));
			reader.current = {
				scrolling: true,
				// Horizontal reading must not resume vertical following merely because its row is visible.
				direction: axis === "y" ? Math.sign(next - node.scrollTop) : 0,
			};
			expectedTop.current = null;
			if (axis === "y") node.scrollTop = next;
			else node.scrollLeft = next;
			notifyViewport();
		},
		[getSnapshot, notifyViewport],
	);
	const resume = useCallback(() => {
		detached.current = false;
		reader.current.scrolling = false;
		setFollowing(true);
		pendingResume.current = true;
		notifyViewport(); // A Diff first chooses its OWN focus projection; null never means end.
		attemptFollow();
	}, [attemptFollow, notifyViewport, setFollowing]);

	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			follower.current?.cancel();
			if (viewportFrame.current !== null) cancelAnimationFrame(viewportFrame.current);
			viewportFrame.current = null;
		};
	}, []);

	const previous = useRef<{ live: boolean; revision: unknown } | null>(null);
	useLayoutEffect(() => {
		const prev = previous.current;
		previous.current = { live, revision };
		everLive.current ||= live;
		if (live && !prev?.live && !detached.current) setFollowing(true);
		if (prev?.live && !live) pendingFinal.current = followingRef.current;
		if (!prev || prev.revision !== revision || prev.live !== live) {
			reader.current.scrolling = false;
			attemptFollow();
		}
	}, [live, revision, setFollowing, attemptFollow]);

	// Native listeners run on the actual scrollport, BEFORE the outer list's wheel listener.
	useLayoutEffect(() => {
		const node = viewportRef.current;
		const body = contentRef.current;
		if (!node || !body) return;
		const readGeometry = () => {
			const target = getTarget();
			const snapshot = getSnapshot();
			return {
				height: snapshot.viewportHeight,
				width: snapshot.viewportWidth,
				scrollHeight: snapshot.scrollHeight,
				revision: config.current.revision,
				atTarget: target !== null && Math.abs(target - snapshot.scrollTop) <= EPSILON,
			};
		};
		let lastGeometry = readGeometry();
		let lastTouchY: number | null = null;
		const owns = (event: Event) =>
			!(event.target instanceof Element) ||
			event.target.closest("[data-content-scrollport]") === node;
		const intent = (direction: number) => {
			reader.current = { scrolling: true, direction };
			expectedTop.current = null;
			if (direction < 0 || config.current.followTarget === "row") pause();
		};
		const canScroll = (direction: number) => {
			const snapshot = getSnapshot();
			return direction < 0
				? snapshot.scrollTop > 0
				: snapshot.scrollTop + snapshot.viewportHeight < snapshot.scrollHeight - 1;
		};
		const onWheel = (event: WheelEvent) => {
			if (!owns(event) || event.ctrlKey || event.metaKey || event.altKey || event.deltaY === 0)
				return;
			intent(Math.sign(event.deltaY));
			if (canScroll(event.deltaY)) event.stopPropagation();
		};
		const onTouchStart = (event: TouchEvent) => {
			lastTouchY = event.touches.length === 1 ? event.touches[0].clientY : null;
		};
		const onTouchMove = (event: TouchEvent) => {
			if (!owns(event) || event.touches.length !== 1 || lastTouchY === null) return;
			const delta = lastTouchY - event.touches[0].clientY;
			lastTouchY = event.touches[0].clientY;
			if (delta === 0) return;
			intent(Math.sign(delta));
			if (canScroll(delta)) event.stopPropagation();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				!owns(event) ||
				event.altKey ||
				event.metaKey ||
				event.ctrlKey ||
				(event.target instanceof Element &&
					event.target.closest("input,textarea,[contenteditable=true]"))
			)
				return;
			const up =
				["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey);
			const down =
				["ArrowDown", "PageDown", "End"].includes(event.key) ||
				(event.key === " " && !event.shiftKey);
			if (up || down) intent(up ? -1 : 1);
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!owns(event) || event.target !== node || config.current.layout) return;
			const width = node.offsetWidth - node.clientWidth;
			if (width > 0 && event.clientX >= node.getBoundingClientRect().right - width) intent(-1);
		};
		const onScroll = (event: Event) => {
			if (event.target !== node) return;
			const top = node.scrollTop;
			const geometry = readGeometry();
			const layoutChanged =
				geometry.height !== lastGeometry.height ||
				geometry.width !== lastGeometry.width ||
				geometry.scrollHeight !== lastGeometry.scrollHeight ||
				geometry.revision !== lastGeometry.revision;
			const echo = expectedTop.current !== null && Math.abs(top - expectedTop.current) < 1;
			if (!echo) {
				// Cap/highlight reflow can clamp or anchor the native scroll position.
				// It is not reader input; explicit input already paused in intent().
				if (top < lastTop.current - 1 && (reader.current.scrolling || !layoutChanged)) pause();
				const target = getTarget();
				if (reader.current.scrolling) {
					if (
						config.current.live &&
						reader.current.direction > 0 &&
						target !== null &&
						Math.abs(top - target) <= EPSILON
					) {
						detached.current = false;
						setFollowing(true);
					}
					config.current.onReaderProgress?.(node, getSnapshot());
				}
			}
			expectedTop.current = null;
			lastTop.current = top;
			lastGeometry = geometry;
			syncResume();
			notifyViewport();
		};
		const onScrollEnd = () => {
			reader.current.scrolling = false;
		};
		node.addEventListener("wheel", onWheel, { passive: true });
		node.addEventListener("touchstart", onTouchStart, { passive: true });
		node.addEventListener("touchmove", onTouchMove, { passive: true });
		node.addEventListener("keydown", onKeyDown);
		node.addEventListener("pointerdown", onPointerDown);
		node.addEventListener("scroll", onScroll, { passive: true });
		node.addEventListener("scrollend", onScrollEnd);
		const onResize = () => {
			const geometry = readGeometry();
			const resized =
				geometry.height !== lastGeometry.height || geometry.width !== lastGeometry.width;
			const changed =
				resized ||
				geometry.scrollHeight !== lastGeometry.scrollHeight ||
				geometry.revision !== lastGeometry.revision;
			if (changed && !reader.current.scrolling) {
				// Record the actual layout-induced position, not a timed grace period.
				expectedTop.current = node.scrollTop;
				lastTop.current = node.scrollTop;
			}
			if (
				resized &&
				geometry.revision === lastGeometry.revision &&
				lastGeometry.atTarget &&
				!config.current.live &&
				everLive.current &&
				followingRef.current
			) {
				const target = getTarget();
				if (target !== null) write(target);
			}
			lastGeometry = readGeometry();
			notifyLayout();
		};
		layoutChanged.current = onResize;
		const observer =
			!modeled && typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
		observer?.observe(node);
		observer?.observe(body);
		notifyViewport();
		return () => {
			layoutChanged.current = null;
			observer?.disconnect();
			node.removeEventListener("wheel", onWheel);
			node.removeEventListener("touchstart", onTouchStart);
			node.removeEventListener("touchmove", onTouchMove);
			node.removeEventListener("keydown", onKeyDown);
			node.removeEventListener("pointerdown", onPointerDown);
			node.removeEventListener("scroll", onScroll);
			node.removeEventListener("scrollend", onScrollEnd);
		};
	}, [
		getSnapshot,
		getTarget,
		modeled,
		notifyLayout,
		notifyViewport,
		pause,
		setFollowing,
		syncResume,
		write,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: declared geometry replaces ResizeObserver notifications; the handler reads current refs.
	useLayoutEffect(() => {
		layoutChanged.current?.();
	}, [layout?.width, layout?.height, contentPadding?.x, contentPadding?.y]);

	const context = useMemo<ContentViewport>(
		() => ({
			viewportRef,
			layout,
			contentPadding,
			getSnapshot,
			setContentSize,
			live,
			following,
			isFollowing: () => followingRef.current,
			pauseFollowing: pause,
			setRowTarget,
			notifyLayout,
			scrollTo: write,
			subscribeViewport,
		}),
		[
			layout,
			contentPadding,
			getSnapshot,
			setContentSize,
			live,
			following,
			pause,
			setRowTarget,
			notifyLayout,
			write,
			subscribeViewport,
		],
	);
	const label =
		followTarget === "row"
			? t("followLatestChange", "Follow latest change")
			: t("resumeContentFollow", "Resume following");
	return (
		<Box
			pos="relative"
			data-content-layout-root={modeled ? "true" : undefined}
			style={{
				minWidth: 0,
				minHeight: 0,
				...style,
				...(layout ? { width: layout.width, height: layout.height } : {}),
			}}
			{...boxProps}
		>
			<ContentViewportContext value={context}>
				<section
					id={viewportId}
					ref={viewportRef}
					data-content-geometry={modeled ? "layout" : "dom"}
					data-diff-scroll-container={followTarget === "row" || undefined}
					data-content-scrollport={bodyId}
					data-following={following}
					aria-label={t("contentViewport", "Scrollable content")}
					// biome-ignore lint/a11y/noNoninteractiveTabindex: native scrollport must accept keyboard PageUp/Home; this is not an inert layout div.
					tabIndex={0}
					style={{
						overflowY: "auto",
						maxHeight: "inherit",
						...viewportStyle,
						...(contentPadding ? { padding: 0 } : {}),
						...(layout
							? {
									width: layout.width,
									height: layout.height,
									maxHeight: layout.height,
									border: 0,
									padding: 0,
									boxSizing: "border-box",
									scrollbarWidth: "none",
								}
							: {}),
						scrollBehavior: "auto",
					}}
				>
					{layout && (
						<div
							style={{
								position: "sticky",
								top: 0,
								left: 0,
								width: layout.width,
								height: 0,
								zIndex: 6,
								overflowAnchor: "none",
							}}
						>
							<ContentScrollbars
								controlsId={viewportId}
								getSnapshot={getSnapshot}
								subscribe={subscribeViewport}
								onStart={pause}
								onScroll={scrollByReader}
							/>
						</div>
					)}
					<div
						ref={contentRef}
						data-content-box="true"
						style={{
							minWidth: 0,
							...contentStyle,
							...(contentPadding
								? {
										padding: `${contentPadding.y}px ${contentPadding.x}px`,
										boxSizing: "border-box",
									}
								: {}),
							...(layout
								? {
										width: Math.max(layout.width, contentSize.width + 2 * (contentPadding?.x ?? 0)),
										height: contentSize.height + 2 * (contentPadding?.y ?? 0),
										padding: `${contentPadding?.y ?? 0}px ${contentPadding?.x ?? 0}px`,
										border: 0,
										margin: 0,
										boxSizing: "border-box",
									}
								: {}),
						}}
					>
						{children}
					</div>
				</section>
			</ContentViewportContext>
			{showResume && (
				<ActionIcon
					size="xs"
					variant="filled"
					color="indigo"
					aria-label={label}
					title={label}
					onClick={resume}
					style={{ position: "absolute", right: 8, bottom: 8, zIndex: 5 }}
				>
					{followTarget === "row" ? <IconFocus2 size={12} /> : <IconArrowDown size={12} />}
				</ActionIcon>
			)}
		</Box>
	);
}
