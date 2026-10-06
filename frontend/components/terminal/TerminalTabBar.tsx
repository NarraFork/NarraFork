import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ActionIcon,
	Button,
	Group,
	Popover,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
	useComputedColorScheme,
} from "@mantine/core";
import { IconGripVertical, IconPlus, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTerminalCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import { attachTabStripWheel } from "./tab-strip-wheel";

interface Tab {
	id: string;
	name: string;
}

interface TerminalTabBarProps {
	tabs: Tab[];
	activeTabId: string | null;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onCreate: () => void;
	onRename: (tabId: string, name: string) => void;
	onReorder: (ids: string[]) => void;
	createPending?: boolean;
	createDisabled?: boolean;
	createDisabledReason?: string;
}

function SortableTab({
	tab,
	isActive,
	onSelect,
	onClose,
	onRename,
	processTreeSupported,
}: {
	tab: Tab;
	isActive: boolean;
	onSelect: () => void;
	onClose: () => void;
	onRename: (name: string) => void;
	processTreeSupported: boolean;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: tab.id,
	});
	const computedScheme = useComputedColorScheme("dark");
	const { t } = useTranslation("terminal");
	const [editing, setEditing] = useState(false);
	const [editName, setEditName] = useState(tab.name);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};

	const commitRename = () => {
		const trimmed = editName.trim();
		if (trimmed && trimmed !== tab.name) {
			onRename(trimmed);
		}
		setEditing(false);
	};

	const tryClose = async () => {
		if (processTreeSupported) {
			try {
				const processes = await api.getTerminalProcesses(tab.id);
				if (processes.length > 1) {
					setConfirmOpen(true);
					return;
				}
			} catch {
				// Can't check — close directly
			}
		}
		onClose();
	};

	return (
		<div ref={setNodeRef} style={style}>
			<Popover opened={confirmOpen} onChange={setConfirmOpen} position="bottom" withArrow>
				<Popover.Target>
					<UnstyledButton
						onClick={onSelect}
						onMouseDown={(e: React.MouseEvent) => {
							if (e.button === 1) {
								e.preventDefault();
								tryClose();
							}
						}}
						onDoubleClick={() => {
							setEditName(tab.name);
							setEditing(true);
							setTimeout(() => inputRef.current?.select(), 0);
						}}
						px={8}
						py={4}
						style={{
							display: "flex",
							alignItems: "center",
							gap: 4,
							borderBottom: isActive
								? "2px solid var(--mantine-color-indigo-6)"
								: "2px solid transparent",
							backgroundColor: isActive
								? computedScheme === "dark"
									? "var(--mantine-color-dark-6)"
									: "var(--mantine-color-gray-1)"
								: "transparent",
							borderRadius: "4px 4px 0 0",
							fontSize: 13,
							whiteSpace: "nowrap",
							color: isActive ? "var(--mantine-color-text)" : "var(--mantine-color-dimmed)",
						}}
					>
						<span {...attributes} {...listeners} style={{ cursor: "grab", display: "flex" }}>
							<IconGripVertical size={12} />
						</span>
						{editing ? (
							<TextInput
								ref={inputRef}
								value={editName}
								onChange={(e) => setEditName(e.currentTarget.value)}
								onBlur={commitRename}
								onKeyDown={(e) => {
									if (e.key === "Enter") commitRename();
									if (e.key === "Escape") setEditing(false);
								}}
								size="xs"
								variant="unstyled"
								styles={{
									input: {
										fontSize: 13,
										padding: 0,
										height: 20,
										minHeight: 20,
									},
								}}
								onClick={(e) => e.stopPropagation()}
							/>
						) : (
							<span>{tab.name}</span>
						)}
						<ActionIcon
							size={16}
							variant="subtle"
							onClick={(e) => {
								e.stopPropagation();
								tryClose();
							}}
						>
							<IconX size={10} />
						</ActionIcon>
					</UnstyledButton>
				</Popover.Target>
				<Popover.Dropdown p="sm">
					<Text size="sm" mb="xs">
						{t("closeConfirmMessage")}
					</Text>
					<Group justify="flex-end" gap="xs">
						<Button size="compact-xs" variant="default" onClick={() => setConfirmOpen(false)}>
							{t("cancel")}
						</Button>
						<Button
							size="compact-xs"
							color="red"
							onClick={() => {
								setConfirmOpen(false);
								onClose();
							}}
						>
							{t("confirmClose")}
						</Button>
					</Group>
				</Popover.Dropdown>
			</Popover>
		</div>
	);
}

export function TerminalTabBar({
	tabs,
	activeTabId,
	onSelect,
	onClose,
	onCreate,
	onRename,
	onReorder,
	createPending,
	createDisabled,
	createDisabledReason,
}: TerminalTabBarProps) {
	const { t } = useTranslation("terminal");
	const terminalCapability = useTerminalCapability();
	const processTreeSupported = terminalCapability.processTree?.supported !== false;
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
	const scrollRef = useRef<HTMLDivElement>(null);

	// Vertical wheel pans overflowing tabs horizontally without needing Shift.
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		return attachTabStripWheel(el);
	}, []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const oldIndex = tabs.findIndex((t) => t.id === active.id);
			const newIndex = tabs.findIndex((t) => t.id === over.id);
			if (oldIndex === -1 || newIndex === -1) return;
			const newOrder = [...tabs];
			const [moved] = newOrder.splice(oldIndex, 1);
			newOrder.splice(newIndex, 0, moved);
			onReorder(newOrder.map((t) => t.id));
		},
		[tabs, onReorder],
	);

	return (
		<Group gap={0} wrap="nowrap" style={{ overflow: "hidden", flex: 1, minWidth: 0 }}>
			<div
				ref={scrollRef}
				style={{
					display: "flex",
					overflowX: "auto",
					flex: 1,
					minWidth: 0,
					scrollbarWidth: "none",
				}}
			>
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
						{tabs.map((tab) => (
							<SortableTab
								key={tab.id}
								tab={tab}
								isActive={tab.id === activeTabId}
								onSelect={() => onSelect(tab.id)}
								onClose={() => onClose(tab.id)}
								onRename={(name) => onRename(tab.id, name)}
								processTreeSupported={processTreeSupported}
							/>
						))}
					</SortableContext>
				</DndContext>
			</div>
			<Tooltip
				label={
					createDisabled ? (createDisabledReason ?? t("terminalUnsupported")) : t("newTerminal")
				}
			>
				<ActionIcon
					variant="subtle"
					onClick={onCreate}
					loading={createPending}
					disabled={createDisabled}
					ml={4}
					size="sm"
					style={{ flexShrink: 0 }}
				>
					<IconPlus size={14} />
				</ActionIcon>
			</Tooltip>
		</Group>
	);
}
