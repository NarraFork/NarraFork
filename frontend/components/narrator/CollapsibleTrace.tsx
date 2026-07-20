import { Box, Group, Text, ThemeIcon } from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconDots } from "@tabler/icons-react";
import { memo, type ReactNode, useState } from "react";
import { LazyCollapse } from "./LazyCollapse";

// ---------------------------------------------------------------------------
// CollapsibleTrace — a content-agnostic "trace" block: a header line (icon +
// label + count), an optional "show earlier" fold, and a list of rows. Each
// row is a chevron (expandable) or a plain dot (not) + an optional icon + a
// single truncated title, with an optional collapsible body and an optional
// streaming shimmer. Distilled from ReasoningStepsTrace so reasoning traces,
// tool summaries, and the unified L1/L2 activity trace all share one structure —
// which keeps their look identical and lets item-level keys stay stable for
// future animated LOD transitions.
// ---------------------------------------------------------------------------

// --- Cross-remount persistence (LRU) ---------------------------------------
const MAX_STATE_ENTRIES = 1000;
const expandState = new Map<string, boolean>();

function readState(key: string | undefined): boolean | undefined {
	if (!key) return undefined;
	const value = expandState.get(key);
	if (value !== undefined) {
		expandState.delete(key);
		expandState.set(key, value);
	}
	return value;
}

function writeState(key: string | undefined, value: boolean) {
	if (!key) return;
	expandState.delete(key);
	expandState.set(key, value);
	while (expandState.size > MAX_STATE_ENTRIES) {
		const oldest = expandState.keys().next().value;
		if (oldest === undefined) break;
		expandState.delete(oldest);
	}
}

export interface CollapsibleTraceItem {
	/** Stable React key + persist-key suffix (e.g. toolUseId / `seg${i}`). */
	key: string;
	/** Per-row icon node (tool category icon / brain). Omit for a plain row. */
	icon?: ReactNode;
	/** ThemeIcon tint for the row icon. */
	iconColor?: string;
	/** Single-line truncated row title. */
	title: string;
	/** Expandable body; null/undefined → non-expandable dot row. */
	body?: ReactNode | null;
	/** Streaming shimmer on this row (the latest live item). */
	shimmer?: boolean;
	/** Persist-key override; defaults to `${persistKeyBase}:${key}`. */
	persistKey?: string;
}

export interface CollapsibleTraceProps {
	items: CollapsibleTraceItem[];
	headerIcon: ReactNode;
	headerColor: string;
	headerLabel: string;
	/** Pre-formatted count text ("N 步" / "N 次"), localized by the caller. */
	headerCount: string;
	/** Rows visible before "show earlier" folding (reasoning=5, tools=10). */
	maxVisible?: number;
	/** LRU persist-key base; undefined → no persistence. */
	persistKeyBase?: string;
	/** Localized labels (the component stays i18n-free). */
	showEarlierLabel: (hiddenCount: number) => string;
	hideEarlierLabel: string;
	/** Collapse the complete row list behind the clickable header. */
	collapseItems?: boolean;
}

const TraceRow = memo(function TraceRow({
	item,
	persistKeyBase,
}: {
	item: CollapsibleTraceItem;
	persistKeyBase?: string;
}) {
	const persistKey =
		item.persistKey ?? (persistKeyBase ? `${persistKeyBase}:${item.key}` : undefined);
	const expandable = item.body != null;
	const [opened, setOpened] = useState(readState(persistKey) ?? false);

	const toggle = () => {
		if (!expandable) return;
		setOpened((v) => {
			const next = !v;
			writeState(persistKey, next);
			return next;
		});
	};

	return (
		<Box>
			<Group
				gap={6}
				wrap="nowrap"
				align="center"
				py={1}
				style={{ cursor: expandable ? "pointer" : "default", userSelect: "none" }}
				onClick={toggle}
			>
				<Box style={{ display: "flex", alignItems: "center", width: 12, justifyContent: "center" }}>
					{expandable ? (
						opened ? (
							<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
						) : (
							<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
						)
					) : (
						<Text span size="xs" c="dimmed" style={{ opacity: 0.5, lineHeight: 1, fontSize: 10 }}>
							•
						</Text>
					)}
				</Box>
				{item.icon != null && (
					<ThemeIcon size={14} variant="light" color={item.iconColor ?? "gray"} radius="sm">
						{item.icon}
					</ThemeIcon>
				)}
				<Text
					size="xs"
					c="dimmed"
					truncate
					className={item.shimmer ? "reasoning-step-shimmer" : undefined}
					style={{ flex: 1, minWidth: 0 }}
				>
					{item.title || "…"}
				</Text>
			</Group>
			{expandable && (
				<LazyCollapse in={opened}>
					<Box
						pl="lg"
						py={2}
						style={{
							borderLeft: "2px solid var(--mantine-color-grape-9)",
							opacity: 0.75,
							fontSize: "var(--mantine-font-size-xs)",
						}}
					>
						{item.body}
					</Box>
				</LazyCollapse>
			)}
		</Box>
	);
});

