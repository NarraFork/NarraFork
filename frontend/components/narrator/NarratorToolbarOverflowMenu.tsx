/**
 * Overflow menu for the narrator header toolbar: lists the tucked-away entries
 * and lets the reader reorder / re-surface any of them by dragging.
 *
 * Structurally a copy of `components/nav/NavOverflowMenu.tsx` — one flat sortable
 * list where the "tucked away" heading is itself a (non-draggable) drop target,
 * so moving an entry across the boundary is a plain `arrayMove` with no separate
 * zone bookkeeping. Keeping the two menus isomorphic is deliberate: a reader who
 * has customized the sidebar already knows how this works.
 *
 * Archive is appended below a separator and is NOT part of the sortable list. It
 * is a destructive action rather than a panel toggle, and the cost of a mis-tap is
 * not symmetric with opening a panel — so it can never be dragged up into the
 * always-visible row.
 */

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, Badge, Group, Indicator, Menu, Text, Tooltip } from "@mantine/core";
import { IconArchive, IconDotsVertical, IconGripVertical } from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	NARRATOR_TOOLBAR_DIVIDER_ID,
	type NarratorToolbarEntry,
} from "../../hooks/narrator-toolbar-layout";
import {
	aggregateOverflowBadge,
	type NarratorToolbarBadgeCounts,
	resolveNarratorToolbarBadge,
} from "./narrator-toolbar-badges";
import {
	isNarratorToolbarItemAvailable,
	type NarratorToolbarHost,
	narratorToolbarItem,
} from "./narrator-toolbar-items";

function entryId(entry: NarratorToolbarEntry): string {
	return entry.kind === "divider" ? NARRATOR_TOOLBAR_DIVIDER_ID : entry.id;
}

function SortableRow({
	id,
	tucked,
	label,
	badgeLabel,
	badgeProcessing,
	headerOnlyHint,
	onActivate,
}: {
	id: string;
	tucked: boolean;
	label: string;
	badgeLabel?: string;
	badgeProcessing?: boolean;
	/** Shown instead of a click action for self-contained controls. */
	headerOnlyHint?: string;
	onActivate?: () => void;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id,
	});
	const def = narratorToolbarItem(id);
	if (!def) return null;
	const Icon = def.icon;

	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				opacity: isDragging ? 0.9 : 1,
				zIndex: isDragging ? 10 : undefined,
				position: "relative",
				background: isDragging ? "var(--mantine-color-dark-6)" : undefined,
				borderRadius: isDragging ? "var(--mantine-radius-sm)" : undefined,
				boxShadow: isDragging ? "var(--mantine-shadow-md)" : undefined,
				userSelect: "none",
				touchAction: "none",
				cursor: isDragging ? "grabbing" : undefined,
			}}
		>
			<Group gap={6} wrap="nowrap" px={8} py={6}>
				<span style={{ display: "flex", color: "var(--mantine-color-dimmed)" }}>
					<IconGripVertical size={14} />
				</span>
				<Group
					gap={6}
					wrap="nowrap"
					// A self-contained control cannot be opened from the menu, so its row
					// is plain data (still draggable) rather than a button.
					style={{ flex: 1, minWidth: 0, cursor: onActivate ? "pointer" : "default" }}
					onClick={onActivate}
				>
					<Icon size={14} />
					<Text
						size="sm"
						c={tucked ? "dimmed" : undefined}
						style={{ flex: 1, minWidth: 0 }}
						truncate
					>
						{label}
					</Text>
					{badgeLabel ? (
						<Badge size="sm" circle variant="filled" color={badgeProcessing ? "blue" : "indigo"}>
							{badgeLabel}
						</Badge>
					) : null}
					{headerOnlyHint ? (
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{headerOnlyHint}
						</Text>
					) : null}
				</Group>
			</Group>
		</div>
	);
}

