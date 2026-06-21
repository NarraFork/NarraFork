import { clearCache as clearPretextCache, setLocale as setPretextLocale } from "@chenglou/pretext";
import i18n from "@frontend/lib/i18n";
import { Z } from "@frontend/lib/z-index";
import { Box, Menu } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconArrowBackUp,
	IconCopy,
	IconGitFork,
	IconMessageQuestion,
	IconPhoto,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { Application, Container, Graphics, type Ticker } from "pixi.js";
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
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocalPref } from "../../../hooks/useLocalPref";
import { useFileSystemCapability, useUploadCapability } from "../../../hooks/usePlatform";
import { CompactMenuSub } from "../CompactMenuSub";
import { copyGeneratedImageToClipboard } from "../image-clipboard";
import { BLOCK_ID_ATTR, useMessageSelection } from "../MessageSelectionCtx";
import { getRenderableMessageOrder } from "../message-order-utils";
import { resolvePendingPerm } from "../narrator-message-helpers";
import type { MessagesQueryData, NarratorMsg, PendingPermission } from "../narrator-panel-types";
import {
	getGlobalCloseSwipe,
	getGlobalOnSelectionRange,
	getGlobalSwipeAnchor,
	getGlobalToggleBlock,
	setGlobalCloseSwipe,
	setGlobalSwipeAnchor,
} from "../swipeState";
import { invalidatePixiImageTextures, subscribePixiImageTextureLoads } from "./pixi-image-textures";
import {
	drawPixiMessages,
	ImageSpritePool,
	type PixiMessageHitTarget,
	TextPool,
} from "./pixi-message-draw";
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
	pendingPermission?: PendingPermission | null;
	pendingPermsMap?: Map<string, PendingPermission>;
	onPermissionDecision?: (
		requestId: string,
		decision: "allow" | "deny",
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	onForkFromMessage?: (uuid: string) => void;
	onAskInPassing?: (messageUuid: string | null, messageId: string) => void;
	onCompactBeforeMessage?: (messageId: string) => void;
	onClearContextBefore?: (messageId: string) => void;
	onManualSummarize?: (messageId: string) => void;
	onDeleteBlock?: (messageId: string, blockIndex: number) => void;
	onRollbackToBlock?: (messageId: string, blockIndex: number) => void;
	scrollRef: RefObject<HTMLElement | null> | ((node: HTMLDivElement | null) => void);
	contentRef: RefObject<HTMLDivElement | null>;
	shift?: boolean;
}

function destroyPixiApplication(app: Application): void {
	const pixiApp = app as unknown as { _cancelResize?: () => void; destroy: Application["destroy"] };
	if (typeof pixiApp._cancelResize !== "function") pixiApp._cancelResize = () => {};
	app.destroy(true, { children: true });
}

type RenderableContainer = Container & { destroyed?: boolean; children?: unknown[] | null };
type RenderableApplication = Application & {
	destroyed?: boolean;
	renderer?: unknown;
	stage?: RenderableContainer | null;
};

function isRenderableContainer(container: Container | null): container is RenderableContainer {
	if (!container) return false;
	const renderable = container as RenderableContainer;
	return renderable.destroyed !== true && Array.isArray(renderable.children);
}

