import { ActionIcon, Box, type BoxProps, Tooltip } from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import {
	Children,
	cloneElement,
	isValidElement,
	type PointerEventHandler,
	type ReactElement,
	type ReactNode,
	type TouchEventHandler,
	type UIEventHandler,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type WheelEventHandler,
} from "react";
import { useTranslation } from "react-i18next";

const BOTTOM_EPSILON_PX = 4;
const PROGRAMMATIC_SCROLL_GRACE_MS = 100;

function getDistanceFromBottom(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isAtBottom(el: HTMLElement): boolean {
	return getDistanceFromBottom(el) <= BOTTOM_EPSILON_PX;
}

function scrollToBottom(el: HTMLElement) {
	el.scrollTop = el.scrollHeight;
}

export interface AutoFollowScrollHandle {
	registerUserIntent: () => void;
	noteProgrammaticScroll: () => void;
	isProgrammaticScroll: () => boolean;
	isAutoFollowEnabled: () => boolean;
	resumeAutoFollow: () => void;
}

export interface AutoFollowScrollProps extends Omit<BoxProps, "children"> {
	children: ReactNode | ((handle: AutoFollowScrollHandle) => ReactNode);
	/** Changing this key resets auto-follow for a new streaming session. */
	followKey?: string | number | null;
	/** Values that should trigger a follow attempt after render. */
	deps?: readonly unknown[];
	/** Allow disabling without changing call sites. Defaults to true. */
	enabled?: boolean;
	/** When true, injects `ref` into a single valid child instead of making Box scrollable. */
	asChild?: boolean;
	onScroll?: UIEventHandler<HTMLElement>;
	onWheel?: WheelEventHandler<HTMLElement>;
	onTouchMove?: TouchEventHandler<HTMLElement>;
	onPointerDown?: PointerEventHandler<HTMLElement>;
}

export function AutoFollowScroll({
	children,
	followKey,
	deps = [],
	enabled = true,
	asChild,
	onScroll,
	onWheel,
	onTouchMove,
	onPointerDown,
	style,
	...boxProps
}: AutoFollowScrollProps) {
	const { t } = useTranslation("narrator");
	const scrollRef = useRef<HTMLElement | null>(null);
	const autoFollowRef = useRef(true);
	const lastFollowKeyRef = useRef(followKey);
	const programmaticScrollUntilRef = useRef(0);
	const userIntentRef = useRef(false);
	const [showResume, setShowResume] = useState(false);

	const noteProgrammaticScroll = useCallback(() => {
		programmaticScrollUntilRef.current = performance.now() + PROGRAMMATIC_SCROLL_GRACE_MS;
	}, []);

	const isProgrammaticScroll = useCallback(
		() => performance.now() <= programmaticScrollUntilRef.current,
		[],
	);

	const syncResumeButton = useCallback(() => {
		const el = scrollRef.current;
		if (!enabled || !el) {
			setShowResume(false);
			return;
		}
		setShowResume(!autoFollowRef.current && !isAtBottom(el));
	}, [enabled]);

	const followNow = useCallback(() => {
		const el = scrollRef.current;
		if (!enabled || !el) return;
		noteProgrammaticScroll();
		scrollToBottom(el);
		setShowResume(false);
	}, [enabled, noteProgrammaticScroll]);

	const registerUserIntent = useCallback(() => {
		if (!enabled) return;
		userIntentRef.current = true;
	}, [enabled]);

	const resumeAutoFollow = useCallback(() => {
		autoFollowRef.current = true;
		userIntentRef.current = false;
		followNow();
		requestAnimationFrame(followNow);
	}, [followNow]);

	const handleScroll = useCallback(
		(event: React.UIEvent<HTMLElement>) => {
			onScroll?.(event as never);
			if (!enabled) return;
			if (isProgrammaticScroll()) return;
			const el = event.currentTarget;
			if (isAtBottom(el)) {
				autoFollowRef.current = true;
				userIntentRef.current = false;
				setShowResume(false);
				return;
			}
			if (userIntentRef.current) {
				autoFollowRef.current = false;
				setShowResume(true);
			}
		},
		[enabled, isProgrammaticScroll, onScroll],
	);

	const handleWheel = useCallback(
		(event: React.WheelEvent<HTMLElement>) => {
			onWheel?.(event as never);
			registerUserIntent();
		},
		[onWheel, registerUserIntent],
	);

	const handleTouchMove = useCallback(
		(event: React.TouchEvent<HTMLElement>) => {
			onTouchMove?.(event as never);
			registerUserIntent();
		},
		[onTouchMove, registerUserIntent],
	);

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			onPointerDown?.(event as never);
			const el = event.currentTarget;
			const verticalScrollbarWidth = el.offsetWidth - el.clientWidth;
			const horizontalScrollbarHeight = el.offsetHeight - el.clientHeight;
			if (verticalScrollbarWidth <= 0 && horizontalScrollbarHeight <= 0) return;
			const rect = el.getBoundingClientRect();
			const onVerticalScrollbar =
				verticalScrollbarWidth > 0 && event.clientX >= rect.right - verticalScrollbarWidth;
			const onHorizontalScrollbar =
				horizontalScrollbarHeight > 0 && event.clientY >= rect.bottom - horizontalScrollbarHeight;
			if (onVerticalScrollbar || onHorizontalScrollbar) registerUserIntent();
		},
		[onPointerDown, registerUserIntent],
	);

	const setScrollNode = useCallback((node: HTMLElement | null) => {
		scrollRef.current = node;
	}, []);

	useLayoutEffect(() => {
		if (lastFollowKeyRef.current !== followKey) {
			lastFollowKeyRef.current = followKey;
			autoFollowRef.current = true;
			userIntentRef.current = false;
			programmaticScrollUntilRef.current = 0;
			setShowResume(false);
		}
		if (!enabled || !autoFollowRef.current) return;
		followNow();
		const rafId = requestAnimationFrame(followNow);
		return () => cancelAnimationFrame(rafId);
	}, [enabled, followKey, followNow, ...deps]);

	useEffect(() => {
		if (!enabled) return;
		syncResumeButton();
	}, [enabled, syncResumeButton]);

	const handle: AutoFollowScrollHandle = {
		registerUserIntent,
		noteProgrammaticScroll,
		isProgrammaticScroll,
		isAutoFollowEnabled: () => autoFollowRef.current,
		resumeAutoFollow,
	};
	const content = typeof children === "function" ? children(handle) : children;

	const scrollHandlers = {
		onScroll: handleScroll,
		onWheel: handleWheel,
		onTouchMove: handleTouchMove,
		onPointerDown: handlePointerDown,
	};

	const scrollChild = asChild
		? (() => {
				const onlyChild = Children.only(content);
				if (!isValidElement(onlyChild)) return onlyChild;
				const child = onlyChild as ReactElement<{
					ref?: React.Ref<HTMLElement>;
					onScroll?: React.UIEventHandler<HTMLElement>;
					onWheel?: React.WheelEventHandler<HTMLElement>;
					onTouchMove?: React.TouchEventHandler<HTMLElement>;
					onPointerDown?: React.PointerEventHandler<HTMLElement>;
				}>;
				return cloneElement(child, {
					ref: setScrollNode,
					onScroll: (event) => {
						child.props.onScroll?.(event);
						handleScroll(event);
					},
					onWheel: (event) => {
						child.props.onWheel?.(event);
						handleWheel(event);
					},
					onTouchMove: (event) => {
						child.props.onTouchMove?.(event);
						handleTouchMove(event);
					},
					onPointerDown: (event) => {
						child.props.onPointerDown?.(event);
						handlePointerDown(event);
					},
				});
			})()
		: content;

	return (
		<Box pos="relative" style={{ minWidth: 0, ...style }} {...boxProps}>
			{asChild ? (
				scrollChild
			) : (
				<Box
					ref={setScrollNode}
					style={{ overflow: "auto", maxHeight: "inherit" }}
					{...scrollHandlers}
				>
					{scrollChild}
				</Box>
			)}
			{enabled && showResume && (
				<Tooltip label={t("scrollToBottom")} withArrow position="top">
					<ActionIcon
						size="xs"
						variant="filled"
						color="indigo"
						aria-label={t("scrollToBottom")}
						onClick={resumeAutoFollow}
						style={{
							position: "absolute",
							right: 8,
							bottom: 8,
							zIndex: 5,
							boxShadow: "var(--mantine-shadow-sm)",
						}}
					>
						<IconArrowDown size={12} />
					</ActionIcon>
				</Tooltip>
			)}
		</Box>
	);
}
