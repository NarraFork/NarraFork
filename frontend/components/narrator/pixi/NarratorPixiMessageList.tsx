import { clearCache as clearPretextCache, setLocale as setPretextLocale } from "@chenglou/pretext";
import i18n from "@frontend/lib/i18n";
import { Application, Container, Graphics } from "pixi.js";
import {
	forwardRef,
	type MutableRefObject,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getRenderableMessageOrder } from "../message-order-utils";
import type { MessagesQueryData, NarratorMsg } from "../narrator-panel-types";
import { drawPixiMessages, TextPool } from "./pixi-message-draw";
import { clearPixiMessageLayoutCache, layoutPixiMessageItems } from "./pixi-message-layout";
import { buildPixiMessageItems } from "./pixi-message-model";
import { invalidatePixiMessageThemeCache, resolvePixiMessageTheme } from "./pixi-message-theme";
import { subscribePixiShikiHighlights } from "./pixi-shiki-highlight";
import { IconSpritePool, subscribePixiTablerIconLoads } from "./pixi-tabler-icons";

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

function isViewportAtBottom(viewport: HTMLElement): boolean {
	return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 30;
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
		shift,
	},
	ref,
) {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const canvasHostRef = useRef<HTMLDivElement | null>(null);
	const spacerRef = useRef<HTMLDivElement | null>(null);
	const appRef = useRef<Application | null>(null);
	const stageContainerRef = useRef<Container | null>(null);
	const gfxRef = useRef<Graphics | null>(null);
	const textPoolRef = useRef<TextPool | null>(null);
	const iconPoolRef = useRef<IconSpritePool | null>(null);
	const [ready, setReady] = useState(false);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [scrollTop, setScrollTop] = useState(0);
	const [themeVersion, setThemeVersion] = useState(0);
	const [layoutVersion, setLayoutVersion] = useState(0);
	const [dprVersion, setDprVersion] = useState(0);
	const [iconVersion, setIconVersion] = useState(0);
	const [highlightVersion, setHighlightVersion] = useState(0);
	const isAtBottomRef = useRef(true);
	const prevTotalHeightRef = useRef(0);
	const prevFirstKeyRef = useRef<string | null>(null);

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

	const refreshTheme = useCallback(() => {
		invalidatePixiMessageThemeCache();
		setThemeVersion((version) => version + 1);
	}, []);

	const refreshLayoutLocale = useCallback((locale?: string | null) => {
		setPretextLocale(locale || undefined);
		clearPretextCache();
		clearPixiMessageLayoutCache();
		setLayoutVersion((version) => version + 1);
	}, []);

	const layout = useMemo(() => {
		void layoutVersion;
		return layoutPixiMessageItems(items, Math.max(1, size.width));
	}, [items, size.width, layoutVersion]);

	const setViewportNode = useCallback(
		(node: HTMLDivElement | null) => {
			viewportRef.current = node;
			if (typeof scrollRef === "function") {
				scrollRef(node);
			} else if (scrollRef) {
				(scrollRef as MutableRefObject<HTMLElement | null>).current = node;
			}
		},
		[scrollRef],
	);

	const setSpacerNode = useCallback(
		(node: HTMLDivElement | null) => {
			spacerRef.current = node;
			(contentRef as MutableRefObject<HTMLDivElement | null>).current = node;
		},
		[contentRef],
	);

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
		const onScroll = () => {
			setScrollTop(viewport.scrollTop);
			isAtBottomRef.current = isViewportAtBottom(viewport);
		};
		onScroll();
		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => viewport.removeEventListener("scroll", onScroll);
	}, []);

	useLayoutEffect(() => {
		const previousTotalHeight = prevTotalHeightRef.current;
		const previousFirstKey = prevFirstKeyRef.current;
		const nextTotalHeight = layout.totalHeight;
		const nextFirstKey = layout.items[0]?.item.key ?? null;
		const heightDelta = nextTotalHeight - previousTotalHeight;
		const viewport = viewportRef.current;

		if (viewport) {
			const prependedItems =
				shift === true &&
				previousFirstKey !== null &&
				nextFirstKey !== previousFirstKey &&
				heightDelta > 0;

			if (prependedItems) {
				viewport.scrollTop += heightDelta;
				setScrollTop(viewport.scrollTop);
				isAtBottomRef.current = isViewportAtBottom(viewport);
			} else if (isAtBottomRef.current) {
				viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
				setScrollTop(viewport.scrollTop);
				isAtBottomRef.current = true;
			}
		}

		prevTotalHeightRef.current = nextTotalHeight;
		prevFirstKeyRef.current = nextFirstKey;
	}, [layout, shift]);

	useEffect(() => {
		const observer = new MutationObserver((mutations) => {
			const hasThemeChange = mutations.some(
				(mutation) =>
					mutation.attributeName === "data-mantine-color-scheme" ||
					mutation.attributeName === "data-oled",
			);
			if (hasThemeChange) refreshTheme();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-mantine-color-scheme", "data-oled"],
		});
		return () => observer.disconnect();
	}, [refreshTheme]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key === "narrafork_oled") {
				refreshTheme();
				return;
			}
			if (event.key === "narrafork_lang") {
				refreshLayoutLocale(event.newValue ?? i18n.language);
			}
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [refreshLayoutLocale, refreshTheme]);

	useEffect(() => {
		const readCurrentLanguage = () => {
			try {
				return localStorage.getItem("narrafork_lang") ?? i18n.language;
			} catch {
				return i18n.language;
			}
		};
		const onLanguageChanged = (language: string) => refreshLayoutLocale(language);
		refreshLayoutLocale(readCurrentLanguage());
		i18n.on("languageChanged", onLanguageChanged);
		return () => {
			i18n.off("languageChanged", onLanguageChanged);
		};
	}, [refreshLayoutLocale]);

	useEffect(() => {
		return subscribePixiTablerIconLoads(() => setIconVersion((version) => version + 1));
	}, []);

	useEffect(() => {
		return subscribePixiShikiHighlights(() => setHighlightVersion((version) => version + 1));
	}, []);

	useEffect(() => {
		let removeCurrentListener: (() => void) | null = null;
		const attachDprListener = () => {
			const dpr = window.devicePixelRatio || 1;
			const media = window.matchMedia(`(resolution: ${dpr}dppx)`);
			const onChange = () => {
				removeCurrentListener?.();
				setDprVersion((version) => version + 1);
				attachDprListener();
			};
			media.addEventListener("change", onChange);
			removeCurrentListener = () => media.removeEventListener("change", onChange);
		};
		attachDprListener();
		return () => removeCurrentListener?.();
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
				textPoolRef.current = new TextPool(container);
				iconPoolRef.current = new IconSpritePool(container);
				setReady(true);
			});
		return () => {
			destroyed = true;
			if (appRef.current) destroyPixiApplication(appRef.current);
			appRef.current = null;
			stageContainerRef.current = null;
			gfxRef.current = null;
			textPoolRef.current = null;
			iconPoolRef.current = null;
		};
		// init once; resize is handled below
	}, []);

	useEffect(() => {
		void dprVersion;
		const app = appRef.current;
		if (!ready || !app?.renderer) return;
		app.renderer.resize(
			Math.max(1, size.width),
			Math.max(1, size.height),
			window.devicePixelRatio || 1,
		);
	}, [ready, size, dprVersion]);

	useEffect(() => {
		void themeVersion;
		void dprVersion;
		void iconVersion;
		void highlightVersion;
		if (
			!ready ||
			!appRef.current ||
			!stageContainerRef.current ||
			!gfxRef.current ||
			!textPoolRef.current ||
			!iconPoolRef.current
		) {
			return;
		}
		const textPool = textPoolRef.current;
		const iconPool = iconPoolRef.current;
		textPool.reset();
		iconPool.reset();
		drawPixiMessages({
			textPool,
			iconPool,
			gfx: gfxRef.current,
			items: layout.items,
			theme: resolvePixiMessageTheme(),
			scrollTop,
			viewportHeight: size.height,
			highlightedId,
		});
		textPool.releaseUnused();
		iconPool.releaseUnused();
		appRef.current.render();
	}, [
		ready,
		layout,
		scrollTop,
		size.height,
		highlightedId,
		themeVersion,
		dprVersion,
		iconVersion,
		highlightVersion,
	]);

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
				ref={setSpacerNode}
				style={{
					height: Math.max(size.height, layout.totalHeight),
					marginTop: -(size.height || 0),
					pointerEvents: "none",
				}}
			/>
		</div>
	);
});
