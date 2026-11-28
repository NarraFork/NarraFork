/**
 * Read-only preview of a Word document (DOCX/DOCM).
 *
 * The server parses the package and answers with Markdown, which is rendered by the SAME
 * `MarkdownContent` that renders `.md` files — that is what makes a document preview look like
 * a Markdown preview with no second stylesheet (and what makes inline pictures clickable, since
 * they go through `MarkdownImage` like any other preview image).
 *
 * Remote devices are refused outright: the parse endpoints are `local`-only `/api/fs/*`, so
 * forwarding a remote path could silently show the server's own file of the same name. Same
 * rule the image reader and `BinaryFilePreview` already follow.
 */

import { ApiError, authorizedFetch, readFetchError } from "@frontend/lib/api";
import { apiUrl } from "@frontend/lib/base-path";
import { Box, Center, Loader, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "../markdown/MarkdownContent";

const TIMEOUT_MS = 25_000;

/** Wire shape of `/api/fs/document-preview`. */
type DocumentPreviewResponse =
	| {
			ok: true;
			result: {
				markdown: string;
				assets: Array<{ id: string; mime: string; byteLength: number }>;
				truncated: boolean;
				omitted: string[];
				meta: { title?: string; author?: string };
			};
	  }
	| {
			ok: false;
			failure: { kind: "legacy-office" | "pdf" | "unsupported"; reason: string; detail: string };
	  };

export function DocumentPreview({
	filePath,
	deviceId = "local",
	onDownload,
}: {
	filePath: string;
	deviceId?: string;
	onDownload?: () => void;
}) {
	const { t } = useTranslation("narrator");
	// Read through a ref: `t` is a new identity in some i18n setups (and every test double), and
	// a request effect must not re-run because a translator was replaced mid-flight.
	const tRef = useRef(t);
	tRef.current = t;
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "ready"; result: Extract<DocumentPreviewResponse, { ok: true }>["result"] }
		| { status: "refused"; kind: "legacy-office" | "pdf" | "unsupported" }
		| { status: "error"; message: string }
	>({ status: "loading" });

	const remote = deviceId !== "local";

	useEffect(() => {
		if (remote) return;
		const controller = new AbortController();
		let cancelled = false;
		setState({ status: "loading" });
		const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

		const read = async () => {
			const response = await authorizedFetch(
				`${apiUrl("/fs/document-preview")}?path=${encodeURIComponent(filePath)}`,
				{ signal: controller.signal },
			);
			if (!response.ok) {
				const failure = await readFetchError(response, tRef.current("filePreview_loadError"));
				throw new ApiError(failure.message, response.status, failure.data);
			}
			return (await response.json()) as DocumentPreviewResponse;
		};

		read()
			.then((payload) => {
				if (cancelled) return;
				if (payload.ok) setState({ status: "ready", result: payload.result });
				else setState({ status: "refused", kind: payload.failure.kind });
			})
			.catch((error) => {
				if (cancelled) return;
				setState({
					status: "error",
					message: error instanceof Error ? error.message : tRef.current("filePreview_loadError"),
				});
			})
			.finally(() => clearTimeout(timeout));

		return () => {
			cancelled = true;
			clearTimeout(timeout);
			controller.abort();
		};
	}, [filePath, remote]);

	if (remote) {
		return (
			<Box p="md">
				<Text size="sm" c="dimmed">
					{t("fileViewer.documentRemoteUnsupported", {
						defaultValue: "Document preview is only available on the device that stores the file.",
					})}
				</Text>
			</Box>
		);
	}

	if (state.status === "loading") {
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	}

	if (state.status === "refused") {
		const legacy = state.kind === "legacy-office";
		return (
			<Box p="md">
				<Text size="sm" c="dimmed">
					{legacy
						? t("fileViewer.documentLegacyUnsupported", {
								defaultValue:
									"This is a legacy .doc file and cannot be previewed. Re-save it as .docx.",
							})
						: t("fileViewer.documentUnsupported", {
								defaultValue: "This document format cannot be previewed.",
							})}
				</Text>
				{legacy && onDownload && (
					<Text size="sm" mt="xs">
						<Text component="span" c="indigo" onClick={onDownload} style={{ cursor: "pointer" }}>
							{t("fileViewer.documentDownload", { defaultValue: "Download the file" })}
						</Text>
					</Text>
				)}
			</Box>
		);
	}

	if (state.status === "error") {
		return (
			<Box p="md">
				<Text size="sm" c="red">
					{state.message}
				</Text>
			</Box>
		);
	}

	const { result } = state;
	return (
		<Box p="xs">
			{result.truncated && (
				<Text size="xs" c="yellow" px="xs" pb="xs">
					{t("fileViewer.documentTruncated", {
						defaultValue: "This document is long; the preview shows the beginning.",
					})}
				</Text>
			)}
			<MarkdownContent text={result.markdown} />
		</Box>
	);
}
