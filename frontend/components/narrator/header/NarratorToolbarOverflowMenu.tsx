/**
 * Overflow menu for the narrator header toolbar: lists the tucked-away entries
 * and lets the reader reorder / re-surface any of them by dragging.
 *
 * Structurally a copy of `components/nav/NavOverflowMenu.tsx` — one flat sortable
 * list where the "tucked away" heading is itself a (non-draggable) drop target,
 * so moving an entry crosses section boundaries without separate visibility flags.
 * Reordering uses the full saved list to preserve tools unavailable on this host.
 * Keeping the two menus isomorphic is deliberate: a reader who
 * has customized the sidebar already knows how this works.
 *
 * Archive is appended below a separator and is NOT part of the sortable list. It
 * is a destructive action rather than a panel toggle, and the cost of a mis-tap is
 * not symmetric with opening a panel — so it can never be dragged up into the
 * always-visible row.
 *
 * Self-contained entries (the detail-level and execution-device pickers, the
 * plugin picker) expand INLINE here via `renderInlineOptions`. They used to render
 * as a dead row labelled "header only", which on a narrow row meant no reachable
 * entry point at all: after the title floor only a couple of icons fit, and
 * everything else lives in this menu. The expansion is a `Collapse` rather than
 * `Menu.Sub` because Mantine's submenu opens on hover or ArrowRight only — neither
 * exists on touch, which is the platform this fixes (same reasoning as
 * CompactMenuSub).
 */

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ActionIcon,
	Badge,
	Box,
	Collapse,
	Group,
	Indicator,
	Menu,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconArchive,
	IconChevronDown,
	IconDotsVertical,
	IconGripVertical,
} from "@tabler/icons-react";
import { Fragment, type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	moveToolbarEntry,
	NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID,
	NARRATOR_TOOLBAR_DIVIDER_ID,
	type NarratorToolbarEntry,
} from "../../../hooks/narrator-toolbar-layout";
import { HEADER_TOOLBAR_FIXED_ATTR } from "./narrator-header-toolbar-capacity";
import {
	aggregateOverflowBadge,
	type NarratorToolbarBadgeCounts,
	resolveNarratorToolbarBadge,
} from "./narrator-toolbar-badges";
import {
	isNarratorToolbarItemAvailable,
	type NarratorToolbarHost,
	type NarratorToolbarItemDef,
	narratorToolbarItem,
} from "./narrator-toolbar-items";

function entryId(entry: NarratorToolbarEntry): string {
	if (entry.kind === "divider") return NARRATOR_TOOLBAR_DIVIDER_ID;
	if (entry.kind === "bottom-divider") return NARRATOR_TOOLBAR_BOTTOM_DIVIDER_ID;
	return entry.id;
}

/** Max height of an inline expansion before it scrolls (device / plugin lists can be long). */
const INLINE_OPTIONS_MAX_HEIGHT_PX = 260;

