import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragStartEvent,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ActionIcon,
	Button,
	Checkbox,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconFolder, IconGripVertical, IconStar, IconStarFilled, IconX } from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
	useReorderFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import { useAllModels } from "../../hooks/useModels";
import { useCreateNarrator } from "../../hooks/useNarrator";
import { usePlatform } from "../../hooks/usePlatform";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import { DirectoryPicker } from "../common/DirectoryPicker";

export interface CreateNarratorResult {
	id: string;
	title: string;
	cwd?: string;
	status: string;
}

interface CreateNarratorModalProps {
	opened: boolean;
	onClose: () => void;
	onCreated?: (narrator: CreateNarratorResult) => void;
}

function FavoriteItemContent({
	fav,
	isActive,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	fav: any;
	isActive: boolean;
}) {
	return (
		<Group gap="xs" wrap="nowrap">
			<span style={{ display: "flex", flexShrink: 0 }}>
				<IconGripVertical size={14} color="var(--mantine-color-dimmed)" />
			</span>
			<Button
				variant={isActive ? "light" : "subtle"}
				size="xs"
				style={{ flex: 1, justifyContent: "flex-start" }}
			>
				<Text size="xs" truncate>
					{fav.label || fav.path}
				</Text>
			</Button>
			<ActionIcon variant="subtle" color="red" size="xs">
				<IconX size={14} />
			</ActionIcon>
		</Group>
	);
}

