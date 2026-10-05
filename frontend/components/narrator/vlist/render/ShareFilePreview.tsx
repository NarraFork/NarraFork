import { Box, Button, Group, Loader, Modal, Text } from "@mantine/core";
import {
	SHARE_CONTENT_TIMEOUT_MS,
	SHARE_HTML_CSP,
	SHARE_TEXT_MAX_CHARS,
	type SharePreviewRef,
} from "@shared/share-preview";
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getShikiLang } from "../../../../lib/shiki-lang";
import { useImageViewer } from "../../../common/image-viewer-context";
import {
	formatShareJson,
	readShareHtml,
	readShareText,
	releaseShareMedia,
	type SharePreviewError,
	shareDownloadUrl,
	shareErrorForStatus,
	sharePreviewUrl,
} from "./share-preview-client";

const HighlightedCode = lazy(() =>
	import("../../markdown/HighlightedCode").then((m) => ({ default: m.HighlightedCode })),
);

/** Both card and modal use this body; all asynchronous content stays inside its reserved box. */
function SharePreviewBody({
	preview,
	height,
	active,
	activate,
	fullscreen = false,
	displayWidth,
}: {
	preview: SharePreviewRef;
	height: number;
	active: boolean;
	activate?: () => void;
	fullscreen?: boolean;
	displayWidth?: number;
}) {
	const { t } = useTranslation("narrator");
	const openImageViewer = useImageViewer();
	const mediaRef = useRef<HTMLMediaElement | null>(null);
	const setMediaRef = useCallback((node: HTMLMediaElement | null) => {
		mediaRef.current = node;
	}, []);
	const recheckRef = useRef<AbortController | null>(null);
	useEffect(() => () => recheckRef.current?.abort(), []);
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<SharePreviewError | null>(null);
	const [text, setText] = useState<string | null>(null);
	const [truncated, setTruncated] = useState(false);
	const [source, setSource] = useState(false);
	const [retry, setRetry] = useState(0);
	const url = sharePreviewUrl(preview);
	const download = shareDownloadUrl(preview);

	useEffect(() => {
		recheckRef.current?.abort();
		setReady(false);
		setError(null);
		setText(null);
		setTruncated(false);
		if (!active || preview.kind === "unsupported") return;
		if (!url) {
			setError("unsupported");
			return;
		}
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(SHARE_CONTENT_TIMEOUT_MS),
		]);
		const load = async () => {
			const info = await fetch(`${url}-info`, { signal, cache: retry > 0 ? "reload" : "no-store" });
			signal.throwIfAborted();
			if (!info.ok) {
				await info.body?.cancel();
				if (controller.signal.aborted) return;
				setError(shareErrorForStatus(info.status));
				return;
			}
			// Preflight carries no file content and is intentionally not accumulated.
			await info.body?.cancel();
			if (preview.kind === "text" || preview.kind === "html") {
				const response = await fetch(url, { signal, cache: "no-store" });
				signal.throwIfAborted();
				if (!response.ok) {
					await response.body?.cancel();
					if (controller.signal.aborted) return;
					setError(shareErrorForStatus(response.status));
					return;
				}
				const content = await (preview.kind === "html"
					? readShareHtml(response, signal)
					: readShareText(response, signal));
				if (controller.signal.aborted) return;
				if (preview.kind === "html" && content.truncated) {
					setError("tooLarge");
					return;
				}
				setText(
					preview.textFormat === "json"
						? formatShareJson(content.text, content.truncated)
						: content.text,
				);
				setTruncated(content.truncated);
			}
			if (!controller.signal.aborted) setReady(true);
		};
		void load().catch(() => {
			if (!controller.signal.aborted) setError(signal.aborted ? "timeout" : "loadError");
		});
		return () => controller.abort();
	}, [active, url, preview.kind, preview.textFormat, retry]);

	// Capture the mounted element before React clears its ref during unmount.
	useEffect(() => {
		const media = active && ready && !error ? mediaRef.current : null;
		return () => releaseShareMedia(media);
	}, [active, ready, error]);

	const onMediaError = () => {
		const code = mediaRef.current?.error?.code;
		setError(code === 3 || code === 4 ? "codec" : "loadError");
		// An expiry/restart can happen between preflight and the next Range request.
		if (url) {
			recheckRef.current?.abort();
			const controller = new AbortController();
			recheckRef.current = controller;
			void fetch(`${url}-info`, {
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(SHARE_CONTENT_TIMEOUT_MS)]),
				cache: "no-store",
			})
				.then(async (r) => {
					await r.body?.cancel();
					if (!controller.signal.aborted && (r.status === 404 || r.status === 410))
						setError("unavailable");
				})
				.catch(() => {});
		}
	};
	let content: ReactNode;
	if (preview.kind === "unsupported")
		content = <Text size="sm">{t(`sharePreview.${preview.reason ?? "unsupported"}`)}</Text>;
	else if (error)
		content = (
			<Text size="sm" c="red" role="alert">
				{t(`sharePreview.${error}`)}
			</Text>
		);
	else if (!active)
		content = (
			<Button variant="light" onClick={activate}>
				{t("sharePreview.load")}
			</Button>
		);
	else if (!ready)
		content = (
			<Group gap="xs">
				<Loader size="sm" />
				<Text size="sm">{t("sharePreview.loading")}</Text>
			</Group>
		);
	else if (preview.kind === "image" && url)
		content = (
			// biome-ignore lint/a11y/useKeyWithClickEvents: shared image viewer provides keyboard controls
			<img
				src={url}
				alt={preview.filename}
				loading="lazy"
				onError={() => setError("loadError")}
				onClick={() => openImageViewer({ src: url, filename: preview.filename })}
				style={{
					maxWidth: "100%",
					maxHeight: "100%",
					width: displayWidth ? "100%" : "auto",
					objectFit: "contain",
					cursor: "pointer",
				}}
			/>
		);
	else if (preview.kind === "video" && url)
		content = (
			// biome-ignore lint/a11y/useMediaCaption: arbitrary shared files do not necessarily have caption tracks
			<video
				ref={setMediaRef}
				src={url}
				controls
				preload="metadata"
				playsInline
				onError={onMediaError}
				aria-label={preview.filename}
				style={{ width: "100%", height: "100%", objectFit: "contain" }}
			/>
		);
	else if (preview.kind === "audio" && url)
		content = (
			// biome-ignore lint/a11y/useMediaCaption: arbitrary shared audio has no caption tracks
			<audio
				ref={setMediaRef}
				src={url}
				controls
				preload="metadata"
				onError={onMediaError}
				aria-label={preview.filename}
				style={{ width: "100%" }}
			/>
		);
	else if ((preview.kind === "pdf" || preview.kind === "html") && url)
		content = (
			<iframe
				src={preview.kind === "pdf" ? url : undefined}
				srcDoc={
					preview.kind === "html" && text !== null
						? `<meta http-equiv="Content-Security-Policy" content="${SHARE_HTML_CSP}">${text}`
						: undefined
				}
				title={preview.filename}
				sandbox={preview.kind === "html" ? "" : undefined}
				referrerPolicy="no-referrer"
				onError={() => setError("loadError")}
				style={{ border: 0, width: "100%", height: "100%" }}
			/>
		);
	else if (text !== null) {
		const limit = fullscreen ? SHARE_TEXT_MAX_CHARS : 20_000;
		const shown = text.slice(0, limit);
		content = (
			<Box style={{ width: "100%", height: "100%", overflow: "auto" }}>
				{(truncated || text.length > limit) && (
					<Text size="xs" c="dimmed">
						{t("sharePreview.truncated")}
					</Text>
				)}
				{preview.textFormat === "markdown" && (
					<Button size="compact-xs" variant="subtle" onClick={() => setSource(!source)}>
						{t(source ? "sharePreview.rendered" : "sharePreview.source")}
					</Button>
				)}
				{preview.textFormat === "markdown" && !source ? (
					<Markdown
						remarkPlugins={[remarkGfm]}
						components={{
							img: () => (
								<Text component="span" size="xs">
									{t("sharePreview.externalImage")}
								</Text>
							),
							a: ({ children, href }) => (
								<a
									href={
										href?.startsWith("https://") || href?.startsWith("http://") ? href : undefined
									}
									target="_blank"
									rel="noopener noreferrer"
								>
									{children}
								</a>
							),
						}}
					>
						{shown}
					</Markdown>
				) : (
					<Suspense fallback={<pre style={{ whiteSpace: "pre-wrap" }}>{shown}</pre>}>
						<HighlightedCode
							code={shown}
							lang={preview.textFormat === "json" ? "json" : getShikiLang(preview.filename)}
						/>
					</Suspense>
				)}
			</Box>
		);
	}
	return (
		<Box
			data-share-preview={preview.kind}
			style={{
				height,
				width: displayWidth ?? "100%",
				maxWidth: "100%",
				overflow: error || preview.kind === "unsupported" ? "auto" : "hidden",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: error || preview.kind === "unsupported" ? "flex-start" : "center",
			}}
		>
			{content}
			{error && (
				<Button variant="subtle" size="compact-xs" onClick={() => setRetry((value) => value + 1)}>
					{t("sharePreview.retry")}
				</Button>
			)}
			{(error || preview.kind === "unsupported") && download && (
				<a href={download} download>
					{t("sharePreview.download")}
				</a>
			)}
		</Box>
	);
}