export const CollapsibleTrace = memo(function CollapsibleTrace({
	items,
	headerIcon,
	headerColor,
	headerLabel,
	headerCount,
	maxVisible = 5,
	persistKeyBase,
	showEarlierLabel,
	hideEarlierLabel,
	collapseItems = false,
}: CollapsibleTraceProps) {
	const earlierKey = persistKeyBase ? `${persistKeyBase}:earlier` : undefined;
	const [showEarlier, setShowEarlier] = useState(readState(earlierKey) ?? false);
	const [itemsOpened, setItemsOpened] = useState(false);
	const [previousCollapseItems, setPreviousCollapseItems] = useState(collapseItems);
	if (previousCollapseItems !== collapseItems) {
		setPreviousCollapseItems(collapseItems);
		setItemsOpened(false);
	}

	if (items.length === 0) return null;

	const hiddenCount = Math.max(0, items.length - maxVisible);
	const visibleStart = showEarlier ? 0 : hiddenCount;
	const rowsOpened = !collapseItems || itemsOpened;

	const toggleEarlier = () => {
		setShowEarlier((v) => {
			const next = !v;
			writeState(earlierKey, next);
			return next;
		});
	};

	return (
		<Box py={2}>
			<Group
				gap={6}
				wrap="nowrap"
				align="center"
				py={2}
				style={{ cursor: collapseItems ? "pointer" : "default", userSelect: "none" }}
				onClick={collapseItems ? () => setItemsOpened((opened) => !opened) : undefined}
			>
				{collapseItems &&
					(itemsOpened ? (
						<IconChevronDown size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					) : (
						<IconChevronRight size={12} style={{ color: "var(--mantine-color-dimmed)" }} />
					))}
				<ThemeIcon size={16} variant="light" color={headerColor} radius="sm">
					{headerIcon}
				</ThemeIcon>
				<Text size="xs" c="dimmed" fw={500} style={{ flexShrink: 0 }}>
					{headerLabel}
				</Text>
				<Text size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.5 }}>
					{headerCount}
				</Text>
			</Group>

			<LazyCollapse in={rowsOpened}>
				{hiddenCount > 0 && (
					<Group
						gap={6}
						wrap="nowrap"
						align="center"
						py={1}
						style={{ cursor: "pointer", userSelect: "none" }}
						onClick={toggleEarlier}
					>
						<Box
							style={{
								display: "flex",
								alignItems: "center",
								width: 12,
								justifyContent: "center",
							}}
						>
							<IconDots size={12} style={{ color: "var(--mantine-color-dimmed)", opacity: 0.6 }} />
						</Box>
						<Text size="xs" c="dimmed" style={{ opacity: 0.7 }}>
							{showEarlier ? hideEarlierLabel : showEarlierLabel(hiddenCount)}
						</Text>
					</Group>
				)}

				{items.slice(visibleStart).map((item) => (
					<TraceRow key={item.key} item={item} persistKeyBase={persistKeyBase} />
				))}
			</LazyCollapse>
		</Box>
	);
});

// CSS keyframes — inject once. A subtle gradient text shimmer marks the latest
// live row while the model is still working. Shared by every trace kind.
if (typeof document !== "undefined") {
	const id = "reasoning-step-shimmer-style";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `
@keyframes reasoning-step-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.reasoning-step-shimmer {
  background: linear-gradient(
    90deg,
    var(--mantine-color-dimmed) 0%,
    var(--mantine-color-dimmed) 35%,
    light-dark(rgba(0,0,0,.85), rgba(255,255,255,.92)) 50%,
    var(--mantine-color-dimmed) 65%,
    var(--mantine-color-dimmed) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: reasoning-step-shimmer 2.2s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .reasoning-step-shimmer { animation: none; -webkit-text-fill-color: currentColor; }
}
`;
		document.head.appendChild(style);
	}
}
