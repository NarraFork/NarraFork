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
	Divider,
	Group,
	Loader,
	Modal,
	NavLink,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import {
	IconArrowUp,
	IconDeviceDesktop,
	IconEye,
	IconEyeOff,
	IconFolder,
	IconFolderOpen,
	IconFolderPlus,
	IconFolderSymlink,
	IconGripVertical,
	IconHome,
	IconPencil,
	IconRefresh,
	IconStar,
	IconStarFilled,
	IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
	useReorderFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import { useFileSystemCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";
import {
	DIRECTORY_BROWSER_MODAL_STYLES,
	DIRECTORY_BROWSER_ROOT_STYLE,
} from "./directory-browser-modal";
import { PathInput } from "./PathInput";

const MAX_DIRECTORY_ENTRIES = 1_000;
const FS_SHORTCUTS_QUERY_GC_TIME_MS = 60_000;

interface DirectoryPickerProps {
	value: string;
	onChange: (path: string) => void;
	label?: string;
	placeholder?: string;
	description?: string;
	error?: string;
	required?: boolean;
	disabled?: boolean;
	/** Extra element rendered before the browse button in rightSection */
	rightSectionExtra?: React.ReactNode;
	leftSection?: React.ReactNode;
	dropdownPosition?: "top" | "bottom";
}

export function DirectoryPicker({
	value,
	onChange,
	label,
	placeholder,
	description,
	error,
	required,
	disabled,
	rightSectionExtra,
	leftSection,
	dropdownPosition,
}: DirectoryPickerProps) {
	const { t } = useTranslation("common");
	const fsCapability = useFileSystemCapability();
	const browseSupported = fsCapability.browse.supported;
	const browseUnavailableReason = fsCapability.browse.reason ?? t("fileSystemBrowseUnavailable");
	const [opened, { open, close }] = useDisclosure(false);
	const [browsePath, setBrowsePath] = useState<string | undefined>(undefined);
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;

	const handleOpen = () => {
		if (!browseSupported) return;
		setBrowsePath(value || undefined);
		open();
	};

	const handleSelect = (path: string) => {
		onChange(path);
		close();
	};

	const rightContent = rightSectionExtra ? (
		<Group gap={2} wrap="nowrap">
			{rightSectionExtra}
			<ActionIcon
				variant="subtle"
				onClick={handleOpen}
				aria-label={t("browse")}
				disabled={disabled || !browseSupported}
				title={!browseSupported ? browseUnavailableReason : undefined}
			>
				<IconFolderOpen size={18} />
			</ActionIcon>
		</Group>
	) : (
		<ActionIcon
			variant="subtle"
			onClick={handleOpen}
			aria-label={t("browse")}
			disabled={disabled || !browseSupported}
			title={!browseSupported ? browseUnavailableReason : undefined}
		>
			<IconFolderOpen size={18} />
		</ActionIcon>
	);

	return (
		<>
			<PathInput
				label={label}
				placeholder={placeholder}
				description={description}
				error={error}
				required={required}
				disabled={disabled}
				value={value}
				onChange={onChange}
				leftSection={leftSection}
				rightSection={rightContent}
				rightSectionWidth={rightSectionExtra ? 64 : undefined}
				dropdownPosition={dropdownPosition}
			/>
			<Modal
				opened={opened}
				onClose={close}
				title={t("selectDirectory")}
				size={isWide ? 880 : "md"}
				styles={DIRECTORY_BROWSER_MODAL_STYLES}
			>
				<DirectoryBrowser
					initialPath={browsePath}
					onSelect={handleSelect}
					onCancel={close}
					isWide={isWide}
				/>
			</Modal>
		</>
	);
}

// ── Sortable Favorite Nav Item ────────────────────────────────────────────────

interface FavoriteNavContentProps {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	fav: any;
	label: string;
	isActive: boolean;
	onNavigate: () => void;
	onRemove: () => void;
	dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
}

function FavoriteNavContent({
	label,
	isActive,
	onNavigate,
	onRemove,
	fav,
	dragHandleProps,
}: FavoriteNavContentProps) {
	return (
		<NavLink
			label={label}
			leftSection={
				<span style={{ display: "flex", cursor: "grab" }} {...dragHandleProps}>
					<IconGripVertical size={12} color="var(--mantine-color-dimmed)" />
				</span>
			}
			rightSection={
				<ActionIcon
					variant="subtle"
					size="xs"
					color="red"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
				>
					<IconTrash size={12} />
				</ActionIcon>
			}
			active={isActive}
			onClick={onNavigate}
			py={4}
			styles={{
				label: { fontSize: 12 },
				root: { borderRadius: 0 },
				section: { marginRight: 4 },
			}}
			title={fav.path}
		/>
	);
}

function SortableFavoriteNav({
	fav,
	label,
	isActive,
	onNavigate,
	onRemove,
}: FavoriteNavContentProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: fav.id,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		visibility: isDragging ? ("hidden" as const) : undefined,
	};

	return (
		<div ref={setNodeRef} style={style}>
			<FavoriteNavContent
				fav={fav}
				label={label}
				isActive={isActive}
				onNavigate={onNavigate}
				onRemove={onRemove}
				dragHandleProps={{ ...attributes, ...listeners }}
			/>
		</div>
	);
}

// ── Directory Browser (modal content) ────────────────────────────────────────

interface DirectoryBrowserProps {
	initialPath?: string;
	onSelect: (path: string) => void;
	onCancel: () => void;
	isWide?: boolean;
}

export function DirectoryBrowser({
	initialPath,
	onSelect,
	onCancel,
	isWide = false,
}: DirectoryBrowserProps) {
	const { t } = useTranslation("common");
	const [currentPath, setCurrentPath] = useState<string | undefined>(initialPath);
	const [creatingFolder, setCreatingFolder] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const [showHidden, setShowHidden] = useState(false);
	const newFolderInputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();
	const fsCapability = useFileSystemCapability();
	const browseSupported = fsCapability.browse.supported;
	const browseUnavailableReason = fsCapability.browse.reason ?? t("fileSystemBrowseUnavailable");
	const shortcutsSupported = fsCapability.shortcuts.supported;
	const mkdirSupported = fsCapability.mkdir.supported;
	const mkdirUnsupportedReason = fsCapability.mkdir.reason ?? t("fileSystemMkdirUnavailable");

	// Editable path bar state
	const [editing, setEditing] = useState(false);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef<HTMLInputElement>(null);

	// Shortcuts (system dirs)
	const { data: shortcutsData } = useQuery({
		queryKey: ["fs-shortcuts"],
		queryFn: () => api.fsShortcuts(),
		enabled: shortcutsSupported,
		staleTime: 60_000,
		gcTime: FS_SHORTCUTS_QUERY_GC_TIME_MS,
	});

	// Favorites
	const { data: favorites = [] } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();
	const reorderFavorites = useReorderFavoriteDirectories();

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
	const [activeFavId, setActiveFavId] = useState<string | null>(null);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const activeFav = activeFavId ? favorites.find((f: any) => f.id === activeFavId) : null;

	const handleFavDragStart = useCallback((event: DragStartEvent) => {
		setActiveFavId(event.active.id as string);
	}, []);

	const handleFavDragEnd = useCallback(
		(event: DragEndEvent) => {
			setActiveFavId(null);
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const oldIndex = favorites.findIndex((f) => f.id === active.id);
			const newIndex = favorites.findIndex((f) => f.id === over.id);
			if (oldIndex === -1 || newIndex === -1) return;
			const newOrder = [...favorites];
			const [moved] = newOrder.splice(oldIndex, 1);
			newOrder.splice(newIndex, 0, moved);
			reorderFavorites.mutate(newOrder.map((f) => f.id));
		},
		[favorites, reorderFavorites],
	);

	const handleFavDragCancel = useCallback(() => {
		setActiveFavId(null);
	}, []);

	const { data, isLoading, error } = useQuery({
		queryKey: ["fs-browse", currentPath, showHidden],
		queryFn: () => api.fsBrowse(currentPath, { showHidden }),
		enabled: browseSupported,
		gcTime: 30_000,
	});
	const displayedEntries = data?.entries.slice(0, MAX_DIRECTORY_ENTRIES) ?? [];
	const hiddenEntryCount = Math.max(0, (data?.entries.length ?? 0) - displayedEntries.length);

	const isFavorited = favorites.some((f) => f.path === (data?.path ?? ""));

	const mkdirMutation = useMutation({
		mutationFn: ({ parent, name }: { parent: string; name: string }) => api.fsMkdir(parent, name),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: ["fs-browse", currentPath, showHidden] });
			setCreatingFolder(false);
			setNewFolderName("");
			setCurrentPath(result.path);
		},
	});

	const hasDrives = (data?.drives?.length ?? 0) > 0;
	const isAtDriveRoot = !data?.path && hasDrives;

	const navigateTo = useCallback((path: string) => {
		setCurrentPath(path);
		setCreatingFolder(false);
		setEditing(false);
	}, []);

	const goUp = useCallback(() => {
		setCreatingFolder(false);
		setEditing(false);
		if (data?.parent) {
			setCurrentPath(data.parent);
		} else if (hasDrives) {
			setCurrentPath(undefined);
		}
	}, [data, hasDrives]);

	const goHome = useCallback(() => {
		setCurrentPath(undefined);
		setCreatingFolder(false);
		setEditing(false);
	}, []);

	const refreshCurrent = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["fs-browse", currentPath, showHidden] });
	}, [queryClient, currentPath, showHidden]);

	const startCreatingFolder = useCallback(() => {
		if (!mkdirSupported) return;
		setNewFolderName("");
		mkdirMutation.reset();
		setCreatingFolder(true);
		setTimeout(() => newFolderInputRef.current?.focus(), 0);
	}, [mkdirMutation, mkdirSupported]);

	const submitNewFolder = useCallback(() => {
		const name = newFolderName.trim();
		// The input is deliberately never `disabled` (that would steal keyboard focus
		// mid-request), so guard the double submit here instead: the Button relies on
		// its `loading` state, the Enter key has nothing else stopping it.
		if (!mkdirSupported || !name || !data?.path || mkdirMutation.isPending) return;
		mkdirMutation.mutate({ parent: data.path, name });
	}, [newFolderName, data?.path, mkdirMutation, mkdirSupported]);

	const startEditing = useCallback(() => {
		setEditValue(data?.path ?? "");
		setEditing(true);
		setTimeout(() => {
			editInputRef.current?.focus();
			editInputRef.current?.select();
		}, 0);
	}, [data?.path]);

	const commitEdit = useCallback(() => {
		const v = editValue.trim();
		if (v) {
			setCurrentPath(v);
		}
		setEditing(false);
	}, [editValue]);

	const cancelEdit = useCallback(() => {
		setEditing(false);
	}, []);

	const toggleFavorite = useCallback(() => {
		if (!data?.path) return;
		const existing = favorites.find((f) => f.path === data.path);
		if (existing) {
			removeFavorite.mutate(existing.id);
		} else {
			addFavorite.mutate({ path: data.path });
		}
	}, [data?.path, favorites, addFavorite, removeFavorite]);

	// Shortcut label mapping
	const shortcutLabel = useCallback(
		(key: string) => {
			const map: Record<string, string> = {
				home: t("homeDirectory"),
				desktop: t("desktop"),
				documents: t("documents"),
				downloads: t("downloads"),
				root: t("rootDirectory"),
			};
			return map[key] || key;
		},
		[t],
	);

	const shortcutIcon = useCallback((key: string) => {
		switch (key) {
			case "home":
				return <IconHome size={16} />;
			case "desktop":
				return <IconDeviceDesktop size={16} />;
			default:
				return <IconFolder size={16} />;
		}
	}, []);

	const handleEntryDoubleClick = useCallback(
		(entryPath: string) => {
			onSelect(entryPath);
		},
		[onSelect],
	);

	return (
		<Stack gap={0} style={DIRECTORY_BROWSER_ROOT_STYLE}>
			{/* ── Toolbar ── */}
			<Group gap={4} px="sm" py={6} wrap="nowrap">
				<Tooltip label={t("homeDirectory")} openDelay={400}>
					<ActionIcon variant="subtle" size="sm" onClick={goHome}>
						<IconHome size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("goUp")} openDelay={400}>
					<ActionIcon variant="subtle" size="sm" onClick={goUp} disabled={isAtDriveRoot}>
						<IconArrowUp size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("refresh")} openDelay={400}>
					<ActionIcon variant="subtle" size="sm" onClick={refreshCurrent}>
						<IconRefresh size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={mkdirSupported ? t("newFolder") : mkdirUnsupportedReason} openDelay={400}>
					<ActionIcon
						variant="subtle"
						size="sm"
						onClick={startCreatingFolder}
						disabled={!data?.path || !mkdirSupported}
					>
						<IconFolderPlus size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={showHidden ? t("hideHiddenDirs") : t("showHiddenDirs")} openDelay={400}>
					<ActionIcon
						variant="subtle"
						size="sm"
						onClick={() => setShowHidden((v) => !v)}
						color={showHidden ? "indigo" : undefined}
					>
						{showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
					</ActionIcon>
				</Tooltip>
			</Group>

			<Divider />

			{/* ── Path bar with star ── */}
			<Group gap={4} px="sm" py={6} wrap="nowrap">
				{editing ? (
					<TextInput
						ref={editInputRef}
						size="xs"
						value={editValue}
						onChange={(e) => setEditValue(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") commitEdit();
							if (e.key === "Escape") cancelEdit();
						}}
						onBlur={commitEdit}
						placeholder={t("pathBarPlaceholder")}
						style={{ flex: 1 }}
						styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
					/>
				) : (
					<UnstyledButton
						onClick={startEditing}
						style={{
							flex: 1,
							fontFamily: "monospace",
							fontSize: 12,
							padding: "4px 8px",
							borderRadius: 4,
							border: "1px solid var(--mantine-color-default-border)",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							minHeight: 30,
							display: "flex",
							alignItems: "center",
						}}
					>
						{data?.path || (isAtDriveRoot ? t("computer") : "~")}
					</UnstyledButton>
				)}
				{!editing && (
					<>
						<Tooltip label={t("editPath")} openDelay={400}>
							<ActionIcon variant="subtle" size="sm" onClick={startEditing}>
								<IconPencil size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip
							label={isFavorited ? t("removeFromFavorites") : t("addToFavorites")}
							openDelay={400}
						>
							<ActionIcon
								variant="subtle"
								size="sm"
								onClick={toggleFavorite}
								disabled={!data?.path}
								color={isFavorited ? "yellow" : undefined}
							>
								{isFavorited ? <IconStarFilled size={14} /> : <IconStar size={14} />}
							</ActionIcon>
						</Tooltip>
					</>
				)}
			</Group>

			<Divider />

			{/* ── Main content: sidebar + directory listing ── */}
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragStart={handleFavDragStart}
				onDragEnd={handleFavDragEnd}
				onDragCancel={handleFavDragCancel}
			>
				<Group gap={0} wrap="nowrap" align="stretch" style={{ flex: 1, minHeight: 0 }}>
					{/* Sidebar: shortcuts + favorites */}
					<ScrollArea
						style={{
							width: isWide ? 220 : 150,
							flexShrink: 0,
							borderRight: "1px solid var(--mantine-color-default-border)",
						}}
						h="100%"
						type="auto"
					>
						{/* System shortcuts */}
						<Text size="xs" fw={600} c="dimmed" px="xs" py={6}>
							{t("quickAccess")}
						</Text>
						<Stack gap={0}>
							{!shortcutsSupported && (
								<Text size="xs" c="dimmed" px="xs" py={4}>
									{fsCapability.shortcuts.reason ?? t("fileSystemShortcutsUnavailable")}
								</Text>
							)}
							{shortcutsData?.shortcuts.map((s) => (
								<NavLink
									key={s.key}
									label={shortcutLabel(s.key)}
									leftSection={shortcutIcon(s.key)}
									active={data?.path === s.path}
									onClick={() => navigateTo(s.path)}
									py={4}
									styles={{
										label: { fontSize: 12 },
										root: { borderRadius: 0 },
									}}
								/>
							))}
							{/* Windows drives */}
							{shortcutsData?.drives?.map((drive) => (
								<NavLink
									key={drive.path}
									label={drive.name}
									leftSection={<IconDeviceDesktop size={16} />}
									active={data?.path?.startsWith(drive.path)}
									onClick={() => navigateTo(drive.path)}
									py={4}
									styles={{
										label: { fontSize: 12 },
										root: { borderRadius: 0 },
									}}
								/>
							))}
						</Stack>

						{/* Favorites */}
						<Divider my={4} />
						<Text size="xs" fw={600} c="dimmed" px="xs" py={6}>
							{t("favorites")}
						</Text>
						<Stack gap={0}>
							{favorites.length === 0 && (
								<Text size="xs" c="dimmed" px="xs" py={4}>
									{t("noFavorites")}
								</Text>
							)}
							<SortableContext
								items={favorites.map((f) => f.id)}
								strategy={verticalListSortingStrategy}
							>
								{favorites.map((fav) => {
									const label =
										fav.label || fav.path.split(/[/\\]/).filter(Boolean).pop() || fav.path;
									return (
										<SortableFavoriteNav
											key={fav.id}
											fav={fav}
											label={label}
											isActive={data?.path === fav.path}
											onNavigate={() => navigateTo(fav.path)}
											onRemove={() => removeFavorite.mutate(fav.id)}
										/>
									);
								})}
							</SortableContext>
						</Stack>
					</ScrollArea>

					{/*
					 * Directory listing. `100%` at every breakpoint, never a fixed pixel height:
					 * the row is already bounded by the browser's own definite height, and a
					 * fixed height left the pane short of the modal's bottom edge on a narrow
					 * portrait viewport — visible as dead space under the last folder while the
					 * list itself still had to scroll.
					 */}
					<ScrollArea style={{ flex: 1, minWidth: 0 }} h="100%" type="auto" offsetScrollbars>
						{!browseSupported && (
							<Text c="dimmed" size="sm" ta="center" mt="xl" px="sm">
								{browseUnavailableReason}
							</Text>
						)}
						{isLoading && <Loader size="sm" m="auto" display="block" mt="xl" />}
						{error && (
							<Text c="red" size="sm" ta="center" mt="xl" px="sm">
								{(error as Error).message}
							</Text>
						)}
						{data && (
							<Stack gap={0}>
								{/* Drive letters (Windows) — shown in main area when at drive root */}
								{isAtDriveRoot && hasDrives && (
									<>
										<Group gap="xs" px="sm" py={4} wrap="wrap">
											{data.drives?.map((drive) => (
												<Button
													key={drive.path}
													variant="subtle"
													size="compact-sm"
													leftSection={<IconDeviceDesktop size={14} />}
													onClick={() => navigateTo(drive.path)}
												>
													{drive.name}
												</Button>
											))}
										</Group>
										<Divider />
									</>
								)}
								{/* Subdirectories */}
								{displayedEntries.map((entry) => {
									// Symlinked directories are navigable like any other, but the
									// distinction matters when picking a path to persist: the link
									// can later be repointed or removed.
									const EntryIcon = entry.isSymlink ? IconFolderSymlink : IconFolder;
									return (
										<UnstyledButton
											key={entry.path}
											onClick={() => navigateTo(entry.path)}
											onDoubleClick={() => handleEntryDoubleClick(entry.path)}
											px="sm"
											py={5}
											className="dir-entry"
											style={{ borderRadius: 0 }}
											title={entry.isSymlink ? t("symlinkDirectory") : undefined}
										>
											<Group gap="xs" wrap="nowrap">
												<EntryIcon
													size={16}
													style={{
														flexShrink: 0,
														opacity: entry.name.startsWith(".") ? 0.5 : 0.8,
													}}
												/>
												<Text
													size="sm"
													truncate
													c={entry.name.startsWith(".") ? "dimmed" : undefined}
												>
													{entry.name}
												</Text>
											</Group>
										</UnstyledButton>
									);
								})}
								{hiddenEntryCount > 0 && (
									<Text c="dimmed" size="xs" ta="center" px="sm" py={8}>
										{t("directoryPickerMoreEntries", { count: hiddenEntryCount })}
									</Text>
								)}
								{/* Inline new folder input */}
								{creatingFolder && data.path && (
									<Group gap="xs" px="sm" py={4} wrap="nowrap">
										<IconFolder size={16} style={{ flexShrink: 0 }} />
										<TextInput
											ref={newFolderInputRef}
											size="xs"
											placeholder={t("newFolderPlaceholder")}
											value={newFolderName}
											onChange={(e) => {
												setNewFolderName(e.currentTarget.value);
												mkdirMutation.reset();
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter") submitNewFolder();
												if (e.key === "Escape") setCreatingFolder(false);
											}}
											error={mkdirMutation.error?.message}
											style={{ flex: 1 }}
										/>
										<Button
											size="compact-xs"
											onClick={submitNewFolder}
											disabled={!newFolderName.trim()}
											loading={mkdirMutation.isPending}
										>
											{t("create")}
										</Button>
									</Group>
								)}
								{data.path && !data.entries.length && !creatingFolder && (
									<Text c="dimmed" size="sm" ta="center" mt="xl">
										{t("emptyDirectory")}
									</Text>
								)}
							</Stack>
						)}
					</ScrollArea>
				</Group>
				{createPortal(
					<DragOverlay dropAnimation={null}>
						{activeFav && (
							<div
								style={{
									backgroundColor: "var(--mantine-color-body)",
									boxShadow: "var(--mantine-shadow-md)",
									width: isWide ? 220 : 150,
								}}
							>
								<FavoriteNavContent
									fav={activeFav}
									label={
										activeFav.label ||
										activeFav.path.split(/[/\\]/).filter(Boolean).pop() ||
										activeFav.path
									}
									isActive={data?.path === activeFav.path}
									onNavigate={() => {}}
									onRemove={() => {}}
								/>
							</div>
						)}
					</DragOverlay>,
					document.body,
				)}
			</DndContext>

			<Divider />

			{/* ── Bottom bar ── */}
			<Group justify="space-between" px="sm" py={8}>
				<Text size="xs" c="dimmed" truncate style={{ flex: 1 }} ff="monospace">
					{data?.path}
				</Text>
				<Group gap="xs">
					<Button variant="default" size="sm" onClick={onCancel}>
						{t("cancel")}
					</Button>
					<Button
						size="sm"
						onClick={() => data?.path && onSelect(data.path)}
						disabled={!data?.path}
					>
						{t("selectThisDirectory")}
					</Button>
				</Group>
			</Group>
		</Stack>
	);
}