function SortableRow({
	id,
	label,
	badgeLabel,
	badgeProcessing,
	onActivate,
	inlineOptions,
	expanded,
	onToggleExpanded,
	expandLabel,
}: {
	id: string;
	label: string;
	badgeLabel?: string;
	badgeProcessing?: boolean;
	onActivate?: () => void;
	/** Rows to reveal below this entry; present only for self-contained controls. */
	inlineOptions?: ReactNode;
	expanded?: boolean;
	onToggleExpanded?: () => void;
	expandLabel?: string;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id,
	});
	const def = narratorToolbarItem(id);
	if (!def) return null;
	const Icon = def.icon;
	const hasInlineOptions = !!inlineOptions;

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.9 : 1,
				zIndex: isDragging ? 10 : undefined,
				position: "relative",
				background: isDragging ? "var(--mantine-color-dark-6)" : undefined,
				borderRadius: isDragging ? "var(--mantine-radius-sm)" : undefined,
				boxShadow: isDragging ? "var(--mantine-shadow-md)" : undefined,
			}}
		>
			{/*
			 * Drag listeners live on the ROW, not on the node above, so the inline
			 * expansion below is outside `touch-action: none`. Hoisting them would make
			 * a scrollable device / plugin list unscrollable on touch — silently, since
			 * the rows still render and nothing errors.
			 */}
			<Group
				{...attributes}
				{...listeners}
				gap={6}
				wrap="nowrap"
				px={8}
				py={6}
				style={{
					userSelect: "none",
					touchAction: "none",
					cursor: isDragging ? "grabbing" : undefined,
				}}
			>
				<span style={{ display: "flex", color: "var(--mantine-color-dimmed)" }}>
					<IconGripVertical size={14} />
				</span>
				<Group
					gap={6}
					wrap="nowrap"
					style={{
						flex: 1,
						minWidth: 0,
						cursor: onActivate ? "pointer" : "default",
					}}
					onClick={onActivate}
				>
					<Icon size={14} />
					<Text size="sm" c="inherit" style={{ flex: 1, minWidth: 0 }} truncate>
						{label}
					</Text>
					{badgeLabel ? (
						<Badge size="sm" circle variant="filled" color={badgeProcessing ? "blue" : "indigo"}>
							{badgeLabel}
						</Badge>
					) : null}
				</Group>
				{hasInlineOptions ? (
					<UnstyledButton
						aria-label={expandLabel}
						aria-expanded={expanded}
						onClick={(event) => {
							// The label beside it may be an activation target; expanding must not
							// double as opening whatever that would open.
							event.stopPropagation();
							onToggleExpanded?.();
						}}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							flexShrink: 0,
							padding: "0 4px",
							borderRadius: "var(--mantine-radius-sm)",
							color: "var(--mantine-color-dimmed)",
							background: expanded ? "var(--mantine-color-default-hover)" : undefined,
						}}
					>
						<IconChevronDown
							size={14}
							style={{
								transform: expanded ? "rotate(180deg)" : undefined,
								transition: "transform 150ms ease",
							}}
						/>
					</UnstyledButton>
				) : null}
			</Group>
			{hasInlineOptions ? (
				/*
				 * `keepMounted={false}` so a collapsed row costs nothing: the plugin
				 * options subscribe to the contribution store and trigger a fetch on
				 * mount, and merely opening this menu should not do that for a row the
				 * reader never expanded.
				 */
				<Collapse expanded={!!expanded} keepMounted={false}>
					<Box pl="md" style={{ maxHeight: INLINE_OPTIONS_MAX_HEIGHT_PX, overflowY: "auto" }}>
						{inlineOptions}
					</Box>
				</Collapse>
			) : null}
		</div>
	);
}

/** The zone boundary. Not draggable, but a valid drop target. */
function SortableDivider({ id, label }: { id: string; label: string }) {
	const { setNodeRef, transform, transition, isOver } = useSortable({
		id,
		disabled: { draggable: true, droppable: false },
	});
	return (
		<div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
			<Text
				size="xs"
				fw={600}
				px={8}
				py={6}
				c={isOver ? "indigo" : "dimmed"}
				style={{
					borderTop: "1px solid var(--mantine-color-dark-4)",
					background: isOver ? "var(--mantine-color-dark-6)" : undefined,
					transition: "color 120ms ease, background 120ms ease",
				}}
			>
				{label}
			</Text>
		</div>
	);
}

export interface NarratorToolbarOverflowMenuProps {
	/** Full flat layout (header, menu and bottom zones) — the drag list operates on this. */
	entries: readonly NarratorToolbarEntry[];
	/**
	 * Entries NOT on the header row right now, whether the reader tucked them away
	 * or the row ran out of width.
	 *
	 * Supplied by the header rather than derived from the divider position, because
	 * the divider only records the reader's intent. An entry collapsed for width is
	 * still "shown in header" by that measure, so deriving the aggregate badge from
	 * the divider would take its unread count off screen with nothing to show it —
	 * silently, which is the whole reason the aggregate badge exists.
	 */
	hiddenDefs?: readonly NarratorToolbarItemDef[];
	/**
	 * Ids the reader placed above the divider that the row could not fit.
	 *
	 * Marked in the list because otherwise the menu says "shown in header" about an
	 * entry that is demonstrably not there — the reader would go looking for it in
	 * the row and find nothing, with no explanation.
	 */
	noRoomIds?: readonly string[];
	onSaveLayout: (entries: NarratorToolbarEntry[]) => void;
	/** Capabilities of the current host; unavailable entries are not listed. */
	hostCapabilities: readonly NarratorToolbarHost[];
	badgeCounts: NarratorToolbarBadgeCounts;
	/** Activate an entry (open its panel / drawer). */
	onActivate: (id: string) => void;
	/**
	 * Rows to reveal inline for a self-contained control (one that renders its own
	 * Menu in the header and therefore cannot be "activated"). `close` dismisses
	 * this menu once the reader picks something.
	 *
	 * Required for every `selfContained` entry the host offers: without it the row
	 * is informational only, which is what made the detail-level and device pickers
	 * unreachable on a phone.
	 */
	renderInlineOptions?: (id: string, close: () => void) => ReactNode;
	/** Archive action, pinned below the sortable list. Omit to hide it. */
	onArchive?: () => void;
	archiveLoading?: boolean;
	compatibilityEntry?: ReactNode;
}

