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
import { useLocalPref } from "../../../hooks/useLocalPref";
import { getRenderableMessageOrder } from "../message-order-utils";
import type { MessagesQueryData, NarratorMsg } from "../narrator-panel-types";
import { invalidatePixiImageTextures, subscribePixiImageTextureLoads } from "./pixi-image-textures";
import { drawPixiMessages, ImageSpritePool, TextPool } from "./pixi-message-draw";
import { clearPixiMessageLayoutCache, layoutPixiMessageItems } from "./pixi-message-layout";
import { buildPixiMessageItems } from "./pixi-message-model";
import { invalidatePixiMessageThemeCache, resolvePixiMessageTheme } from "./pixi-message-theme";
import { subscribePixiShikiHighlights } from "./pixi-shiki-highlight";
import {
	IconSpritePool,
	invalidatePixiTablerIconTextures,
	subscribePixiTablerIconLoads,
} from "./pixi-tabler-icons";

export interface NarratorPixiMessageListHandle {
	scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" }) => void;
	scrollToOffset: (offset: number) => void;
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

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function getMaxScrollTop(viewport: HTMLElement): number {
	return Math.max(0, viewport.scrollHeight - viewport.clientHeight);
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
	const imagePoolRef = useRef<ImageSpritePool | null>(null);
	const [ready, setReady] = useState(false);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [themeVersion, setThemeVersion] = useState(0);
	const [layoutVersion, setLayoutVersion] = useState(0);
	const [dprVersion, setDprVersion] = useState(0);
	const [iconVersion, setIconVersion] = useState(0);
	const [imageVersion, setImageVersion] = useState(0);
	const [highlightVersion, setHighlightVersion] = useState(0);
	const [restoreVersion, setRestoreVersion] = useState(0);
	const [expandReasoning] = useLocalPref("narrafork_expand_reasoning");
	const virtualScrollTopRef = useRef(0);
	const scrollEndTimerRef = useRef(0);
	const lastLightResumeAtRef = useRef(0);
	const lastVisibilityStateRef = useRef(
		typeof document !== "undefined" ? document.visibilityState : "visible",
	);
	const isAtBottomRef = useRef(true);
	const prevTotalHeightRef = useRef(0);
	const prevFirstKeyRef = useRef<string | null>(null);
	const appliedRestoreVersionRef = useRef(0);
	const lastRendererSizeRef = useRef({ width: 0, height: 0, dpr: 0 });

	const orderedMessages = useMemo(() => {
		if (!messagesData?.pages?.length) return [];
		return getRenderableMessageOrder(messagesData.pages).messages;
	}, [messagesData]);

	const items = useMemo(() => {
		void layoutVersion;
		return buildPixiMessageItems({
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
			expandReasoning,
		});
	}, [
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
		expandReasoning,
		layoutVersion,
	]);

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
	const virtualScrollHeight = Math.max(size.height, layout.totalHeight);

	const renderPixiViewport = useCallback(
		(nextScrollTop?: number, options?: { bufferPx?: number }) => {
			void themeVersion;
			void dprVersion;
			void iconVersion;
			void imageVersion;
			void highlightVersion;
			void restoreVersion;
			if (
				!ready ||
				!appRef.current ||
				!stageContainerRef.current ||
				!gfxRef.current ||
				!textPoolRef.current ||
				!iconPoolRef.current ||
				!imagePoolRef.current
			) {
				return false;
			}

			const currentScrollTop = Math.max(
				0,
				nextScrollTop ?? viewportRef.current?.scrollTop ?? virtualScrollTopRef.current,
			);
			virtualScrollTopRef.current = currentScrollTop;

			const app = appRef.current;
			const gfx = gfxRef.current;
			const textPool = textPoolRef.current;
			const iconPool = iconPoolRef.current;
			const imagePool = imagePoolRef.current;
			const theme = resolvePixiMessageTheme();
			textPool.reset();
			iconPool.reset();
			imagePool.reset();
			drawPixiMessages({
				textPool,
				iconPool,
				imagePool,
				gfx,
				items: layout.items,
				theme,
				scrollTop: currentScrollTop,
				viewportHeight: size.height,
				highlightedId,
				...(options?.bufferPx != null ? { bufferPx: options.bufferPx } : {}),
			});
			imagePool.releaseUnused();
			textPool.releaseUnused();
			iconPool.releaseUnused();
			app.render();
			return true;
		},
		[
			ready,
			layout.items,
			size.height,
			highlightedId,
			themeVersion,
			dprVersion,
			iconVersion,
			imageVersion,
			highlightVersion,
			restoreVersion,
		],
	);

	const setNativeScrollTop = useCallback(
		(targetScrollTop: number, options?: { behavior?: ScrollBehavior; bufferPx?: number }) => {
			const viewport = viewportRef.current;
			if (!viewport) return 0;
			const target = clamp(targetScrollTop, 0, getMaxScrollTop(viewport));
			if (options?.behavior === "smooth") {
				viewport.scrollTo({ top: target, behavior: "smooth" });
				return target;
			}
			viewport.scrollTop = target;
			virtualScrollTopRef.current = viewport.scrollTop;
			isAtBottomRef.current = isViewportAtBottom(viewport);
			renderPixiViewport(viewport.scrollTop, { bufferPx: options?.bufferPx });
			return viewport.scrollTop;
		},
		[renderPixiViewport],
	);

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
			const next = { width: viewport.clientWidth, height: viewport.clientHeight };
			setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
		};
		updateSize();
		const ro = new ResizeObserver(updateSize);
		ro.observe(viewport);
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;

