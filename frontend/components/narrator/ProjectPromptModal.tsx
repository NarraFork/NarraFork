/**
 * View and edit one directory's project prompt (AGENTS.md and the other names
 * `narrator-prompt` injects).
 *
 * This is a file editor, not part of creating a session. The create dialog only
 * opens it. Saving writes the file on its own; closing the dialog, or creating
 * a session, does not.
 *
 * Source, preview, and split follow the file panel: source is the markdown text,
 * preview is the rendered document, split shows both.
 */

import {
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	ScrollArea,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePromptLibrary } from "../../hooks/usePromptLibrary";
import type { OptimizeStyle } from "../../hooks/usePromptOptimize";
import { api } from "../../lib/api";
import { TextareaOptimizeControls } from "./composer/TextareaOptimizeControls";

const MarkdownContent = lazy(() =>
	import("./markdown/MarkdownContent").then((module) => ({ default: module.MarkdownContent })),
);

type ProjectPromptFile = Awaited<ReturnType<typeof api.getProjectPrompt>>;
type PromptViewMode = "source" | "preview" | "split";

interface StalePrompt {
	content: string;
	hash: string | null;
}

export function ProjectPromptModal({ cwd, onClose }: { cwd: string; onClose: () => void }) {
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const queryClient = useQueryClient();
	const wide = useMediaQuery("(min-width: 62em)") ?? false;
	const { data: promptLibrary } = usePromptLibrary(true);
	const promptQuery = useQuery({
		queryKey: ["project-prompt", cwd],
		queryFn: () => api.getProjectPrompt(cwd),
		enabled: cwd.trim().length > 0,
		retry: false,
		staleTime: 0,
		gcTime: 0,
	});

	const [mode, setMode] = useState<PromptViewMode>("source");
	const [draft, setDraft] = useState("");
	const [baseline, setBaseline] = useState("");
	const [pickedPromptId, setPickedPromptId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [optimizing, setOptimizing] = useState(false);
	const [conflict, setConflict] = useState<StalePrompt | null>(null);
	const loadedKeyRef = useRef<string | null>(null);
	const hashRef = useRef<string | null>(null);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const optimizeAbortRef = useRef<AbortController | null>(null);
	const cwdRef = useRef(cwd);

	const file = promptQuery.data;
	const dirty = draft !== baseline;
	const dirtyRef = useRef(dirty);
	dirtyRef.current = dirty;

	useEffect(() => () => optimizeAbortRef.current?.abort(), []);

	useEffect(() => {
		if (cwdRef.current === cwd) return;
		cwdRef.current = cwd;
		loadedKeyRef.current = null;
		hashRef.current = null;
		setDraft("");
		setBaseline("");
		setConflict(null);
	}, [cwd]);

	useEffect(() => {
		if (!file) return;
		const key = `${file.path}|${file.hash ?? "absent"}`;
		if (key === loadedKeyRef.current) return;
		const content = typeof file.content === "string" ? file.content : "";
		if (dirtyRef.current && loadedKeyRef.current !== null) {
			setConflict({ content, hash: file.hash });
			return;
		}
		loadedKeyRef.current = key;
		hashRef.current = file.hash;
		setDraft(content);
		setBaseline(content);
		setConflict(null);
	}, [file]);

	const editable = !!file && !file.truncated && !promptQuery.isPending && !promptQuery.isError;
	const pickedPromptContent =
		(promptLibrary ?? []).find((entry) => entry.id === pickedPromptId)?.content ?? "";

	const requestClose = () => {
		if (dirty) {
			const confirm = globalThis.confirm;
			if (typeof confirm === "function" && !confirm(t("projectPromptDiscard"))) return;
		}
		onClose();
	};

	const applyLibraryPrompt = (action: "insert" | "replace") => {
		if (!pickedPromptContent || !editable) return;
		if (action === "replace") {
			setDraft(pickedPromptContent);
			return;
		}
		const input = inputRef.current;
		const start = input?.selectionStart ?? null;
		const end = input?.selectionEnd ?? null;
		setDraft((current) => {
			if (start === null || end === null) {
				return current.trim() ? `${current}\n\n${pickedPromptContent}` : pickedPromptContent;
			}
			return current.slice(0, start) + pickedPromptContent + current.slice(end);
		});
	};

	const reloadConflict = () => {
		if (!conflict || !file) return;
		const key = `${file.path}|${conflict.hash ?? "absent"}`;
		loadedKeyRef.current = key;
		hashRef.current = conflict.hash;
		setDraft(conflict.content);
		setBaseline(conflict.content);
		setConflict(null);
	};

	const save = useCallback(async () => {
		if (!file || file.truncated || saving) return;
		const content = draft;
		if (content === baseline) return;
		setSaving(true);
		try {
			const saved = await api.saveProjectPrompt({
				cwd: file.cwd,
				filename: file.filename,
				content,
				baseHash: hashRef.current,
			});
			loadedKeyRef.current = `${saved.path}|${saved.hash}`;
			hashRef.current = saved.hash;
			setBaseline(content);
			setConflict(null);
			queryClient.setQueryData<ProjectPromptFile>(["project-prompt", cwd], (current) =>
				current
					? {
							...current,
							cwd: file.cwd,
							exists: true,
							filename: saved.filename,
							path: saved.path,
							content,
							hash: saved.hash,
							truncated: false,
						}
					: current,
			);
			notifications.show({
				message: t("projectPromptSaved"),
				color: "green",
				autoClose: 4000,
			});
		} catch (error) {
			const stale = stalePrompt(error);
			if (stale) setConflict(stale);
			notifications.show({
				color: "red",
				title: t("projectPromptSaveFailed"),
				message: error instanceof Error ? error.message : tc("unknownError"),
				autoClose: 12000,
			});
		} finally {
			setSaving(false);
		}
	}, [baseline, cwd, draft, file, queryClient, saving, t, tc]);

	const optimize = async (style: OptimizeStyle) => {
		const original = draft;
		if (!original.trim() || optimizing || !editable) return;
		optimizeAbortRef.current?.abort();
		const controller = new AbortController();
		optimizeAbortRef.current = controller;
		setOptimizing(true);
		try {
			const result = await api.optimizeDraftPrompt(original, style, { signal: controller.signal });
			if (controller.signal.aborted) return;
			setDraft((current) => {
				if (current !== original) {
					notifications.show({
						title: tn("optimizeFailed"),
						message: tn("richComposer.optimizeChanged"),
						color: "red",
						autoClose: 10000,
					});
					return current;
				}
				notifications.show({ message: tn("optimizeSuccess"), color: "green", autoClose: 8000 });
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
			setOptimizing(false);
		}
	};

	const description = !file
		? promptQuery.isError
			? undefined
			: t("projectPromptLoading")
		: file.truncated
			? t("projectPromptTruncated", { max: 200 })
			: file.exists
				? t("projectPromptExisting", { filename: file.filename })
				: t("projectPromptWillCreate", { filename: file.filename });

	const showSource = mode === "source" || mode === "split";
	const showPreview = mode === "preview" || mode === "split";
	const split = mode === "split";

	return (
		<Modal
			opened
			onClose={requestClose}
			title={t("projectPrompt")}
			size="xl"
			centered
			onKeyDown={(event) => {
				if (
					!event.nativeEvent.isComposing &&
					(event.ctrlKey || event.metaKey) &&
					event.key.toLowerCase() === "s"
				) {
					event.preventDefault();
					void save();
				}
			}}
		>
			<Stack gap="sm">
				<Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
					<Text size="xs" c="dimmed" style={{ flex: 1 }}>
						{description}
					</Text>
					{dirty ? (
						<Badge size="xs" color="yellow" variant="light">
							{t("projectPromptUnsaved")}
						</Badge>
					) : null}
				</Group>
				<Group justify="space-between" align="center" wrap="wrap" gap="xs">
					<SegmentedControl
						size="xs"
						value={mode}
						onChange={(value) => setMode(value as PromptViewMode)}
						data={[
							{ value: "source", label: t("projectPromptModeSource") },
							{ value: "preview", label: t("projectPromptModePreview") },
							{ value: "split", label: t("projectPromptModeSplit") },
						]}
					/>
					<Group gap="xs" wrap="nowrap">
						<TextareaOptimizeControls
							optimizeAvailable={editable && draft.trim().length > 0}
							disabled={!editable}
							loading={optimizing}
							withContext={false}
							contextAvailable={false}
							onToggleContext={() => {}}
							onOptimize={(style) => void optimize(style)}
							onCancelOptimize={() => {
								optimizeAbortRef.current?.abort();
								optimizeAbortRef.current = null;
								setOptimizing(false);
							}}
						/>
						<Button
							size="xs"
							onClick={() => void save()}
							loading={saving}
							disabled={!editable || !dirty}
						>
							{t("projectPromptSave")}
						</Button>
					</Group>
				</Group>
				{promptQuery.isError ? (
					<Alert color="red" title={t("projectPromptLoadFailed")}>
						{(promptQuery.error as Error).message}
					</Alert>
				) : null}
				{conflict ? (
					<Alert color="yellow" title={t("projectPromptSaveFailed")}>
						<Stack gap="xs">
							<Text size="xs">{t("projectPromptConflict")}</Text>
							<Button size="xs" variant="default" onClick={reloadConflict}>
								{t("projectPromptReload")}
							</Button>
						</Stack>
					</Alert>
				) : null}
				<Box
					style={{
						height: 420,
						display: "flex",
						flexDirection: split && wide ? "row" : "column",
						minHeight: 0,
					}}
				>
					{promptQuery.isPending ? (
						<Group justify="center" style={{ flex: 1 }}>
							<Loader size="sm" />
						</Group>
					) : (
						<>
							{showSource ? (
								<Textarea
									ref={inputRef}
									aria-label={t("projectPromptModeSource")}
									value={draft}
									onChange={(event) => setDraft(event.currentTarget.value)}
									readOnly={!editable}
									placeholder={t("projectPromptPlaceholder")}
									resize="none"
									style={{ flex: 1, minWidth: 0, minHeight: 0 }}
									styles={{
										root: {
											flex: 1,
											minHeight: 0,
											display: "flex",
											flexDirection: "column",
										},
										wrapper: { flex: 1, minHeight: 0 },
										input: { height: "100%", minHeight: 0 },
									}}
								/>
							) : null}
							{split ? (
								<Divider
									orientation={wide ? "vertical" : "horizontal"}
									mx={wide ? "xs" : 0}
									my={wide ? 0 : "xs"}
								/>
							) : null}
							{showPreview ? (
								<ScrollArea
									style={{ flex: 1, minWidth: 0, minHeight: 0 }}
									type="auto"
									offsetScrollbars
								>
									<Suspense
										fallback={
											<Group justify="center" p="md">
												<Loader size="sm" />
											</Group>
										}
									>
										<MarkdownContent text={draft} />
									</Suspense>
								</ScrollArea>
							) : null}
						</>
					)}
				</Box>
				<Group gap="xs" wrap="nowrap" align="flex-end">
					<Select
						size="xs"
						style={{ flex: 1, minWidth: 0 }}
						label={t("promptLibraryPick")}
						placeholder={
							promptLibrary && promptLibrary.length > 0
								? t("promptLibraryPickPlaceholder")
								: t("promptLibraryEmpty")
						}
						searchable
						clearable
						disabled={!editable || !promptLibrary || promptLibrary.length === 0}
						data={(promptLibrary ?? []).map((entry) => ({
							value: entry.id,
							label: entry.name,
						}))}
						value={pickedPromptId}
						onChange={setPickedPromptId}
						comboboxProps={{ withinPortal: true, position: "bottom-start", zIndex: 320 }}
					/>
					<Button
						size="compact-sm"
						variant="light"
						disabled={!editable || !pickedPromptContent}
						onClick={() => applyLibraryPrompt("insert")}
					>
						{t("promptLibraryInsert")}
					</Button>
					<Button
						size="compact-sm"
						variant="subtle"
						disabled={!editable || !pickedPromptContent}
						onClick={() => applyLibraryPrompt("replace")}
					>
						{t("promptLibraryReplace")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function stalePrompt(error: unknown): StalePrompt | null {
	if (!error || typeof error !== "object") return null;
	const status = "status" in error ? error.status : undefined;
	const data = "data" in error ? error.data : undefined;
	if (status !== 409 || !data || typeof data !== "object") return null;
	const body = data as { currentContent?: unknown; currentHash?: unknown };
	return {
		content: typeof body.currentContent === "string" ? body.currentContent : "",
		hash: typeof body.currentHash === "string" ? body.currentHash : null,
	};
}
