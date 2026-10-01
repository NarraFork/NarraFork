import { ActionIcon, Box, Group, Menu, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconDotsVertical } from "@tabler/icons-react";
import {
	createContext,
	Fragment,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useInputMenu } from "../../../hooks/useInputMenu";
import { getNarratorStatusInlineStyle } from "../../../lib/safe-area";

const DEFAULT_GAP_PX = 4;
/**
 * Layout budget for the overflow button. It must stay in sync with the button's
 * rendered `size="sm"` box (--ai-size-sm = 1.375rem = 22px) so reserving space
 * never disagrees with what is painted.
 */
const MORE_BUTTON_WIDTH_PX = 22;
/**
 * Locks the status row height so toggling the overflow button or moving the
 * terminal action (whose badge reserves 5px of block padding) can never change
 * the row's height. 28px covers the tallest inline control plus its reserve.
 */
export const NARRATOR_STATUS_ROW_MIN_HEIGHT_PX = 28;
/**
 * Space kept for the leading status dot / label / elapsed time. Those controls
 * truncate, so the toolbar may claim everything else on the row.
 */
export const NARRATOR_STATUS_RESERVED_TEXT_WIDTH_PX = 96;
/**
 * Extra width required before a collapsed action returns inline. Without it,
 * sub-pixel measurements, scrollbar changes and font swaps flip the decision
 * back and forth around the exact threshold.
 */
const RESTORE_HYSTERESIS_PX = 8;

export interface NarratorStatusToolbarVisualOverflow {
	/**
	 * Reserve space for absolutely positioned badges. Prefer the inline axis.
	 *
	 * A one-sided block reserve is almost always wrong here: each wrapper is a
	 * centre-aligned flex item, so padding on a single side moves that control off
	 * the row's shared centre line and it reads as "this button sits lower than
	 * its neighbours". A symmetric reserve keeps the centre but grows the row past
	 * NARRATOR_STATUS_ROW_MIN_HEIGHT_PX. Badges painted inside a control that
	 * clips its own overflow (ActionIcon does) cannot be rescued by either.
	 */
	blockStart?: number;
	blockEnd?: number;
	inlineStart?: number;
	inlineEnd?: number;
}

export interface NarratorStatusToolbarAction {
	key: string;
	/** Lower values move into the overflow menu first. */
	collapsePriority: number;
	/** Reserve space for absolutely positioned badges outside the control's own box. */
	visualOverflow?: NarratorStatusToolbarVisualOverflow;
	render: (mode: "inline" | "menu") => ReactNode;
}

export interface ToolbarWidthAction {
	key: string;
	width: number;
	collapsePriority: number;
}

interface ResolveToolbarOverflowOptions {
	/**
	 * Width available to the toolbar, derived from the status row rather than
	 * from the toolbar's own content. A budget that shrinks as actions collapse
	 * would make the result depend on itself and cascade to a single button.
	 */
	budgetWidth: number;
	leadingWidth: number;
	actions: readonly ToolbarWidthAction[];
	/** Current decision, used to apply restore hysteresis. */
	previousHiddenKeys?: readonly string[];
	gap?: number;
	moreButtonWidth?: number;
	restoreHysteresis?: number;
}

function requiredToolbarWidth(
	leadingWidth: number,
	visibleActions: readonly ToolbarWidthAction[],
	showMore: boolean,
	gap: number,
	moreButtonWidth: number,
): number {
	const itemCount = 1 + visibleActions.length + (showMore ? 1 : 0);
	return (
		leadingWidth +
		visibleActions.reduce((total, action) => total + action.width, 0) +
		Math.max(0, itemCount - 1) * gap +
		(showMore ? moreButtonWidth : 0)
	);
}

/**
 * Evaluate every candidate layout (keep all actions, keep all but the
 * lowest-priority one, and so on) against a fixed budget and take the first one
 * that fits. Scanning candidates instead of greedily hiding one action at a
 * time keeps the result a pure function of the budget, so the same width always
 * produces the same layout and widening deterministically restores actions.
 */
