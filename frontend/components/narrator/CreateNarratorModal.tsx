import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
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
	Divider,
	Group,
	Modal,
	ScrollArea,
	Select,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { handleLength, MIN_HANDLE_LENGTH } from "@shared/narrator-handle";
import { IconFolder, IconGripVertical, IconStar, IconStarFilled, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { api } from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import { DirectoryPicker } from "../common/DirectoryPicker";

const MODEL_SELECT_OPTION_LIMIT = 100;
const CREATE_NARRATOR_SETTINGS_QUERY_GC_TIME_MS = 60_000;

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
	/** Pre-fill the working directory (e.g. "new narrator in this directory" entry points). */
	initialCwd?: string;
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
		<Group gap="xs" wrap="nowrap" miw={0}>
			<span style={{ display: "flex", flexShrink: 0 }}>
				<IconGripVertical size={14} color="var(--mantine-color-dimmed)" />
			</span>
			<Button
				variant={isActive ? "light" : "subtle"}
				size="xs"
				style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }}
				styles={{ label: { width: "100%", justifyContent: "flex-start" } }}
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
		<Group ref={setNodeRef} style={style} gap="xs" wrap="nowrap" miw={0}>
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
				style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }}
				styles={{ label: { width: "100%", justifyContent: "flex-start" } }}
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

