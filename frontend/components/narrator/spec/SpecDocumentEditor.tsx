import {
	ActionIcon,
	Box,
	Button,
	Center,
	Group,
	Loader,
	ScrollArea,
	SegmentedControl,
	Text,
	Tooltip,
} from "@mantine/core";
import { useDebouncedValue, useElementSize } from "@mantine/hooks";
import { IconAlertTriangle, IconDeviceFloppy, IconRefresh } from "@tabler/icons-react";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MonacoEditor, type MonacoEditorHandle } from "../file-editor/MonacoEditor";
import { MarkdownContent } from "../markdown/MarkdownContent";
import {
	availableSpecEditorModes,
	type SpecEditorMode,
	type SpecEditorView,
	type SpecEditorViewInput,
	type SpecRichUnsupportedKind,
	selectSpecEditorMode,
	syncSpecEditorView,
} from "./spec-editor-mode";

// Tiptap is only needed once the reader opts into rich mode.
const SpecMarkdownEditor = lazy(() =>
	import("./SpecMarkdownEditor").then((m) => ({ default: m.SpecMarkdownEditor })),
);

/** Same debounce as the file editor's split preview: typing never re-renders markdown per key. */
const SPLIT_PREVIEW_DEBOUNCE_MS = 300;

interface SpecDocumentEditorProps {
	/** Identity of the open document (its spec:// URI). */
	documentKey: string;
	path: string;
	value: string;
	/** Changes whenever content is (re)loaded from the server; stable while the reader types. */
	revisionKey: string;
	onChange: (text: string) => void;
	dirty: boolean;
	onSave: () => void;
	onReload: () => void;
	isSaving: boolean;
	/** The reader's last explicit mode choice in this panel; source by default. */
	preferredMode: SpecEditorMode;
	onPreferredModeChange: (mode: SpecEditorMode) => void;
}

/**
 * Editor for every spec document except tasks.json. Source first: the default mode edits the raw
 * text, so a save writes back exactly what the reader typed. Markdown files can also be shown
 * side by side with a rendered preview, or opened in the WYSIWYG editor; content the WYSIWYG
 * editor cannot keep is shown read-only there instead.
 */
export function SpecDocumentEditor(props: SpecDocumentEditorProps) {
	const { documentKey, path, value, revisionKey, onChange, dirty, onSave, onReload, isSaving } =
		props;
	const { t } = useTranslation("narrator");
	const input: SpecEditorViewInput = {
		documentKey,
		path,
		revisionKey,
		value,
		preferredMode: props.preferredMode,
	};
	const [storedView, setStoredView] = useState<SpecEditorView>(() =>
		syncSpecEditorView(null, input),
	);
	// Derived during render (not in an effect) so the rich editor never mounts, even for one
	// commit, on a revision it has not been checked against.
	const view = syncSpecEditorView(storedView, input);
	if (view !== storedView) setStoredView(view);

	const modes = availableSpecEditorModes(path);
	const { onPreferredModeChange } = props;
	const switchMode = (mode: SpecEditorMode) => {
		if (mode === view.mode) return;
		setStoredView(selectSpecEditorMode(view, mode, input));
		onPreferredModeChange(mode);
	};

	const rich = view.mode === "rich" ? view.rich : null;
	const sourceVisible = view.mode === "source" || view.mode === "split";

	return (
		<Box style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column" }}>
			<Group
				gap={6}
				px="xs"
				py={4}
				wrap="nowrap"
				justify="space-between"
				style={{ flexShrink: 0, borderBottom: "1px solid var(--mantine-color-default-border)" }}
			>
				{modes.length > 1 ? (
					<SegmentedControl
						size="xs"
						value={view.mode}
						onChange={(next) => switchMode(next as SpecEditorMode)}
						data={modes.map((mode) => ({
							value: mode,
							label:
								mode === "rich" ? (
									<Tooltip label={t("spec.modeRichHint")} openDelay={400} multiline maw={260}>
										<span>{t("spec.mode_rich")}</span>
									</Tooltip>
								) : (
									t(`spec.mode_${mode}`)
								),
						}))}
					/>
				) : (
					<Text size="xs" c="dimmed" truncate>
						{t("spec.plainTextHint")}
					</Text>
				)}
				{dirty && (
					<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
						<Tooltip label={t("spec.save")} openDelay={200}>
							<ActionIcon
								variant="filled"
								color="green"
								onClick={onSave}
								loading={isSaving}
								size="sm"
								aria-label={t("spec.save")}
							>
								<IconDeviceFloppy size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={t("spec.reload")} openDelay={200}>
							<ActionIcon
								variant="subtle"
								color="gray"
								onClick={onReload}
								disabled={isSaving}
								size="sm"
								aria-label={t("spec.reload")}
							>
								<IconRefresh size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>
				)}
			</Group>
			<SpecDocumentBody
				split={view.mode === "split"}
				previewValue={view.mode === "split" ? value : null}
			>
				{sourceVisible && (
					<SpecSourcePane
						documentKey={documentKey}
						path={path}
						value={value}
						revisionKey={revisionKey}
						onChange={onChange}
						onSave={onSave}
					/>
				)}
				{rich &&
					(rich.unsupported.length === 0 ? (
						<Suspense
							fallback={
								<Center style={{ flex: 1 }}>
									<Loader size="sm" />
								</Center>
							}
						>
							<SpecMarkdownEditor
								value={rich.text}
								revisionKey={`${documentKey}:${rich.revisionKey}`}
								onChange={onChange}
								onSave={onSave}
							/>
						</Suspense>
					) : (
						<SpecRichBlocked
							unsupported={rich.unsupported}
							value={value}
							onSwitchToSource={() => switchMode("source")}
						/>
					))}
			</SpecDocumentBody>
		</Box>
	);
}