export function resolveNarratorStatusToolbarOverflow({
	budgetWidth,
	leadingWidth,
	actions,
	previousHiddenKeys,
	gap = DEFAULT_GAP_PX,
	moreButtonWidth = MORE_BUTTON_WIDTH_PX,
	restoreHysteresis = RESTORE_HYSTERESIS_PX,
}: ResolveToolbarOverflowOptions): string[] {
	if (actions.length === 0) return [];

	// Highest priority survives longest, so drop from the end of this list.
	const byPriority = [...actions].sort(
		(a, b) => a.collapsePriority - b.collapsePriority || a.key.localeCompare(b.key),
	);
	const previousHiddenCount = previousHiddenKeys?.length ?? 0;

	for (let keepCount = actions.length; keepCount > 0; keepCount--) {
		const hidden = new Set(byPriority.slice(0, actions.length - keepCount).map((a) => a.key));
		const visibleActions = actions.filter((action) => !hidden.has(action.key));
		const showMore = hidden.size > 0;
		const need = requiredToolbarWidth(leadingWidth, visibleActions, showMore, gap, moreButtonWidth);
		// Restoring an action (fewer hidden than before) must clear the budget by
		// the hysteresis margin; collapsing further only needs to fit.
		const margin = hidden.size < previousHiddenCount ? restoreHysteresis : 0;
		if (need + margin <= budgetWidth) {
			return actions.filter((action) => hidden.has(action.key)).map((action) => action.key);
		}
	}

	return actions.map((action) => action.key);
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

function computedStyleOf(element: HTMLElement): CSSStyleDeclaration | null {
	if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return null;
	try {
		return window.getComputedStyle(element);
	} catch {
		return null;
	}
}

function paddingInlineOf(element: HTMLElement): number {
	const styles = computedStyleOf(element);
	return (
		(Number.parseFloat(styles?.paddingLeft ?? "") || 0) +
		(Number.parseFloat(styles?.paddingRight ?? "") || 0)
	);
}

function contentWidthOf(element: HTMLElement): number {
	const width = element.getBoundingClientRect().width;
	if (width <= 0) return 0;
	// The status row carries safe-area padding when it owns the horizontal
	// insets, so the usable width is the content box, not the border box.
	return Math.max(0, width - paddingInlineOf(element));
}

function inlineGapOf(element: HTMLElement): number {
	const styles = computedStyleOf(element);
	return Number.parseFloat(styles?.columnGap ?? "") || 0;
}

/**
 * A flex item that grows absorbs whatever space the toolbar does not use, so
 * its measured width is a function of the toolbar's own layout. Such siblings
 * must be budgeted by policy, never by measurement.
 */
function growsToFill(element: HTMLElement): boolean {
	const computedGrow = Number.parseFloat(computedStyleOf(element)?.flexGrow ?? "");
	if (Number.isFinite(computedGrow) && computedGrow > 0) return true;
	const inlineGrow = Number.parseFloat(element.style.flexGrow || "");
	if (Number.isFinite(inlineGrow) && inlineGrow > 0) return true;
	// React writes `flex: 1` as the shorthand; its first component is flex-grow.
	const shorthandGrow = Number.parseFloat(element.style.flex || "");
	return Number.isFinite(shorthandGrow) && shorthandGrow > 0;
}

const MAX_BUDGET_WALK_DEPTH = 6;

/**
 * Space the toolbar may occupy: the status row's content width, less a reserved
 * minimum for the growing status text and less every measured sibling between
 * the toolbar and the row (context ring, quota, viewers, and so on).
 *
 * None of those inputs depend on which actions are currently inline, so the
 * resulting budget is stable and the overflow decision has a fixed point.
 */
export function resolveNarratorStatusToolbarBudget(
	container: HTMLElement,
	row: HTMLElement,
	reservedTextWidth: number,
): number {
	if (row !== container && !row.contains(container)) return 0;
	let budget = contentWidthOf(row);
	if (budget <= 0) return 0;

	let reservedForGrowing = 0;
	let node: HTMLElement = container;
	for (let depth = 0; depth < MAX_BUDGET_WALK_DEPTH && node !== row; depth++) {
		const parent = node.parentElement;
		if (!parent) break;
		const gap = inlineGapOf(parent);
		for (const child of parent.children) {
			if (child === node) continue;
			const sibling = child as HTMLElement;
			if (typeof sibling.getBoundingClientRect !== "function") continue;
			const width = sibling.getBoundingClientRect().width;
			// Zero width means a media query or conditional render removed it.
			if (width <= 0) continue;
			if (growsToFill(sibling))
				reservedForGrowing = Math.max(reservedForGrowing, reservedTextWidth);
			else budget -= width;
			budget -= gap;
		}
		if (parent !== row) budget -= paddingInlineOf(parent);
		node = parent;
	}

	return Math.max(0, budget - reservedForGrowing);
}

/**
 * Lets the toolbar read its width budget from the whole status row. The row
 * width is independent of which actions are currently inline, which is what
 * makes the overflow decision a stable fixed point.
 */
const NarratorStatusRowContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function NarratorStatusBar({
	children,
	ownsHorizontalSafeArea = false,
	borderTop,
}: {
	children: ReactNode;
	ownsHorizontalSafeArea?: boolean;
	borderTop?: string;
}) {
	const rowRef = useRef<HTMLDivElement>(null);

	return (
		<Box
			data-testid="narrator-status-bar"
			px="md"
			pt="xs"
			pb="xs"
			style={{ boxSizing: "border-box", width: "100%", borderTop, flexShrink: 0 }}
		>
			<Group
				ref={rowRef}
				data-testid="narrator-status-bar-content"
				gap="xs"
				justify="space-between"
				wrap="nowrap"
				style={{
					...getNarratorStatusInlineStyle(ownsHorizontalSafeArea),
					minHeight: NARRATOR_STATUS_ROW_MIN_HEIGHT_PX,
				}}
			>
				<NarratorStatusRowContext.Provider value={rowRef}>
					{children}
				</NarratorStatusRowContext.Provider>
			</Group>
		</Box>
	);
}

/** Reuses the toolbar's live count without starting another task-list subscription. */
export function BackgroundTasksStatusButton({
	runningCount,
	onOpen,
}: {
	runningCount: number;
	onOpen: () => void;
}) {
	const { t } = useTranslation("narrator");
	if (runningCount <= 0) return null;

	const label = t("backgroundTasks.activeCount", { count: runningCount });
	return (
		<Tooltip label={t("backgroundTasks.openPanel")} withinPortal>
			<UnstyledButton
				type="button"
				onClick={onOpen}
				aria-label={label}
				style={{ flexShrink: 0, whiteSpace: "nowrap" }}
			>
				<Text component="span" size="xs" c="blue">
					<span aria-hidden="true">· </span>
					{label}
				</Text>
			</UnstyledButton>
		</Tooltip>
	);
}

export function NarratorStatusToolbar({
	leading,
	actions,
	moreLabel,
	measurementKey,
	reservedTextWidth = NARRATOR_STATUS_RESERVED_TEXT_WIDTH_PX,
}: {
	leading: ReactNode;
	actions: readonly NarratorStatusToolbarAction[];
	moreLabel: string;
	measurementKey: string;
	reservedTextWidth?: number;
}) {
	const inputMenu = useInputMenu();
	const rowRef = useContext(NarratorStatusRowContext);
	const containerRef = useRef<HTMLDivElement>(null);
	const leadingRef = useRef<HTMLDivElement>(null);
	const actionRefs = useRef(new Map<string, HTMLDivElement>());
	const widthCache = useRef(new Map<string, number>());
	const cacheKeyRef = useRef<string | null>(null);
	const hiddenKeysRef = useRef<readonly string[]>([]);
	const frameRef = useRef<number | null>(null);
	const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);

	// Callers rebuild the action array on every render, so derive the
	// measurement identity from the keys and priorities rather than from array
	// identity. Otherwise every parent render would restart the measurement.
	const actionSignature = actions
		.map((action) => `${action.key}\u0002${action.collapsePriority}`)
		.join("\u0000");
	const actionMetrics = useMemo(
		() =>
			actionSignature.length === 0
				? []
				: actionSignature.split("\u0000").map((entry) => {
						const [key, priority] = entry.split("\u0002");
						return { key: key as string, collapsePriority: Number(priority) };
					}),
		[actionSignature],
	);
	// Cached widths are only valid while the controls keep their rendered size
	// and the action set is unchanged.
	const cacheKey = `${measurementKey}\u0001${actionSignature}`;

	const measureAndResolve = useCallback(
		(currentHiddenKeys: readonly string[]) => {
			const container = containerRef.current;
			const leadingElement = leadingRef.current;
			if (!container || !leadingElement) return;

			if (cacheKeyRef.current !== cacheKey) {
				cacheKeyRef.current = cacheKey;
				widthCache.current.clear();
			}

			// Budget comes from the status row (falling back to the toolbar's parent
			// when rendered outside NarratorStatusBar) so it never depends on how
			// many actions are currently inline.
			const budgetSource = rowRef?.current ?? container.parentElement;
			const budgetWidth = budgetSource
				? resolveNarratorStatusToolbarBudget(container, budgetSource, reservedTextWidth)
				: 0;
			const leadingWidth = leadingElement.getBoundingClientRect().width;
			if (budgetWidth <= 0 || leadingWidth <= 0) return;

			for (const [key, element] of actionRefs.current) {
				const width = element.getBoundingClientRect().width;
				if (width > 0) widthCache.current.set(key, width);
			}

			// A cache miss means the action is not currently laid out inline. Render
			// everything inline for one pass so it can be measured, instead of
			// abandoning the calculation and leaving a stale decision behind.
			const measuredActions: ToolbarWidthAction[] = [];
			let missingWidth = false;
			for (const action of actionMetrics) {
				const width = widthCache.current.get(action.key);
				if (!width) {
					missingWidth = true;
					continue;
				}
				measuredActions.push({
					key: action.key,
					width,
					collapsePriority: action.collapsePriority,
				});
			}
			if (missingWidth) {
				if (currentHiddenKeys.length > 0) setHiddenKeys([]);
				return;
			}

			const nextHiddenKeys = resolveNarratorStatusToolbarOverflow({
				budgetWidth,
				leadingWidth,
				actions: measuredActions,
				previousHiddenKeys: currentHiddenKeys,
			});
			if (!sameKeys(currentHiddenKeys, nextHiddenKeys)) setHiddenKeys(nextHiddenKeys);
		},
		[actionMetrics, cacheKey, reservedTextWidth, rowRef],
	);

	/**
	 * Coalesce every trigger into a single frame. ResizeObserver fires while the
	 * DOM is still settling, and measuring per notification would resolve
	 * against half-applied layouts.
	 */
	const scheduleMeasure = useCallback(() => {
		if (frameRef.current != null) return;
		if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
			measureAndResolve(hiddenKeysRef.current);
			return;
		}
		frameRef.current = window.requestAnimationFrame(() => {
			frameRef.current = null;
			measureAndResolve(hiddenKeysRef.current);
		});
	}, [measureAndResolve]);

	useEffect(
		() => () => {
			if (frameRef.current != null && typeof window !== "undefined") {
				window.cancelAnimationFrame(frameRef.current);
				frameRef.current = null;
			}
		},
		[],
	);

	// Re-measure whenever a new layout is committed. Layout effects flush before
	// paint, so a reset pass never shows an expanded frame.
	useLayoutEffect(() => {
		hiddenKeysRef.current = hiddenKeys;
		measureAndResolve(hiddenKeys);
	}, [measureAndResolve, hiddenKeys]);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// Observe only elements this component does not add or remove. Watching
		// the action wrappers would feed the resolver's own output back in.
		const observer =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
		observer?.observe(container);
		if (leadingRef.current) observer?.observe(leadingRef.current);
		if (rowRef?.current) observer?.observe(rowRef.current);
		else if (container.parentElement) observer?.observe(container.parentElement);
		window.addEventListener("resize", scheduleMeasure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", scheduleMeasure);
		};
	}, [rowRef, scheduleMeasure]);

	const hiddenKeySet = new Set(hiddenKeys);
	const overflowActions = actions.filter((action) => hiddenKeySet.has(action.key));

	return (
		<Group
			ref={containerRef}
			data-testid="narrator-status-toolbar"
			gap={DEFAULT_GAP_PX}
			wrap="nowrap"
			justify="flex-end"
			style={{
				width: "100%",
				maxWidth: "100%",
				minWidth: 0,
				minHeight: NARRATOR_STATUS_ROW_MIN_HEIGHT_PX,
				overflow: "visible",
				flexShrink: 1,
			}}
		>
			<Group
				ref={leadingRef}
				data-toolbar-leading
				gap={DEFAULT_GAP_PX}
				wrap="nowrap"
				style={{ flexShrink: 0 }}
			>
				{leading}
			</Group>
			{actions.map((action) =>
				hiddenKeySet.has(action.key) ? null : (
					<div
						key={action.key}
						ref={(element) => {
							if (element) actionRefs.current.set(action.key, element);
							else actionRefs.current.delete(action.key);
						}}
						data-toolbar-action={action.key}
						style={{
							display: "flex",
							alignItems: "center",
							flexShrink: 0,
							paddingBlockStart: action.visualOverflow?.blockStart,
							paddingBlockEnd: action.visualOverflow?.blockEnd,
							paddingInlineStart: action.visualOverflow?.inlineStart,
							paddingInlineEnd: action.visualOverflow?.inlineEnd,
						}}
					>
						{action.render("inline")}
					</div>
				),
			)}
			{overflowActions.length > 0 && (
				<Menu
					{...inputMenu.menuProps}
					position="top-end"
					withinPortal
					keepMounted
					transitionProps={{ duration: 0 }}
				>
					<Menu.Target>
						<Tooltip label={moreLabel}>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								aria-label={moreLabel}
								data-testid="narrator-status-more"
								{...inputMenu.targetProps}
								style={{ flexShrink: 0 }}
							>
								<IconDotsVertical size={16} />
							</ActionIcon>
						</Tooltip>
					</Menu.Target>
					<Menu.Dropdown style={{ overflowY: "auto" }}>
						{overflowActions.map((action) => (
							<Fragment key={action.key}>{action.render("menu")}</Fragment>
						))}
					</Menu.Dropdown>
				</Menu>
			)}
		</Group>
	);
}
