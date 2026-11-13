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
import { restrictToVerticalAxis } from "@frontend/lib/dnd-modifiers";
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
import { notifications } from "@mantine/notifications";
import { handleLength, MIN_HANDLE_LENGTH } from "@shared/narrator-handle";
import {
	IconFolder,
	IconFolderOpen,
	IconGripVertical,
	IconStar,
	IconStarFilled,
	IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
	useReorderFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import {
	narratorGitIdentityQueryKey,
	useFolderGitIdentity,
	useGitIdentities,
} from "../../hooks/useGitIdentities";
import { useGitIdentityVisibility } from "../../hooks/useGitIdentityVisibility";
import { useAllModels } from "../../hooks/useModels";
import { useCreateNarrator } from "../../hooks/useNarrator";
import { useProjectDirStatus } from "../../hooks/useProjectDirStatus";
import { useWorkspaceDevices } from "../../hooks/useWorkspaceContext";
import { api } from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import { Z } from "../../lib/z-index";
import { DirectoryPicker } from "../common/DirectoryPicker";
import { DIRECTORY_BROWSER_MODAL_STYLES } from "../common/directory-browser-modal";
import { resolveCwdPrefill } from "./composer/create-narrator-cwd-prefill";
import {
	resolveStartInPlanModePrefill,
	shouldSendStartInPlanMode,
} from "./composer/create-narrator-plan-mode-prefill";
import { followIdentityKind } from "./details/git-identity-follow-label";
import { ProjectPromptModal } from "./ProjectPromptModal";

const RemoteDirectoryBrowser = lazy(() =>
	import("../permissions/RemoteDirectoryBrowser").then((module) => ({
		default: module.RemoteDirectoryBrowser,
	})),
);

const MODEL_SELECT_OPTION_LIMIT = 100;
const CREATE_NARRATOR_SETTINGS_QUERY_GC_TIME_MS = 60_000;

const LOCAL_DEVICE = "local";

/** 选择它表示不写绑定，跟随本人的默认身份（与会话详情面板的哨兵值一致）。 */
const FOLLOW_DEFAULT_GIT_IDENTITY = "__follow_default__";

export interface CreateNarratorResult {
	id: string;
	title: string;
	cwd?: string;
	status: string;
}

export interface CreateNarratorModalProps {
	opened: boolean;
	onClose: () => void;
	onCreated?: (narrator: CreateNarratorResult) => void;
	/** Pre-fill the working directory (e.g. "new narrator in this directory" entry points). */
	initialCwd?: string;
	/** Explicit project membership; a directory alone never implies a project. */
	contextProjectId?: string;
	/**
	 * 侧栏文件夹 id：从这个文件夹里新建会话时传入。
	 *
	 * 会话自身不写 git 身份 pick，运行时按「会话 → 文件夹 → 全局」解析，所以这里只需
	 * 让选择器说清"跟随"跟的是哪一条。
	 */
	gitIdentityFolderId?: string;
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

export function CreateNarratorModalBody({
	opened,
	onClose,
	onCreated,
	initialCwd,
	contextProjectId,
	gitIdentityFolderId,
}: CreateNarratorModalProps) {
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const createNarrator = useCreateNarrator();
	const queryClient = useQueryClient();
	const { groupedModels } = useAllModels();
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		gcTime: CREATE_NARRATOR_SETTINGS_QUERY_GC_TIME_MS,
	});
	// Only a default that EXISTS is prefilled: the server no longer creates it, so an unset
	// or deleted one would just fail the create.
	const { usablePath, needsChoice } = useProjectDirStatus();
	const defaultProjectDir = usablePath ?? "";
	const [promptEditorOpen, setPromptEditorOpen] = useState(false);
	const { data: favorites } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();
	const reorderFavorites = useReorderFavoriteDirectories();

	const [cwd, setCwd] = useState(initialCwd ?? "");
	// Which execution device the session starts on. A remote device makes `cwd` a path
	// on THAT machine, so the local picker (favorites, mkdir, drive list) does not apply.
	const [deviceId, setDeviceId] = useState<string>(LOCAL_DEVICE);
	const [remoteBrowserOpen, setRemoteBrowserOpen] = useState(false);
	const workspaceDevicesQuery = useWorkspaceDevices(contextProjectId ?? null, opened);
	const remoteDevices = (workspaceDevicesQuery.data?.devices ?? []).filter(
		(device) => device.id !== LOCAL_DEVICE,
	);
	const selectedDevice = remoteDevices.find((device) => device.id === deviceId);
	const isRemoteDevice = deviceId !== LOCAL_DEVICE;
	const [selectedModel, setSelectedModel] = useState("");
	// The switch starts as a placeholder for "follow agent.defaultStartInPlanMode".
	// `startInPlanModeTouched` records an immediate user flip so a late-arriving
	// settings default cannot rewrite it; `planModePrefilledForOpenRef` stops the
	// prefill from writing more than once per open (same timing shape as cwd).
	const [startInPlanMode, setStartInPlanMode] = useState(false);
	const [startInPlanModeTouched, setStartInPlanModeTouched] = useState(false);
	const planModePrefilledForOpenRef = useRef(false);
	const defaultStartInPlanMode = settings?.agent?.defaultStartInPlanMode ?? false;
	// Query resolved ⇒ we know the default (server merges agent defaults). Until
	// then the switch is a placeholder and submit omits the field.
	const planModeSettingsKnown = settings != null;
	const [sessionTitle, setSessionTitle] = useState("");
	const [makeNamed, setMakeNamed] = useState(false);
	const [knowledgeSteward, setKnowledgeSteward] = useState(false);
	// A bot is met in a chat room and signs its messages with its title, so it is named
	// at creation (the server refuses an unnamed bot). Exclusive with the steward kind.
	const [bot, setBot] = useState(false);
	// 提交身份只对当前用户生效（服务端按 用户 × 会话 保存），默认跟随本人默认身份。
	const [gitIdentityId, setGitIdentityId] = useState(FOLLOW_DEFAULT_GIT_IDENTITY);
	const gitIdentityVisibility = useGitIdentityVisibility();
	const {
		data: gitIdentityList,
		isLoading: gitIdentitiesLoading,
		isError: gitIdentitiesError,
	} = useGitIdentities(gitIdentityVisibility.createModal);
	const gitIdentities = gitIdentityList ?? [];
	const defaultGitIdentity = gitIdentities.find((identity) => identity.isDefault);
	// 从文件夹里新建："跟随"跟的是该文件夹的 git 身份（运行时按 会话→文件夹→全局 解析）。
	const { data: folderGitIdentity } = useFolderGitIdentity(
		opened && gitIdentityVisibility.createModal ? (gitIdentityFolderId ?? null) : null,
	);
	const folderIdentity = folderGitIdentity?.selectedId
		? folderGitIdentity.identities.find((identity) => identity.id === folderGitIdentity.selectedId)
		: undefined;
	const [handle, setHandle] = useState("");
	const [activeId, setActiveId] = useState<string | null>(null);
	// No directory typed and no usable default: the server would refuse, so ask up front.
	// A project context supplies its own directory — but only for the LOCAL device: a
	// remote creation always needs an explicit path on that machine.
	const directoryRequired = isRemoteDevice
		? !cwd.trim()
		: needsChoice && !cwd.trim() && !contextProjectId;

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

	// When the caller gives no entry-point directory, pre-fill the instance's default
	// project directory: the field previously only SHOWED it as a placeholder while an
	// empty submit actually created the narrator in ~, which read as "the setting does
	// nothing". Prefilling makes what you see what you get.
	//
	// The decision lives in `resolveCwdPrefill` because it is a timing question — the
	// settings query is often unresolved on the first open, so the default arrives a
	// render or two late and a fires-once-on-open effect would miss it permanently.
	const prefilledForOpenRef = useRef(false);
	useEffect(() => {
		if (isRemoteDevice) {
			// The instance's default project directory is a path on THIS server; pre-filling
			// it into a remote session would create it in a directory that does not exist
			// there. Re-arm the prefill so switching back to local still adopts it.
			prefilledForOpenRef.current = false;
			return;
		}
		const decision = resolveCwdPrefill({
			opened,
			alreadyPrefilled: prefilledForOpenRef.current,
			initialCwd,
			cwd,
			defaultProjectDir,
		});
		if (decision.kind === "reset") {
			prefilledForOpenRef.current = false;
			return;
		}
		if (decision.kind === "markPrefilled") {
			prefilledForOpenRef.current = true;
			return;
		}
		if (decision.kind === "prefill") {
			setCwd(decision.value);
			prefilledForOpenRef.current = true;
		}
	}, [opened, cwd, initialCwd, defaultProjectDir, isRemoteDevice]);

	// Same timing question as the cwd field: the settings query is often unresolved
	// on the first open, so `defaultStartInPlanMode` arrives a render or two late.
	// Adopt it until the user flips the switch; never after.
	useEffect(() => {
		const decision = resolveStartInPlanModePrefill({
			opened,
			userTouched: startInPlanModeTouched,
			alreadyPrefilled: planModePrefilledForOpenRef.current,
			value: startInPlanMode,
			settingsKnown: planModeSettingsKnown,
			defaultStartInPlanMode,
		});
		if (decision.kind === "reset") {
			planModePrefilledForOpenRef.current = false;
			if (startInPlanModeTouched) setStartInPlanModeTouched(false);
			if (startInPlanMode) setStartInPlanMode(false);
			return;
		}
		if (decision.kind === "markPrefilled") {
			planModePrefilledForOpenRef.current = true;
			return;
		}
		if (decision.kind === "prefill") {
			setStartInPlanMode(decision.value);
			planModePrefilledForOpenRef.current = true;
		}
	}, [
		opened,
		startInPlanModeTouched,
		startInPlanMode,
		planModeSettingsKnown,
		defaultStartInPlanMode,
	]);

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

	/**
	 * Switching the execution device resets the directory field.
	 *
	 * A local path does not exist on another machine and a remote path does not exist
	 * here, so carrying the value across the switch would pre-fill a directory the
	 * create request must then reject.
	 */
	const handleDeviceChange = (nextDeviceId: string) => {
		setDeviceId(nextDeviceId);
		if (nextDeviceId === LOCAL_DEVICE) {
			setCwd(initialCwd ?? defaultProjectDir ?? "");
			return;
		}
		const device = remoteDevices.find((entry) => entry.id === nextDeviceId);
		setCwd(device?.defaultCwd?.trim() ?? "");
	};

	const handleCreate = () => {
		// Explicit boolean whenever the switch means something (user flipped it, or
		// the instance default is showing on it). Omitting `false` would let the
		// server's `input.startInPlanMode ?? defaultStartInPlanMode` re-impose the
		// default over a deliberate uncheck — the silent-override bug.
		const sendPlanMode = shouldSendStartInPlanMode({
			userTouched: startInPlanModeTouched,
			settingsKnown: planModeSettingsKnown,
		});
		createNarrator.mutate(
			{
				...(cwd ? { cwd } : {}),
				...(isRemoteDevice ? { deviceId } : {}),
				...(contextProjectId ? { contextProjectId } : {}),
				model: selectedModel || FOLLOW_DEFAULT_MODEL,
				...(sendPlanMode ? { startInPlanMode } : {}),
				// 自定义标题留空时不传，服务端沿用「首条消息后自动命名」的原逻辑。
				...(sessionTitle.trim() ? { title: sessionTitle.trim() } : {}),
				...(makeNamed && handle.trim() ? { makeNamed: true, handle: handle.trim() } : {}),
				...(bot
					? { kind: "bot" as const }
					: knowledgeSteward
						? { kind: "knowledge" as const }
						: {}),
			},
			{
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				onSuccess: (data: any) => {
					// 身份绑定是第二个请求：创建本身已经成功，写失败只提示、不回滚也不阻塞进入会话。
					// 开关关掉后不再提交隐藏的选择；成功后作废详情面板的查询，避免 30 秒内显示旧值。
					if (gitIdentityVisibility.createModal && gitIdentityId !== FOLLOW_DEFAULT_GIT_IDENTITY) {
						const narratorId = data.id as string;
						void api.setNarratorGitIdentity(narratorId, gitIdentityId).then(
							() => {
								void queryClient.invalidateQueries({
									queryKey: narratorGitIdentityQueryKey(narratorId),
								});
							},
							(error: unknown) => {
								notifications.show({
									color: "red",
									title: tc("operationFailed"),
									message: error instanceof Error ? error.message : tc("unknownError"),
								});
							},
						);
					}
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

	const resetForm = useCallback(() => {
		setCwd("");
		setDeviceId(LOCAL_DEVICE);
		setRemoteBrowserOpen(false);
		setSelectedModel("");
		// Reset to "follow settings" — not a hard false preference. The next open
		// re-adopts agent.defaultStartInPlanMode via the prefill effect.
		setStartInPlanMode(false);
		setStartInPlanModeTouched(false);
		planModePrefilledForOpenRef.current = false;
		setMakeNamed(false);
		setKnowledgeSteward(false);
		setBot(false);
		setHandle("");
		setSessionTitle("");
		setPromptEditorOpen(false);
		setGitIdentityId(FOLLOW_DEFAULT_GIT_IDENTITY);
	}, []);

	const handleClose = () => {
		onClose();
		resetForm();
	};

	// The shell may close from its own title bar, bypassing the body's cancel button.
	useEffect(() => {
		if (!opened) resetForm();
	}, [opened, resetForm]);

	// Wide screens get a two-column layout: the left column is dedicated entirely to
	// directory + favorites, the right column holds model/session options.
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;

	const favoritesDnd = favorites?.length ? (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			modifiers={[restrictToVerticalAxis]}
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
			{/* Device first: it decides what the directory below even means. Local keeps the
			    existing picker + favorites; a remote device gets a plain absolute-path field
			    with the device's own directory browser, because a local path list would be
			    meaningless there. */}
			<Select
				label={t("executionDevice")}
				description={t("executionDeviceHint")}
				data={[
					{ value: LOCAL_DEVICE, label: t("executionDeviceLocal") },
					...remoteDevices.map((device) => ({
						value: device.id,
						label: device.online ? device.name : `${device.name} · ${t("executionDeviceOffline")}`,
						disabled: !device.online,
					})),
				]}
				value={deviceId}
				onChange={(value) => handleDeviceChange(value ?? LOCAL_DEVICE)}
				allowDeselect={false}
				comboboxProps={{ withinPortal: true, position: "bottom-start", zIndex: 320 }}
				style={{ flexShrink: 0 }}
			/>

			{isRemoteDevice ? (
				<Stack gap={6} style={{ flexShrink: 0 }}>
					<TextInput
						label={t("workingDirectory")}
						description={t("workingDirectoryRemoteHint", {
							device: selectedDevice?.name ?? deviceId,
						})}
						placeholder={selectedDevice?.defaultCwd ?? t("workingDirectoryPlaceholder")}
						leftSection={<IconFolder size={16} />}
						value={cwd}
						onChange={(event) => setCwd(event.currentTarget.value)}
						error={directoryRequired ? t("workingDirectoryRemoteRequired") : undefined}
					/>
					<Group gap="xs">
						<Button
							size="compact-xs"
							variant="light"
							leftSection={<IconFolderOpen size={14} />}
							onClick={() => setRemoteBrowserOpen(true)}
						>
							{t("browseRemoteDirectory")}
						</Button>
						{selectedDevice?.defaultCwd ? (
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => setCwd(selectedDevice.defaultCwd ?? "")}
							>
								{t("useDeviceDefaultDirectory")}
							</Button>
						) : null}
					</Group>
				</Stack>
			) : (
				<>
					{/* DirectoryPicker's inner TextInput carries style={{flex:1}} (for horizontal layouts).
				    Wrap it so that flex:1 cannot stretch it vertically inside the flex-column left pane. */}
					<div style={{ flexShrink: 0 }}>
						<DirectoryPicker
							label={t("workingDirectory")}
							description={directoryRequired ? undefined : t("workingDirectoryHint")}
							error={directoryRequired ? t("workingDirectoryRequired") : undefined}
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
			)}
		</>
	);

	const projectPromptSection = (
		<Stack gap={6}>
			<Button variant="light" disabled={!cwd.trim()} onClick={() => setPromptEditorOpen(true)}>
				{t("projectPromptOpen")}
			</Button>
			<Text size="xs" c="dimmed">
				{cwd.trim() ? t("projectPromptOpenHint") : t("projectPromptChooseDirectory")}
			</Text>
		</Stack>
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

			{gitIdentityVisibility.createModal && (
				<>
					<Select
						label={t("narrator:details.gitIdentity")}
						description={t("narrator:details.gitIdentityCreateDescription")}
						data={[
							{
								value: FOLLOW_DEFAULT_GIT_IDENTITY,
								label: gitIdentitiesLoading
									? t("common:loading")
									: followIdentityKind(folderIdentity, defaultGitIdentity) === "folder"
										? t("narrator:details.gitIdentityFollowFolder", {
												name: folderIdentity?.name,
											})
										: defaultGitIdentity
											? t("narrator:details.gitIdentityFollowDefault", {
													name: defaultGitIdentity.name,
												})
											: t("narrator:details.gitIdentityFollowDefaultPlain"),
							},
							...gitIdentities.map((identity) => ({
								value: identity.id,
								label: `${identity.name} <${identity.email}>`,
							})),
						]}
						value={gitIdentityId}
						onChange={(value) => setGitIdentityId(value ?? FOLLOW_DEFAULT_GIT_IDENTITY)}
						disabled={gitIdentitiesLoading || gitIdentitiesError || gitIdentities.length === 0}
						comboboxProps={{ withinPortal: true, position: "bottom-start", zIndex: 320 }}
					/>
					{gitIdentitiesError ? (
						<Text size="xs" c="red">
							{t("narrator:details.gitIdentityCreateLoadFailed")}
						</Text>
					) : !gitIdentitiesLoading && gitIdentities.length === 0 ? (
						<Text size="xs" c="dimmed">
							{t("narrator:details.gitIdentityUnconfigured")}
						</Text>
					) : null}
				</>
			)}

			<Checkbox
				label={t("startInPlanMode")}
				description={t("startInPlanModeHint")}
				checked={startInPlanMode}
				onChange={(e) => {
					// Immediate preference: after this, settings defaults must not rewrite
					// the switch, and submit always carries this explicit boolean.
					setStartInPlanMode(e.currentTarget.checked);
					setStartInPlanModeTouched(true);
					planModePrefilledForOpenRef.current = true;
				}}
			/>

			<TextInput
				label={bot ? t("botName") : t("sessionTitle")}
				description={bot ? t("botNameHint") : t("sessionTitleHint")}
				required={bot}
				value={sessionTitle}
				onChange={(e) => setSessionTitle(e.currentTarget.value)}
				maxLength={200}
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
				onChange={(e) => {
					setKnowledgeSteward(e.currentTarget.checked);
					if (e.currentTarget.checked) setBot(false);
				}}
			/>

			<Checkbox
				label={t("botNarrator")}
				description={t("botNarratorHint")}
				checked={bot}
				onChange={(e) => {
					setBot(e.currentTarget.checked);
					if (e.currentTarget.checked) setKnowledgeSteward(false);
				}}
			/>

			{projectPromptSection}
		</>
	);

	return (
		<>
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
					onClick={() => void handleCreate()}
					loading={createNarrator.isPending}
					disabled={
						directoryRequired ||
						(makeNamed && handleLength(handle.trim()) < MIN_HANDLE_LENGTH) ||
						(bot && !sessionTitle.trim())
					}
				>
					{t("createNarrator")}
				</Button>
			</Group>
			{promptEditorOpen && cwd.trim() ? (
				<ProjectPromptModal cwd={cwd} onClose={() => setPromptEditorOpen(false)} />
			) : null}
			{isRemoteDevice ? (
				<Modal
					opened={remoteBrowserOpen}
					onClose={() => setRemoteBrowserOpen(false)}
					title={t("browseRemoteDirectoryTitle", { device: selectedDevice?.name ?? deviceId })}
					size="md"
					// Opened from inside this modal: use the global modal token, not Mantine's
					// base modal level, or the picker would render behind its parent.
					zIndex={Z.modal}
					styles={DIRECTORY_BROWSER_MODAL_STYLES}
				>
					{remoteBrowserOpen ? (
						<Suspense fallback={null}>
							<RemoteDirectoryBrowser
								deviceLabel={selectedDevice?.name ?? deviceId}
								initialPath={cwd.trim() || undefined}
								listDirectory={(path, opts) =>
									api.browseWorkspaceDirectory(deviceId, path, {
										showHidden: opts.showHidden,
										projectId: contextProjectId,
									})
								}
								queryKey={["workspaceDeviceBrowse", deviceId, contextProjectId ?? null]}
								onSelect={(path) => {
									setCwd(path);
									setRemoteBrowserOpen(false);
								}}
								onCancel={() => setRemoteBrowserOpen(false)}
							/>
						</Suspense>
					) : null}
				</Modal>
			) : null}
		</>
	);
}

/** Compatibility wrapper for callers that still own the Mantine modal. */
export function CreateNarratorModal(props: CreateNarratorModalProps) {
	const { t } = useTranslation("narrators");
	const isWide = useMediaQuery("(min-width: 62em)") ?? false;
	return (
		<Modal
			opened={props.opened}
			onClose={props.onClose}
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
			<CreateNarratorModalBody {...props} />
		</Modal>
	);
}
