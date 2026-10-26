import { usePromptOptimize } from "@frontend/hooks/usePromptOptimize";
import { ActionIcon, Box, Button, Group, Stack, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ComposerDocument } from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import { isTextFile, MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import { IconPaperclip } from "@tabler/icons-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { clearTokenOnSessionFailure, getToken } from "../../../lib/api";
import { apiUrl } from "../../../lib/base-path";
import { useFullscreenEscape } from "../../../lib/fullscreen-escape";
import { Z } from "../../../lib/z-index";
import { useImageViewer } from "../../common/image-viewer-context";
import { composerOptimizeTarget } from "../composer/composer-optimize-target";
import type { ComposerQuote } from "../composer/composer-quotes";
import { useFileReferenceScope } from "../composer/FileReferenceScope";
import {
	InlineComposerEditor,
	type InlineComposerEditorHandle,
} from "../composer/InlineComposerEditor";
import { MAX_IMAGE_CLIPBOARD_BLOB_BYTES } from "../composer/image-clipboard";
import { QuoteDetailModal } from "../composer/QuoteDetailModal";
import { revealComposerQuote, revealQuotedFile } from "../composer/quote-jump";
import { TextareaOptimizeControls } from "../composer/TextareaOptimizeControls";
import { useNarratorDockContext } from "../dock/NarratorDockContext";
import {
	bindComposerEditFiles,
	type ComposerEditDetail,
	type ComposerEditSession,
	type ComposerEditSnapshot,
	composerEditDetailAttachments,
	type ExistingComposerAttachment,
	MAX_QUEUED_IMAGES,
	MAX_QUEUED_TEXT_FILES,
	projectComposerEdit,
	seedComposerEditSession,
} from "../interaction/queued-attachment-edit";
import {
	ACCEPTED_TYPES,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	resizeImageIfNeeded,
} from "../narrator-panel-types";

export interface EditableComposerDocumentProps {
	narratorId?: string;
	messageId?: string;
	text: string;
	fileReferences: FileReference[];
	attachments: ExistingComposerAttachment[];
	composerDocument?: ComposerDocument;
	/** Only mounted editors request the bounded layout detail, never queue/message summaries. */
	loadDocument?: (signal: AbortSignal) => Promise<ComposerEditDetail>;
	onChange: (snapshot: ComposerEditSnapshot | undefined) => void;
	disabled?: boolean;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}

/** One controller for historical and queued user edits; resources survive deletion/undo. */
export function EditableComposerDocument(props: EditableComposerDocumentProps) {
	const { t } = useTranslation("narrator");
	const initial = useRef(props);
	const latest = useRef(props);
	latest.current = props;
	const [session, setSession] = useState<ComposerEditSession>();
	const [document, setDocument] = useState<ComposerDocument>();
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [resources, setResources] = useState<ReadonlyMap<string, File | string>>(new Map());
	const editor = useRef<InlineComposerEditorHandle>(null);
	const input = useRef<HTMLInputElement>(null);
	const inserting = useRef(false);
	const [addingFiles, setAddingFiles] = useState(false);
	const mounted = useRef(true);
	const openImage = useImageViewer();
	const fileScope = useFileReferenceScope();
	const dock = useNarratorDockContext();
	const localPreviews = useRef(new Map<string, string>());
	useEffect(
		() => () => {
			for (const url of localPreviews.current.values()) URL.revokeObjectURL(url);
		},
		[],
	);
	const [fullscreen, setFullscreen] = useState(false);
	const [quoteDetail, setQuoteDetail] = useState<ComposerQuote | null>(null);
	// 原地 position: fixed 全屏(保住光标/撤销栈);中和祖先层叠上下文,
	// 否则全屏框会画在 AppShell 导航栏/顶栏之下。
	const fullscreenBoxRef = useRef<HTMLDivElement>(null);
	useFullscreenEscape(fullscreenBoxRef, fullscreen);
	const unusedTextarea = useRef<HTMLTextAreaElement>(null);
	const optimize = usePromptOptimize({
		narratorId: props.narratorId ?? "",
		messageId: props.messageId,
		textareaRef: unusedTextarea,
		target: () => {
			if (latest.current.disabled || inserting.current) return null;
			const target = composerOptimizeTarget(editor.current);
			return target
				? {
						text: target.text,
						apply: (text) => !latest.current.disabled && !inserting.current && target.apply(text),
					}
				: null;
		},
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: Only an explicit retry may reseed an editor; broadcasts must not overwrite its draft.
	useEffect(() => {
		mounted.current = true;
		const controller = new AbortController();
		let active = true;
		latest.current.onChange(undefined);
		setError(false);
		const seed = async () => {
			try {
				const source = initial.current;
				const detail: ComposerEditDetail | undefined = source.composerDocument
					? { composerDocument: source.composerDocument }
					: await source.loadDocument?.(controller.signal);
				if (!active) return;
				const sameSnapshotAttachments =
					detail && composerEditDetailAttachments(detail, source.narratorId);
				if (!source.composerDocument && detail?.composerDocument && !sameSnapshotAttachments)
					throw new Error("Layout resource detail is unavailable");
				const next = seedComposerEditSession(
					{
						text: detail?.text ?? source.text,
						fileReferences: detail?.fileReferences ?? source.fileReferences,
						composerDocument: detail?.composerDocument,
					},
					sameSnapshotAttachments ?? source.attachments,
				);
				setSession(next);
				setDocument(next.document);
				latest.current.onChange(projectComposerEdit(next, next.document));
			} catch {
				if (active) setError(true);
			}
		};
		void seed();
		return () => {
			active = false;
			mounted.current = false;
			controller.abort();
		};
	}, [attempt]);

	// Preview URLs are display resources only: a failed image preview does not delete
	// its authorized kept-image binding. Abort/size limits avoid unbounded blob reads.
	useEffect(() => {
		if (!session) return;
		const controller = new AbortController();
		const urls: string[] = [];
		const next = new Map<string, File | string>();
		const jobs: (() => Promise<void>)[] = [];
		for (const [id, resource] of session.bindings) {
			if (resource instanceof File) {
				next.set(id, resource);
				continue;
			}
			if (resource.kind === "textFile") {
				next.set(id, "kept-text-file");
				continue;
			}
			if (resource.previewUrl?.startsWith("blob:")) {
				next.set(id, resource.previewUrl);
				continue;
			}
			// A kept server resource is sendable even while its optional preview is unavailable.
			next.set(id, "kept-image");
			if (!resource.imageId || !resource.uploadNarratorId) continue;
			jobs.push(async () => {
				const token = getToken();
				const response = await fetch(
					apiUrl(
						`/uploads/${encodeURIComponent(resource.uploadNarratorId ?? "")}/${encodeURIComponent(resource.imageId ?? "")}`,
					),
					{
						headers: token ? { Authorization: `Bearer ${token}` } : {},
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
					},
				);
				if (!response.ok) {
					await clearTokenOnSessionFailure(response);
					return;
				}
				const reader = response.body?.getReader();
				if (!reader) return;
				const chunks: Uint8Array<ArrayBuffer>[] = [];
				let size = 0;
				try {
					while (true) {
						const result = await reader.read();
						if (result.done) break;
						size += result.value.byteLength;
						if (size > MAX_IMAGE_CLIPBOARD_BLOB_BYTES) {
							await reader.cancel();
							return;
						}
						chunks.push(new Uint8Array(result.value));
					}
				} finally {
					reader.releaseLock();
				}
				if (controller.signal.aborted) return;
				const url = URL.createObjectURL(
					new Blob(chunks, { type: response.headers.get("content-type") ?? resource.mimeType }),
				);
				urls.push(url);
				setResources((previous) => new Map(previous).set(id, url));
			});
		}
		setResources(next);
		let cursor = 0;
		const worker = async () => {
			while (cursor < jobs.length && !controller.signal.aborted) {
				const job = jobs[cursor++];
				try {
					await job();
				} catch {
					/* The kept attachment remains valid without a preview. */
				}
			}
		};
		void Promise.all([worker(), worker()]);
		return () => {
			controller.abort();
			for (const url of urls) URL.revokeObjectURL(url);
		};
	}, [session]);

	const change = (next: ComposerDocument) => {
		if (!session) return;
		setDocument(next);
		try {
			latest.current.onChange(projectComposerEdit(session, next));
		} catch {
			latest.current.onChange(undefined);
		}
	};
	const addFiles = async (files: File[]) => {
		if (!session || latest.current.disabled || inserting.current) return;
		inserting.current = true;
		setAddingFiles(true);
		latest.current.onChange(undefined);
		try {
			const current = editor.current?.getDocument() ?? session.document;
			let images = current.assets.filter((asset) => asset.kind === "image").length;
			let texts = current.assets.filter((asset) => asset.kind === "textFile").length;
			const additions: ReturnType<typeof bindComposerEditFiles> = { nodes: [], assets: [] };
			for (let file of files) {
				const image = ACCEPTED_TYPES.includes(file.type);
				if (image) {
					if (file.size > MAX_IMAGE_SIZE || images >= MAX_QUEUED_IMAGES) {
						notifications.show({
							color: "yellow",
							message:
								file.size > MAX_IMAGE_SIZE
									? t("imageTooLarge")
									: t("editTooManyImages", { max: MAX_QUEUED_IMAGES }),
						});
						continue;
					}
					if (file.type !== "image/gif") {
						try {
							file = await resizeImageIfNeeded(file, MAX_IMAGE_LONG_EDGE);
						} catch {
							/* Keep the original accepted image. */
						}
					}
					images++;
				} else {
					if (
						!isTextFile(file.name) ||
						file.size > MAX_TEXT_FILE_SIZE ||
						texts >= MAX_QUEUED_TEXT_FILES
					) {
						notifications.show({
							color: "yellow",
							title: t(
								!isTextFile(file.name)
									? "unsupportedFileType"
									: file.size > MAX_TEXT_FILE_SIZE
										? "textFileTooLarge"
										: "editTooManyFiles",
								{ max: MAX_QUEUED_TEXT_FILES },
							),
							message: file.name,
						});
						continue;
					}
					texts++;
				}
				if (!mounted.current || latest.current.disabled) return;
				const added = bindComposerEditFiles(session, [file], image ? "image" : "textFile");
				additions.nodes.push(...added.nodes);
				additions.assets.push(...added.assets);
			}
			if (!mounted.current || latest.current.disabled || !additions.nodes.length) return;
			setResources((previous) => {
				const next = new Map(previous);
				for (const asset of additions.assets) {
					const file = session.bindings.get(asset.id);
					if (file instanceof File) next.set(asset.id, file);
				}
				return next;
			});
			// Unlock the same controller before its guarded insertion command; no timeout/bookmark race.
			flushSync(() => setAddingFiles(false));
			editor.current?.insertNodes(additions.nodes, additions.assets);
		} finally {
			inserting.current = false;
			if (mounted.current) {
				setAddingFiles(false);
				try {
					latest.current.onChange(
						projectComposerEdit(session, editor.current?.getDocument() ?? session.document),
					);
				} catch {
					latest.current.onChange(undefined);
				}
			}
		}
	};

	if (error)
		return (
			<Stack gap="xs">
				<Text size="xs" c="red" role="alert">
					{t("textPreview.loadFailed")}
				</Text>
				<Button size="xs" variant="subtle" onClick={() => setAttempt((value) => value + 1)}>
					{t("documentRetry")}
				</Button>
			</Stack>
		);
	if (!document)
		return (
			<Text size="xs" c="dimmed">
				{t("textPreview.loading")}
			</Text>
		);
	return (
		<Box
			ref={fullscreenBoxRef}
			onDrop={(event) => {
				// Drops on chips/controls bypass ProseMirror; claim them so the panel's
				// drop zone does not import them into the outer composer.
				if (event.defaultPrevented || !event.dataTransfer.types.includes("Files")) return;
				event.preventDefault();
				void addFiles(Array.from(event.dataTransfer.files));
			}}
			style={
				fullscreen
					? {
							position: "fixed",
							inset: 16,
							zIndex: Z.fullscreenEditor,
							background: "var(--mantine-color-body)",
							padding: 16,
							overflow: "auto",
							borderRadius: 8,
							// 与 NarratorComposer 全屏一致的 100vmax 遮罩:盖住被中和祖先在
							// 16px 边带内的重绘差异,也统一两个全屏编辑器的视觉。
							boxShadow: "var(--mantine-shadow-xl), 0 0 0 100vmax rgb(0 0 0 / 55%)",
						}
					: undefined
			}
		>
			<QuoteDetailModal
				quote={quoteDetail}
				onClose={() => setQuoteDetail(null)}
				onJump={(quote) => revealComposerQuote(dock, quote, editor.current?.getElement() ?? null)}
			/>
			{fullscreen && (
				<Group justify="flex-end" mb="xs">
					<Button size="xs" variant="subtle" onClick={() => setFullscreen(false)}>
						{t("editCancel")}
					</Button>
				</Group>
			)}
			<InlineComposerEditor
				ref={editor}
				value={document}
				onChange={change}
				resources={resources}
				disabled={props.disabled || addingFiles}
				onKeyDown={(event) => {
					if (event.key === "Escape" && fullscreen) {
						event.preventDefault();
						setFullscreen(false);
						return;
					}
					// 全屏编辑模式下 Enter/Shift+Enter 一律只换行,不提交编辑;
					// 提交走按钮或 mod+Enter(后者继续透传给调用方的 onKeyDown)。
					if (fullscreen && event.key === "Enter" && !event.ctrlKey && !event.metaKey) return;
					props.onKeyDown?.(event);
				}}
				onPasteFiles={(files) => void addFiles(files)}
				onOpenQuote={setQuoteDetail}
				onOpenFile={(reference) => {
					if (fileScope.openFile) fileScope.openFile(reference);
					else revealQuotedFile(dock, reference);
				}}
				onOpenImage={(asset) => {
					const resource = resources.get(asset.id);
					let src =
						typeof resource === "string" && resource.startsWith("blob:")
							? resource
							: localPreviews.current.get(asset.id);
					if (!src && resource instanceof File) {
						src = URL.createObjectURL(resource);
						localPreviews.current.set(asset.id, src);
					}
					if (src) openImage({ src, filename: asset.name, alt: asset.name });
				}}
				controls={
					<Group gap="xs">
						<Tooltip label={t("attachFile")}>
							<ActionIcon
								variant="subtle"
								color="gray"
								disabled={props.disabled || addingFiles}
								aria-label={t("attachFile")}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => input.current?.click()}
							>
								<IconPaperclip size={18} />
							</ActionIcon>
						</Tooltip>
						<TextareaOptimizeControls
							disabled={
								props.disabled ||
								addingFiles ||
								optimize.loading ||
								!document.paragraphs.some((paragraph) =>
									paragraph.children.some((node) => node.type === "text" && node.text.trim()),
								)
							}
							loading={optimize.loading}
							withContext={optimize.withContext}
							onToggleContext={optimize.toggleContext}
							onOptimize={optimize.handleOptimize}
							onCancelOptimize={optimize.cancelOptimize}
							onExpand={() => setFullscreen((value) => !value)}
							contextMessageCount={optimize.contextMessageCount}
							onContextMessageCountChange={optimize.setContextMessageCount}
						/>
					</Group>
				}
			/>
			<input
				ref={input}
				type="file"
				multiple
				disabled={props.disabled || addingFiles}
				style={{ display: "none" }}
				onChange={(event) => {
					const files = Array.from(event.target.files ?? []);
					event.target.value = "";
					void addFiles(files);
				}}
			/>
		</Box>
	);
}