export function NarratorToolbarOverflowMenu({
	entries,
	hiddenDefs,
	noRoomIds,
	onSaveLayout,
	hostCapabilities,
	badgeCounts,
	onActivate,
	renderInlineOptions,
	onArchive,
	archiveLoading,
	compatibilityEntry,
}: NarratorToolbarOverflowMenuProps) {
	const { t } = useTranslation("narrator");
	const [menuOpen, setMenuOpen] = useState(false);
	/**
	 * At most one expansion at a time, and never across an open/close cycle: a
	 * dropdown that reopens mid-scroll with a 260px list already unfolded hides the
	 * rows the reader came for.
	 */
	const [expandedId, setExpandedId] = useState<string | null>(null);
	// A press must travel ≥6px to become a drag, so a plain tap still activates
	// the row (important on touch, where every tap has some jitter).
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

	/**
	 * Only entries this host can present take part. Dropping the others keeps the
	 * drag list identical to what the reader sees; if they stayed, an invisible
	 * participant would absorb drop positions and reordering would feel wrong.
	 */
	const listedEntries = useMemo(
		() =>
			entries.filter((entry) => {
				if (entry.kind !== "item") return true;
				const def = narratorToolbarItem(entry.id);
				return !!def && isNarratorToolbarItemAvailable(def, hostCapabilities);
			}),
		[entries, hostCapabilities],
	);

	const flatIds = useMemo(() => listedEntries.map(entryId), [listedEntries]);
	const dividerIndex = useMemo(() => flatIds.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID), [flatIds]);

	const closeMenu = useCallback(() => {
		setMenuOpen(false);
		setExpandedId(null);
	}, []);

	const handleMenuChange = useCallback((opened: boolean) => {
		setMenuOpen(opened);
		if (!opened) setExpandedId(null);
	}, []);

	// An unfolded list would ride along with the sortable transform and make the
	// drop position hard to read, so collapse before the move starts.
	const handleDragStart = useCallback(() => setExpandedId(null), []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			// Move within the FULL saved list. Entries unavailable on this host keep
			// their original zone and order rather than being relocated on every drag.
			onSaveLayout(moveToolbarEntry(entries, String(active.id), String(over.id)));
		},
		[entries, onSaveLayout],
	);

	/**
	 * Fallback for a caller that does not pass `hiddenDefs`: menu-zone entries only.
	 * Bottom icons are visible elsewhere. Correct only when nothing collapsed for width.
	 */
	const tuckedDefs = useMemo(() => {
		if (dividerIndex < 0) return [];
		const bottomIndex = listedEntries.findIndex((entry) => entry.kind === "bottom-divider");
		return listedEntries
			.slice(dividerIndex + 1, bottomIndex < 0 ? undefined : bottomIndex)
			.flatMap((entry) => (entry.kind === "item" ? [narratorToolbarItem(entry.id)] : []))
			.filter((def): def is NonNullable<typeof def> => def != null);
	}, [listedEntries, dividerIndex]);
	const aggregate = aggregateOverflowBadge(hiddenDefs ?? tuckedDefs, badgeCounts);
	const noRoomIdSet = useMemo(() => new Set(noRoomIds ?? []), [noRoomIds]);
	// A visual boundary only; it must not participate in the persisted drag order.
	const firstNoRoomIndex = useMemo(
		() =>
			listedEntries.findIndex(
				(entry, index) =>
					entry.kind === "item" &&
					!(dividerIndex >= 0 && index > dividerIndex) &&
					noRoomIdSet.has(entry.id),
			),
		[listedEntries, dividerIndex, noRoomIdSet],
	);

	const moreLabel = t("toolbar.more");

	return (
		<Menu
			opened={menuOpen}
			onChange={handleMenuChange}
			position="bottom-end"
			withinPortal
			// The menu is the drop target — a click on a row must not close it.
			closeOnItemClick={false}
			shadow="md"
			width={240}
		>
			<Menu.Target>
				<Tooltip label={moreLabel} disabled={menuOpen}>
					<Indicator
						/*
						 * The header's capacity measurement subtracts this control's width from
						 * the budget. Marking it "fixed" is what says "always rendered, so it is
						 * safe to measure" — without the attribute the budget is overstated by
						 * one button and the row keeps one entry too many.
						 */
						{...{ [HEADER_TOOLBAR_FIXED_ATTR]: "" }}
						inline
						size={aggregate.processing ? 8 : 14}
						offset={aggregate.processing ? 3 : 4}
						label={aggregate.processing ? undefined : aggregate.label}
						color="blue"
						processing={aggregate.processing}
						disabled={aggregate.count === 0}
						zIndex={1}
						style={{ height: "var(--ai-size-sm)", display: "flex", alignItems: "center" }}
					>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							aria-label={moreLabel}
							data-testid="narrator-toolbar-more"
							style={{ flexShrink: 0 }}
						>
							<IconDotsVertical size={16} />
						</ActionIcon>
					</Indicator>
				</Tooltip>
			</Menu.Target>
			<Menu.Dropdown>
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragStart={handleDragStart}
					onDragEnd={handleDragEnd}
				>
					<SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
						<Box px={8} py={4}>
							<Text size="xs" c="dimmed" fw={600}>
								{t("toolbar.sectionVisible")}
							</Text>
						</Box>
						{listedEntries.map((entry, index) => {
							if (entry.kind !== "item") {
								return (
									<SortableDivider
										key={entryId(entry)}
										id={entryId(entry)}
										label={t(
											entry.kind === "bottom-divider"
												? "toolbar.sectionBottom"
												: "toolbar.sectionTucked",
										)}
									/>
								);
							}
							const def = narratorToolbarItem(entry.id);
							if (!def) return null;
							const badge = resolveNarratorToolbarBadge(def.badge, badgeCounts);
							// A self-contained control renders its own Menu in the header, so it has
							// no panel to toggle from here. Instead of the old dead row it expands
							// its options inline — which is the only entry point it has on a phone.
							const activatable = def.selfContained !== true;
							const inlineOptions = activatable
								? undefined
								: renderInlineOptions?.(entry.id, closeMenu);
							return (
								<Fragment key={entry.id}>
									{index === firstNoRoomIndex ? (
										<>
											<Menu.Divider />
											<Menu.Label>{t("toolbar.someHiddenNoRoom")}</Menu.Label>
										</>
									) : null}
									<SortableRow
										id={entry.id}
										label={t(def.labelKey, { ns: def.namespace ?? "narrator" })}
										badgeLabel={badge.label || undefined}
										badgeProcessing={badge.processing}
										onActivate={
											activatable
												? () => {
														closeMenu();
														onActivate(entry.id);
													}
												: undefined
										}
										inlineOptions={inlineOptions ?? undefined}
										expanded={expandedId === entry.id}
										onToggleExpanded={() =>
											setExpandedId((current) => (current === entry.id ? null : entry.id))
										}
										expandLabel={t("toolbar.expandOptions")}
									/>
								</Fragment>
							);
						})}
					</SortableContext>
				</DndContext>
				{compatibilityEntry && (
					<>
						<Menu.Divider />
						{compatibilityEntry}
					</>
				)}
				{onArchive ? (
					<>
						<Menu.Divider />
						<Menu.Item
							color="orange"
							leftSection={<IconArchive size={14} />}
							disabled={archiveLoading}
							onClick={() => {
								closeMenu();
								onArchive();
							}}
						>
							{t("archiveNarrator")}
						</Menu.Item>
					</>
				) : null}
			</Menu.Dropdown>
		</Menu>
	);
}
