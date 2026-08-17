/**
 * The title region of a chapter-like canvas node.
 *
 * An expanded node used to show the title TWICE: once here, and once inside the
 * embedded `NarratorPanel`'s own header — where a dozen tool buttons squeezed it to
 * zero width, so the only readable copy was this one. The panel's copy (and its
 * pencil / sparkles buttons) is therefore suppressed inside a node dock, and those
 * two actions move here, next to the title that is actually visible.
 *
 * Chapter title and narrator title are kept in sync server-side (see
 * `narrator-title.ts`: `syncTitleToChapter` / `syncTitleToNarrator`), so editing the
 * CHAPTER is enough — the bound primary narrator follows.
 */

import { ActionIcon, Group, Text, TextInput } from "@mantine/core";
import { IconPencil, IconSparkles } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useUpdateChapter } from "../../hooks/useChapters";
import { api } from "../../lib/api";
import { resolveTitleCommit } from "./node-title-commit";

export interface NodeTitleEditorProps {
	/** Chapter whose title is edited (the node's own id). */
	chapterId: string;
	/**
	 * Primary narrator of that chapter, used for AI title generation. Null when the
	 * chapter has none — then there is no conversation to summarize and the generate
	 * button is not rendered at all.
	 */
	narratorId: string | null;
	title: string;
	/** Rendered before the title (the role emoji). */
	prefix?: ReactNode;
	/**
	 * Whether to offer the edit / generate actions. Collapsed nodes pass false: they
	 * host no panel, so nothing is competing for the title's space and the extra
	 * chrome would only shrink it.
	 */
	showActions: boolean;
	size?: "sm" | "xs";
	textStyle?: CSSProperties;
}

/**
 * Guard shared by every interactive part of this component.
 *
 * `nodrag` is what keeps React Flow's drag filter off these controls: an expanded
 * node uses the header as its `dragHandle`, and RF's filter is purely class-based,
 * so a button inside the handle would otherwise start a NODE DRAG on pointerdown
 * and swallow the click. `nopan` stops a text selection inside the input from
 * panning the canvas.
 */
const INTERACTIVE_CLASS = "nodrag nopan";

function TitleText({
	title,
	prefix,
	size,
}: {
	title: string;
	prefix?: ReactNode;
	size: "sm" | "xs";
}) {
	return (
		<Text size={size} fw={600} lineClamp={1} title={title} style={{ minWidth: 0, flex: 1 }}>
			{prefix ? <>{prefix} </> : null}
			{title}
		</Text>
	);
}

/**
 * Title plus its two actions. Split from the wrapper so the query hooks (chapter
 * mutation, cache invalidation) only exist when the actions do — a collapsed node
 * is a plain Card on a canvas that may render outside any QueryClientProvider, and
 * making every one of them require a client would be a needless coupling.
 */
function EditableNodeTitle({
	chapterId,
	narratorId,
	title,
	prefix,
	size,
}: {
	chapterId: string;
	narratorId: string | null;
	title: string;
	prefix?: ReactNode;
	size: "sm" | "xs";
}) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const updateChapter = useUpdateChapter();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [generating, setGenerating] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	// Guards the input's `onBlur` save: committing via Enter blurs the field, and
	// without this the same edit would be submitted a second time.
	const committedRef = useRef(false);

	useEffect(() => {
		if (!editing) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [editing]);

	const startEditing = useCallback(() => {
		setDraft(title);
		committedRef.current = false;
		setEditing(true);
	}, [title]);

	const commit = useCallback(() => {
		const outcome = resolveTitleCommit({
			draft,
			currentTitle: title,
			alreadyCommitted: committedRef.current,
		});
		if (outcome.action === "ignore") return;
		committedRef.current = true;
		setEditing(false);
		if (outcome.action !== "save") return;
		// PATCH /chapters/:id — the server syncs the new title to the bound primary
		// narrator, so the panel and every narrator list follow without a second call.
		updateChapter.mutate({ id: chapterId, data: { title: outcome.title } });
	}, [chapterId, draft, title, updateChapter]);

	const cancel = useCallback(() => {
		committedRef.current = true;
		setEditing(false);
	}, []);

	const generate = useCallback(async () => {
		if (!narratorId || generating) return;
		setGenerating(true);
		try {
			await api.generateNarratorTitle(narratorId);
			// The generated title lands on the narrator and is synced to the chapter, so
			// both the node (graph) and any open panel need refreshing.
			qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
		} finally {
			setGenerating(false);
		}
	}, [generating, narratorId, qc]);

	if (editing) {
		return (
			<TextInput
				ref={inputRef}
				className={INTERACTIVE_CLASS}
				value={draft}
				size="xs"
				aria-label={t("editTitle")}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					} else if (event.key === "Escape") {
						event.preventDefault();
						cancel();
					}
				}}
				onBlur={commit}
				// The canvas turns a double click on a node into expand/collapse, which
				// would tear the editor down mid-word when the reader double-clicks to
				// select one.
				onDoubleClick={(event) => event.stopPropagation()}
				onPointerDown={(event) => event.stopPropagation()}
				style={{ flex: 1, minWidth: 0 }}
			/>
		);
	}

	return (
		<>
			<TitleText title={title} prefix={prefix} size={size} />
			<ActionIcon
				className={INTERACTIVE_CLASS}
				size="xs"
				variant="subtle"
				color="gray"
				aria-label={t("editTitle")}
				title={t("editTitle")}
				onClick={(event) => {
					event.stopPropagation();
					startEditing();
				}}
			>
				<IconPencil size={12} />
			</ActionIcon>
			{narratorId && (
				<ActionIcon
					className={INTERACTIVE_CLASS}
					size="xs"
					variant="subtle"
					color="gray"
					loading={generating}
					aria-label={t("generateTitle")}
					title={t("generateTitle")}
					onClick={(event) => {
						event.stopPropagation();
						generate();
					}}
				>
					<IconSparkles size={12} />
				</ActionIcon>
			)}
		</>
	);
}

export function NodeTitleEditor({
	chapterId,
	narratorId,
	title,
	prefix,
	showActions,
	size = "sm",
	textStyle,
}: NodeTitleEditorProps) {
	return (
		<Group gap={4} wrap="nowrap" style={{ minWidth: 0, ...textStyle }}>
			{showActions ? (
				// Keyed on nothing: unmounting when the node collapses is what discards a
				// half-finished edit, so a stale draft cannot reappear on re-expand.
				<EditableNodeTitle
					chapterId={chapterId}
					narratorId={narratorId}
					title={title}
					prefix={prefix}
					size={size}
				/>
			) : (
				<TitleText title={title} prefix={prefix} size={size} />
			)}
		</Group>
	);
}
