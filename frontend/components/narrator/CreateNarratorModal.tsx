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
	Textarea,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { handleLength, MIN_HANDLE_LENGTH } from "@shared/narrator-handle";
import { IconFolder, IconGripVertical, IconStar, IconStarFilled, IconX } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
	useReorderFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import { narratorGitIdentityQueryKey, useGitIdentities } from "../../hooks/useGitIdentities";
import { useGitIdentityVisibility } from "../../hooks/useGitIdentityVisibility";
import { useAllModels } from "../../hooks/useModels";
import { useCreateNarrator } from "../../hooks/useNarrator";
import { useProjectDirStatus } from "../../hooks/useProjectDirStatus";
import type { OptimizeStyle } from "../../hooks/usePromptOptimize";
import { api } from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import { DirectoryPicker } from "../common/DirectoryPicker";
import { resolveCwdPrefill } from "./composer/create-narrator-cwd-prefill";
import {
	resolveStartInPlanModePrefill,
	shouldSendStartInPlanMode,
} from "./composer/create-narrator-plan-mode-prefill";
import {
	TextareaOptimizeControls,
	textareaOptimizeControlsWidth,
} from "./composer/TextareaOptimizeControls";

/**
 * Drag limits for the project-prompt box, in px.
 *
 * The minimum matches the `rows={6}` default so a drag can never make the box smaller
 * than it opens; the maximum keeps the dialog's footer reachable on a laptop screen.
 */
const PROMPT_MIN_HEIGHT = 132;
const PROMPT_MAX_HEIGHT = 520;

