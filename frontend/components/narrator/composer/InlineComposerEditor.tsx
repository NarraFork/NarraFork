import type {
	ComposerAsset,
	ComposerDocument,
	ComposerInlineNode,
} from "@shared/composer-document";
import { parseComposerDocument } from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import {
	IconFileText,
	IconLoader2,
	IconPaperclip,
	IconPhoto,
	IconQuote,
	IconX,
} from "@tabler/icons-react";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import {
	EditorState,
	NodeSelection,
	Plugin,
	type Selection,
	type SelectionBookmark,
	TextSelection,
} from "@tiptap/pm/state";
import {
	EditorContent,
	Extension,
	type JSONContent,
	Node,
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
	useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
	createContext,
	forwardRef,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { fileReferenceToken } from "./file-reference-input";
import classes from "./InlineComposerEditor.module.css";
import { useComposerLayout } from "./use-composer-layout";

export interface InlineComposerSelection {
	start: number;
	end: number;
	/** Native selection metadata, non-enumerable for legacy start/end consumers. */
	empty?: boolean;
	type?: "text" | "node" | "all";
}
export interface InlineComposerTextContext {
	text: string;
	start: number;
	end: number;
	caret: number;
}
export interface InlineComposerSelectionBookmark {
	/** Single-use, mapped through editing transactions; false after cancel/reset/unmount. */
	restore(): boolean;
	cancel(): void;
}
export interface InlineComposerEditorHandle {
	focus(): void;
	getDocument(): ComposerDocument;
	/** preserveHistory=true is one undoable local replacement and emits onChange. */
	setDocument(document: ComposerDocument, preserveHistory?: boolean): void;
	insertNodes(nodes: ComposerInlineNode[], assets?: ComposerAsset[]): void;
	/** Delegates validation/resource allocation to onPasteFiles; never allocates hidden assets. */
	insertFiles(files: File[]): void;
	getSelection(): InlineComposerSelection;
	/**
	 * Collapsed caret on the first visual line (`up`) or the last (`down`), including soft wraps.
	 * Read before the key's default action; editor state lags that action until selectionchange.
	 */
	isCaretOnVerticalEdge(direction: "up" | "down"): boolean;
	/** Put the caret at the end and scroll it into the composer viewport. */
	revealCaretAtEnd(): void;
	/** The caret's contiguous text run; atoms, hard breaks and paragraphs are boundaries. */
	getTextContext(): InlineComposerTextContext | null;
	captureSelectionBookmark(): InlineComposerSelectionBookmark;
	setSelection(start: number, end: number): void;
	getElement(): HTMLDivElement | null;
}
export interface InlineComposerEditorProps {
	value: ComposerDocument;
	onChange(document: ComposerDocument): void;
	resources?: ReadonlyMap<string, File | string>;
	attachmentsHydrating?: boolean;
	attachmentsRestoreFailed?: boolean;
	elementRef?: RefObject<HTMLDivElement | null>;
	onElement?: (element: HTMLDivElement | null) => void;
	/** Notification only: retain resources for undo until the editor lifecycle ends. */
	onRemoveAsset?: (assetId: string) => void;
	placeholder?: string;
	disabled?: boolean;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
	onFocus?: () => void;
	onBlur?: () => void;
	onPasteFiles?: (files: File[]) => void;
	/** Offsets are UTF-16 in legacy body, excluding quote prefix and attachment nodes. */
	onSelectionChange?: (selection: InlineComposerSelection) => void;
	onOpenQuote?: (quote: Extract<ComposerInlineNode, { type: "quote" }>) => void;
	onOpenFile?: (reference: FileReference) => void;
	onOpenImage?: (asset: ComposerAsset) => void;
	onOpenAttachment?: (asset: ComposerAsset) => void;
	controls?: ReactNode;
	leadingControls?: ReactNode;
	adaptive?: boolean;
}

/** Bounds the unacknowledged-emission queue for a parent that never renders changes back. */
const MAX_PENDING_ECHOES = 32;

type AtomNode = Exclude<ComposerInlineNode, { type: "text" } | { type: "break" }>;
type AtomContextValue = Pick<
	InlineComposerEditorProps,
	| "resources"
	| "attachmentsHydrating"
	| "attachmentsRestoreFailed"
	| "disabled"
	| "onOpenQuote"
	| "onOpenFile"
	| "onOpenImage"
	| "onOpenAttachment"
> & { assets: ReadonlyMap<string, ComposerAsset> };
const AtomContext = createContext<AtomContextValue>({ assets: new Map() });

function inlineJSON(node: ComposerInlineNode): JSONContent {
	if (node.type === "text") return { type: "text", text: node.text };
	if (node.type === "break") return { type: "hardBreak" };
	return { type: node.type, attrs: { value: node } };
}
export function composerDocumentToEditorJSON(document: ComposerDocument): JSONContent {
	return {
		type: "doc",
		content: document.paragraphs.map((paragraph) => ({
			type: "paragraph",
			content: paragraph.children
				.filter((node) => node.type !== "text" || node.text.length > 0)
				.map(inlineJSON),
		})),
	};
}
function readEditorDocument(
	doc: ProseMirrorNode,
	assets: ReadonlyMap<string, ComposerAsset>,
): ComposerDocument {
	const used = new Set<string>();
	const paragraphs: ComposerDocument["paragraphs"] = [];
	doc.forEach((paragraph) => {
		const children: ComposerInlineNode[] = [];
		paragraph.forEach((node) => {
			if (node.isText) children.push({ type: "text", text: node.text ?? "" });
			else if (node.type.name === "hardBreak") children.push({ type: "break" });
			else {
				const value = node.attrs.value as AtomNode;
				children.push(value);
				if (value.type === "attachment") used.add(value.assetId);
			}
		});
		paragraphs.push({ children });
	});
	return {
		version: 1,
		paragraphs,
		assets: [...used].flatMap((id) => (assets.has(id) ? [assets.get(id) as ComposerAsset] : [])),
	};
}

/** One adapter for selection coordinates; never expose ProseMirror positions as body offsets. */
export function editorBodyPositions(doc: ProseMirrorNode) {
	const positions: { from: number; to: number; start: number; end: number }[] = [];
	let offset = 0;
	doc.forEach((paragraph, paragraphPosition, index) => {
		if (index) {
			positions.push({
				from: paragraphPosition - 1,
				to: paragraphPosition + 1,
				start: offset,
				end: offset + 1,
			});
			offset++;
		}
		paragraph.forEach((node, nodePosition) => {
			let length = 0;
			if (node.isText) length = node.text?.length ?? 0;
			else if (node.type.name === "hardBreak") length = 1;
			else if (node.type.name === "fileReference")
				length = fileReferenceToken(
					(node.attrs.value as Extract<AtomNode, { type: "fileReference" }>).reference,
				).length;
			const from = paragraphPosition + 1 + nodePosition;
			positions.push({ from, to: from + node.nodeSize, start: offset, end: offset + length });
			offset += length;
		});
	});
	return {
		toBody(position: number): number {
			for (const part of positions) {
				if (position < part.from) return part.start;
				if (position <= part.to)
					return (
						part.start +
						Math.round(((position - part.from) / (part.to - part.from)) * (part.end - part.start))
					);
			}
			return offset;
		},
		toEditor(bodyOffset: number, affinity: "left" | "right" = "right"): number {
			const target = Math.max(0, Math.min(offset, bodyOffset));
			for (const part of positions) {
				if (affinity === "left" && target === part.start) return part.from;
				if (affinity === "left" && target === part.end) return part.to;
				if (part.end <= target) continue;
				if (target <= part.start) return part.from;
				return (
					part.from +
					Math.round(((target - part.start) / (part.end - part.start)) * (part.to - part.from))
				);
			}
			return Math.max(1, doc.content.size - 1);
		},
	};
}

function warnSlowComposer(
	phase: "conversion" | "transaction",
	elapsedMs: number,
	doc: ProseMirrorNode,
) {
	if (!import.meta.env?.DEV || elapsedMs <= (phase === "conversion" ? 16 : 50)) return;
	let nodes = 0;
	doc.descendants(() => {
		nodes++;
	});
	console.warn(`[InlineComposerEditor] slow ${phase}`, { elapsedMs, nodes });
}

function safeImageSource(resource: File | string | undefined): string | undefined {
	if (typeof resource !== "string") return undefined;
	if (resource.startsWith("blob:") || /^\/api\//.test(resource)) return resource;
	return undefined;
}
function ComposerAtomView({ node, selected, editor, getPos }: NodeViewProps) {
	const context = useContext(AtomContext);
	const { t } = useTranslation("narrator");
	const value = node.attrs.value as AtomNode;
	const asset = value.type === "attachment" ? context.assets.get(value.assetId) : undefined;
	const resource = value.type === "attachment" ? context.resources?.get(value.assetId) : undefined;
	const [objectURL, setObjectURL] = useState<{ file: File; url: string }>();
	const [failedSource, setFailedSource] = useState<string>();
	const gesture = useRef<{ type: string; x: number; y: number; moved: boolean } | null>(null);
	const pointerType = useRef("mouse");
	useEffect(() => {
		setFailedSource(undefined);
		if (asset?.kind !== "image" || !resource || typeof resource === "string") {
			setObjectURL(undefined);
			return;
		}
		const url = URL.createObjectURL(resource);
		setObjectURL({ file: resource, url });
		return () => URL.revokeObjectURL(url);
	}, [resource, asset?.kind]);
	const image = asset?.kind === "image";
	const source =
		typeof resource === "string"
			? safeImageSource(resource)
			: objectURL?.file === resource
				? objectURL?.url
				: undefined;
	const failed = !!source && failedSource === source;
	const restoring =
		value.type === "attachment" &&
		((!resource && context.attachmentsHydrating) ||
			(image && !!resource && typeof resource !== "string" && !source));
	const label =
		value.type === "quote"
			? value.label
			: value.type === "fileReference"
				? fileReferenceToken(value.reference).replace(/^#file:/, "")
				: (asset?.name ?? t("attachments.missing", { defaultValue: "Attachment unavailable" }));
	const missing = value.type === "attachment" && !resource && !restoring;
	const select = () => {
		const position = getPos();
		if (typeof position === "number") editor.chain().focus().setNodeSelection(position).run();
	};
	const remove = () => {
		if (context.disabled) return;
		const position = getPos();
		if (typeof position !== "number") return;
		editor.view.dispatch(closeHistory(editor.state.tr).delete(position, position + node.nodeSize));
		editor.commands.focus();
	};
	const open =
		value.type === "quote"
			? context.onOpenQuote
				? () => context.onOpenQuote?.(value)
				: undefined
			: value.type === "fileReference"
				? context.onOpenFile
					? () => context.onOpenFile?.(value.reference)
					: undefined
				: asset
					? image
						? context.onOpenImage && (() => context.onOpenImage?.(asset))
						: context.onOpenAttachment && (() => context.onOpenAttachment?.(asset))
					: undefined;
	const preview = () => {
		if (!restoring && !missing) open?.();
	};
	const Icon =
		value.type === "quote"
			? IconQuote
			: value.type === "fileReference"
				? IconFileText
				: image
					? IconPhoto
					: IconPaperclip;
	return (
		<NodeViewWrapper
			as="span"
			contentEditable={false}
			className={`${classes.atom} ${image ? classes.imageAtom : classes.chip} ${selected ? classes.selected : ""}`}
			data-composer-atom={value.type}
			data-composer-asset-id={value.type === "attachment" ? value.assetId : undefined}
			data-missing={missing || undefined}
			data-loading={restoring || undefined}
			aria-busy={restoring || undefined}
		>
			<button
				type="button"
				className={classes.nodeBody}
				title={value.type === "quote" ? value.text.slice(0, 600) : label}
				aria-label={label}
				onPointerDown={(event) => {
					event.preventDefault();
					pointerType.current = event.pointerType;
					gesture.current = {
						type: event.pointerType,
						x: event.clientX,
						y: event.clientY,
						moved: false,
					};
				}}
				onPointerMove={(event) => {
					const start = gesture.current;
					if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
						start.moved = true;
				}}
				onPointerCancel={() => {
					gesture.current = null;
				}}
				onClick={(event) => {
					const start = gesture.current;
					gesture.current = null;
					const type = (event.nativeEvent as PointerEvent).pointerType || start?.type;
					if ((!type && event.detail === 0) || (start && !start.moved && type !== "mouse"))
						preview();
					else {
						select();
						// A quote chip opens its detail on a plain click; other atoms keep
						// click-to-select and open on double-click.
						if (value.type === "quote" && type === "mouse" && !start?.moved) preview();
					}
				}}
				onDoubleClick={() => {
					if (pointerType.current === "mouse" && value.type !== "quote") preview();
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						// Let the button generate its native keyboard click, but never submit the composer.
						event.stopPropagation();
						gesture.current = null;
					}
				}}
			>
				{image ? (
					<span className={classes.thumbnail}>
						{source && !failed ? (
							<img key={source} src={source} alt={label} onError={() => setFailedSource(source)} />
						) : restoring ? (
							<IconLoader2 size={22} />
						) : (
							<IconPhoto size={22} />
						)}
						<span className={classes.imageLabel}>
							{restoring ? t("attachments.restoring") : label}
						</span>
					</span>
				) : (
					<>
						{restoring ? <IconLoader2 size={14} /> : <Icon size={14} />}
						<span className={classes.label}>{label}</span>
						{asset && <small>{Math.ceil(asset.size / 1024)} KB</small>}
					</>
				)}
			</button>
			<span className={classes.nodeActions}>
				<button
					type="button"
					className={classes.action}
					disabled={context.disabled}
					aria-label={t(
						value.type === "quote"
							? "quote.remove"
							: value.type === "fileReference"
								? "fileReferences.remove"
								: "attachments.remove",
						{ defaultValue: "Remove attachment" },
					)}
					onPointerDown={(event) => event.preventDefault()}
					onClick={remove}
				>
					<IconX size={12} />
				</button>
			</span>
			{missing && (
				<span
					className={classes.missing}
					title={
						context.attachmentsRestoreFailed
							? t("composerAttachmentsRestoreFailed")
							: t("attachments.missing", { defaultValue: "Attachment needs to be reselected" })
					}
				>
					!
				</span>
			)}
		</NodeViewWrapper>
	);
}
function atomExtension(name: AtomNode["type"]) {
	return Node.create({
		name,
		group: "inline",
		inline: true,
		atom: true,
		selectable: true,
		draggable: false,
		addAttributes: () => ({ value: { default: null } }),
		// Only programmatic semantic inserts create atoms. External HTML is never imported.
		parseHTML: () => [],
		renderHTML: () => ["span", { "data-composer-atom": name }],
		addNodeView: () => ReactNodeViewRenderer(ComposerAtomView, { as: "span" }),
	});
}

export const InlineComposerEditor = forwardRef<
	InlineComposerEditorHandle,
	InlineComposerEditorProps
>(function InlineComposerEditor(props, ref) {
	const { t } = useTranslation("narrator");
	const propsRef = useRef(props);
	propsRef.current = props;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const leadingRef = useRef<HTMLDivElement | null>(null);
	const trailingRef = useRef<HTMLDivElement | null>(null);
	// Deliberately retain asset metadata for undo, including assets no longer in the live document.
	const assetsRef = useRef(new Map(props.value.assets.map((asset) => [asset.id, asset])));
	const [assetGeneration, setAssetGeneration] = useState(0);
	const latestRef = useRef(props.value);
	const signatureRef = useRef(JSON.stringify(props.value));
	const actualSignatureRef = useRef<string | null>(null);
	/*
	 * Documents emitted through onChange that the parent has not rendered back yet,
	 * oldest first. Under load the parent can commit an older emission after the
	 * editor moved on (an insert's render landing after the next undo); such a stale
	 * echo is not a new controlled value, and replacing the document with it would
	 * rebuild the state and wipe the undo history.
	 */
	const pendingEchoesRef = useRef<string[]>([]);
	const receivedValueRef = useRef(props.value);
	const transactionStartedRef = useRef(0);
	const bookmarksRef = useRef(new Set<{ value: SelectionBookmark | null }>());
	const clearBookmarks = useCallback(() => {
		for (const bookmark of bookmarksRef.current) bookmark.value = null;
		bookmarksRef.current.clear();
	}, []);
	const mergeAssets = (assets: ComposerAsset[]) => {
		for (const asset of assets) assetsRef.current.set(asset.id, asset);
	};
	const selectionOf = (doc: ProseMirrorNode, selection: Selection): InlineComposerSelection => {
		const mapping = editorBodyPositions(doc);
		return Object.defineProperties(
			{ start: mapping.toBody(selection.from), end: mapping.toBody(selection.to) },
			{
				empty: { value: selection.empty },
				type: {
					value:
						selection instanceof NodeSelection
							? "node"
							: selection instanceof TextSelection
								? "text"
								: "all",
				},
			},
		);
	};
	const editor = useEditor({
		immediatelyRender: false,
		shouldRerenderOnTransaction: false,
		enableInputRules: false,
		enablePasteRules: false,
		content: composerDocumentToEditorJSON(props.value),
		extensions: [
			StarterKit.configure({
				blockquote: false,
				bold: false,
				bulletList: false,
				code: false,
				codeBlock: false,
				heading: false,
				horizontalRule: false,
				italic: false,
				link: false,
				listItem: false,
				listKeymap: false,
				orderedList: false,
				strike: false,
				underline: false,
				trailingNode: false,
				gapcursor: false,
				dropcursor: false,
			}),
			atomExtension("quote"),
			atomExtension("fileReference"),
			atomExtension("attachment"),
			Extension.create({
				name: "composerBoundaries",
				addProseMirrorPlugins: () => [
					new Plugin({
						state: {
							init: () => null,
							apply: (transaction) => {
								for (const bookmark of bookmarksRef.current) {
									if (bookmark.value) bookmark.value = bookmark.value.map(transaction.mapping);
								}
								return null;
							},
						},
						filterTransaction: (transaction) => {
							if (!transaction.docChanged) return true;
							const started = performance.now();
							transactionStartedRef.current = started;
							try {
								parseComposerDocument(readEditorDocument(transaction.doc, assetsRef.current));
								return true;
							} catch {
								return false;
							} finally {
								warnSlowComposer("conversion", performance.now() - started, transaction.doc);
							}
						},
					}),
				],
				addKeyboardShortcuts() {
					const selectAdjacent = (backward: boolean) => {
						const { state, view } = this.editor;
						if (
							view.composing ||
							!state.selection.empty ||
							state.selection instanceof NodeSelection
						)
							return false;
						const adjacent = backward
							? state.selection.$from.nodeBefore
							: state.selection.$from.nodeAfter;
						if (!adjacent?.isAtom || adjacent.isText || adjacent.type.name === "hardBreak")
							return false;
						view.dispatch(
							state.tr.setSelection(
								NodeSelection.create(
									state.doc,
									state.selection.from - (backward ? adjacent.nodeSize : 0),
								),
							),
						);
						return true;
					};
					return { Backspace: () => selectAdjacent(true), Delete: () => selectAdjacent(false) };
				},
			}),
		],
		editorProps: {
			attributes: (state) => ({
				role: "textbox",
				"aria-multiline": "true",
				class: classes.editable,
				"data-empty": String(
					state.doc.childCount === 1 && state.doc.firstChild?.content.size === 0,
				),
			}),
			handleKeyDown: (_view, event) => event.defaultPrevented,
			clipboardTextSerializer: (slice) =>
				slice.content.textBetween(0, slice.content.size, "\n", (node) => {
					if (node.type.name === "hardBreak") return "\n";
					const value = node.attrs.value as AtomNode | undefined;
					if (value?.type === "quote") return `${value.label}: ${value.text}`;
					if (value?.type === "fileReference") return fileReferenceToken(value.reference);
					if (value?.type === "attachment")
						return assetsRef.current.get(value.assetId)?.name ?? "[attachment]";
					return "";
				}),
			handlePaste: (view, event) => {
				if (propsRef.current.disabled) return true;
				const files = Array.from(event.clipboardData?.files ?? []);
				if (files.length) {
					event.preventDefault();
					propsRef.current.onPasteFiles?.(files);
					return true;
				}
				const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
				event.preventDefault();
				if (!text || text.length > 200_000) return true;
				const nodes: ProseMirrorNode[] = [];
				for (const [index, line] of text.split("\n").entries()) {
					if (index) nodes.push(view.state.schema.nodes.hardBreak.create());
					if (line) nodes.push(view.state.schema.text(line));
				}
				view.dispatch(
					view.state.tr
						.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0))
						.scrollIntoView(),
				);
				return true;
			},
			handleDrop: (view, event) => {
				const files = Array.from(event.dataTransfer?.files ?? []);
				if (!files.length) return false;
				event.preventDefault();
				event.stopPropagation();
				if (propsRef.current.disabled) {
					propsRef.current.onPasteFiles?.([]);
					return true;
				}
				const position = view.posAtCoords({ left: event.clientX, top: event.clientY });
				if (position)
					view.dispatch(
						view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position.pos))),
					);
				propsRef.current.onPasteFiles?.(files);
				return true;
			},
		},
		onCreate: ({ editor: instance }) => {
			// The imperative handle can receive restore→append before useEditor creates its instance.
			const current = readEditorDocument(instance.state.doc, assetsRef.current);
			if (JSON.stringify(current) !== signatureRef.current) {
				const doc = instance.schema.nodeFromJSON(composerDocumentToEditorJSON(latestRef.current));
				instance.view.updateState(
					EditorState.create({
						schema: instance.schema,
						doc,
						plugins: instance.state.plugins,
						selection: TextSelection.atEnd(doc),
					}),
				);
			} else instance.commands.setTextSelection(Math.max(1, instance.state.doc.content.size - 1));
			actualSignatureRef.current = JSON.stringify(
				readEditorDocument(instance.state.doc, assetsRef.current),
			);
		},
		onUpdate: ({ editor: instance, transaction }) => {
			if (!transaction.docChanged) return;
			const document = readEditorDocument(instance.state.doc, assetsRef.current);
			const currentAssets = new Set(document.assets.map((asset) => asset.id));
			const removed = latestRef.current.assets.filter((asset) => !currentAssets.has(asset.id));
			latestRef.current = document;
			signatureRef.current = JSON.stringify(document);
			actualSignatureRef.current = signatureRef.current;
			pendingEchoesRef.current.push(signatureRef.current);
			if (pendingEchoesRef.current.length > MAX_PENDING_ECHOES) pendingEchoesRef.current.shift();
			propsRef.current.onChange(document);
			for (const asset of removed) propsRef.current.onRemoveAsset?.(asset.id);
			if (transactionStartedRef.current)
				warnSlowComposer(
					"transaction",
					performance.now() - transactionStartedRef.current,
					instance.state.doc,
				);
		},
		onSelectionUpdate: ({ editor: instance }) =>
			propsRef.current.onSelectionChange?.(
				selectionOf(instance.state.doc, instance.state.selection),
			),
		onFocus: ({ editor: instance }) => {
			propsRef.current.onFocus?.();
			propsRef.current.onSelectionChange?.(
				selectionOf(instance.state.doc, instance.state.selection),
			);
		},
		onBlur: ({ editor: instance }) => {
			// Keep the native selection/bookmarks, but let query UI close independently.
			propsRef.current.onSelectionChange?.(
				selectionOf(instance.state.doc, instance.state.selection),
			);
			propsRef.current.onBlur?.();
		},
	});
	useComposerLayout({ editor, adaptive: !!props.adaptive, rootRef, leadingRef, trailingRef });
	const replaceDocument = (document: ComposerDocument, preserveHistory = false) => {
		const parsed = parseComposerDocument(document);
		if (preserveHistory && propsRef.current.disabled) return;
		const nextAssets = new Map(preserveHistory ? assetsRef.current : []);
		for (const asset of parsed.assets) nextAssets.set(asset.id, asset);
		if (preserveHistory && editor && !editor.isDestroyed) {
			const previousAssets = assetsRef.current;
			assetsRef.current = nextAssets;
			try {
				const doc = editor.schema.nodeFromJSON(composerDocumentToEditorJSON(parsed));
				editor.view.dispatch(
					closeHistory(editor.state.tr).replaceWith(0, editor.state.doc.content.size, doc.content),
				);
				editor.view.dispatch(closeHistory(editor.state.tr));
			} catch (error) {
				assetsRef.current = previousAssets;
				throw error;
			}
			clearBookmarks();
			setAssetGeneration((generation) => generation + 1);
			return;
		}
		if (editor && !editor.isDestroyed) {
			const doc = editor.schema.nodeFromJSON(composerDocumentToEditorJSON(parsed));
			// A failed view application cannot clear the current draft's metadata or resources.
			editor.view.updateState(
				EditorState.create({
					schema: editor.schema,
					doc,
					plugins: editor.state.plugins,
					selection: TextSelection.atEnd(doc),
				}),
			);
		}
		assetsRef.current = nextAssets;
		latestRef.current = parsed;
		signatureRef.current = JSON.stringify(parsed);
		clearBookmarks();
		if (editor && !editor.isDestroyed) {
			actualSignatureRef.current = JSON.stringify(
				readEditorDocument(editor.state.doc, assetsRef.current),
			);
			propsRef.current.onSelectionChange?.(selectionOf(editor.state.doc, editor.state.selection));
		}
		setAssetGeneration((generation) => generation + 1);
	};
	useEffect(() => {
		if (!editor || receivedValueRef.current === props.value) return;
		receivedValueRef.current = props.value;
		const signature = JSON.stringify(props.value);
		const echo = pendingEchoesRef.current.indexOf(signature);
		if (echo >= 0) {
			// The parent caught up to (at least) this emission; anything older is settled.
			pendingEchoesRef.current.splice(0, echo + 1);
			return;
		}
		// Internal render/imperative restore is not a newly received controlled value.
		if (signature !== signatureRef.current) {
			pendingEchoesRef.current = [];
			replaceDocument(props.value);
		}
	});
	useEffect(() => () => clearBookmarks(), [clearBookmarks]);
	useEffect(() => {
		editor?.setEditable(!props.disabled, false);
	}, [editor, props.disabled]);
	useEffect(() => {
		if (!editor) return;
		const element = editor.view.dom as HTMLDivElement;
		if (props.elementRef) props.elementRef.current = element;
		props.onElement?.(element);
		return () => {
			if (props.elementRef) props.elementRef.current = null;
			props.onElement?.(null);
		};
	}, [editor, props.elementRef, props.onElement]);
	useEffect(() => {
		if (!editor) return;
		editor.view.dom.setAttribute(
			"aria-label",
			props.placeholder ?? t("composer.placeholder", { defaultValue: "Message" }),
		);
		editor.view.dom.setAttribute("data-placeholder", props.placeholder ?? "");
		editor.view.dom.setAttribute("aria-disabled", String(!!props.disabled));
	}, [editor, props.placeholder, props.disabled, t]);
	const isCaretOnVerticalEdge = (direction: "up" | "down") => {
		if (!editor || editor.isDestroyed || editor.view.dom.getClientRects().length === 0)
			return false;
		const selection = editor.state.selection;
		if (!selection.empty || !(selection instanceof TextSelection)) return false;
		try {
			const edge =
				direction === "up"
					? TextSelection.atStart(editor.state.doc).from
					: TextSelection.atEnd(editor.state.doc).from;
			const caret = editor.view.coordsAtPos(selection.head);
			const boundary = editor.view.coordsAtPos(edge);
			if (caret.bottom <= caret.top || boundary.bottom <= boundary.top) return false;
			const lineHeight =
				Number.parseFloat(getComputedStyle(editor.view.dom).lineHeight) ||
				boundary.bottom - boundary.top;
			return Math.abs(caret.top - boundary.top) < Math.max(4, lineHeight / 2);
		} catch {
			return false;
		}
	};
	const revealCaretAtEnd = () => {
		if (!editor || editor.isDestroyed) return;
		editor.view.dispatch(
			editor.state.tr
				.setSelection(TextSelection.atEnd(editor.state.doc))
				.scrollIntoView()
				.setMeta("addToHistory", false),
		);
	};
	useImperativeHandle(ref, () => ({
		focus: () => {
			editor?.commands.focus();
		},
		getDocument: () =>
			editor && actualSignatureRef.current !== null
				? readEditorDocument(editor.state.doc, assetsRef.current)
				: latestRef.current,
		setDocument: replaceDocument,
		insertNodes: (nodes, assets = []) => {
			if (!editor || propsRef.current.disabled) return;
			mergeAssets(assets);
			const content = nodes
				.filter((node) => node.type !== "text" || node.text.length > 0)
				.map(inlineJSON);
			if (!content.length) {
				if (editor.state.selection.empty) return;
				editor.view.dispatch(closeHistory(editor.state.tr).deleteSelection());
				editor.view.dispatch(closeHistory(editor.state.tr));
				return;
			}
			editor.view.dispatch(closeHistory(editor.state.tr));
			editor.chain().focus().insertContent(content).run();
			editor.view.dispatch(closeHistory(editor.state.tr));
			setAssetGeneration((generation) => generation + 1);
		},
		insertFiles: (files) => {
			if (!propsRef.current.disabled) propsRef.current.onPasteFiles?.(files);
		},
		getSelection: () =>
			editor ? selectionOf(editor.state.doc, editor.state.selection) : { start: 0, end: 0 },
		isCaretOnVerticalEdge,
		revealCaretAtEnd,
		getTextContext: () => {
			if (!editor || editor.isDestroyed) return null;
			const { selection, doc } = editor.state;
			if (!(selection instanceof TextSelection) || !selection.empty) return null;
			const { parent, parentOffset } = selection.$from;
			if (!parent.inlineContent) return null;
			const mapping = editorBodyPositions(doc);
			const caret = mapping.toBody(selection.from);
			let run: { text: string; from: number; to: number } | null = null;
			let found: { text: string; from: number; to: number } | null = null;
			parent.forEach((node, offset) => {
				if (!node.isText) {
					run = null;
					return;
				}
				if (run) {
					run.text += node.text ?? "";
					run.to = offset + node.nodeSize;
				} else run = { text: node.text ?? "", from: offset, to: offset + node.nodeSize };
				if (parentOffset >= run.from && parentOffset <= run.to) found = run;
			});
			// A caret between two atoms still has a valid empty text context.
			if (!found) return { text: "", start: caret, end: caret, caret };
			const fragment = found as { text: string; from: number; to: number };
			const start = caret - (parentOffset - fragment.from);
			return { text: fragment.text, start, end: start + fragment.text.length, caret };
		},
		captureSelectionBookmark: () => {
			const entry = {
				value: editor && !editor.isDestroyed ? editor.state.selection.getBookmark() : null,
			};
			if (entry.value) {
				if (bookmarksRef.current.size >= 64) {
					const oldest = bookmarksRef.current.values().next().value;
					if (oldest) {
						oldest.value = null;
						bookmarksRef.current.delete(oldest);
					}
				}
				bookmarksRef.current.add(entry);
			}
			const cancel = () => {
				entry.value = null;
				bookmarksRef.current.delete(entry);
			};
			return {
				cancel,
				restore: () => {
					const bookmark = entry.value;
					cancel();
					if (!bookmark || !editor || editor.isDestroyed) return false;
					try {
						editor.view.dispatch(
							editor.state.tr
								.setSelection(bookmark.resolve(editor.state.doc))
								.setMeta("addToHistory", false),
						);
						return true;
					} catch {
						return false;
					}
				},
			};
		},
		setSelection: (start, end) => {
			if (!editor) return;
			const mapping = editorBodyPositions(editor.state.doc);
			const native = editor.state.selection;
			if (start === end && native.empty && mapping.toBody(native.from) === start) return;
			editor.commands.setTextSelection({
				from: mapping.toEditor(start, start > end ? "left" : "right"),
				to: mapping.toEditor(end, start < end ? "left" : "right"),
			});
		},
		getElement: () => (editor?.view.dom as HTMLDivElement) ?? null,
	}));
	const atomContext = useMemo(
		() => ({
			assets: new Map(assetsRef.current),
			resources: props.resources,
			attachmentsHydrating: props.attachmentsHydrating,
			attachmentsRestoreFailed: props.attachmentsRestoreFailed,
			disabled: props.disabled,
			onOpenQuote: props.onOpenQuote,
			onOpenFile: props.onOpenFile,
			onOpenImage: props.onOpenImage,
			onOpenAttachment: props.onOpenAttachment,
			// The generation changes only for insert/load, not individual text keystrokes.
			generation: assetGeneration,
		}),
		[
			assetGeneration,
			props.resources,
			props.attachmentsHydrating,
			props.attachmentsRestoreFailed,
			props.disabled,
			props.onOpenQuote,
			props.onOpenFile,
			props.onOpenImage,
			props.onOpenAttachment,
		],
	);
	return (
		<AtomContext.Provider value={atomContext}>
			<div
				ref={rootRef}
				className={classes.root}
				data-inline-composer
				data-adaptive={props.adaptive || undefined}
				data-assets-generation={assetGeneration}
				data-disabled={props.disabled || undefined}
				onDropCapture={(event) => {
					if (!propsRef.current.disabled || !event.dataTransfer.files.length) return;
					event.preventDefault();
					event.stopPropagation();
					propsRef.current.onPasteFiles?.([]);
				}}
				onKeyDownCapture={(event) => {
					const target = event.target as HTMLElement;
					if (!editor?.view.dom.contains(target) || target.closest("button")) return;
					if (
						!event.nativeEvent.isComposing &&
						event.nativeEvent.keyCode !== 229 &&
						!editor.view.composing
					)
						propsRef.current.onKeyDown?.(event);
				}}
			>
				<EditorContent editor={editor} className={classes.content} data-composer-scroll />
				{(props.controls || props.leadingControls) && (
					<div className={classes.controls} data-composer-controls>
						<div ref={leadingRef} className={classes.leadingControls}>
							{props.leadingControls}
						</div>
						<div ref={trailingRef} className={classes.trailingControls}>
							{props.controls}
						</div>
					</div>
				)}
			</div>
		</AtomContext.Provider>
	);
});