export function CreateNarratorModal({
	opened,
	onClose,
	onCreated,
	initialCwd,
}: CreateNarratorModalProps) {
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const createNarrator = useCreateNarrator();
	const { groupedModels } = useAllModels();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		gcTime: CREATE_NARRATOR_SETTINGS_QUERY_GC_TIME_MS,
	});
	const defaultProjectDir = settings?.paths?.defaultProjectDir ?? "";
	const { data: favorites } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();
	const reorderFavorites = useReorderFavoriteDirectories();

	const [cwd, setCwd] = useState(initialCwd ?? "");
	const [selectedModel, setSelectedModel] = useState("");
	const [startInPlanMode, setStartInPlanMode] = useState(false);
	const [makeNamed, setMakeNamed] = useState(false);
	const [knowledgeSteward, setKnowledgeSteward] = useState(false);
	const [handle, setHandle] = useState("");
	const [activeId, setActiveId] = useState<string | null>(null);

	// Favorites list is a resizable region: defaults to ~5 rows, user can drag to adjust.
	const FAV_LIST_DEFAULT_H = 165;
	const FAV_LIST_MIN_H = 80;
	const FAV_LIST_MAX_H = 400;
	const [favListHeight, setFavListHeight] = useState(FAV_LIST_DEFAULT_H);
	const resizeCleanupRef = useRef<(() => void) | null>(null);

	const startFavResize = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			const startY = e.clientY;
			const startH = favListHeight;
			const onMove = (ev: MouseEvent) => {
				const next = Math.min(
					FAV_LIST_MAX_H,
					Math.max(FAV_LIST_MIN_H, startH + (ev.clientY - startY)),
				);
				setFavListHeight(next);
			};
			const onUp = () => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				resizeCleanupRef.current = null;
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
			resizeCleanupRef.current = onUp;
		},
		[favListHeight],
	);

	// Safety net: detach any dangling listeners if the modal unmounts mid-drag.
	useEffect(() => () => resizeCleanupRef.current?.(), []);

	// Callers may keep this modal mounted across opens (or swap the target directory
	// while it is closed), so adopt `initialCwd` on every open rather than only at mount.
	useEffect(() => {
		if (opened && initialCwd) setCwd(initialCwd);
	}, [opened, initialCwd]);

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
			// biome-ignore lint/suspicious/noExplicitAny: dynamic favorite directory shape
			const oldIndex = favorites.findIndex((f: any) => f.id === active.id);
			// biome-ignore lint/suspicious/noExplicitAny: dynamic favorite directory shape
			const newIndex = favorites.findIndex((f: any) => f.id === over.id);
			if (oldIndex === -1 || newIndex === -1) return;
			const newOrder = [...favorites];
			const [moved] = newOrder.splice(oldIndex, 1);
			newOrder.splice(newIndex, 0, moved);
			// biome-ignore lint/suspicious/noExplicitAny: dynamic favorite directory shape
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
				...(startInPlanMode ? { startInPlanMode: true } : {}),
				...(makeNamed && handle.trim() ? { makeNamed: true, handle: handle.trim() } : {}),
				...(knowledgeSteward ? { kind: "knowledge" as const } : {}),
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
		setMakeNamed(false);
		setKnowledgeSteward(false);
		setHandle("");
	};

	// Wide screens get a two-column layout: the left column is dedicated entirely to
	// directory + favorites, the right column holds model/session options.
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;

	const favoritesDnd = favorites?.length ? (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragCancel={handleDragCancel}
		>
			<SortableContext
				// biome-ignore lint/suspicious/noExplicitAny: dynamic favorite directory shape
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
			{createPortal(
				<DragOverlay dropAnimation={null}>
					{activeFav && (
						<div
							style={{
								backgroundColor: "var(--mantine-color-body)",
								boxShadow: "var(--mantine-shadow-md)",
								borderRadius: 4,
							}}
						>
							<FavoriteItemContent fav={activeFav} isActive={cwd === activeFav.path} />
						</div>
					)}
				</DragOverlay>,
				document.body,
			)}
		</DndContext>
	) : null;

	const directorySection = (
		<>
			{/* DirectoryPicker's inner TextInput carries style={{flex:1}} (for horizontal layouts).
			    Wrap it so that flex:1 cannot stretch it vertically inside the flex-column left pane. */}
			<div style={{ flexShrink: 0 }}>
				<DirectoryPicker
					label={t("workingDirectory")}
					description={t("workingDirectoryHint")}
					placeholder={defaultProjectDir || undefined}
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
			</div>

			{favorites?.length ? (
				// Wide: favorites fills the rest of the column. Narrow: fixed height + drag-to-resize.
				<Stack gap="xs" style={isWide ? { flex: 1, minHeight: 0 } : undefined}>
					<Text size="xs" fw={500} c="dimmed">
						{t("favoriteDirectories")}
					</Text>
					<div
						style={
							isWide
								? { flex: 1, minHeight: 0, overflowY: "auto" }
								: { height: favListHeight, overflowY: "auto" }
						}
					>
						{favoritesDnd}
					</div>
					{!isWide && (
						// Drag handle: resize the favorites list height (narrow layout only).
						<button
							type="button"
							aria-label={t("resizeFavorites")}
							title={t("resizeFavorites")}
							onMouseDown={startFavResize}
							style={{
								height: 6,
								padding: 0,
								border: "none",
								cursor: "ns-resize",
								borderRadius: 3,
								background: "var(--mantine-color-default-border)",
								alignSelf: "stretch",
							}}
						/>
					)}
				</Stack>
			) : null}
		</>
	);

	const optionsSection = (
		<>
			<Select
				label={t("model")}
				description={t("modelHint")}
				data={groupedModels}
				searchable
				limit={MODEL_SELECT_OPTION_LIMIT}
				value={selectedModel || FOLLOW_DEFAULT_MODEL}
				onChange={(v) => setSelectedModel(v ?? "")}
				maxDropdownHeight={320}
				comboboxProps={{
					withinPortal: true,
					position: "bottom-start",
					// 该 Select 位于 Mantine Modal 内,沿用 Mantine 自管层级体系
					// (略高于 Popover 默认 300),不使用全局 Z token,避免破坏 Modal 内叠放。
					zIndex: 320,
				}}
			/>

			<Checkbox
				label={t("startInPlanMode")}
				description={t("startInPlanModeHint")}
				checked={startInPlanMode}
				onChange={(e) => setStartInPlanMode(e.currentTarget.checked)}
			/>

			<Divider label={t("sectionSessionType")} labelPosition="left" />

			<Checkbox
				label={t("makeNamed")}
				description={t("makeNamedHint")}
				checked={makeNamed}
				onChange={(e) => setMakeNamed(e.currentTarget.checked)}
			/>
			{makeNamed && (
				<TextInput
					label={t("handle")}
					description={t("handleHint")}
					placeholder="alice"
					leftSection="@"
					value={handle}
					onChange={(e) => setHandle(e.currentTarget.value)}
					maxLength={32}
				/>
			)}

			<Checkbox
				label={t("knowledgeSteward")}
				description={t("knowledgeStewardHint")}
				checked={knowledgeSteward}
				onChange={(e) => setKnowledgeSteward(e.currentTarget.checked)}
			/>
		</>
	);

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={t("newNarratorModal")}
			size={isWide ? 880 : "md"}
			styles={{
				body: {
					maxHeight: "85vh",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				},
			}}
		>
			{isWide ? (
				// Two columns: left dedicated to directory + favorites, right to options.
				// Use an explicit viewport height (not a flex chain through Modal body, which
				// is unreliable in Mantine modals) so the favorites list can fill the column.
				<Group
					align="stretch"
					wrap="nowrap"
					gap="lg"
					h="calc(85vh - 150px)"
					style={{ minHeight: 0 }}
				>
					<Stack gap="md" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
						{directorySection}
					</Stack>
					<Divider orientation="vertical" />
					<ScrollArea style={{ flex: 1, minWidth: 0 }} type="auto">
						<Stack gap="md" pr="xs">
							{optionsSection}
						</Stack>
					</ScrollArea>
				</Group>
			) : (
				// Single column: everything stacked in one scroll region.
				// Plain ScrollArea (not Autosize) avoids an inner flex wrapper that lacks
				// min-width:0; combined with minWidth:0 here, long favorite paths truncate
				// instead of forcing horizontal scroll on mobile.
				<ScrollArea
					mah="calc(85vh - 64px)"
					style={{ flex: 1, minWidth: 0, minHeight: 0 }}
					type="auto"
				>
					<Stack gap="md" pb="xs">
						{directorySection}
						{optionsSection}
					</Stack>
				</ScrollArea>
			)}

			{/* Fixed footer — always visible, never scrolled out of reach. */}
			<Divider mt="sm" />
			<Group justify="flex-end" pt="sm">
				<Button variant="default" onClick={handleClose}>
					{tc("cancel")}
				</Button>
				<Button
					onClick={handleCreate}
					loading={createNarrator.isPending}
					disabled={makeNamed && handleLength(handle.trim()) < MIN_HANDLE_LENGTH}
				>
					{t("createNarrator")}
				</Button>
			</Group>
		</Modal>
	);
}
