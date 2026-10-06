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
import { ActionIcon, Badge, Group, Menu, Text, Tooltip } from "@mantine/core";
import { IconDots, IconGripVertical } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NAV_DIVIDER_ID, type NavLayoutEntry } from "../../hooks/useNavLayout";
import { CUSTOMIZABLE_NAV_ITEMS, type NavItemDef } from "./nav-items";
import { useNavBadges } from "./use-nav-badges";

interface NavOverflowMenuProps {
	/** Flat ordered layout including the divider entry. */
	entries: NavLayoutEntry[];
	onSaveLayout: (entries: NavLayoutEntry[]) => void;
	/** Whether the sidebar is collapsed (icon-only). */
	navCollapsed: boolean;
}

const ITEM_DEF_MAP = new Map<string, NavItemDef>(CUSTOMIZABLE_NAV_ITEMS.map((d) => [d.id, d]));

function entryId(entry: NavLayoutEntry): string {
	return entry.kind === "divider" ? NAV_DIVIDER_ID : entry.id;
}

function SortableRow({
	id,
	onNavigate,
	badgeLabel,
}: {
	id: string;
	onNavigate?: () => void;
	/** Unread count label for this row, when the entry has a live badge. */
	badgeLabel?: string;
}) {
	const { t } = useTranslation("nav");
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id,
	});
	const def = ITEM_DEF_MAP.get(id);
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
				// Dragged row follows the pointer directly (no DragOverlay) and is
				// raised above siblings; the drop animation is transform→0.
				opacity: isDragging ? 0.9 : 1,
				zIndex: isDragging ? 10 : undefined,
				position: "relative",
				background: isDragging ? "var(--mantine-color-dark-6)" : undefined,
				borderRadius: isDragging ? "var(--mantine-radius-sm)" : undefined,
				boxShadow: isDragging ? "var(--mantine-shadow-md)" : undefined,
				// Whole row is the drag hot zone; prevent text selection during drag.
				userSelect: "none",
				touchAction: "none",
				// Only show the grabbing cursor while actually dragging.
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
					style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
					onClick={onNavigate}
				>
					<Icon size={14} />
					<Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
						{t(def.labelKey)}
					</Text>
					{badgeLabel ? (
						<Badge size="sm" circle variant="filled" color="indigo">
							{badgeLabel}
						</Badge>
					) : null}
				</Group>
			</Group>
		</div>
	);
}

/** The zone boundary: the "Tucked away" header itself. Not draggable, but a
 *  valid drop target so items can be moved across zones in one flat list. */
function SortableDivider() {
	const { t } = useTranslation("nav");
	const { setNodeRef, transform, transition, isOver } = useSortable({
		id: NAV_DIVIDER_ID,
		disabled: true, // cannot be dragged
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
				{t("navSectionMore")}
			</Text>
		</div>
	);
}

export function NavOverflowMenu({ entries, onSaveLayout, navCollapsed }: NavOverflowMenuProps) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);
	// Reads the same cached query the sidebar badge uses — no extra request.
	const resolveBadge = useNavBadges();
	// Distance constraint: a press must move ≥6px to become a drag, so plain
	// clicks still work (navigation) and never accidentally start a drag.
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

	const flatIds = useMemo(() => entries.map(entryId), [entries]);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id || active.id === NAV_DIVIDER_ID) return;

			const oldIndex = flatIds.indexOf(String(active.id));
			const newIndex = flatIds.indexOf(String(over.id));
			if (oldIndex === -1 || newIndex === -1) return;

			// Pure reorder of the single flat list — the divider is just another
			// entry, so moving an item past it naturally crosses zones. No rebuild.
			const nextIds = arrayMove(flatIds, oldIndex, newIndex);
			const byId = new Map(entries.map((entry) => [entryId(entry), entry]));
			const nextEntries = nextIds
				.map((id) => byId.get(id))
				.filter((entry): entry is NavLayoutEntry => entry != null);
			onSaveLayout(nextEntries);
		},
		[flatIds, entries, onSaveLayout],
	);

	// Hidden-zone rows get click-to-navigate; visible rows are already in the sidebar.
	const handleNavigate = useCallback(
		(id: string) => {
			const def = ITEM_DEF_MAP.get(id);
			if (!def) return;
			setMenuOpen(false);
			navigate({ to: def.to });
		},
		[navigate],
	);

	return (
		<Menu
			opened={menuOpen}
			onChange={setMenuOpen}
			position="right-start"
			withArrow
			// The menu itself is the drop target — don't close on item click.
			closeOnItemClick={false}
			shadow="md"
			width={220}
		>
			<Menu.Target>
				<Tooltip label={t("more")} position="right" disabled={menuOpen}>
					<ActionIcon
						variant="subtle"
						color="gray"
						size={navCollapsed ? "lg" : "md"}
						aria-label={t("more")}
						style={{ flexShrink: 0 }}
					>
						<IconDots size={navCollapsed ? 18 : 16} />
					</ActionIcon>
				</Tooltip>
			</Menu.Target>
			<Menu.Dropdown>
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext items={flatIds} strategy={verticalListSortingStrategy}>
						<Text size="xs" c="dimmed" fw={600} px={8} py={4}>
							{t("navSectionVisible")}
						</Text>
						{entries.map((entry) => {
							if (entry.kind === "divider") return <SortableDivider key={NAV_DIVIDER_ID} />;
							return (
								<SortableRow
									key={entry.id}
									id={entry.id}
									onNavigate={() => handleNavigate(entry.id)}
									badgeLabel={resolveBadge(ITEM_DEF_MAP.get(entry.id)?.badge).label || undefined}
								/>
							);
						})}
					</SortableContext>
				</DndContext>
			</Menu.Dropdown>
		</Menu>
	);
}