function isRenderableApplication(app: Application | null): app is RenderableApplication {
	if (!app) return false;
	const renderable = app as RenderableApplication;
	return (
		renderable.destroyed !== true &&
		!!renderable.renderer &&
		isRenderableContainer(renderable.stage ?? null)
	);
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

const SWIPE_DIRECTION_THRESHOLD = 10;
const SWIPE_THRESHOLD = 60;
const SWIPE_REVEAL_WIDTH = 180;
const SWIPE_CLOSE_DURATION = 220;
const TOUCH_MOMENTUM_TIME_CONSTANT_MS = 325;
const TOUCH_MOMENTUM_MIN_VELOCITY_PX_PER_MS = 0.02;
const WHEEL_LINE_HEIGHT_PX = 16;
const WHEEL_SMOOTHING_TIME_CONSTANT_MS = 95;
const WHEEL_SMOOTHING_EPSILON_PX = 0.5;

type MessageMenuTarget = Extract<PixiMessageHitTarget, { kind: "message-menu" }>;
type ToolContentScrollTarget = Extract<PixiMessageHitTarget, { kind: "tool-content-scroll" }>;

type PixiSwipeGeometry = {
	initialRight: number;
	targetLayoutTop: number;
	targetLayoutBottom: number;
	targetTop: number;
	targetBottom: number;
	visibleTop: number;
	visibleBottom: number;
};

type PixiMessageMenuState = {
	x: number;
	y: number;
	mode: "context" | "swipe";
	offset: number;
	dragging?: boolean;
	closing?: boolean;
	offscreen?: "top" | "bottom" | null;
	swipeGeometry?: PixiSwipeGeometry;
	target: MessageMenuTarget;
};

type TouchScrollState = {
	moved: boolean;
	pointerId: number;
	startX: number;
	startY: number;
	lastY: number;
	lastTime: number;
	direction: "horizontal" | "vertical" | null;
	rangeCandidate: boolean;
	target: PixiMessageHitTarget | null;
	scrollTarget: ToolContentScrollTarget | null;
	swipeTarget: MessageMenuTarget | null;
	swipeOffset: number;
	swipeGeometry: PixiSwipeGeometry | null;
	velocity: number;
};

function targetContainsPoint(target: PixiMessageHitTarget, x: number, y: number): boolean {
	if (x < target.x || x > target.x + target.width || y < target.y || y > target.y + target.height) {
		return false;
	}
	return !target.excludeRects?.some(
		(rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height,
	);
}

function hitTestPixiTarget(
	targets: PixiMessageHitTarget[],
	x: number,
	y: number,
): PixiMessageHitTarget | null {
	for (let i = targets.length - 1; i >= 0; i--) {
		const target = targets[i];
		if (targetContainsPoint(target, x, y)) return target;
	}
	return null;
}

function hitTestPixiMessageMenuTarget(
	targets: PixiMessageHitTarget[],
	x: number,
	y: number,
): MessageMenuTarget | null {
	for (let i = targets.length - 1; i >= 0; i--) {
		const target = targets[i];
		if (target.kind === "message-menu" && targetContainsPoint(target, x, y)) return target;
	}
	return null;
}

function hitTestPixiToolContentScrollTarget(
	targets: PixiMessageHitTarget[],
	x: number,
	y: number,
): ToolContentScrollTarget | null {
	for (let i = targets.length - 1; i >= 0; i--) {
		const target = targets[i];
		if (target.kind === "tool-content-scroll" && targetContainsPoint(target, x, y)) return target;
	}
	return null;
}

function pruneMapToKeys<V>(map: Map<string, V>, keys: ReadonlySet<string>): void {
	for (const key of map.keys()) {
		if (!keys.has(key)) map.delete(key);
	}
}

function pruneSetToKeys(set: Set<string>, keys: ReadonlySet<string>): void {
	for (const key of set) {
		if (!keys.has(key)) set.delete(key);
	}
}

function computePixiSwipeMenuPosition(
	menu: Pick<PixiMessageMenuState, "x" | "y" | "offset" | "swipeGeometry">,
	menuHeight = 120,
): { x: number; y: number } {
	const geometry = menu.swipeGeometry;
	if (!geometry) return { x: menu.x, y: menu.y };

	const menuLeft = geometry.initialRight - menu.offset;
	const half = menuHeight / 2;

	const center = (geometry.visibleTop + geometry.visibleBottom) / 2;
	let menuTop = center;
	const minTop = geometry.targetTop + half;
	const maxTop = geometry.targetBottom - half;
	if (minTop <= maxTop) {
		menuTop = Math.max(minTop, Math.min(center, maxTop));
	} else {
		menuTop = (geometry.targetTop + geometry.targetBottom) / 2;
	}
	menuTop = Math.max(geometry.visibleTop + half, Math.min(menuTop, geometry.visibleBottom - half));

	return { x: menuLeft, y: menuTop };
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
		pendingPermission,
		pendingPermsMap,
		onPermissionDecision,
		onForkFromMessage,
		onAskInPassing,
		onCompactBeforeMessage,
		onClearContextBefore,
		onManualSummarize,
		onDeleteBlock,
		onRollbackToBlock,
		scrollRef,
		contentRef,
		shift,
	},
	ref,
) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const fsCapability = useFileSystemCapability();
	const fsPreviewSupported = fsCapability.preview.supported;
	const uploadCapability = useUploadCapability();
	const avatarServingSupported = uploadCapability.serveAvatars.supported;
	const narratorImageServingSupported = uploadCapability.serveNarratorImages.supported;
	const selection = useMessageSelection();
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const canvasHostRef = useRef<HTMLDivElement | null>(null);
	const spacerRef = useRef<HTMLDivElement | null>(null);
	const appRef = useRef<Application | null>(null);
	const stageContainerRef = useRef<Container | null>(null);
	const imageContainerRef = useRef<Container | null>(null);
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
	const [fpsText, setFpsText] = useState("-- fps");
	const [hoveredHitTargetId, setHoveredHitTargetId] = useState<string | null>(null);
	const [expandReasoning] = useLocalPref("narrafork_expand_reasoning");
	const hitTargetsRef = useRef<PixiMessageHitTarget[]>([]);
	const hoveredHitTargetIdRef = useRef<string | null>(null);
	const [messageMenu, setMessageMenu] = useState<PixiMessageMenuState | null>(null);
	const [expandedStateVersion, setExpandedStateVersion] = useState(0);
	const toolExpandedMapRef = useRef(new Map<string, boolean>());
	const userToggledToolKeysRef = useRef(new Set<string>());
	const forcedToolExpandedKeysRef = useRef(new Set<string>());
	const resolvedToolExpandedRef = useRef(new Map<string, boolean>());
	const reasoningExpandedMapRef = useRef(new Map<string, boolean>());
	const toolContentScrollMapRef = useRef(new Map<string, number>());
	const userToggledReasoningKeysRef = useRef(new Set<string>());
	const reasoningSlotExpandedRef = useRef(new Map<string, boolean>());
	const reasoningKeySlotRef = useRef(new Map<string, string>());
	const seenReasoningKeysRef = useRef(new Set<string>());
	const resolvedReasoningExpandedRef = useRef(new Map<string, boolean>());
	const swipedMessageRef = useRef<{
		targetId: string;
		offset: number;
		offscreen?: "top" | "bottom" | null;
	} | null>(null);
	const swipeCloseTimerRef = useRef(0);
	const messageMenuRef = useRef<HTMLDivElement | null>(null);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const onPermissionDecisionRef = useRef(onPermissionDecision);
	onPermissionDecisionRef.current = onPermissionDecision;
	const renderPixiViewportRef = useRef<
		(nextScrollTop?: number, options?: { bufferPx?: number }) => boolean
	>(() => false);
	const refreshAfterResumeRef = useRef<(options?: { resetTextures?: boolean }) => void>(() => {});
	const sizeRef = useRef(size);
	sizeRef.current = size;
	const virtualScrollTopRef = useRef(0);
	const pixiScrollOffsetRef = useRef(0);
	const touchDrivingScrollRef = useRef(false);
	const outerScrollInProgressRef = useRef(false);
	const scrollEndTimerRef = useRef(0);
	const pixiDrivenScrollTopRef = useRef<number | null>(null);
	const lastLightResumeAtRef = useRef(0);
	const lastVisibilityStateRef = useRef(
		typeof document !== "undefined" ? document.visibilityState : "visible",
	);
	const isAtBottomRef = useRef(true);
	const prevTotalHeightRef = useRef(0);
	const prevFirstKeyRef = useRef<string | null>(null);
	const fpsLastCommitAtRef = useRef(0);
	const fpsFrameCountRef = useRef(0);
	const appliedRestoreVersionRef = useRef(0);
	const lastRendererSizeRef = useRef({ width: 0, height: 0, dpr: 0 });
	const pixiDestroyedRef = useRef(true);

	const recordPixiFrame = useCallback(() => {
		const now = performance.now();
		if (fpsLastCommitAtRef.current === 0) {
			fpsLastCommitAtRef.current = now;
			fpsFrameCountRef.current = 0;
			return;
		}
		fpsFrameCountRef.current += 1;
		const elapsed = now - fpsLastCommitAtRef.current;
		if (elapsed < 500) return;
		const fps = (fpsFrameCountRef.current * 1000) / elapsed;
		fpsLastCommitAtRef.current = now;
		fpsFrameCountRef.current = 0;
		setFpsText(`${Math.round(fps)} fps`);
	}, []);

	useEffect(() => {
		hoveredHitTargetIdRef.current = hoveredHitTargetId;
	}, [hoveredHitTargetId]);

	const orderedMessages = useMemo(() => {
		if (!messagesData?.pages?.length) return [];
		return getRenderableMessageOrder(messagesData.pages).messages;
	}, [messagesData]);

	const resolvePixiPermission = useCallback(
		(
			tc: Parameters<
				NonNullable<Parameters<typeof buildPixiMessageItems>[0]["resolvePermission"]>
			>[0],
		) =>
			resolvePendingPerm(
				tc as Parameters<typeof resolvePendingPerm>[0],
				pendingPermission,
				pendingPermsMap,
			),
		[pendingPermission, pendingPermsMap],
	);

	const resolveToolExpanded = useCallback(
		(
			tool: Parameters<
				NonNullable<Parameters<typeof buildPixiMessageItems>[0]["resolveToolExpanded"]>
			>[0],
		) => {
			const forced = !!tool.pendingPermission || tool.status === "pending";
			if (forced) {
				forcedToolExpandedKeysRef.current.add(tool.toolKey);
				resolvedToolExpandedRef.current.set(tool.toolKey, true);
				return true;
			}
			forcedToolExpandedKeysRef.current.delete(tool.toolKey);
			const value = userToggledToolKeysRef.current.has(tool.toolKey)
				? (toolExpandedMapRef.current.get(tool.toolKey) ?? tool.defaultOpen)
				: tool.defaultOpen;
			resolvedToolExpandedRef.current.set(tool.toolKey, value);
			return value;
		},
		[],
	);

	const resolveReasoningExpanded = useCallback(
		(
			reasoning: Parameters<
				NonNullable<Parameters<typeof buildPixiMessageItems>[0]["resolveReasoningExpanded"]>
			>[0],
		) => {
			reasoningKeySlotRef.current.set(reasoning.reasoningKey, reasoning.reasoningSlotKey);
			const manualKey = [reasoning.reasoningKey, ...(reasoning.reasoningAliasKeys ?? [])].find(
				(key) => userToggledReasoningKeysRef.current.has(key),
			);
			if (manualKey) {
				const value = reasoningExpandedMapRef.current.get(manualKey) ?? reasoning.defaultExpanded;
				resolvedReasoningExpandedRef.current.set(reasoning.reasoningKey, value);
				seenReasoningKeysRef.current.add(reasoning.reasoningKey);
				return value;
			}
			if (seenReasoningKeysRef.current.has(reasoning.reasoningKey)) {
				return (
					resolvedReasoningExpandedRef.current.get(reasoning.reasoningKey) ??
					reasoning.defaultExpanded
				);
			}
			const value =
				reasoningSlotExpandedRef.current.get(reasoning.reasoningSlotKey) ??
				reasoning.defaultExpanded;
			resolvedReasoningExpandedRef.current.set(reasoning.reasoningKey, value);
			seenReasoningKeysRef.current.add(reasoning.reasoningKey);
			return value;
		},
		[],
	);

	const items = useMemo(() => {
		void layoutVersion;
		void expandedStateVersion;
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
			resolvePermission: resolvePixiPermission,
			resolveToolExpanded,
			resolveReasoningExpanded,
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
		resolvePixiPermission,
		resolveToolExpanded,
		resolveReasoningExpanded,
		layoutVersion,
		expandedStateVersion,
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
	const pixiStateKeys = useMemo(() => {
		const toolKeys = new Set<string>();
		const reasoningKeys = new Set<string>();
		const reasoningSlotKeys = new Set<string>();
		const toolContentScrollKeys = new Set<string>();
		for (const laid of layout.items) {
			for (const block of laid.blocks) {
				if (block.toolKey) toolKeys.add(block.toolKey);
				if (block.reasoningKey) {
					reasoningKeys.add(block.reasoningKey);
					const slotKey = reasoningKeySlotRef.current.get(block.reasoningKey);
					if (slotKey) reasoningSlotKeys.add(slotKey);
				}
				for (const detail of block.toolDetailBlocks ?? []) {
					if (detail.scrollKey) toolContentScrollKeys.add(detail.scrollKey);
				}
			}
		}
		return { toolKeys, reasoningKeys, reasoningSlotKeys, toolContentScrollKeys };
	}, [layout.items]);

	useEffect(() => {
		pruneMapToKeys(toolExpandedMapRef.current, pixiStateKeys.toolKeys);
		pruneSetToKeys(userToggledToolKeysRef.current, pixiStateKeys.toolKeys);
		pruneSetToKeys(forcedToolExpandedKeysRef.current, pixiStateKeys.toolKeys);
		pruneMapToKeys(resolvedToolExpandedRef.current, pixiStateKeys.toolKeys);
		pruneMapToKeys(reasoningExpandedMapRef.current, pixiStateKeys.reasoningKeys);
		pruneSetToKeys(userToggledReasoningKeysRef.current, pixiStateKeys.reasoningKeys);
		pruneMapToKeys(resolvedReasoningExpandedRef.current, pixiStateKeys.reasoningKeys);
		pruneSetToKeys(seenReasoningKeysRef.current, pixiStateKeys.reasoningKeys);
		pruneMapToKeys(reasoningKeySlotRef.current, pixiStateKeys.reasoningKeys);
		pruneMapToKeys(reasoningSlotExpandedRef.current, pixiStateKeys.reasoningSlotKeys);
		pruneMapToKeys(toolContentScrollMapRef.current, pixiStateKeys.toolContentScrollKeys);
	}, [pixiStateKeys]);
	const virtualScrollHeight = Math.max(size.height, layout.totalHeight);
	const selectionMarkers = useMemo(() => {
		const markers: Array<{
			blockId: string;
			messageId?: string;
			blockIndex?: number;
			text: string;
			x: number;
			y: number;
			width: number;
			height: number;
		}> = [];
		for (const laid of layout.items) {
			if (laid.item.kind === "divider") continue;
			for (const block of laid.blocks) {
				if (!block.messageId && !block.copyText) continue;
				const blockId = `px-${block.messageId ?? laid.item.key}-${block.blockIndex ?? block.type}`;
				markers.push({
					blockId,
					messageId: block.messageId ?? laid.item.messageId,
					blockIndex: block.blockIndex,
					text:
						block.copyText || block.text || block.lines?.map((line) => line.text).join("\n") || "",
					x: laid.x + block.x,
					y: laid.y + block.y,
					width: block.width,
					height: block.height,
				});
			}
		}
		return markers;
	}, [layout.items]);

	const closePixiMessageMenu = useCallback((animate = true) => {
		window.clearTimeout(swipeCloseTimerRef.current);
		if (animate && swipedMessageRef.current) {
			swipedMessageRef.current = { ...swipedMessageRef.current, offset: 0 };
			setMessageMenu((menu) =>
				menu ? { ...menu, x: menu.x + menu.offset, offset: 0, closing: true } : menu,
			);
			renderPixiViewportRef.current();
			swipeCloseTimerRef.current = window.setTimeout(() => {
				swipedMessageRef.current = null;
				setMessageMenu(null);
				renderPixiViewportRef.current();
			}, SWIPE_CLOSE_DURATION);
		} else {
			swipedMessageRef.current = null;
			setMessageMenu(null);
			renderPixiViewportRef.current();
		}
		if (getGlobalCloseSwipe() === closePixiMessageMenu) setGlobalCloseSwipe(null);
		setGlobalSwipeAnchor(null);
	}, []);

	const openPixiMessageMenu = useCallback(
		(menu: PixiMessageMenuState) => {
			window.clearTimeout(swipeCloseTimerRef.current);
			const currentClose = getGlobalCloseSwipe();
			if (currentClose && currentClose !== closePixiMessageMenu) currentClose();
			setGlobalCloseSwipe(closePixiMessageMenu);
			if (menu.mode === "swipe") setGlobalSwipeAnchor(menu.target.blockId);
			setMessageMenu(menu);
		},
		[closePixiMessageMenu],
	);

	useEffect(() => {
		return () => {
			window.clearTimeout(swipeCloseTimerRef.current);
			if (getGlobalCloseSwipe() === closePixiMessageMenu) setGlobalCloseSwipe(null);
		};
	}, [closePixiMessageMenu]);

	const toggleTool = useCallback((toolKey: string) => {
		if (forcedToolExpandedKeysRef.current.has(toolKey)) return;
		const current = resolvedToolExpandedRef.current.get(toolKey) ?? false;
		toolExpandedMapRef.current.set(toolKey, !current);
		userToggledToolKeysRef.current.add(toolKey);
		setExpandedStateVersion((version) => version + 1);
	}, []);

	const toggleReasoning = useCallback((reasoningKey: string) => {
		const current = resolvedReasoningExpandedRef.current.get(reasoningKey) ?? false;
		const next = !current;
		reasoningExpandedMapRef.current.set(reasoningKey, next);
		userToggledReasoningKeysRef.current.add(reasoningKey);
		resolvedReasoningExpandedRef.current.set(reasoningKey, next);
		const slotKey = reasoningKeySlotRef.current.get(reasoningKey);
		if (slotKey) reasoningSlotExpandedRef.current.set(slotKey, next);
		setExpandedStateVersion((version) => version + 1);
	}, []);

	const renderPixiViewport = useCallback(
		(nextScrollTop?: number, options?: { bufferPx?: number }) => {
			void themeVersion;
			void dprVersion;
			void iconVersion;
			void imageVersion;
			void highlightVersion;
			void restoreVersion;
			void hoveredHitTargetId;
			if (
				!ready ||
				pixiDestroyedRef.current ||
				!isRenderableApplication(appRef.current) ||
				!isRenderableContainer(stageContainerRef.current) ||
				!isRenderableContainer(imageContainerRef.current) ||
				!gfxRef.current ||
				!textPoolRef.current ||
				!iconPoolRef.current ||
				!imagePoolRef.current
			) {
				return false;
			}

			const currentScrollTop = Math.max(0, nextScrollTop ?? pixiScrollOffsetRef.current);
			virtualScrollTopRef.current = currentScrollTop;
			pixiScrollOffsetRef.current = currentScrollTop;

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
				hitTargets: hitTargetsRef.current,
				hoveredHitTargetId,
				swipedMessage: swipedMessageRef.current,
				selectedBlockIds: selectionRef.current.selectionMode
					? selectionRef.current.selectedBlockIds
					: undefined,
				getToolContentScroll: (scrollKey) => toolContentScrollMapRef.current.get(scrollKey) ?? 0,
				fsPreviewSupported,
				avatarServingSupported,
				narratorImageServingSupported,
				...(options?.bufferPx != null ? { bufferPx: options.bufferPx } : {}),
			});
			imagePool.releaseUnused();
			textPool.releaseUnused();
			iconPool.releaseUnused();
			app.render();
			recordPixiFrame();
			return true;
		},
		[
			ready,
			layout.items,
			size.height,
			fsPreviewSupported,
			avatarServingSupported,
			narratorImageServingSupported,

			highlightedId,
			themeVersion,
			dprVersion,
			iconVersion,
			imageVersion,
			highlightVersion,
			restoreVersion,
			hoveredHitTargetId,
			recordPixiFrame,
		],
	);

	renderPixiViewportRef.current = renderPixiViewport;

	useEffect(() => {
		void selection.selectionMode;
		void selection.selectedBlockIds;
		renderPixiViewportRef.current();
	}, [selection.selectionMode, selection.selectedBlockIds]);

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
			pixiScrollOffsetRef.current = target;
			virtualScrollTopRef.current = target;
			isAtBottomRef.current = isViewportAtBottom(viewport);
			renderPixiViewport(target, { bufferPx: options?.bufferPx });
			return target;
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
			pixiScrollOffsetRef.current = viewport.scrollTop;
			virtualScrollTopRef.current = viewport.scrollTop;
			isAtBottomRef.current = isViewportAtBottom(viewport);
			renderPixiViewport(viewport.scrollTop, bufferPx == null ? undefined : { bufferPx });
		};
		const markOuterScrollInProgress = () => {
			outerScrollInProgressRef.current = true;
			clearTimeout(scrollEndTimerRef.current);
			scrollEndTimerRef.current = window.setTimeout(() => {
				outerScrollInProgressRef.current = false;
				viewport.dispatchEvent(new Event("scrollend"));
			}, 120);
		};
		const onScroll = () => {
			const pixiDrivenScrollTop = pixiDrivenScrollTopRef.current;
			const isPixiDrivenScroll =
				touchDrivingScrollRef.current ||
				(pixiDrivenScrollTop !== null && Math.abs(viewport.scrollTop - pixiDrivenScrollTop) < 0.5);
			if (isPixiDrivenScroll) {
				pixiDrivenScrollTopRef.current = null;
			} else {
				cancelAnimationFrame(renderRaf);
				renderRaf = requestAnimationFrame(() => renderFromNativeScroll());
			}
			markOuterScrollInProgress();
		};

		renderFromNativeScroll(0);
		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			cancelAnimationFrame(renderRaf);
			clearTimeout(scrollEndTimerRef.current);
			outerScrollInProgressRef.current = false;
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
				setNativeScrollTop(pixiScrollOffsetRef.current + heightDelta);
				isAtBottomRef.current = isViewportAtBottom(viewport);
			} else if (isAtBottomRef.current) {
				setNativeScrollTop(getMaxScrollTop(viewport));
				isAtBottomRef.current = true;
			} else {
				setNativeScrollTop(pixiScrollOffsetRef.current, { bufferPx: 0 });
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
		return subscribePixiShikiHighlights(() => {
			clearPixiMessageLayoutCache();
			setHighlightVersion((version) => version + 1);
		});
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
			pixiScrollOffsetRef.current = viewport.scrollTop;
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
	refreshAfterResumeRef.current = refreshAfterResume;

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
		pixiDestroyedRef.current = true;
		let touchScrollState: TouchScrollState | null = null;
		let momentumVelocity = 0;
		let momentumTickerAttached = false;
		let momentumTick: ((ticker: Ticker) => void) | null = null;
		let wheelSmoothingTickerAttached = false;
		let wheelSmoothingTick: ((ticker: Ticker) => void) | null = null;
		let hasActiveWheelSmoothing = false;
		let wheelSmoothingTarget: ToolContentScrollTarget | null = null;
		let wheelSmoothingTargetOffset = 0;
		const syncNativeScrollFromPixi = () => {
			const viewport = viewportRef.current;
			if (!viewport) return;
			const offset = clamp(pixiScrollOffsetRef.current, 0, getMaxScrollTop(viewport));
			pixiScrollOffsetRef.current = offset;
			virtualScrollTopRef.current = offset;
			pixiDrivenScrollTopRef.current = offset;
			viewport.scrollTop = offset;
			isAtBottomRef.current = isViewportAtBottom(viewport);
		};
		const cancelTouchMomentum = () => {
			if (momentumTickerAttached && momentumTick) {
				app.ticker.remove(momentumTick);
				momentumTickerAttached = false;
				if (app.ticker.count === 0) app.ticker.stop();
			}
			momentumVelocity = 0;
			touchDrivingScrollRef.current = false;
			syncNativeScrollFromPixi();
		};
		const cancelWheelSmoothing = () => {
			if (wheelSmoothingTickerAttached && wheelSmoothingTick) {
				app.ticker.remove(wheelSmoothingTick);
				wheelSmoothingTickerAttached = false;
				if (app.ticker.count === 0) app.ticker.stop();
			}
			hasActiveWheelSmoothing = false;
			wheelSmoothingTarget = null;
			wheelSmoothingTargetOffset = 0;
		};
		const handleContextLost = (event: Event) => {
			cancelTouchMomentum();
			cancelWheelSmoothing();
			event.preventDefault();
		};
		const handleContextRestored = () => refreshAfterResumeRef.current({ resetTextures: true });
		const eventLocalPoint = (event: PointerEvent | MouseEvent) => {
			const canvas = event.currentTarget as HTMLCanvasElement;
			const rect = canvas.getBoundingClientRect();
			return { rect, x: event.clientX - rect.left, y: event.clientY - rect.top };
		};
		const hitTargetAtEvent = (event: PointerEvent | MouseEvent) => {
			const point = eventLocalPoint(event);
			return hitTestPixiTarget(hitTargetsRef.current, point.x, point.y);
		};
		const messageMenuTargetAtEvent = (event: PointerEvent | MouseEvent) => {
			const point = eventLocalPoint(event);
			return hitTestPixiMessageMenuTarget(hitTargetsRef.current, point.x, point.y);
		};
		const toolContentScrollTargetAtEvent = (event: PointerEvent | MouseEvent) => {
			const point = eventLocalPoint(event);
			return hitTestPixiToolContentScrollTarget(hitTargetsRef.current, point.x, point.y);
		};
		const swipeGeometryForTarget = (
			target: MessageMenuTarget,
			canvasRect: DOMRect,
		): PixiSwipeGeometry => {
			let visibleTop = 0;
			let visibleBottom = window.innerHeight;
			const viewport = viewportRef.current;
			if (viewport) {
				const viewportRect = viewport.getBoundingClientRect();
				visibleTop = Math.max(visibleTop, viewportRect.top);
				visibleBottom = Math.min(visibleBottom, viewportRect.bottom);
			}
			const targetLayoutTop = pixiScrollOffsetRef.current + target.y;
			const targetLayoutBottom = targetLayoutTop + target.height;
			return {
				initialRight: canvasRect.left + (target.swipeInitialRight ?? target.x + target.width),
				targetLayoutTop,
				targetLayoutBottom,
				targetTop: canvasRect.top + target.y,
				targetBottom: canvasRect.top + target.y + target.height,
				visibleTop,
				visibleBottom,
			};
		};
		const swipePositionForGeometry = (geometry: PixiSwipeGeometry, offset: number) =>
			computePixiSwipeMenuPosition(
				{ x: geometry.initialRight - offset, y: 0, offset, swipeGeometry: geometry },
				messageMenuRef.current?.offsetHeight,
			);
		const clearHoveredTarget = (canvas: HTMLCanvasElement) => {
			if (hoveredHitTargetIdRef.current !== null) {
				hoveredHitTargetIdRef.current = null;
				setHoveredHitTargetId(null);
			}
			canvas.style.cursor = "default";
		};
		const triggerHitTarget = (target: PixiMessageHitTarget) => {
			if (target.kind === "tool-content-scroll") return;
			if (target.kind === "tool-toggle") {
				toggleTool(target.toolKey);
				return;
			}
			if (target.kind === "reasoning-toggle") {
				toggleReasoning(target.reasoningKey);
				return;
			}
			if (target.kind !== "permission-action" && target.kind !== "permission") return;
			if (target.action === "deny") {
				onPermissionDecisionRef.current?.(target.permissionId, "deny");
			} else {
				onPermissionDecisionRef.current?.(
					target.permissionId,
					"allow",
					undefined,
					target.action === "allow_compact" ? true : undefined,
				);
			}
		};
		const dispatchScrollIntent = (viewport: HTMLElement, deltaY: number) => {
			viewport.dispatchEvent(new WheelEvent("wheel", { deltaY }));
		};
		const scrollViewportBy = (deltaY: number, options?: { renderNow?: boolean }) => {
			const viewport = viewportRef.current;
			if (!viewport) return false;
			const previous = pixiScrollOffsetRef.current;
			const next = clamp(previous + deltaY, 0, getMaxScrollTop(viewport));
			const actualDelta = next - previous;
			if (actualDelta === 0) return false;
			outerScrollInProgressRef.current = true;
			pixiScrollOffsetRef.current = next;
			virtualScrollTopRef.current = next;
			isAtBottomRef.current = next >= getMaxScrollTop(viewport) - 30;
			dispatchScrollIntent(viewport, actualDelta);
			pixiDrivenScrollTopRef.current = next;
			viewport.scrollTop = next;
			if (options?.renderNow) renderPixiViewportRef.current(next);
			return true;
		};
		const scrollToolContentBy = (target: ToolContentScrollTarget, deltaY: number) => {
			const previous = toolContentScrollMapRef.current.get(target.scrollKey) ?? 0;
			const next = clamp(previous + deltaY, 0, target.maxScrollTop);
			if (next === previous) return false;
			toolContentScrollMapRef.current.set(target.scrollKey, next);
			renderPixiViewportRef.current();
			return true;
		};
		const normalizeWheelDeltaY = (event: WheelEvent) => {
			if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * WHEEL_LINE_HEIGHT_PX;
			if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
				return event.deltaY * Math.max(1, viewportRef.current?.clientHeight ?? 1);
			}
			return event.deltaY;
		};
		const currentWheelOffset = (target: ToolContentScrollTarget | null) =>
			target
				? (toolContentScrollMapRef.current.get(target.scrollKey) ?? 0)
				: pixiScrollOffsetRef.current;
		const maxWheelOffset = (target: ToolContentScrollTarget | null) =>
			target ? target.maxScrollTop : viewportRef.current ? getMaxScrollTop(viewportRef.current) : 0;
		const setWheelOffset = (target: ToolContentScrollTarget | null, offset: number) => {
			if (target) {
				const previous = toolContentScrollMapRef.current.get(target.scrollKey) ?? 0;
				const next = clamp(offset, 0, target.maxScrollTop);
				if (Math.abs(next - previous) < 0.01) return false;
				toolContentScrollMapRef.current.set(target.scrollKey, next);
				renderPixiViewportRef.current();
				return true;
			}
			return scrollViewportBy(offset - pixiScrollOffsetRef.current, { renderNow: true });
		};
		momentumTick = (ticker: Ticker) => {
			const dt = Math.max(Number.EPSILON, ticker.elapsedMS);
			const deltaY = momentumVelocity * dt;
			if (!scrollViewportBy(deltaY, { renderNow: true })) {
				cancelTouchMomentum();
				return;
			}
			momentumVelocity *= Math.exp(-dt / TOUCH_MOMENTUM_TIME_CONSTANT_MS);
			if (Math.abs(momentumVelocity) < TOUCH_MOMENTUM_MIN_VELOCITY_PX_PER_MS) {
				cancelTouchMomentum();
			}
		};
		wheelSmoothingTick = (ticker: Ticker) => {
			const current = currentWheelOffset(wheelSmoothingTarget);
			const remaining = wheelSmoothingTargetOffset - current;
			if (Math.abs(remaining) <= WHEEL_SMOOTHING_EPSILON_PX) {
				setWheelOffset(wheelSmoothingTarget, wheelSmoothingTargetOffset);
				cancelWheelSmoothing();
				return;
			}
			const dt = Math.max(Number.EPSILON, ticker.elapsedMS);
			const step = remaining * (1 - Math.exp(-dt / WHEEL_SMOOTHING_TIME_CONSTANT_MS));
			if (!setWheelOffset(wheelSmoothingTarget, current + step)) {
				cancelWheelSmoothing();
			}
		};

		const startTouchMomentum = (velocity: number) => {
			cancelTouchMomentum();
			if (Math.abs(velocity) < TOUCH_MOMENTUM_MIN_VELOCITY_PX_PER_MS) {
				touchDrivingScrollRef.current = false;
				syncNativeScrollFromPixi();
				return;
			}
			touchDrivingScrollRef.current = true;
			const viewport = viewportRef.current;
			pixiScrollOffsetRef.current = viewport
				? clamp(pixiScrollOffsetRef.current, 0, getMaxScrollTop(viewport))
				: pixiScrollOffsetRef.current;
			momentumVelocity = velocity;
			if (!momentumTickerAttached && momentumTick) {
				app.ticker.add(momentumTick);
				momentumTickerAttached = true;
			}
			app.ticker.start();
		};
		const addWheelDelta = (deltaY: number, target: ToolContentScrollTarget | null) => {
			const sameTarget =
				hasActiveWheelSmoothing &&
				(target ? wheelSmoothingTarget?.id === target.id : wheelSmoothingTarget === null);
			const currentOffset = currentWheelOffset(target);
			const maxOffset = maxWheelOffset(target);
			const activeTargetOffset = sameTarget
				? clamp(wheelSmoothingTargetOffset, 0, maxOffset)
				: currentOffset;
			// When the native viewport or content height changes while smoothing is still
			// active, the old target can end up far above/below the new valid range. Anchor
			// new wheel input to the visible offset in that case; otherwise a small delta can
			// resurrect a stale target and look like a huge opposite-direction impulse.
			const targetIsStale =
				sameTarget && Math.abs(activeTargetOffset - currentOffset) > Math.abs(deltaY) * 4;
			const baseOffset = targetIsStale ? currentOffset : activeTargetOffset;
			const nextTargetOffset = clamp(baseOffset + deltaY, 0, maxOffset);
			if (Math.abs(nextTargetOffset - currentOffset) <= WHEEL_SMOOTHING_EPSILON_PX) return false;
			hasActiveWheelSmoothing = true;
			wheelSmoothingTarget = target;
			wheelSmoothingTargetOffset = nextTargetOffset;
			if (!wheelSmoothingTickerAttached && wheelSmoothingTick) {
				app.ticker.add(wheelSmoothingTick);
				wheelSmoothingTickerAttached = true;
			}
			app.ticker.start();
			return true;
		};
		const handlePointerMove = (event: PointerEvent) => {
			const canvas = event.currentTarget as HTMLCanvasElement;
			if (touchScrollState?.pointerId === event.pointerId) {
				event.stopPropagation();
				const now = event.timeStamp || performance.now();
				const dx = touchScrollState.startX - event.clientX;
				const dy = event.clientY - touchScrollState.startY;
				const absDx = Math.abs(dx);
				const absDy = Math.abs(dy);
				if (!touchScrollState.direction && Math.max(absDx, absDy) >= SWIPE_DIRECTION_THRESHOLD) {
					touchScrollState.direction =
						touchScrollState.swipeTarget && absDx > absDy ? "horizontal" : "vertical";
					touchScrollState.moved = true;
					clearHoveredTarget(canvas);
				}
				const deltaY = touchScrollState.lastY - event.clientY;
				const dt = Math.max(1, now - touchScrollState.lastTime);
				touchScrollState.lastY = event.clientY;
				touchScrollState.lastTime = now;
				if (touchScrollState.direction === "horizontal" && touchScrollState.swipeTarget) {
					event.preventDefault();
					const offset = clamp(dx, 0, SWIPE_REVEAL_WIDTH);
					touchScrollState.swipeOffset = offset;
					swipedMessageRef.current = { targetId: touchScrollState.swipeTarget.id, offset };
					if (touchScrollState.rangeCandidate) {
						renderPixiViewportRef.current();
						return;
					}
					const swipeGeometry = touchScrollState.swipeGeometry;
					if (!swipeGeometry) return;
					const position = swipePositionForGeometry(swipeGeometry, offset);
					openPixiMessageMenu({
						x: position.x,
						y: position.y,
						mode: "swipe",
						offset,
						dragging: true,
						swipeGeometry,
						target: touchScrollState.swipeTarget,
					});
					renderPixiViewportRef.current();
					return;
				}
				if (touchScrollState.direction === "vertical") {
					event.preventDefault();
					const scrolledToolContent =
						!outerScrollInProgressRef.current && touchScrollState.scrollTarget
							? scrollToolContentBy(touchScrollState.scrollTarget, deltaY)
							: false;
					if (!scrolledToolContent) {
						const instantVelocity = deltaY / dt;
						touchScrollState.velocity =
							touchScrollState.velocity === 0
								? instantVelocity
								: touchScrollState.velocity * 0.6 + instantVelocity * 0.4;
						scrollViewportBy(deltaY, { renderNow: true });
					} else {
						touchScrollState.velocity = 0;
					}
				}
				return;
			}
			if (event.pointerType === "touch") return;
			const target = hitTargetAtEvent(event);
			const nextId = target?.kind === "tool-content-scroll" ? null : (target?.id ?? null);
			if (hoveredHitTargetIdRef.current !== nextId) {
				hoveredHitTargetIdRef.current = nextId;
				setHoveredHitTargetId(nextId);
			}
			canvas.style.cursor = target && target.kind !== "tool-content-scroll" ? "pointer" : "default";
		};
		const handlePointerLeave = (event: PointerEvent) => {
			if (touchScrollState?.pointerId === event.pointerId) return;
			clearHoveredTarget(event.currentTarget as HTMLCanvasElement);
		};
		const handlePointerDown = (event: PointerEvent) => {
			const canvas = event.currentTarget as HTMLCanvasElement;
			const target = hitTargetAtEvent(event);
			const menuTarget = messageMenuTargetAtEvent(event);
			const scrollTarget = toolContentScrollTargetAtEvent(event);
			if (event.pointerType === "touch") {
				cancelTouchMomentum();
				cancelWheelSmoothing();
				touchDrivingScrollRef.current = true;
				const currentClose = getGlobalCloseSwipe();
				const currentAnchor = getGlobalSwipeAnchor();
				const rangeCandidate = !!(
					currentClose &&
					menuTarget?.blockId &&
					currentAnchor &&
					currentAnchor !== menuTarget.blockId
				);
				const now = event.timeStamp || performance.now();
				const point = eventLocalPoint(event);
				const swipeGeometry = menuTarget ? swipeGeometryForTarget(menuTarget, point.rect) : null;
				touchScrollState = {
					moved: false,
					pointerId: event.pointerId,
					startX: event.clientX,
					startY: event.clientY,
					lastY: event.clientY,
					lastTime: now,
					direction: null,
					rangeCandidate,
					target,
					scrollTarget,
					swipeTarget: menuTarget,
					swipeOffset: 0,
					swipeGeometry,
					velocity: 0,
				};
				canvas.setPointerCapture?.(event.pointerId);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			const isModKey = event.metaKey || event.ctrlKey;
			const isShift = event.shiftKey;
			if ((isModKey || isShift) && menuTarget) {
				event.preventDefault();
				event.stopPropagation();
				if (isShift) selectionRef.current.rangeSelectTo(menuTarget.blockId);
				else selectionRef.current.toggleBlock(menuTarget.blockId);
				return;
			}
			if (!target) {
				closePixiMessageMenu();
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			triggerHitTarget(target);
		};
		const handlePointerUp = (event: PointerEvent) => {
			if (touchScrollState?.pointerId !== event.pointerId) return;
			const state = touchScrollState;
			touchScrollState = null;
			const canvas = event.currentTarget as HTMLCanvasElement;
			if (canvas.hasPointerCapture?.(event.pointerId))
				canvas.releasePointerCapture(event.pointerId);
			event.preventDefault();
			event.stopPropagation();
			if (state.direction === "horizontal" && state.swipeTarget) {
				touchDrivingScrollRef.current = false;
				syncNativeScrollFromPixi();
				const finalOffset = state.swipeOffset >= SWIPE_THRESHOLD ? SWIPE_REVEAL_WIDTH : 0;
				if (state.rangeCandidate) {
					if (finalOffset > 0) {
						const anchor = getGlobalSwipeAnchor();
						if (anchor) getGlobalOnSelectionRange()?.(anchor, state.swipeTarget.blockId);
						getGlobalCloseSwipe()?.();
					} else {
						swipedMessageRef.current = null;
						renderPixiViewportRef.current();
					}
					return;
				}
				const toggleFn = getGlobalToggleBlock();
				if (toggleFn && finalOffset > 0) {
					toggleFn(state.swipeTarget.blockId);
					swipedMessageRef.current = null;
					renderPixiViewportRef.current();
					return;
				}
				if (finalOffset === 0) {
					closePixiMessageMenu();
				} else if (state.swipeGeometry) {
					swipedMessageRef.current = { targetId: state.swipeTarget.id, offset: finalOffset };
					const position = swipePositionForGeometry(state.swipeGeometry, finalOffset);
					openPixiMessageMenu({
						x: position.x,
						y: position.y,
						mode: "swipe",
						offset: finalOffset,
						dragging: false,
						swipeGeometry: state.swipeGeometry,
						target: state.swipeTarget,
					});
					renderPixiViewportRef.current();
				}
				return;
			}
			if (!state.moved && state.target) {
				touchDrivingScrollRef.current = false;
				syncNativeScrollFromPixi();
				triggerHitTarget(state.target);
			} else if (state.moved) startTouchMomentum(state.velocity);
		};
		const handlePointerCancel = (event: PointerEvent) => {
			if (touchScrollState?.pointerId !== event.pointerId) return;
			touchScrollState = null;
			touchDrivingScrollRef.current = false;
			closePixiMessageMenu();
			syncNativeScrollFromPixi();
			const canvas = event.currentTarget as HTMLCanvasElement;
			if (canvas.hasPointerCapture?.(event.pointerId))
				canvas.releasePointerCapture(event.pointerId);
			event.stopPropagation();
		};
		const handleContextMenu = (event: MouseEvent) => {
			const target = messageMenuTargetAtEvent(event);
			if (!target) return;
			event.preventDefault();
			event.stopPropagation();
			openPixiMessageMenu({
				x: Math.min(event.clientX, window.innerWidth - 200),
				y: event.clientY,
				mode: "context",
				offset: 0,
				target,
			});
		};
		const handleWheel = (event: WheelEvent) => {
			closePixiMessageMenu();
			cancelTouchMomentum();
			touchDrivingScrollRef.current = true;
			event.preventDefault();
			const deltaY = normalizeWheelDeltaY(event);
			const toolScrollTarget = toolContentScrollTargetAtEvent(event);
			const innerTarget =
				toolScrollTarget && !outerScrollInProgressRef.current ? toolScrollTarget : null;
			if (!innerTarget || !addWheelDelta(deltaY, innerTarget)) {
				addWheelDelta(deltaY, null);
			}
			touchDrivingScrollRef.current = false;
		};
		let destroyed = false;
		app
			.init({
				width: 1,
				height: 1,
				backgroundAlpha: 0,
				antialias: false,
				autoDensity: true,
				resolution: window.devicePixelRatio || 1,
				roundPixels: true,
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
				pixiDestroyedRef.current = false;
				const canvas = app.canvas as HTMLCanvasElement;
				canvas.style.position = "absolute";
				canvas.style.inset = "0";
				canvas.style.width = "100%";
				canvas.style.height = "100%";
				canvas.style.imageRendering = "pixelated";
				canvas.style.pointerEvents = "auto";
				canvas.style.touchAction = "none";
				canvas.addEventListener("webglcontextlost", handleContextLost);
				canvas.addEventListener("webglcontextrestored", handleContextRestored);
				canvas.addEventListener("pointermove", handlePointerMove, { passive: false });
				canvas.addEventListener("pointerleave", handlePointerLeave);
				canvas.addEventListener("pointerdown", handlePointerDown, { passive: false });
				canvas.addEventListener("pointerup", handlePointerUp, { passive: false });
				canvas.addEventListener("pointercancel", handlePointerCancel);
				canvas.addEventListener("contextmenu", handleContextMenu);
				canvas.addEventListener("wheel", handleWheel, { passive: false });
				host.appendChild(canvas);
				const container = new Container();
				const imageContainer = new Container();
				const gfx = new Graphics({ roundPixels: true });
				app.stage.addChild(gfx);
				app.stage.addChild(imageContainer);
				app.stage.addChild(container);
				stageContainerRef.current = container;
				imageContainerRef.current = imageContainer;
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
			cancelTouchMomentum();
			cancelWheelSmoothing();
			pixiDestroyedRef.current = true;
			const app = appRef.current;
			appRef.current = null;
			stageContainerRef.current = null;
			imageContainerRef.current = null;
			gfxRef.current = null;
			textPoolRef.current = null;
			iconPoolRef.current = null;
			imagePoolRef.current = null;
			lastRendererSizeRef.current = { width: 0, height: 0, dpr: 0 };
			if (app) {
				const canvas = app.canvas as HTMLCanvasElement;
				canvas.removeEventListener("webglcontextlost", handleContextLost);
				canvas.removeEventListener("webglcontextrestored", handleContextRestored);
				canvas.removeEventListener("pointermove", handlePointerMove);
				canvas.removeEventListener("pointerleave", handlePointerLeave);
				canvas.removeEventListener("pointerdown", handlePointerDown);
				canvas.removeEventListener("pointerup", handlePointerUp);
				canvas.removeEventListener("pointercancel", handlePointerCancel);
				canvas.removeEventListener("contextmenu", handleContextMenu);
				canvas.removeEventListener("wheel", handleWheel);
				destroyPixiApplication(app);
			}
		};
		// init once; resize is handled below
	}, [closePixiMessageMenu, openPixiMessageMenu, toggleReasoning, toggleTool]);

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

	const renderMenuItems = useCallback(
		(target: MessageMenuTarget, close: () => void) => {
			const messageId = target.messageId;
			const blockIndex = target.blockIndex;
			const canUseBlock = !!messageId && blockIndex != null;
			const canCopyImage = !!target.imageSrc || (!!target.imageSavedPath && fsPreviewSupported);
			return (
				<>
					{canCopyImage && (
						<Menu.Item
							leftSection={<IconPhoto size={14} />}
							onClick={() => {
								void copyGeneratedImageToClipboard({
									imageSrc: target.imageSrc,
									savedPath: fsPreviewSupported ? target.imageSavedPath : null,
								})
									.then(() => notifications.show({ color: "teal", message: t("copyImageSuccess") }))
									.catch(() => notifications.show({ color: "red", message: t("copyImageFailed") }));
								close();
							}}
						>
							{t("contextMenu_copyImage")}
						</Menu.Item>
					)}
					<Menu.Item
						leftSection={<IconCopy size={14} />}
						onClick={() => {
							void navigator.clipboard?.writeText(target.copyText ?? "");
							close();
						}}
					>
						{t("contextMenu_copyBlock")}
					</Menu.Item>
					<Menu.Item
						leftSection={<IconArrowBackUp size={14} />}
						disabled={!canUseBlock || !onRollbackToBlock}
						onClick={() => {
							if (messageId && blockIndex != null) onRollbackToBlock?.(messageId, blockIndex);
							close();
						}}
					>
						{t("contextMenu_rollback")}
					</Menu.Item>
					<Menu.Item
						leftSection={<IconGitFork size={14} />}
						disabled={!target.messageUuid || !onForkFromMessage}
						onClick={() => {
							if (target.messageUuid) onForkFromMessage?.(target.messageUuid);
							close();
						}}
					>
						{t("contextMenu_fork")}
					</Menu.Item>
					<Menu.Item
						leftSection={<IconMessageQuestion size={14} />}
						disabled={!messageId || !onAskInPassing}
						onClick={() => {
							if (messageId) onAskInPassing?.(target.messageUuid ?? null, messageId);
							close();
						}}
					>
						{t("contextMenu_askInPassing")}
					</Menu.Item>
					<CompactMenuSub
						disabled={!messageId || !onCompactBeforeMessage}
						onCompact={messageId ? () => onCompactBeforeMessage?.(messageId) : undefined}
						onClearContext={messageId ? () => onClearContextBefore?.(messageId) : undefined}
						onManualSummarize={messageId ? () => onManualSummarize?.(messageId) : undefined}
						onClose={close}
					/>
					<Menu.Divider />
					<Menu.Item
						color="red"
						leftSection={<IconTrash size={14} />}
						disabled={!canUseBlock || !onDeleteBlock}
						onClick={() => {
							if (messageId && blockIndex != null) onDeleteBlock?.(messageId, blockIndex);
							close();
						}}
					>
						{t("contextMenu_delete")}
					</Menu.Item>
					<Menu.Item leftSection={<IconX size={14} />} onClick={close}>
						{tc("cancel")}
					</Menu.Item>
				</>
			);
		},
		[
			fsPreviewSupported,
			onAskInPassing,
			onCompactBeforeMessage,
			onClearContextBefore,
			onManualSummarize,
			onDeleteBlock,
			onForkFromMessage,
			onRollbackToBlock,
			t,
			tc,
		],
	);

	useLayoutEffect(() => {
		if (!messageMenu || messageMenu.mode !== "swipe") return;
		const menuHeight = messageMenuRef.current?.offsetHeight;
		if (!menuHeight) return;
		const position = computePixiSwipeMenuPosition(messageMenu, menuHeight);
		if (Math.abs(position.x - messageMenu.x) < 0.5 && Math.abs(position.y - messageMenu.y) < 0.5) {
			return;
		}
		setMessageMenu((current) =>
			current === messageMenu ? { ...current, x: position.x, y: position.y } : current,
		);
	}, [messageMenu]);

	const messageMenuPosition = messageMenu
		? messageMenu.mode === "swipe"
			? computePixiSwipeMenuPosition(messageMenu, messageMenuRef.current?.offsetHeight)
			: { x: messageMenu.x, y: messageMenu.y }
		: null;

	const resolveCurrentSwipeGeometry = useCallback((geometry: PixiSwipeGeometry) => {
		const viewport = viewportRef.current;
		const canvasHost = canvasHostRef.current;
		let visibleTop = 0;
		let visibleBottom = window.innerHeight;
		if (viewport) {
			const viewportRect = viewport.getBoundingClientRect();
			visibleTop = Math.max(visibleTop, viewportRect.top);
			visibleBottom = Math.min(visibleBottom, viewportRect.bottom);
		}
		const canvasRect = canvasHost?.getBoundingClientRect();
		const canvasTop = canvasRect?.top ?? 0;
		const scrollTop = pixiScrollOffsetRef.current;
		return {
			...geometry,
			targetTop: canvasTop + geometry.targetLayoutTop - scrollTop,
			targetBottom: canvasTop + geometry.targetLayoutBottom - scrollTop,
			visibleTop,
			visibleBottom,
		};
	}, []);

	const updateOpenSwipeMenuPosition = useCallback(() => {
		setMessageMenu((current) => {
			if (!current || current.mode !== "swipe" || !current.swipeGeometry) return current;
			const swipeGeometry = resolveCurrentSwipeGeometry(current.swipeGeometry);
			const offscreen =
				swipeGeometry.targetBottom < swipeGeometry.visibleTop
					? "top"
					: swipeGeometry.targetTop > swipeGeometry.visibleBottom
						? "bottom"
						: null;
			const position = computePixiSwipeMenuPosition(
				{ ...current, swipeGeometry },
				messageMenuRef.current?.offsetHeight,
			);
			if (swipedMessageRef.current) {
				swipedMessageRef.current = { ...swipedMessageRef.current, offscreen };
			}
			return { ...current, ...position, offscreen, swipeGeometry };
		});
	}, [resolveCurrentSwipeGeometry]);

	useEffect(() => {
		if (!messageMenu || messageMenu.mode !== "swipe") return;
		const viewport = viewportRef.current;
		let rafId = 0;
		const scheduleUpdate = () => {
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				updateOpenSwipeMenuPosition();
			});
		};
		viewport?.addEventListener("scroll", scheduleUpdate, { passive: true });
		window.addEventListener("resize", scheduleUpdate, { passive: true });
		return () => {
			cancelAnimationFrame(rafId);
			viewport?.removeEventListener("scroll", scheduleUpdate);
			window.removeEventListener("resize", scheduleUpdate);
		};
	}, [messageMenu, updateOpenSwipeMenuPosition]);

	const swipeAnchorPreview =
		messageMenu?.mode === "swipe" && messageMenu.offscreen && messageMenu.swipeGeometry
			? {
					direction: messageMenu.offscreen,
					previewText:
						(messageMenu.target.copyText ?? "").slice(0, 120).replace(/\s+/g, " ").trim() ||
						messageMenu.target.messageId ||
						"…",
					geometry: messageMenu.swipeGeometry,
				}
			: null;

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
				return pixiScrollOffsetRef.current;
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
				isolation: "isolate",
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
						position: "relative",
						width: Math.max(1, size.width),
					}}
				>
					{selectionMarkers.map((marker) => (
						<div
							key={marker.blockId}
							{...{ [BLOCK_ID_ATTR]: marker.blockId }}
							{...(marker.messageId ? { "data-message-id": marker.messageId } : {})}
							{...(marker.blockIndex != null
								? { "data-block-index": String(marker.blockIndex) }
								: {})}
							style={{
								color: "transparent",
								height: marker.height,
								left: marker.x,
								overflow: "hidden",
								position: "absolute",
								top: marker.y,
								whiteSpace: "pre-wrap",
								width: marker.width,
							}}
						>
							{marker.text}
						</div>
					))}
				</div>
			</div>
			<div
				ref={canvasHostRef}
				style={{
					height: size.height || "100%",
					left: 0,
					pointerEvents: "auto",
					position: "absolute",
					top: 0,
					width: size.width || "100%",
					zIndex: 0,
				}}
			/>
			<div
				style={{
					background: "rgba(0, 0, 0, 0.65)",
					border: "1px solid rgba(255, 255, 255, 0.18)",
					borderRadius: 4,
					color: "#d7fdd7",
					fontFamily: "monospace",
					fontSize: 11,
					left: 6,
					lineHeight: 1.3,
					padding: "2px 5px",
					pointerEvents: "none",
					position: "absolute",
					top: 6,
					zIndex: 2,
				}}
			>
				{fpsText}
			</div>
			{swipeAnchorPreview && (
				<Box
					style={{
						...(swipeAnchorPreview.direction === "top" ? { top: 0 } : { bottom: 0 }),
						cursor: "pointer",
						left: 0,
						maxHeight: 72,
						overflow: "hidden",
						pointerEvents: "auto",
						position: "absolute",
						right: 0,
						zIndex: 2,
						maskImage:
							swipeAnchorPreview.direction === "top"
								? "linear-gradient(to bottom, black 40%, transparent 100%)"
								: "linear-gradient(to top, black 40%, transparent 100%)",
						WebkitMaskImage:
							swipeAnchorPreview.direction === "top"
								? "linear-gradient(to bottom, black 40%, transparent 100%)"
								: "linear-gradient(to top, black 40%, transparent 100%)",
					}}
					onClick={() => {
						const geometry = swipeAnchorPreview.geometry;
						const blockCenter = (geometry.targetLayoutTop + geometry.targetLayoutBottom) / 2;
						setNativeScrollTop(blockCenter - (viewportRef.current?.clientHeight ?? 0) / 2, {
							behavior: "smooth",
						});
					}}
				>
					<Box
						style={{
							background: "rgba(20, 21, 28, 0.72)",
							border: "1px solid rgba(255, 255, 255, 0.14)",
							borderRadius: 8,
							color: "var(--mantine-color-dimmed)",
							fontSize: 12,
							lineHeight: 1.45,
							margin: "0 var(--mantine-spacing-md)",
							opacity: 0.72,
							padding: "8px 10px",
							transform: `translateX(-${messageMenu?.offset ?? 0}px)`,
						}}
					>
						{swipeAnchorPreview.previewText}
					</Box>
				</Box>
			)}
			{messageMenu &&
				messageMenuPosition &&
				createPortal(
					<Box
						ref={messageMenuRef}
						style={{
							left: messageMenuPosition.x,
							pointerEvents: messageMenu.closing ? "none" : "auto",
							position: "fixed",
							top: messageMenuPosition.y,
							transform: messageMenu.mode === "swipe" ? "translateY(-50%)" : undefined,
							transition: messageMenu.dragging ? "none" : "left 200ms ease, transform 200ms ease",
							zIndex: Z.popover,
						}}
					>
						{messageMenu.mode === "swipe" ? (
							<Menu opened withinPortal={false} position="bottom-start" shadow="md">
								<Menu.Dropdown style={{ position: "relative", width: SWIPE_REVEAL_WIDTH }}>
									{renderMenuItems(messageMenu.target, () => closePixiMessageMenu())}
								</Menu.Dropdown>
							</Menu>
						) : (
							<Menu opened withinPortal={false} onClose={() => closePixiMessageMenu()} shadow="md">
								<Menu.Target>
									<Box w={1} h={1} />
								</Menu.Target>
								<Menu.Dropdown w={190}>
									{renderMenuItems(messageMenu.target, () => closePixiMessageMenu())}
								</Menu.Dropdown>
							</Menu>
						)}
					</Box>,
					document.body,
				)}
		</div>
	);
});