/**
 * Lays out the active pane. The source pane is always the first child so that switching between
 * source and split keeps the same Monaco view (cursor, undo history). Split follows the panel's
 * aspect ratio: side by side when wide, preview below when tall.
 */
function SpecDocumentBody({
	split,
	previewValue,
	children,
}: {
	split: boolean;
	previewValue: string | null;
	children: ReactNode;
}) {
	const { ref, width, height } = useElementSize();
	const horizontal = width >= height;
	return (
		<Box
			ref={ref}
			style={{
				flex: 1,
				minHeight: 0,
				minWidth: 0,
				display: "flex",
				flexDirection: split && !horizontal ? "column" : "row",
			}}
		>
			{children}
			{split && previewValue !== null && (
				<SpecSplitPreview value={previewValue} horizontal={horizontal} />
			)}
		</Box>
	);
}

function SpecSplitPreview({ value, horizontal }: { value: string; horizontal: boolean }) {
	const [text] = useDebouncedValue(value, SPLIT_PREVIEW_DEBOUNCE_MS);
	return (
		<ScrollArea
			style={{
				flex: 1,
				minWidth: 0,
				minHeight: 0,
				borderLeft: horizontal ? "1px solid var(--mantine-color-default-border)" : undefined,
				borderTop: horizontal ? undefined : "1px solid var(--mantine-color-default-border)",
			}}
		>
			<Box p="sm">
				<MarkdownContent text={text} />
			</Box>
		</ScrollArea>
	);
}

/**
 * Raw-text editing through the file editor's Monaco view. Monaco owns the document; `value` is
 * only pushed into it when the server hands over text that differs from what Monaco holds (an
 * agent edit, a reload). A save echoes the reader's own text back, so it keeps the view as is.
 */
function SpecSourcePane({
	documentKey,
	path,
	value,
	revisionKey,
	onChange,
	onSave,
}: {
	documentKey: string;
	path: string;
	value: string;
	revisionKey: string;
	onChange: (text: string) => void;
	onSave: () => void;
}) {
	const handleRef = useRef<MonacoEditorHandle | null>(null);
	// The text Monaco currently holds, as last reported to the panel.
	const bufferRef = useRef(value);
	const syncedRevisionRef = useRef(revisionKey);
	const [doc, setDoc] = useState(() => ({ generation: 0, text: value }));

	useEffect(() => {
		if (syncedRevisionRef.current === revisionKey) return;
		syncedRevisionRef.current = revisionKey;
		if (value === bufferRef.current) return;
		bufferRef.current = value;
		setDoc((prev) => ({ generation: prev.generation + 1, text: value }));
	}, [revisionKey, value]);

	const handleReady = useCallback((handle: MonacoEditorHandle | null) => {
		handleRef.current = handle;
	}, []);
	const handleDocumentChange = useCallback(() => {
		const text = handleRef.current?.getModel()?.getValue();
		if (text === undefined || text === bufferRef.current) return;
		bufferRef.current = text;
		onChange(text);
	}, [onChange]);

	return (
		<Box style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }}>
			<Box style={{ position: "absolute", inset: 0 }}>
				<MonacoEditor
					// A new generation is a different document: remount instead of reusing the view.
					key={doc.generation}
					documentKey={`spec:${documentKey}:${doc.generation}`}
					initialValue={doc.text}
					filePath={path}
					onReady={handleReady}
					onDocumentChange={handleDocumentChange}
					onSave={onSave}
					lineWrapping
				/>
			</Box>
		</Box>
	);
}

/** Rich mode on content the WYSIWYG editor would lose: render it read-only, point to source. */
function SpecRichBlocked({
	unsupported,
	value,
	onSwitchToSource,
}: {
	unsupported: SpecRichUnsupportedKind[];
	value: string;
	onSwitchToSource: () => void;
}) {
	const { t } = useTranslation("narrator");
	const kinds = unsupported
		.map((kind) => t(`spec.richUnsupported_${kind}`))
		.join(t("spec.richUnsupportedSeparator"));
	return (
		<Box style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
			<Group
				gap={6}
				px="sm"
				py={6}
				wrap="nowrap"
				align="flex-start"
				role="status"
				data-spec-rich-blocked={unsupported.join(" ")}
				style={{
					flexShrink: 0,
					borderBottom:
						"1px solid light-dark(var(--mantine-color-yellow-2), var(--mantine-color-default-border))",
					background:
						"light-dark(var(--mantine-color-yellow-0), color-mix(in srgb, var(--mantine-color-yellow-9) 18%, var(--mantine-color-dark-6)))",
				}}
			>
				<IconAlertTriangle
					size={13}
					color="var(--mantine-color-yellow-6)"
					style={{ marginTop: 2, flexShrink: 0 }}
				/>
				<Text
					size="xs"
					style={{
						flex: 1,
						color: "light-dark(var(--mantine-color-yellow-9), var(--mantine-color-yellow-1))",
					}}
				>
					{t("spec.richBlocked", { kinds })}
				</Text>
				<Button size="compact-xs" variant="light" color="yellow" onClick={onSwitchToSource}>
					{t("spec.richBlockedSwitch")}
				</Button>
			</Group>
			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				<Box p="sm">
					<MarkdownContent text={value} />
				</Box>
			</ScrollArea>
		</Box>
	);
}
