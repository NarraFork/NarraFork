import {
	ActionIcon,
	Box,
	Button,
	Checkbox,
	Group,
	Loader,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconArrowDown, IconArrowUp, IconSearch, IconSelectAll, IconX } from "@tabler/icons-react";
import type { editor as Monaco } from "monaco-editor";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { applyEditorReplacePlan, EditorSearchClient } from "./editor-worker-client";
import {
	EDITOR_WORKER_LIMITS as L,
	type SearchOptions,
	type SearchPage,
	type TextMatch,
} from "./editor-worker-protocol";

export interface MonacoSearchPanelProps {
	editor: Monaco.IStandaloneCodeEditor;
	onClose: () => void;
	readOnly: boolean;
	onSave?: () => void | Promise<void>;
}

export function MonacoSearchPanel({ editor, onClose, readOnly, onSave }: MonacoSearchPanelProps) {
	const { t } = useTranslation("narrator");
	const phrases = t("fileEditor.searchPhrases", { returnObjects: true }) as Record<string, string>;
	const label = (key: string) => phrases[key] ?? key;
	const [options, setOptions] = useState<SearchOptions>({
		query: "",
		caseSensitive: false,
		wholeWord: false,
		regexp: false,
	});
	const [replacement, setReplacement] = useState("");
	const [version, setVersion] = useState(0);
	const [composing, setComposing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [page, setPage] = useState<SearchPage | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const client = useRef<EditorSearchClient | null>(null);
	const controller = useRef<AbortController | null>(null);
	const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
	const generation = useRef(0);
	const lastMatch = useRef<TextMatch | null>(null);
	const permission = useRef(readOnly);
	permission.current = readOnly;
	const decorations = useRef<Monaco.IEditorDecorationsCollection | null>(null);

	const cancel = useCallback(() => {
		if (debounce.current !== null) {
			clearTimeout(debounce.current);
			debounce.current = null;
		}
		generation.current++;
		controller.current?.abort();
		controller.current = null;
		setBusy(false);
	}, []);
	const close = () => {
		cancel();
		onClose();
		editor.focus();
	};
	useLayoutEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	useEffect(() => {
		const attach = () => {
			cancel();
			client.current?.dispose();
			decorations.current?.clear();
			const model = editor.getModel();
			client.current = model ? new EditorSearchClient(model) : null;
			setPage(null);
			setVersion((value) => value + 1);
		};
		decorations.current = editor.createDecorationsCollection();
		attach();
		const modelListener = editor.onDidChangeModel(attach);
		const contentListener = editor.onDidChangeModelContent(() => {
			cancel();
			decorations.current?.clear();
			setPage(null);
			setVersion((value) => value + 1);
		});
		return () => {
			cancel();
			modelListener.dispose();
			contentListener.dispose();
			client.current?.dispose();
			client.current = null;
			decorations.current?.clear();
			decorations.current = null;
		};
	}, [editor, cancel]);

	const range = (match: TextMatch) => {
		const model = editor.getModel();
		if (!model) throw new Error("EDITOR_STALE");
		const start = model.getPositionAt(match.offset);
		const end = model.getPositionAt(match.offset + match.length);
		return {
			startLineNumber: start.lineNumber,
			startColumn: start.column,
			endLineNumber: end.lineNumber,
			endColumn: end.column,
		};
	};
	const run = async (
		work: (worker: EditorSearchClient, signal: AbortSignal) => Promise<() => void>,
	) => {
		cancel();
		const worker = client.current;
		if (!worker) return;
		const request = generation.current;
		const abort = new AbortController();
		controller.current = abort;
		setBusy(true);
		setError("");
		try {
			const apply = await work(worker, abort.signal);
			if (request !== generation.current || abort.signal.aborted) return;
			apply();
		} catch (cause) {
			if (request !== generation.current || abort.signal.aborted) return;
			setError(cause instanceof Error ? cause.message : "EDITOR_WORKER_ERROR");
		} finally {
			if (request === generation.current) {
				controller.current = null;
				setBusy(false);
			}
		}
	};
	const search = (backwards = false, navigate = false) => {
		if (composing || !options.query) return;
		const model = editor.getModel();
		const selection = editor.getSelection();
		let anchor =
			model && selection
				? model.getOffsetAt(
						navigate && !backwards ? selection.getEndPosition() : selection.getStartPosition(),
					)
				: 0;
		if (
			navigate &&
			!backwards &&
			selection?.isEmpty() &&
			lastMatch.current?.length === 0 &&
			lastMatch.current.offset === anchor
		)
			anchor++;
		void run(async (worker, signal) => {
			const result = await worker.search(options, anchor, backwards, signal);
			return () => {
				setPage(result);
				decorations.current?.set(
					result.matches.slice(0, L.page).map((match) => ({
						range: range(match),
						options: { className: "findMatch", stickiness: 1 },
					})),
				);
				if (navigate && result.matches[0]) {
					lastMatch.current = result.matches[0];
					const target = range(result.matches[0]);
					editor.setSelection(target);
					editor.revealRangeInCenterIfOutsideViewport(target);
				}
			};
		});
	};
	// Debounce user input only; Monaco changes never expand the model on this thread.
	// biome-ignore lint/correctness/useExhaustiveDependencies: search reads current render state; page/busy updates must not start another job.
	useEffect(() => {
		cancel();
		lastMatch.current = null;
		setPage(null);
		setError("");
		decorations.current?.clear();
		if (!options.query || composing) return;
		const timer = setTimeout(() => {
			debounce.current = null;
			search();
		}, 150);
		debounce.current = timer;
		return () => {
			clearTimeout(timer);
			if (debounce.current === timer) debounce.current = null;
		};
	}, [options, version, composing, cancel]);

	const selectAll = () => {
		if (composing) return;
		void run(async (worker, signal) => {
			const matches = await worker.selectAll(options, signal);
			return () => {
				if (!matches.length) return;
				editor.setSelections(
					matches.map((match) => {
						const target = range(match);
						return {
							selectionStartLineNumber: target.startLineNumber,
							selectionStartColumn: target.startColumn,
							positionLineNumber: target.endLineNumber,
							positionColumn: target.endColumn,
						};
					}),
				);
			};
		});
	};
	const replace = (all: boolean) => {
		if (permission.current || composing) return;
		const model = editor.getModel();
		const selection = editor.getSelection();
		const anchor = model && selection ? model.getOffsetAt(selection.getStartPosition()) : 0;
		void run(async (worker, signal) => {
			const plan = await worker.replace(options, replacement, all, anchor, signal);
			return () => applyEditorReplacePlan(editor, plan, permission.current);
		});
	};
	const disabled = !options.query || composing;
	return (
		<Box
			p="xs"
			role="search"
			aria-label={t("fileEditor.search")}
			data-editor-search-panel="true"
			style={{
				background: "var(--mantine-color-body)",
				color: "var(--mantine-color-text)",
				fontFamily: "var(--mantine-font-family)",
				borderBottom: "1px solid var(--mantine-color-default-border)",
			}}
			onCompositionStart={() => setComposing(true)}
			onCompositionEnd={() => setComposing(false)}
			onKeyDown={(event) => {
				if (event.nativeEvent.isComposing || event.keyCode === 229 || composing) return;
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
					event.preventDefault();
					event.stopPropagation();
					if (!permission.current) void onSave?.();
				} else if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					close();
				} else if (event.key === "Enter" && (event.target as HTMLElement).tagName === "INPUT") {
					event.preventDefault();
					event.stopPropagation();
					if (!event.shiftKey && (event.target as HTMLElement).hasAttribute("data-replace-field"))
						replace(false);
					else search(event.shiftKey, true);
				}
			}}
		>
			<Stack gap="xs">
				<Group gap={4} wrap="nowrap" align="flex-start">
					<TextInput
						ref={input}
						size="xs"
						name="search"
						aria-label={label("Find")}
						placeholder={label("Find")}
						leftSection={<IconSearch size={14} />}
						value={options.query}
						maxLength={L.queryLength}
						onChange={(event) => setOptions({ ...options, query: event.currentTarget.value })}
						style={{ flex: 1, minWidth: 0 }}
					/>
					<Group gap={2} wrap="nowrap">
						<Tooltip label={label("previous")}>
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={label("previous")}
								disabled={disabled}
								onClick={() => search(true, true)}
							>
								<IconArrowUp size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={label("next")}>
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={label("next")}
								disabled={disabled}
								onClick={() => search(false, true)}
							>
								<IconArrowDown size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={label("all")}>
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={label("all")}
								disabled={disabled}
								onClick={selectAll}
							>
								<IconSelectAll size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={label("close")}>
							<ActionIcon
								variant="subtle"
								size="sm"
								color="gray"
								aria-label={label("close")}
								onClick={close}
							>
								<IconX size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>
				<Group gap="sm">
					<Checkbox
						size="xs"
						label={label("match case")}
						checked={options.caseSensitive}
						onChange={(event) =>
							setOptions({ ...options, caseSensitive: event.currentTarget.checked })
						}
					/>
					<Checkbox
						size="xs"
						label={label("by word")}
						checked={options.wholeWord}
						onChange={(event) => setOptions({ ...options, wholeWord: event.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={label("regexp")}
						checked={options.regexp}
						onChange={(event) => setOptions({ ...options, regexp: event.currentTarget.checked })}
					/>
				</Group>
				{!readOnly && (
					<Group gap={4}>
						<TextInput
							size="xs"
							name="replace"
							data-replace-field="true"
							aria-label={label("Replace")}
							placeholder={label("Replace")}
							value={replacement}
							maxLength={L.queryLength}
							onChange={(event) => setReplacement(event.currentTarget.value)}
							style={{ flex: "1 1 120px", minWidth: 0 }}
						/>
						<Button
							size="compact-xs"
							variant="default"
							disabled={disabled}
							onClick={() => replace(false)}
						>
							{label("replace")}
						</Button>
						<Button
							size="compact-xs"
							variant="light"
							disabled={disabled}
							onClick={() => replace(true)}
						>
							{label("replace all")}
						</Button>
					</Group>
				)}
				<Group gap="xs" aria-live="polite">
					{busy && (
						<>
							<Loader size="xs" />
							<Text size="xs">{t("fileEditor.searchWorking")}</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => {
									cancel();
									setError("EDITOR_CANCELLED");
								}}
							>
								{t("fileEditor.searchCancel")}
							</Button>
						</>
					)}
					{!busy && page && (
						<Text size="xs">
							{t("fileEditor.searchMatchCount", {
								count: page.count,
								suffix: page.more ? "+" : "",
							})}
						</Text>
					)}
					{error && (
						<Text size="xs" c="red" role="alert">
							{t(`fileEditor.searchErrors.${error}`, {
								defaultValue: t("fileEditor.searchErrors.EDITOR_WORKER_ERROR"),
							})}
						</Text>
					)}
				</Group>
			</Stack>
		</Box>
	);
}