/** The zone boundary. Not draggable, but a valid drop target. */
function SortableDivider({ label }: { label: string }) {
	const { setNodeRef, transform, transition, isOver } = useSortable({
		id: NARRATOR_TOOLBAR_DIVIDER_ID,
		disabled: true,
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
	/** Full flat layout (both zones) — the drag list operates on this. */
	entries: readonly NarratorToolbarEntry[];
	onSaveLayout: (entries: NarratorToolbarEntry[]) => void;
	/** Capabilities of the current host; unavailable entries are not listed. */
	hostCapabilities: readonly NarratorToolbarHost[];
	badgeCounts: NarratorToolbarBadgeCounts;
	/** Activate an entry (open its panel / drawer). */
	onActivate: (id: string) => void;
	/** Archive action, pinned below the sortable list. Omit to hide it. */
	onArchive?: () => void;
	archiveLoading?: boolean;
}

export function NarratorToolbarOverflowMenu({
	entries,
	onSaveLayout,
	hostCapabilities,
	badgeCounts,
	onActivate,
	onArchive,
	archiveLoading,
}: NarratorToolbarOverflowMenuProps) {
	const { t } = useTranslation("narrator");
	const [menuOpen, setMenuOpen] = useState(false);
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
				if (entry.kind === "divider") return true;
				const def = narratorToolbarItem(entry.id);
				return !!def && isNarratorToolbarItemAvailable(def, hostCapabilities);
			}),
		[entries, hostCapabilities],
	);

	const flatIds = useMemo(() => listedEntries.map(entryId), [listedEntries]);
	const dividerIndex = useMemo(() => flatIds.indexOf(NARRATOR_TOOLBAR_DIVIDER_ID), [flatIds]);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id || active.id === NARRATOR_TOOLBAR_DIVIDER_ID) return;

			const oldIndex = flatIds.indexOf(String(active.id));
			const newIndex = flatIds.indexOf(String(over.id));
			if (oldIndex === -1 || newIndex === -1) return;

			const nextIds = arrayMove(flatIds, oldIndex, newIndex);
			const byId = new Map(listedEntries.map((entry) => [entryId(entry), entry]));
			const reordered = nextIds
				.map((id) => byId.get(id))
				.filter((entry): entry is NarratorToolbarEntry => entry != null);

			/*
			 * Entries hidden from this host were excluded above, so they must be
			 * re-attached rather than dropped: saving only the visible ones would
			 * silently delete a desktop-only entry the moment a phone reordered the
			 * list, and the layout is shared across devices. They are appended after
			 * the divider, which is where an unavailable entry belongs until its host
			 * comes back.
			 */
			const kept = new Set(nextIds);
			const hidden = entries.filter((entry) => entry.kind === "item" && !kept.has(entry.id));
			onSaveLayout([...reordered, ...hidden]);
		},
		[flatIds, listedEntries, entries, onSaveLayout],
	);

	const overflowDefs = useMemo(() => {
		if (dividerIndex < 0) return [];
		return listedEntries
			.slice(dividerIndex + 1)
			.flatMap((entry) => (entry.kind === "item" ? [narratorToolbarItem(entry.id)] : []))
			.filter((def): def is NonNullable<typeof def> => def != null);
	}, [listedEntries, dividerIndex]);
	const aggregate = aggregateOverflowBadge(overflowDefs, badgeCounts);

	const moreLabel = t("toolbar.more");

	return (
		<Menu
			opened={menuOpen}
			onChange={setMenuOpen}
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
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
						<Text size="xs" c="dimmed" fw={600} px={8} py={4}>
							{t("toolbar.sectionVisible")}
						</Text>
						{listedEntries.map((entry, index) => {
							if (entry.kind === "divider") {
								return (
									<SortableDivider
										key={NARRATOR_TOOLBAR_DIVIDER_ID}
										label={t("toolbar.sectionTucked")}
									/>
								);
							}
							const def = narratorToolbarItem(entry.id);
							if (!def) return null;
							const badge = resolveNarratorToolbarBadge(def.badge, badgeCounts);
							// Self-contained controls (device menu, plugin picker) open their own
							// UI in the header row; from the menu there is nothing to activate, so
							// the row shows a hint instead of a dead click.
							const activatable = def.selfContained !== true;
							return (
								<SortableRow
									key={entry.id}
									id={entry.id}
									tucked={dividerIndex >= 0 && index > dividerIndex}
									label={t(def.labelKey, { ns: def.namespace ?? "narrator" })}
									badgeLabel={badge.label || undefined}
									badgeProcessing={badge.processing}
									headerOnlyHint={activatable ? undefined : t("toolbar.headerOnly")}
									onActivate={
										activatable
											? () => {
													setMenuOpen(false);
													onActivate(entry.id);
												}
											: undefined
									}
								/>
							);
						})}
					</SortableContext>
				</DndContext>
				{onArchive ? (
					<>
						<Menu.Divider />
						<Menu.Item
							color="orange"
							leftSection={<IconArchive size={14} />}
							disabled={archiveLoading}
							onClick={() => {
								setMenuOpen(false);
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
