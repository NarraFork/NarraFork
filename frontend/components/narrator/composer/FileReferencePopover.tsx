import { fileReferenceApi } from "@frontend/lib/api/file-references";
import { Z } from "@frontend/lib/z-index";
import { Group, Paper, Text, UnstyledButton, useComputedColorScheme } from "@mantine/core";
import {
	FILE_REFERENCE_SEARCH_DEBOUNCE_MS,
	FILE_REFERENCE_SEARCH_TIMEOUT_MS,
	type FileReference,
	type FileReferenceCandidate,
	type FileReferenceContext,
	type FileReferenceEditorSelection,
	MAX_FILE_REFERENCE_SEARCH_RESULTS,
} from "@shared/file-reference";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	createFileReferenceId,
	type FileReferenceQuery,
	fileReferenceKeyAction,
	recentFileReferences,
	savedSelectionReference,
} from "./file-reference-input";

export interface FileReferencePopoverProps {
	narratorId: string;
	context?: FileReferenceContext | null;
	cacheScope: string | null;
	query: FileReferenceQuery | null;
	selection?: FileReferenceEditorSelection | null;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	onSelect: (reference: FileReference) => void;
	onNavigate: (candidate: FileReferenceCandidate) => void;
	onClose: () => void;
}

type Item = { candidate: FileReferenceCandidate } | { reference: FileReference };

