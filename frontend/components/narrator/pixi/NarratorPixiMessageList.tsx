import { Application, Container, Graphics } from "pixi.js";
import {
	forwardRef,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { getRenderableMessageOrder } from "../message-order-utils";
import type { MessagesQueryData, NarratorMsg } from "../narrator-panel-types";
import { drawPixiMessages } from "./pixi-message-draw";
import { layoutPixiMessageItems } from "./pixi-message-layout";
import { buildPixiMessageItems } from "./pixi-message-model";
import { resolvePixiMessageTheme } from "./pixi-message-theme";

export interface NarratorPixiMessageListHandle {
	scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" }) => void;
	getTotalSize: () => number;
	findIndexByKey: (key: string) => number;
	readonly scrollOffset: number;
	readonly viewportSize: number;
}

interface NarratorPixiMessageListProps {
	messagesData?: MessagesQueryData;
	narratorId: string;
	streamingMsg?: NarratorMsg | null;
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	showManualLoadOlder?: boolean;
	showConclusionButton?: boolean;
	showTokenUsage?: boolean;
	highlightedId?: string | null;
	scrollRef: RefObject<HTMLElement | null> | ((node: HTMLDivElement | null) => void);
	contentRef: RefObject<HTMLDivElement | null>;
	shift?: boolean;
}

function destroyPixiApplication(app: Application): void {
	const pixiApp = app as unknown as { _cancelResize?: () => void; destroy: Application["destroy"] };
	if (typeof pixiApp._cancelResize !== "function") pixiApp._cancelResize = () => {};
	app.destroy(true, { children: true });
}

export const NarratorPixiMessageList = forwardRef<
	NarratorPixiMessageListHandle,
	NarratorPixiMessageListProps
>(function NarratorPixiMessageList(
	{
		messagesData,
		narratorId,
		streamingMsg,
		pruneBoundaryMessageId,
		pruneDividerLabel,
		showManualLoadOlder,
		showConclusionButton,
		showTokenUsage,
		highlightedId,
		scrollRef,
		contentRef,
	},
	ref,
) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const canvasHostRef = useRef<HTMLDivElement | null>(null);
	const spacerRef = useRef<HTMLDivElement | null>(null);
	const appRef = useRef<Application | null>(null);
	const stageContainerRef = useRef<Container | null>(null);
	const gfxRef = useRef<Graphics | null>(null);
	const [ready, setReady] = useState(false);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [scrollTop, setScrollTop] = useState(0);

	const orderedMessages = useMemo(() => {
		if (!messagesData?.pages?.length) return [];
		return getRenderableMessageOrder(messagesData.pages).messages;
	}, [messagesData]);

	const items = useMemo(
		() =>
			buildPixiMessageItems({
				pages: messagesData?.pages ?? [],
				pageParams: messagesData?.pageParams,
				orderedMessages,
				narratorId,
				streamingMsg,
				pruneBoundaryMessageId,
				pruneDividerLabel,
				showManualLoadOlder,
				showConclusionButton,
				showTokenUsage,
			}),
		[
			messagesData?.pages,
			messagesData?.pageParams,
			orderedMessages,
			narratorId,
			streamingMsg,
			pruneBoundaryMessageId,
			pruneDividerLabel,
			showManualLoadOlder,
			showConclusionButton,
			showTokenUsage,
		],
	);

	const layout = useMemo(
		() => layoutPixiMessageItems(items, Math.max(1, size.width)),
		[items, size.width],
	);

	const setViewportNode = useCallback(
		(node: HTMLDivElement | null) => {
			viewportRef.current = node;
			if (typeof scrollRef === "function") {
				scrollRef(node);
			} else if (scrollRef) {
				(scrollRef as React.MutableRefObject<HTMLElement | null>).current = node;
			}
		},
		[scrollRef],
	);

	useEffect(() => {
		if (contentRef && spacerRef.current) {
			(contentRef as React.MutableRefObject<HTMLDivElement | null>).current = spacerRef.current;
		}
	}, [contentRef]);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const updateSize = () => {
			setSize({ width: viewport.clientWidth, height: viewport.clientHeight });
		};
		updateSize();
		const ro = new ResizeObserver(updateSize);
		ro.observe(viewport);
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const onScroll = () => setScrollTop(viewport.scrollTop);
		onScroll();
		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => viewport.removeEventListener("scroll", onScroll);
	}, []);

	useEffect(() => {
		const host = canvasHostRef.current;
		if (!host) return;
		const app = new Application();
		let destroyed = false;
		app
			.init({
				width: 1,
				height: 1,
				backgroundAlpha: 0,
				antialias: true,
				autoDensity: true,
				resolution: window.devicePixelRatio || 1,
				autoStart: false,
				resizeTo: undefined,
				preference: "webgl",
			})
			.then(() => {
				if (destroyed) {
					destroyPixiApplication(app);
					return;
				}
				appRef.current = app;
				const canvas = app.canvas as HTMLCanvasElement;
				canvas.style.position = "absolute";
				canvas.style.inset = "0";
				canvas.style.width = "100%";
				canvas.style.height = "100%";
				canvas.style.pointerEvents = "none";
				host.appendChild(canvas);
				const container = new Container();
				const gfx = new Graphics();
				app.stage.addChild(gfx);
				app.stage.addChild(container);
				stageContainerRef.current = container;
				gfxRef.current = gfx;
				setReady(true);
			});
		return () => {
			destroyed = true;
			if (appRef.current) destroyPixiApplication(appRef.current);
			appRef.current = null;
			stageContainerRef.current = null;
			gfxRef.current = null;
		};
		// init once; resize is handled below
	}, []);

	useEffect(() => {
		const app = appRef.current;
		if (!app?.renderer) return;
		app.renderer.resize(Math.max(1, size.width), Math.max(1, size.height));
	}, [size]);

	useEffect(() => {
		if (!ready || !appRef.current || !stageContainerRef.current || !gfxRef.current) return;
		drawPixiMessages({
			container: stageContainerRef.current,
			gfx: gfxRef.current,
			items: layout.items,
			theme: resolvePixiMessageTheme(),
			scrollTop,
			viewportHeight: size.height,
			highlightedId,
		});
		appRef.current.render();
	}, [ready, layout, scrollTop, size.height, highlightedId]);

	useImperativeHandle(
		ref,
		() => ({
			scrollToIndex: (index, options) => {
				const viewport = viewportRef.current;
				const target = layout.items[index];
				if (!viewport || !target) return;
				const align = options?.align ?? "start";
				let top = target.y;
				if (align === "center") top = target.y - viewport.clientHeight / 2 + target.height / 2;
				else if (align === "end") top = target.y - viewport.clientHeight + target.height;
				viewport.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
			},
			getTotalSize: () => layout.totalHeight,
			findIndexByKey: (key: string) => items.findIndex((item) => item.key === key),
			get scrollOffset() {
				return viewportRef.current?.scrollTop ?? 0;
			},
			get viewportSize() {
				return viewportRef.current?.clientHeight ?? 0;
			},
		}),
		[layout, items],
	);

	return (
		<div
			ref={setViewportNode}
			className="narrator-pixi-message-list"
			style={{
				height: "100%",
				overflow: "auto",
				overscrollBehavior: "contain",
				position: "relative",
			}}
		>
			<div
				ref={canvasHostRef}
				style={{
					position: "sticky",
					top: 0,
					left: 0,
					width: "100%",
					height: size.height || "100%",
					pointerEvents: "none",
					zIndex: 0,
				}}
			/>
			<div
				ref={spacerRef}
				style={{
					height: Math.max(size.height, layout.totalHeight),
					marginTop: -(size.height || 0),
					pointerEvents: "none",
				}}
			/>
		</div>
	);
});