		let renderRaf = 0;
		const renderFromNativeScroll = (bufferPx?: number) => {
			virtualScrollTopRef.current = viewport.scrollTop;
			isAtBottomRef.current = isViewportAtBottom(viewport);
			renderPixiViewport(viewport.scrollTop, bufferPx == null ? undefined : { bufferPx });
		};
		const onScroll = () => {
			cancelAnimationFrame(renderRaf);
			renderRaf = requestAnimationFrame(() => renderFromNativeScroll());
			clearTimeout(scrollEndTimerRef.current);
			scrollEndTimerRef.current = window.setTimeout(() => {
				viewport.dispatchEvent(new Event("scrollend"));
			}, 120);
		};

		renderFromNativeScroll(0);
		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			cancelAnimationFrame(renderRaf);
			clearTimeout(scrollEndTimerRef.current);
			viewport.removeEventListener("scroll", onScroll);
		};
	}, [renderPixiViewport]);

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
				setNativeScrollTop(viewport.scrollTop + heightDelta);
				isAtBottomRef.current = isViewportAtBottom(viewport);
			} else if (isAtBottomRef.current) {
				setNativeScrollTop(getMaxScrollTop(viewport));
				isAtBottomRef.current = true;
			} else {
				setNativeScrollTop(viewport.scrollTop, { bufferPx: 0 });
			}
		}

		prevTotalHeightRef.current = nextTotalHeight;
		prevFirstKeyRef.current = nextFirstKey;
	}, [layout, shift, setNativeScrollTop]);

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
		return subscribePixiImageTextureLoads(() => setImageVersion((version) => version + 1));
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

	const refreshAfterResume = useCallback((options?: { resetTextures?: boolean }) => {
		const viewport = viewportRef.current;
		if (viewport) {
			const nextSize = { width: viewport.clientWidth, height: viewport.clientHeight };
			setSize((prev) =>
				prev.width === nextSize.width && prev.height === nextSize.height ? prev : nextSize,
			);
			viewport.scrollTop = clamp(viewport.scrollTop, 0, getMaxScrollTop(viewport));
			virtualScrollTopRef.current = viewport.scrollTop;
			isAtBottomRef.current = isViewportAtBottom(viewport);
		}

		if (options?.resetTextures !== false) {
			invalidatePixiTablerIconTextures();
			invalidatePixiImageTextures();
			setIconVersion((version) => version + 1);
			setImageVersion((version) => version + 1);
		}
		setDprVersion((version) => version + 1);
		setHighlightVersion((version) => version + 1);
		setRestoreVersion((version) => version + 1);
	}, []);

	useEffect(() => {
		const refreshLightly = () => {
			const now = Date.now();
			if (now - lastLightResumeAtRef.current < 500) return;
			lastLightResumeAtRef.current = now;
			refreshAfterResume({ resetTextures: false });
		};
		const onVisibilityChange = () => {
			const previous = lastVisibilityStateRef.current;
			const next = document.visibilityState;
			lastVisibilityStateRef.current = next;
			if (next === "visible" && previous === "hidden") refreshAfterResume({ resetTextures: true });
		};
		const onPageShow = (event: PageTransitionEvent) => {
			if (event.persisted) refreshAfterResume({ resetTextures: true });
			else refreshLightly();
		};
		const onFocus = () => refreshLightly();
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("pageshow", onPageShow);
		window.addEventListener("focus", onFocus);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("pageshow", onPageShow);
			window.removeEventListener("focus", onFocus);
		};
	}, [refreshAfterResume]);

	useEffect(() => {
		const host = canvasHostRef.current;
		if (!host) return;
		const app = new Application();
		const handleContextLost = (event: Event) => event.preventDefault();
		const handleContextRestored = () => refreshAfterResume({ resetTextures: true });
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
				canvas.addEventListener("webglcontextlost", handleContextLost);
				canvas.addEventListener("webglcontextrestored", handleContextRestored);
				host.appendChild(canvas);
				const container = new Container();
				const imageContainer = new Container();
				const gfx = new Graphics();
				app.stage.addChild(gfx);
				app.stage.addChild(imageContainer);
				app.stage.addChild(container);
				stageContainerRef.current = container;
				gfxRef.current = gfx;
				textPoolRef.current = new TextPool(container);
				iconPoolRef.current = new IconSpritePool(container);
				imagePoolRef.current = new ImageSpritePool(imageContainer);

				// Fast Refresh preserves React state, so `ready` may already be true when a
				// new Pixi application is mounted. Size and render explicitly here instead of
				// relying on effects that may not re-run after HMR.
				const viewport = viewportRef.current;
				const nextSize = {
					width: Math.max(1, viewport?.clientWidth ?? 1),
					height: Math.max(1, viewport?.clientHeight ?? 1),
				};
				const nextDpr = window.devicePixelRatio || 1;
				app.renderer.resize(nextSize.width, nextSize.height, nextDpr);
				lastRendererSizeRef.current = { ...nextSize, dpr: nextDpr };
				setSize((prev) =>
					prev.width === nextSize.width && prev.height === nextSize.height ? prev : nextSize,
				);
				setReady(true);
				setRestoreVersion((version) => version + 1);
			});
		return () => {
			destroyed = true;
			if (appRef.current) {
				const canvas = appRef.current.canvas as HTMLCanvasElement;
				canvas.removeEventListener("webglcontextlost", handleContextLost);
				canvas.removeEventListener("webglcontextrestored", handleContextRestored);
				destroyPixiApplication(appRef.current);
			}
			appRef.current = null;
			stageContainerRef.current = null;
			gfxRef.current = null;
			textPoolRef.current = null;
			iconPoolRef.current = null;
			imagePoolRef.current = null;
			lastRendererSizeRef.current = { width: 0, height: 0, dpr: 0 };
		};
		// init once; resize is handled below
	}, [refreshAfterResume]);

	useEffect(() => {
		void dprVersion;
		const app = appRef.current;
		if (!ready || !app?.renderer) return;
		const nextWidth = Math.max(1, size.width);
		const nextHeight = Math.max(1, size.height);
		const nextDpr = window.devicePixelRatio || 1;
		const previous = lastRendererSizeRef.current;
		if (
			previous.width === nextWidth &&
			previous.height === nextHeight &&
			previous.dpr === nextDpr
		) {
			return;
		}
		app.renderer.resize(nextWidth, nextHeight, nextDpr);
		lastRendererSizeRef.current = { width: nextWidth, height: nextHeight, dpr: nextDpr };
	}, [ready, size, dprVersion]);

	useEffect(() => {
		if (!ready || !textPoolRef.current || !iconPoolRef.current || !imagePoolRef.current) return;
		const isRestorePass = restoreVersion !== appliedRestoreVersionRef.current;
		if (isRestorePass) {
			textPoolRef.current.refreshTextures();
			iconPoolRef.current.refreshTextures();
			imagePoolRef.current.refreshTextures();
			appliedRestoreVersionRef.current = restoreVersion;

			// After returning from the background, browser/Pixi texture caches may be
			// cold or invalid. Draw and render the exact viewport first so visible text
			// and icons get their textures requested/generated before buffered content.
			renderPixiViewport(undefined, { bufferPx: 0 });
		}

		renderPixiViewport();
	}, [ready, restoreVersion, renderPixiViewport]);

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
				setNativeScrollTop(top, { behavior: "smooth" });
			},
			scrollToOffset: (offset) => {
				setNativeScrollTop(offset, { bufferPx: 0 });
			},
			getTotalSize: () => layout.totalHeight,
			findIndexByKey: (key: string) => items.findIndex((item) => item.key === key),
			get scrollOffset() {
				return viewportRef.current?.scrollTop ?? virtualScrollTopRef.current;
			},

			get viewportSize() {
				return viewportRef.current?.clientHeight ?? 0;
			},
		}),
		[layout, items, setNativeScrollTop],
	);

	return (
		<div
			className="narrator-pixi-message-list"
			style={{
				height: "100%",
				overflow: "hidden",
				position: "relative",
			}}
		>
			<div
				ref={setViewportNode}
				style={{
					height: "100%",
					outline: "none",
					overflowX: "hidden",
					overflowY: "auto",
					overscrollBehavior: "contain",
					position: "relative",
				}}
			>
				<div
					ref={setSpacerNode}
					style={{
						height: virtualScrollHeight,
						minHeight: "100%",
						pointerEvents: "none",
						width: 1,
					}}
				/>
			</div>
			<div
				ref={canvasHostRef}
				style={{
					height: size.height || "100%",
					left: 0,
					pointerEvents: "none",
					position: "absolute",
					top: 0,
					width: size.width || "100%",
					zIndex: 0,
				}}
			/>
		</div>
	);
});