function SortableFavoriteItem({
	fav,
	isActive,
	onSelect,
	onRemove,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	fav: any;
	isActive: boolean;
	onSelect: () => void;
	onRemove: () => void;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: fav.id,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		visibility: isDragging ? ("hidden" as const) : undefined,
	};

	return (
		<Group ref={setNodeRef} style={style} gap="xs" wrap="nowrap">
			<span
				{...attributes}
				{...listeners}
				style={{ cursor: "grab", display: "flex", flexShrink: 0 }}
			>
				<IconGripVertical size={14} color="var(--mantine-color-dimmed)" />
			</span>
			<Button
				variant={isActive ? "light" : "subtle"}
				size="xs"
				style={{ flex: 1, justifyContent: "flex-start" }}
				onClick={onSelect}
			>
				<Text size="xs" truncate>
					{fav.label || fav.path}
				</Text>
			</Button>
			<ActionIcon variant="subtle" color="red" size="xs" onClick={onRemove}>
				<IconX size={14} />
			</ActionIcon>
		</Group>
	);
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
function DragOverlayPortal({ activeFav, isActive }: { activeFav: any; isActive: boolean }) {
	const [pos, setPos] = useState({ x: 0, y: 0 });
	const offsetRef = useRef({ x: 0, y: 0 });
	const rafRef = useRef(0);

	const handlePointerMove = useCallback((e: PointerEvent) => {
		if (rafRef.current) return;
		rafRef.current = requestAnimationFrame(() => {
			setPos({
				x: e.clientX - offsetRef.current.x,
				y: e.clientY - offsetRef.current.y,
			});
			rafRef.current = 0;
		});
	}, []);

	const handlePointerUp = useCallback(() => {
		if (rafRef.current) cancelAnimationFrame(rafRef.current);
		document.removeEventListener("pointermove", handlePointerMove);
		document.removeEventListener("pointerup", handlePointerUp);
	}, [handlePointerMove]);

	// Use mousedown-like offset: start from the active node rect when overlay first renders
	const ref = useCallback(
		(node: HTMLDivElement | null) => {
			if (node) {
				const rect = node.getBoundingClientRect();
				// Use top-left offset so the overlay follows the cursor naturally
				offsetRef.current = { x: rect.width / 2, y: rect.height / 2 };
				// Start listening for pointer events
				document.addEventListener("pointermove", handlePointerMove);
				document.addEventListener("pointerup", handlePointerUp);
			}
		},
		[handlePointerMove, handlePointerUp],
	);

	return createPortal(
		<div
			ref={ref}
			style={{
				position: "fixed",
				left: pos.x || -9999,
				top: pos.y || -9999,
				zIndex: 9999,
				pointerEvents: "none",
				borderRadius: 4,
				backgroundColor: "var(--mantine-color-dark-6)",
				boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
				opacity: pos.x ? 1 : 0,
				width: "fit-content",
			}}
		>
			<FavoriteItemContent fav={activeFav} isActive={isActive} />
		</div>,
		document.body,
	);
}

export function CreateNarratorModal({ opened, onClose, onCreated }: CreateNarratorModalProps) {
	const { t } = useTranslation("narrators");
	const platform = usePlatform();
	const createNarrator = useCreateNarrator();
	const { groupedModels } = useAllModels();
	const { data: favorites } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();
	const reorderFavorites = useReorderFavoriteDirectories();

	const [cwd, setCwd] = useState("");
	const [selectedModel, setSelectedModel] = useState("");
	const [startInPlanMode, setStartInPlanMode] = useState(false);
	const [activeId, setActiveId] = useState<string | null>(null);

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isFavorited = favorites?.some((f: any) => f.path === cwd);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const activeFav = activeId ? favorites?.find((f: any) => f.id === activeId) : null;

	const handleDragStart = useCallback((event: DragStartEvent) => {
		setActiveId(event.active.id as string);
	}, []);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveId(null);
			const { active, over } = event;
			if (!over || active.id === over.id || !favorites) return;
			const oldIndex = favorites.findIndex((f: any) => f.id === active.id);
			const newIndex = favorites.findIndex((f: any) => f.id === over.id);
			if (oldIndex === -1 || newIndex === -1) return;
			const newOrder = [...favorites];
			const [moved] = newOrder.splice(oldIndex, 1);
			newOrder.splice(newIndex, 0, moved);
			reorderFavorites.mutate(newOrder.map((f: any) => f.id));
		},
		[favorites, reorderFavorites],
	);

	const handleDragCancel = useCallback(() => {
		setActiveId(null);
	}, []);

	const handleCreate = () => {
		createNarrator.mutate(
			{
				...(cwd ? { cwd } : {}),
				model: selectedModel || FOLLOW_DEFAULT_MODEL,
				...(startInPlanMode ? { permissionMode: "plan" as const } : {}),
			},
			{
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				onSuccess: (data: any) => {
					handleClose();
					onCreated?.({
						id: data.id,
						title: data.title || t("newNarrator"),
						cwd: data.cwd || cwd,
						status: data.status || "idle",
					});
				},
			},
		);
	};

	const handleClose = () => {
		onClose();
		setCwd("");
		setSelectedModel("");
		setStartInPlanMode(false);
	};

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={t("newNarratorModal")}
			size="md"
			styles={{
				body: {
					maxHeight: "90vh",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				},
			}}
		>
			<Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
				<Text size="sm" c="dimmed">
					{t("newNarratorDescription")}
				</Text>

				<DirectoryPicker
					label={t("workingDirectory")}
					description={t("workingDirectoryHint")}
					placeholder={
						platform === "windows" ? "E:\\Code\\my-project" : "/home/user/projects/my-project"
					}
					leftSection={<IconFolder size={16} />}
					value={cwd}
					onChange={setCwd}
					rightSectionExtra={
						cwd ? (
							isFavorited ? (
								<IconStarFilled size={16} style={{ color: "var(--mantine-color-yellow-5)" }} />
							) : (
								<Tooltip label={t("addToFavorites")}>
									<ActionIcon
										variant="subtle"
										size="sm"
										onClick={() => addFavorite.mutate({ path: cwd })}
									>
										<IconStar size={16} />
									</ActionIcon>
								</Tooltip>
							)
						) : null
					}
				/>

				{favorites?.length ? (
					<Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
						<Text size="xs" fw={500} c="dimmed">
							{t("favoriteDirectories")}
						</Text>
						<div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragStart={handleDragStart}
								onDragEnd={handleDragEnd}
								onDragCancel={handleDragCancel}
							>
								<SortableContext
									items={favorites.map((f: any) => f.id)}
									strategy={verticalListSortingStrategy}
								>
									{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
									{favorites.map((fav: any) => (
										<SortableFavoriteItem
											key={fav.id}
											fav={fav}
											isActive={cwd === fav.path}
											onSelect={() => setCwd(fav.path)}
											onRemove={() => removeFavorite.mutate(fav.id)}
										/>
									))}
								</SortableContext>
								{activeFav && (
									<DragOverlayPortal activeFav={activeFav} isActive={cwd === activeFav.path} />
								)}
							</DndContext>
						</div>
					</Stack>
				) : null}

				<Select
					label={t("model")}
					description={t("modelHint")}
					data={groupedModels}
					searchable
					value={selectedModel || FOLLOW_DEFAULT_MODEL}
					onChange={(v) => setSelectedModel(v ?? "")}
					maxDropdownHeight={320}
					comboboxProps={{
						withinPortal: true,
						position: "bottom-start",
						zIndex: 320,
					}}
				/>

				<Checkbox
					label={t("startInPlanMode")}
					description={t("startInPlanModeHint")}
					checked={startInPlanMode}
					onChange={(e) => setStartInPlanMode(e.currentTarget.checked)}
				/>

				<Button onClick={handleCreate} loading={createNarrator.isPending}>
					{t("createNarrator")}
				</Button>
			</Stack>
		</Modal>
	);
}