export function ShareFilePreview({
	preview,
	height,
	displayWidth,
}: {
	preview: SharePreviewRef;
	height: number;
	displayWidth?: number;
}) {
	const { t } = useTranslation("narrator");
	const [active, setActive] = useState(preview.kind === "image");
	const [opened, setOpened] = useState(false);
	const image = preview.kind === "image";
	const unsupported = preview.kind === "unsupported";
	const url = sharePreviewUrl(preview);
	return (
		<Box style={{ height, overflow: "hidden" }} onClick={(event) => event.stopPropagation()}>
			{!image && !unsupported && (
				<Group h={36} gap="xs" wrap="nowrap">
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={() => {
							setActive(false);
							setOpened(true);
						}}
					>
						{t("sharePreview.expand")}
					</Button>
					{preview.kind === "pdf" && url && (
						<a href={url} target="_blank" rel="noopener noreferrer">
							{t("sharePreview.openPdf")}
						</a>
					)}
				</Group>
			)}
			<SharePreviewBody
				preview={preview}
				height={Math.max(0, height - (!image && !unsupported ? 36 : 0))}
				displayWidth={displayWidth}
				active={active && !opened}
				activate={() => setActive(true)}
			/>
			<Modal opened={opened} onClose={() => setOpened(false)} title={preview.filename} size="xl">
				{opened && <SharePreviewBody preview={preview} height={560} active fullscreen />}
			</Modal>
		</Box>
	);
}