/** The key handler is scoped to this textarea, not every composer in the document. */
export function FileReferencePopover({
	narratorId,
	context,
	cacheScope,
	query,
	selection,
	textareaRef,
	onSelect,
	onNavigate,
	onClose,
}: FileReferencePopoverProps) {
	const { t } = useTranslation("narrator");
	const scheme = useComputedColorScheme("dark");
	const [result, setResult] = useState<{
		key: string;
		entries: FileReferenceCandidate[];
		truncated?: boolean;
		error?: string;
	}>({ key: "", entries: [] });
	const [selected, setSelected] = useState({ key: "", index: 0 });
	const listRef = useRef<HTMLDivElement>(null);
	const composingRef = useRef(false);
	useEffect(() => {
		const textarea = textareaRef.current;
		const start = () => {
			composingRef.current = true;
		};
		const end = () => {
			composingRef.current = false;
		};
		textarea?.addEventListener("compositionstart", start);
		textarea?.addEventListener("compositionend", end);
		return () => {
			textarea?.removeEventListener("compositionstart", start);
			textarea?.removeEventListener("compositionend", end);
		};
	}, [textareaRef]);
	const search = query?.search ?? "";
	const deviceId = context?.deviceId;
	const cwd = context?.cwd;
	const queryKey = JSON.stringify([cacheScope, narratorId, deviceId, cwd, query?.q]);
	const selectionReference = useMemo(() => savedSelectionReference(selection), [selection]);
	const selectionQuery = search.toLowerCase() === "selection";
	const canSearch =
		!!query && !query.error && !!context && !!cacheScope && search.length > 0 && !selectionQuery;

	useEffect(() => {
		if (!canSearch) return;
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timeout = setTimeout(() => {
				setResult({
					key: queryKey,
					entries: [],
					error: t("fileReferences.searchTimeout", { defaultValue: "文件搜索超时，请缩小范围" }),
				});
				controller.abort();
			}, FILE_REFERENCE_SEARCH_TIMEOUT_MS);
			void fileReferenceApi
				.search(narratorId, { q: search, deviceId, directory: cwd }, controller.signal)
				.then((data) => {
					if (controller.signal.aborted) return;
					setResult({
						key: queryKey,
						entries: data.entries.slice(0, MAX_FILE_REFERENCE_SEARCH_RESULTS),
						truncated: data.truncated,
					});
				})
				.catch((error: unknown) => {
					if (!controller.signal.aborted)
						setResult({
							key: queryKey,
							entries: [],
							error: error instanceof Error ? error.message : String(error),
						});
				})
				.finally(() => clearTimeout(timeout));
		}, FILE_REFERENCE_SEARCH_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			clearTimeout(timeout);
			controller.abort();
		};
	}, [canSearch, search, narratorId, deviceId, cwd, queryKey, t]);

	const items = useMemo<Item[]>(() => {
		if (!query || query.error || !context || !cacheScope) return [];
		const entries = !search
			? recentFileReferences(cacheScope)
			: result.key === queryKey
				? result.entries
				: [];
		const list: Item[] = selectionQuery ? [] : entries.map((candidate) => ({ candidate }));
		if (selectionReference && "selection".startsWith(search.toLowerCase()))
			list.unshift({ reference: selectionReference });
		return list.slice(0, MAX_FILE_REFERENCE_SEARCH_RESULTS);
	}, [query, context, cacheScope, search, result, queryKey, selectionReference, selectionQuery]);
	const index =
		selected.key === queryKey ? Math.min(selected.index, Math.max(0, items.length - 1)) : 0;

	useEffect(() => {
		listRef.current
			?.querySelectorAll("[data-file-reference-item]")
			[index]?.scrollIntoView?.({ block: "nearest" });
	}, [index]);

	useEffect(() => {
		const textarea = textareaRef.current;
		if (!query || !textarea) return;
		const handle = (event: KeyboardEvent) => {
			if (composingRef.current) return;
			const action = fileReferenceKeyAction(event);
			if (!action) return;
			event.preventDefault();
			event.stopPropagation();
			if (action === "close") onClose();
			else if (action === "next" || action === "previous") {
				setSelected({
					key: queryKey,
					index: items.length
						? (index + (action === "next" ? 1 : items.length - 1)) % items.length
						: 0,
				});
			} else {
				const item = items[index];
				if (!item) return; // Pending/empty results still own Enter; never send accidentally.
				if ("reference" in item) onSelect(item.reference);
				else if (item.candidate.isDirectory) onNavigate(item.candidate);
				else
					onSelect({
						id: createFileReferenceId(),
						deviceId: item.candidate.deviceId,
						path: item.candidate.path,
						label: item.candidate.relativePath,
						selection: query.selection,
					});
			}
		};
		textarea.addEventListener("keydown", handle, true);
		return () => textarea.removeEventListener("keydown", handle, true);
	}, [query, textareaRef, items, index, queryKey, onClose, onSelect, onNavigate]);

	if (!query) return null;
	const warning =
		query.error === "queryTooLong"
			? t("fileReferences.queryTooLong", { defaultValue: "文件查询过长，请缩小范围" })
			: query.error === "invalidRange"
				? t("fileReferences.invalidRange", { defaultValue: "请输入有效的行号范围，例如 :10-20" })
				: !context || !cacheScope
					? t("fileReferences.noContext", { defaultValue: "文件工作目录尚未就绪" })
					: selectionQuery && !selectionReference
						? t("fileReferences.selectionUnavailable", {
								defaultValue: "请先保存文件并选择文本；未保存的选区不能引用",
							})
						: result.key === queryKey
							? result.error
							: undefined;
	const loading = canSearch && result.key !== queryKey;
	return (
		<Paper
			withBorder
			shadow="md"
			radius="sm"
			ref={listRef}
			role="listbox"
			aria-label={t("fileReferences.title", { defaultValue: "文件引用" })}
			style={{
				position: "absolute",
				bottom: "100%",
				left: 0,
				right: 0,
				marginBottom: 4,
				maxHeight: 260,
				overflow: "auto",
				zIndex: Z.dropdown,
			}}
		>
			<Text size="xs" c="dimmed" px={10} py={4}>
				{t("fileReferences.title", { defaultValue: "文件引用" })}
			</Text>
			{warning && (
				<Text size="xs" c="orange" px={10} py={6}>
					{warning}
				</Text>
			)}
			{loading && (
				<Text size="xs" c="dimmed" px={10} py={6}>
					{t("fileReferences.searching", { defaultValue: "正在搜索文件…" })}
				</Text>
			)}
			{!warning && !loading && items.length === 0 && (
				<Text size="xs" c="dimmed" px={10} py={6}>
					{t(search ? "fileReferences.noResults" : "fileReferences.recentEmpty", {
						defaultValue: search ? "未找到文件" : "没有最近文件，请输入文件名或路径",
					})}
				</Text>
			)}
			{items.map((item, i) => {
				const reference = "reference" in item ? item.reference : null;
				const candidate = "candidate" in item ? item.candidate : null;
				const label = reference?.label ?? candidate?.relativePath ?? "";
				const name = reference
					? `#selection · ${label}`
					: `${candidate?.name}${candidate?.isDirectory ? "/" : ""}`;
				const directory = label.replace(/[^/\\]+[/\\]?$/, "") || ".";
				return (
					<UnstyledButton
						key={reference?.id ?? JSON.stringify([candidate?.deviceId, candidate?.path])}
						role="option"
						aria-selected={i === index}
						data-file-reference-item
						onMouseDown={(event) => event.preventDefault()}
						onMouseEnter={() => setSelected({ key: queryKey, index: i })}
						onClick={() => {
							if (reference) onSelect(reference);
							else if (candidate?.isDirectory) onNavigate(candidate);
							else if (candidate)
								onSelect({
									id: createFileReferenceId(),
									deviceId: candidate.deviceId,
									path: candidate.path,
									label: candidate.relativePath,
									selection: query.selection,
								});
						}}
						style={{
							display: "block",
							width: "100%",
							padding: "6px 10px",
							background:
								i === index
									? scheme === "dark"
										? "var(--mantine-color-dark-5)"
										: "var(--mantine-color-gray-1)"
									: undefined,
						}}
					>
						<Text size="sm" truncate>
							{name}
						</Text>
						<Group gap="xs" wrap="nowrap">
							<Text size="xs" c="dimmed">
								{reference?.deviceId ?? candidate?.deviceId}
							</Text>
							<Text size="xs" c="dimmed" truncate>
								{directory}
							</Text>
						</Group>
					</UnstyledButton>
				);
			})}
			{result.key === queryKey && result.truncated && (
				<Text size="xs" c="dimmed" px={10} py={4}>
					{t("fileReferences.truncated", { defaultValue: "结果较多，请输入更具体的路径" })}
				</Text>
			)}
		</Paper>
	);
}