const MODEL_SELECT_OPTION_LIMIT = 100;
const CREATE_NARRATOR_SETTINGS_QUERY_GC_TIME_MS = 60_000;

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
}: CreateNarratorModalProps) {
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	// The optimize affordance is the composer's, so its labels come from the same
	// namespace rather than being duplicated here with slightly different wording.
	const { t: tn } = useTranslation("narrator");
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
	const { data: favorites } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();
	const reorderFavorites = useReorderFavoriteDirectories();

	const [cwd, setCwd] = useState(initialCwd ?? "");
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
	// ── Project prompt file (AGENTS.md & friends) ───────────────────────────────
	// The box is NOT a per-session system prompt stored on the narrator: it edits the
	// file that `narrator-prompt` already injects for every session in this directory,
	// so what the user sees here is what every narrator in this directory will read.
	//
	// `draft` is what the textarea shows, `baseline` is what was loaded — their
	// difference is the only reason a save happens. `loadedKeyRef` is the identity of
	// the file the baseline came from (`path|hash`), so a refetch that changed nothing
	// cannot overwrite typing in progress, while changing the directory does load the
	// new file (a stale baseline would otherwise be written into the wrong project).
	const projectPromptQuery = useQuery({
		queryKey: ["project-prompt", cwd],
		queryFn: () => api.getProjectPrompt(cwd),
		enabled: opened && cwd.trim().length > 0,
		retry: false,
		// A prompt file is cheap to refetch and the dialog is short-lived; the server
		// answers 409 on a stale save, so a cached copy costs a retry rather than data.
		staleTime: 0,
		gcTime: 0,
	});
	const [promptDraft, setPromptDraft] = useState("");
	const [promptBaseline, setPromptBaseline] = useState("");
	const promptLoadedKeyRef = useRef<string | null>(null);
	// The optimistic lock as it stands NOW, not as the query last reported it: after a
	// successful save the file on disk holds the new bytes, so a retried create (the
	// narrator request failed, the save did not) must lock against what was written
	// rather than re-sending the hash from before the save.
	const promptHashRef = useRef<string | null>(null);
	// Height the user dragged the box to; `null` means "never dragged", so the box keeps
	// its `rows` default and a dialog reopened on another directory does not inherit a
	// height chosen for a different file.
	const [promptHeight, setPromptHeight] = useState<number | null>(null);
	const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
	const promptResizeCleanupRef = useRef<(() => void) | null>(null);
	const [optimizingPrompt, setOptimizingPrompt] = useState(false);
	const [savingPrompt, setSavingPrompt] = useState(false);
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
	const [handle, setHandle] = useState("");
	const [activeId, setActiveId] = useState<string | null>(null);
	// No directory typed and no usable default: the server would refuse, so ask up front.
	// A project context supplies its own directory.
	const directoryRequired = needsChoice && !cwd.trim() && !contextProjectId;

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
	}, [opened, cwd, initialCwd, defaultProjectDir]);

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

	// Adopt the loaded file into the box, once per identity. Keyed on `path|hash` rather
	// than on the query object: a refetch of unchanged content must not reset text the
	// user is still typing, but a different file (other directory, or the same file
	// edited by an agent meanwhile) must.
	const projectPrompt = projectPromptQuery.data;
	const projectPromptKey = projectPrompt
		? `${projectPrompt.path}|${projectPrompt.hash ?? "absent"}`
		: null;
	useEffect(() => {
		if (!projectPrompt || projectPromptKey === promptLoadedKeyRef.current) return;
		promptLoadedKeyRef.current = projectPromptKey;
		promptHashRef.current = projectPrompt.hash;
		// Coerced rather than trusted: a response that carries no `content` must leave an
		// empty box, never write `undefined` into the draft (which then crashes every
		// `.trim()` in this section and would also be sent as the file body).
		const content = typeof projectPrompt.content === "string" ? projectPrompt.content : "";
		setPromptDraft(content);
		setPromptBaseline(content);
	}, [projectPrompt, projectPromptKey]);

	/**
	 * Switch the prompt box to another directory.
	 *
	 * The reset is explicit rather than inferred from `cwd` in an effect: `cwd` starts
	 * empty and is prefilled a render later, so "the directory is empty" cannot be told
	 * apart from "the prefill has not arrived" — the effect version cleared the box it
	 * had just loaded.
	 */
	const applyCwd = useCallback((next: string) => {
		setCwd(next);
		promptLoadedKeyRef.current = null;
		promptHashRef.current = null;
		setPromptHeight(null);
		setPromptDraft("");
		setPromptBaseline("");
	}, []);

	const promptDirty = promptDraft !== promptBaseline;
	// A truncated file is a PREFIX of the real one; saving it back would delete
	// everything past the cut, so editing is refused instead.
	const promptEditable =
		!!projectPrompt && !projectPrompt.truncated && !projectPromptQuery.isPending;

	/**
	 * Drag the prompt box by its own corner grip.
	 *
	 * Native `resize` cannot serve this box. `autosize` recomputes `style.height` in a
	 * dependency-less `useLayoutEffect` (`@mantine/core` Textarea/Autosize.mjs) and forces
	 * `overflow-y: hidden`, so a dragged height is reverted by the next render while the
	 * browser still paints a ~10px grip that looks usable. Owning the height in React
	 * state is what makes the drag actually stick, and a real element is what gives the
	 * grip a hit area bigger than the browser's ~10px corner.
	 */
	const startPromptResize = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			if (!promptEditable) return;
			const input = promptInputRef.current;
			if (!input) return;
			// Keeps the drag from starting a text selection inside the textarea.
			event.preventDefault();
			const startY = event.clientY;
			const startHeight = input.getBoundingClientRect().height;
			setPromptHeight(startHeight);
			const onMove = (moveEvent: PointerEvent) => {
				const next = Math.round(startHeight + (moveEvent.clientY - startY));
				setPromptHeight(Math.min(PROMPT_MAX_HEIGHT, Math.max(PROMPT_MIN_HEIGHT, next)));
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				promptResizeCleanupRef.current = null;
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			promptResizeCleanupRef.current = onUp;
		},
		[promptEditable],
	);

	// A focusable grip must be operable without a mouse.
	const handlePromptResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
		const step = event.key === "ArrowUp" ? -20 : event.key === "ArrowDown" ? 20 : 0;
		if (step === 0) return;
		event.preventDefault();
		const current = promptInputRef.current?.getBoundingClientRect().height ?? PROMPT_MIN_HEIGHT;
		setPromptHeight(
			Math.min(PROMPT_MAX_HEIGHT, Math.max(PROMPT_MIN_HEIGHT, Math.round(current + step))),
		);
	}, []);

	// Safety net, same shape as the favorites list's: no listeners survive the modal.
	useEffect(() => () => promptResizeCleanupRef.current?.(), []);

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
	 * Write the project prompt file if — and only if — the user changed it.
	 *
	 * Runs BEFORE the narrator is created, deliberately: if the file cannot be saved
	 * (a concurrent agent edit, a permission refusal) the dialog stays open with the
	 * user's text intact. Creating first would leave a session behind whose prompt was
	 * never written, and the error would arrive with nothing to retry.
	 */
	const saveProjectPromptBeforeCreate = async (): Promise<boolean> => {
		if (!projectPrompt || !promptDirty) return true;
		// A truncated file was never fully loaded; the textarea is read-only in that
		// state, so `promptDirty` can only be false here — kept as an explicit guard.
		if (projectPrompt.truncated) return true;
		setSavingPrompt(true);
		try {
			const saved = await api.saveProjectPrompt({
				cwd: projectPrompt.cwd,
				filename: projectPrompt.filename,
				content: promptDraft,
				baseHash: promptHashRef.current,
			});
			// Rebase on what was written, so a failed CREATE followed by a retry does not
			// save the same text twice (the second save would 409 against itself).
			promptLoadedKeyRef.current = `${saved.path}|${saved.hash}`;
			promptHashRef.current = saved.hash;
			setPromptBaseline(promptDraft);
			return true;
		} catch (error) {
			notifications.show({
				color: "red",
				title: t("projectPromptSaveFailed"),
				message: error instanceof Error ? error.message : tc("unknownError"),
				autoClose: 12000,
			});
			return false;
		} finally {
			setSavingPrompt(false);
		}
	};

	/**
	 * The composer's ✨ button, for a file that has no session: same styles, same
	 * optimize model, served by `/api/narrators/optimize-prompt` (no narrator id).
	 *
	 * The result is applied only if the box still holds the text that was sent. An
	 * optimization can take tens of seconds, and silently replacing whatever the user
	 * typed meanwhile is the failure the composer's own delivery path guards against.
	 */
	const optimizeAbortRef = useRef<AbortController | null>(null);
	const handleOptimizePrompt = async (style: OptimizeStyle) => {
		const original = promptDraft;
		if (!original.trim() || optimizingPrompt) return;
		optimizeAbortRef.current?.abort();
		const controller = new AbortController();
		optimizeAbortRef.current = controller;
		setOptimizingPrompt(true);
		try {
			const result = await api.optimizeDraftPrompt(original, style, {
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			setPromptDraft((current) => {
				if (current !== original) {
					notifications.show({
						title: tn("optimizeFailed"),
						message: tn("richComposer.optimizeChanged"),
						color: "red",
						autoClose: 10000,
					});
					return current;
				}
				notifications.show({
					message: tn("optimizeSuccess"),
					color: "green",
					autoClose: 8000,
				});
				return result.text;
			});
			const summary = result.reasoningSummary?.trim();
			if (summary) {
				notifications.show({
					title: tn("optimizeSummaryTitle"),
					message: summary,
					color: "indigo",
					autoClose: 12000,
					withCloseButton: true,
				});
			}
		} catch (error) {
			// An aborted request is the user's own cancel, not a failure.
			if (controller.signal.aborted) return;
			const raw = error instanceof Error ? error.message : "";
			const message =
				raw.includes("timeout") || raw.includes("timed out")
					? tn("optimizeTimeout")
					: raw || tn("optimizeFailedGeneric");
			notifications.show({
				title: tn("optimizeFailed"),
				message,
				color: "red",
				autoClose: 10000,
			});
		} finally {
			if (optimizeAbortRef.current === controller) optimizeAbortRef.current = null;
			setOptimizingPrompt(false);
		}
	};

	const handleCreate = async () => {
		// Explicit boolean whenever the switch means something (user flipped it, or
		// the instance default is showing on it). Omitting `false` would let the
		// server's `input.startInPlanMode ?? defaultStartInPlanMode` re-impose the
		// default over a deliberate uncheck — the silent-override bug.
		const sendPlanMode = shouldSendStartInPlanMode({
			userTouched: startInPlanModeTouched,
			settingsKnown: planModeSettingsKnown,
		});
		if (!(await saveProjectPromptBeforeCreate())) return;
		createNarrator.mutate(
			{
				...(cwd ? { cwd } : {}),
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
		setGitIdentityId(FOLLOW_DEFAULT_GIT_IDENTITY);
		// The prompt box belongs to a directory, not to the form: clearing the identity
		// is what lets the next open adopt the file from scratch.
		promptLoadedKeyRef.current = null;
		promptHashRef.current = null;
		setPromptDraft("");
		setPromptBaseline("");
		setSavingPrompt(false);
		setOptimizingPrompt(false);
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
						onSelect={() => applyCwd(fav.path)}
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
					description={directoryRequired ? undefined : t("workingDirectoryHint")}
					error={directoryRequired ? t("workingDirectoryRequired") : undefined}
					placeholder={defaultProjectDir || undefined}
					leftSection={<IconFolder size={16} />}
					value={cwd}
					onChange={applyCwd}
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

	// The project instruction file, shown as a composer-shaped box. Placed last in the
	// right-hand column so it sits where the screenshot's empty area was: below the
	// session-type switches, above the fixed footer.
	// One hint line, in priority order: what the box cannot do (no directory, load
	// failed) outranks what it is showing, and a truncated file outranks its name.
	const projectPromptDescription = !cwd.trim()
		? t("projectPromptChooseDirectory")
		: projectPromptQuery.isFetching
			? t("projectPromptLoading")
			: projectPromptQuery.isError
				? undefined
				: projectPrompt?.truncated
					? t("projectPromptTruncated", { max: 200 })
					: projectPrompt?.exists
						? t("projectPromptExisting", { filename: projectPrompt.filename })
						: projectPrompt
							? t("projectPromptWillCreate", { filename: projectPrompt.filename })
							: t("projectPromptChooseDirectory");

	const projectPromptSection = (
		<Stack gap={6}>
			{/* `position: relative` exists only for the grip: the browser's own resize
			    corner is what we cannot use here (see `startPromptResize`). */}
			<div style={{ position: "relative" }}>
				<Textarea
					ref={promptInputRef}
					label={t("projectPrompt")}
					description={projectPromptDescription}
					placeholder={
						projectPromptQuery.isError
							? t("projectPromptLoadFailed")
							: t("projectPromptPlaceholder")
					}
					value={promptDraft}
					onChange={(e) => setPromptDraft(e.currentTarget.value)}
					// Read-only whenever the file's current state is unknown — no directory
					// chosen, still loading, load failed, or too large to load fully. Typing
					// into a box we could not read is how a partial file would get saved back.
					readOnly={!promptEditable}
					disabled={!cwd.trim()}
					error={
						projectPromptQuery.isError ? (projectPromptQuery.error as Error).message : undefined
					}
					// NOT `autosize`: Mantine's autosize owns `style.height` (and forces
					// `overflow-y: hidden`), so it would revert every drag the user makes and
					// leave a native grip that never holds. `rows` gives the same first-paint
					// size without handing the height to a layout effect.
					rows={6}
					resize="none"
					styles={{
						input: {
							// Mirrors the composer: the optimize cluster is not measured by
							// Mantine, so the padding that reserves its room is set explicitly.
							paddingInlineEnd: textareaOptimizeControlsWidth(false),
							...(promptHeight === null ? {} : { height: promptHeight }),
						},
					}}
					rightSection={
						<TextareaOptimizeControls
							optimizeAvailable={promptEditable && promptDraft.trim().length > 0}
							disabled={!promptEditable}
							loading={optimizingPrompt}
							withContext={false}
							// A draft prompt has no session, so there is no conversation to attach.
							contextAvailable={false}
							onToggleContext={() => {}}
							onOptimize={(style) => void handleOptimizePrompt(style)}
							onCancelOptimize={() => {
								optimizeAbortRef.current?.abort();
								optimizeAbortRef.current = null;
								setOptimizingPrompt(false);
							}}
						/>
					}
					rightSectionWidth={textareaOptimizeControlsWidth(false)}
					rightSectionPointerEvents="auto"
				/>
				{promptEditable ? (
					// A real <button>, not a div with role="separator": it has to be focusable
					// and operable by keyboard (arrow keys), which is also what a11y lint
					// requires of anything that handles pointer interaction.
					<button
						type="button"
						aria-label={t("projectPromptResize")}
						title={t("projectPromptResize")}
						onPointerDown={startPromptResize}
						onKeyDown={handlePromptResizeKeyDown}
						style={{
							padding: 0,
							border: "none",
							background: "transparent",
							position: "absolute",
							// Inset from the border and sized well past the browser's ~10px
							// corner grip: this is the element the user actually has to hit,
							// and it sits before the ScrollArea's overlay scrollbar.
							right: 2,
							bottom: 2,
							width: 22,
							height: 22,
							display: "grid",
							placeItems: "center",
							cursor: "ns-resize",
							touchAction: "none",
							color: "var(--mantine-color-dimmed)",
							borderRadius: 3,
							// Above the textarea so the pointer lands here, not in the text.
							zIndex: 2,
						}}
					>
						<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
							<path
								d="M12 4 L4 12 M12 9 L9 12"
								stroke="currentColor"
								strokeWidth="1.6"
								strokeLinecap="round"
								fill="none"
							/>
						</svg>
					</button>
				) : null}
			</div>
			{promptDirty && promptEditable ? (
				<Text size="xs" c="dimmed">
					{t("projectPromptDirtyHint")}
				</Text>
			) : null}
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
					loading={createNarrator.isPending || savingPrompt}
					disabled={
						directoryRequired ||
						(makeNamed && handleLength(handle.trim()) < MIN_HANDLE_LENGTH) ||
						(bot && !sessionTitle.trim())
					}
				>
					{t("createNarrator")}
				</Button>
			</Group>
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
