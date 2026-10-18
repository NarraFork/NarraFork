import { Alert, Box, Button, Group, Loader, Text } from "@mantine/core";
import {
	EDITOR_IO_TIMEOUT_MS,
	EDITOR_RAW_WINDOW_BYTES,
	type EditorRawDocumentDescriptor,
} from "@shared/editor-document";
import { assertEditorRawMetadata } from "@shared/editor-stream-codec";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { editorDocumentApi } from "../../../lib/api/editor-documents";
import { useEditorPanelVisible, useRetainedEditorView } from "../narrator-panel-visibility";
import { EditorStreamDecoder } from "./editor-stream-decoder";

/** No random-offset claim: each page is a bounded slice of a fully revalidated
 * sequential source scan. Never install truncated text as a complete model. */
export async function readEditorRawPage(
	narratorId: string,
	document: EditorRawDocumentDescriptor,
	offset: number,
	signal: AbortSignal,
) {
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(EDITOR_IO_TIMEOUT_MS)]);
	const decoder = new EditorStreamDecoder(document.encoding, bounded);
	const parts: string[] = [];
	let consumed = 0,
		length = 0,
		pageBytes = 0,
		lines = 0,
		verified = false,
		full = false;
	try {
		await decoder.ready;
		bounded.throwIfAborted();
		await editorDocumentApi.rawSource(
			narratorId,
			document,
			async (bytes, eof) => {
				const output = await decoder.push(bytes, eof);
				const start = Math.max(0, offset - consumed);
				if (!full && start < output.text.length && length < 32 * 1024 && lines < 2000) {
					let end = Math.min(output.text.length, start + 32 * 1024 - length);
					for (let i = start; i < end; i++)
						if (output.text[i] === "\n" && ++lines === 2000) {
							end = i + 1;
							break;
						}
					// Never split a Unicode scalar at a page boundary.
					if (
						end < output.text.length &&
						output.text.charCodeAt(end - 1) >= 0xd800 &&
						output.text.charCodeAt(end - 1) <= 0xdbff
					)
						end--;
					const text = output.text.slice(start, end);
					pageBytes += new TextEncoder().encode(text).byteLength;
					if (pageBytes > 128 * 1024) throw new Error("EDITOR_PAGE_BYTE_LIMIT");
					parts.push(text);
					length += end - start;
					full = end < output.text.length || length >= 32 * 1024 || lines >= 2000;
				}
				consumed += output.text.length;
				if (eof && output.metadata) {
					assertEditorRawMetadata(document, output.metadata);
					verified = true;
				}
			},
			bounded,
			() => Math.floor((EDITOR_RAW_WINDOW_BYTES - length * 2 - 16) / 4),
		);
		if (!verified) throw new Error("EDITOR_RAW_INCOMPLETE");
		return {
			text: parts.join(""),
			nextOffset: offset + length,
			done: offset + length >= document.textLength,
		};
	} finally {
		decoder.dispose();
	}
}
export function EditorPagedView({
	narratorId,
	document,
	visible,
	expectedHash,
	onReload,
}: {
	narratorId: string;
	document: EditorRawDocumentDescriptor;
	visible?: boolean;
	expectedHash?: string | null;
	onReload?: () => void;
}) {
	const shown = useEditorPanelVisible(visible);
	const retained = useRetainedEditorView(shown);
	const { t } = useTranslation("narrator");
	const changed = expectedHash !== undefined && expectedHash !== document.baseHash;
	const [offset, setOffset] = useState(0);
	const [page, setPage] = useState<Awaited<ReturnType<typeof readEditorRawPage>>>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		setPage(undefined);
		setError(undefined);
		if (!retained || changed) return;
		const controller = new AbortController();
		void readEditorRawPage(narratorId, document, offset, controller.signal).then(
			(page) => {
				if (!controller.signal.aborted) setPage(page);
			},
			(error) => {
				if (!controller.signal.aborted) setError(String(error));
			},
		);
		return () => controller.abort();
	}, [narratorId, document, offset, retained, changed]);
	if (!retained) return null;
	return (
		<Box p="sm" style={{ overflow: "auto", height: "100%" }}>
			<Text size="xs" lineClamp={2}>
				{document.target.path}
			</Text>
			<Alert>{t("fileEditor.rawPaged")}</Alert>
			{changed && (
				<Alert color="orange">
					{t("fileEditor.rawPagedChanged")}{" "}
					<Button size="xs" onClick={onReload}>
						{t("fileEditor.reload")}
					</Button>
				</Alert>
			)}
			<Group my="sm">
				<Button size="xs" disabled={!offset} onClick={() => setOffset(0)}>
					{t("fileEditor.rawFirstPage")}
				</Button>
				<Button
					size="xs"
					disabled={!page || page.done}
					onClick={() => page && setOffset(page.nextOffset)}
				>
					{t("fileEditor.rawNextPage")}
				</Button>
				<Text size="xs">
					{offset} / {document.textLength}
				</Text>
			</Group>
			{changed ? null : error ? (
				<Text c="red">{error}</Text>
			) : page ? (
				<pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{page.text}</pre>
			) : (
				<Loader size="sm" />
			)}
		</Box>
	);
}
