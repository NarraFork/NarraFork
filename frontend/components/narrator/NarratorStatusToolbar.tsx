import { ActionIcon, Box, Group, Menu, Tooltip } from "@mantine/core";
import { IconDotsVertical } from "@tabler/icons-react";
import {
	Fragment,
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { getNarratorStatusInlineStyle } from "../../lib/safe-area";

const DEFAULT_GAP_PX = 4;
const MORE_BUTTON_WIDTH_PX = 28;

export interface NarratorStatusToolbarVisualOverflow {
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
	availableWidth: number;
	leadingWidth: number;
	actions: readonly ToolbarWidthAction[];
	gap?: number;
	moreButtonWidth?: number;
}

function requiredToolbarWidth(
	leadingWidth: number,
	actions: readonly ToolbarWidthAction[],
	showMore: boolean,
	gap: number,
	moreButtonWidth: number,
): number {
	const itemCount = 1 + actions.length + (showMore ? 1 : 0);
	return (
		leadingWidth +
		actions.reduce((total, action) => total + action.width, 0) +
		Math.max(0, itemCount - 1) * gap +
		(showMore ? moreButtonWidth : 0)
	);
}

/**
 * Pick the lowest-priority actions until the remaining inline controls and the
 * permanently reserved more button fit. The calculation always starts from
 * all cached widths, so widening the toolbar restores actions deterministically.
 */
export function resolveNarratorStatusToolbarOverflow({
	availableWidth,
	leadingWidth,
	actions,
	gap = DEFAULT_GAP_PX,
	moreButtonWidth = MORE_BUTTON_WIDTH_PX,
}: ResolveToolbarOverflowOptions): string[] {
	if (requiredToolbarWidth(leadingWidth, actions, false, gap, moreButtonWidth) <= availableWidth) {
		return [];
	}

	const hidden = new Set<string>();
	const collapseOrder = [...actions].sort(
		(a, b) => a.collapsePriority - b.collapsePriority || a.key.localeCompare(b.key),
	);
	for (const action of collapseOrder) {
		hidden.add(action.key);
		const visibleActions = actions.filter((candidate) => !hidden.has(candidate.key));
		if (
			requiredToolbarWidth(leadingWidth, visibleActions, true, gap, moreButtonWidth) <=
			availableWidth
		) {
			break;
		}
	}

	return actions.filter((action) => hidden.has(action.key)).map((action) => action.key);
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function NarratorStatusBar({
	children,
	ownsHorizontalSafeArea = false,
	borderTop,
}: {
	children: ReactNode;
	ownsHorizontalSafeArea?: boolean;
	borderTop?: string;
}) {
	return (
		<Box
			data-testid="narrator-status-bar"
			px="md"
			pt="xs"
			pb="xs"
			style={{ boxSizing: "border-box", width: "100%", borderTop, flexShrink: 0 }}
		>
			<Group
				data-testid="narrator-status-bar-content"
				gap="xs"
				justify="space-between"
				wrap="nowrap"
				style={getNarratorStatusInlineStyle(ownsHorizontalSafeArea)}
			>
				{children}
			</Group>
		</Box>
	);
}

export function NarratorStatusToolbar({
	leading,
	actions,
	moreLabel,
	measurementKey,
}: {
	leading: ReactNode;
	actions: readonly NarratorStatusToolbarAction[];
	moreLabel: string;
	measurementKey: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const leadingRef = useRef<HTMLDivElement>(null);
	const actionRefs = useRef(new Map<string, HTMLDivElement>());
	const widthCache = useRef(new Map<string, number>());
	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
	const actionSignature = useMemo(
		() => actions.map((action) => action.key).join("\u0000"),
		[actions],
	);
	const resetKey = `${measurementKey}\u0001${actionSignature}`;
	const previousResetKey = useRef(resetKey);

	const measureAndResolve = useCallback(() => {
		const container = containerRef.current;
		const leadingElement = leadingRef.current;
		if (!container || !leadingElement) return;

		const availableWidth = container.getBoundingClientRect().width;
		const leadingWidth = leadingElement.getBoundingClientRect().width;
		if (availableWidth <= 0 || leadingWidth <= 0) return;

		for (const [key, element] of actionRefs.current) {
			const width = element.getBoundingClientRect().width;
			if (width > 0) widthCache.current.set(key, width);
		}

		const measuredActions: ToolbarWidthAction[] = [];
		for (const action of actionsRef.current) {
			const width = widthCache.current.get(action.key);
			if (!width) return;
			measuredActions.push({
				key: action.key,
				width,
				collapsePriority: action.collapsePriority,
			});
		}

		const nextHiddenKeys = resolveNarratorStatusToolbarOverflow({
			availableWidth,
			leadingWidth,
			actions: measuredActions,
		});
		setHiddenKeys((current) => (sameKeys(current, nextHiddenKeys) ? current : nextHiddenKeys));
	}, []);

	useLayoutEffect(() => {
		if (previousResetKey.current !== resetKey) {
			previousResetKey.current = resetKey;
			widthCache.current.clear();
			setHiddenKeys([]);
			const frame = window.requestAnimationFrame(measureAndResolve);
			return () => window.cancelAnimationFrame(frame);
		}
		measureAndResolve();
	}, [measureAndResolve, resetKey]);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const observer =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureAndResolve);
		observer?.observe(container);
		if (leadingRef.current) observer?.observe(leadingRef.current);
		for (const element of actionRefs.current.values()) observer?.observe(element);
		window.addEventListener("resize", measureAndResolve);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measureAndResolve);
		};
	}, [measureAndResolve]);

	const hiddenKeySet = new Set(hiddenKeys);
	const overflowActions = actions.filter((action) => hiddenKeySet.has(action.key));

	return (
		<Group
			ref={containerRef}
			data-testid="narrator-status-toolbar"
			gap={DEFAULT_GAP_PX}
			wrap="nowrap"
			justify="flex-end"
			style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflow: "visible", flexShrink: 1 }}
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
				<Menu position="top-end" withinPortal keepMounted transitionProps={{ duration: 0 }}>
					<Menu.Target>
						<Tooltip label={moreLabel}>
							<ActionIcon
								variant="subtle"
								color="gray"
								size={MORE_BUTTON_WIDTH_PX}
								aria-label={moreLabel}
								data-testid="narrator-status-more"
								style={{ flexShrink: 0 }}
							>
								<IconDotsVertical size={16} />
							</ActionIcon>
						</Tooltip>
					</Menu.Target>
					<Menu.Dropdown>
						{overflowActions.map((action) => (
							<Fragment key={action.key}>{action.render("menu")}</Fragment>
						))}
					</Menu.Dropdown>
				</Menu>
			)}
		</Group>
	);
}
