import { subscribeHostPresentation } from "@frontend/components/plugins/host-presentation";
import { useGenUI } from "@frontend/hooks/useGenUI";
import { api } from "@frontend/lib/api";
import { Alert, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import type { GenUiFileReference } from "@shared/gen-ui-files";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewBundle } from "./preview-loader";
import { createPreviewShell, readPreviewTheme } from "./preview-shell";

/** This component's entire lifetime is the open modal's lifetime. */
export function FilePreview({
	narratorId,
	file,
	formToolUseId,
	onSubmitted,
}: {
	narratorId: string;
	file: GenUiFileReference;
	formToolUseId?: string;
	onSubmitted?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { bundle, error, reload } = useGenUI(narratorId, file);
	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t("genUi.currentFiles")}
				</Text>
				<Button size="compact-sm" variant="light" onClick={reload}>
					{t("genUi.reload")}
				</Button>
			</Group>
			{error ? (
				<Alert color="red" title={t("genUi.loadFailed")}>
					<Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
						{error}
					</Text>
				</Alert>
			) : bundle ? (
				<>
					<Text size="xs" c="dimmed">
						{t("genUi.untrustedPreview")}
					</Text>
					<PreviewFrame
						narratorId={narratorId}
						bundle={bundle}
						title={file.title}
						failureMessage={t("genUi.renderFailed")}
						height="65dvh"
						formToolUseId={formToolUseId}
						onSubmitted={onSubmitted}
					/>
				</>
			) : (
				<Group>
					<Loader size="sm" />
					<Text size="sm">{t("genUi.loading")}</Text>
				</Group>
			)}
		</Stack>
	);
}

/**
 * The app run in place in its chat card. Built from the files as they are on disk, like
 * the expanded preview; a failure takes the frame's place and the card offers a retry.
 */
export function AppFrame({
	narratorId,
	file,
	height,
	formToolUseId,
	onSubmitted,
}: {
	narratorId: string;
	file: GenUiFileReference;
	height: number;
	formToolUseId?: string;
	onSubmitted?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { bundle, error, reload } = useGenUI(narratorId, file);
	if (error)
		return (
			<Alert color="red" p="xs" style={{ height, overflow: "auto" }}>
				<Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
					{t("genUi.loadFailed")}
					{"\n"}
					{error}
				</Text>
				<Button size="compact-xs" variant="light" mt={4} onClick={reload}>
					{t("genUi.reload")}
				</Button>
			</Alert>
		);
	if (!bundle)
		return (
			<Group gap="xs" style={{ height }} align="center" justify="center">
				<Loader size="xs" />
				<Text size="xs" c="dimmed">
					{t("genUi.loading")}
				</Text>
			</Group>
		);
	return (
		<PreviewFrame
			narratorId={narratorId}
			bundle={bundle}
			title={file.title}
			failureMessage={t("genUi.renderFailed")}
			height={height}
			formToolUseId={formToolUseId}
			onSubmitted={onSubmitted}
		/>
	);
}

function httpUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

function PreviewFrame({
	narratorId,
	bundle,
	title,
	failureMessage,
	height,
	formToolUseId,
	onSubmitted,
}: {
	narratorId: string;
	bundle: PreviewBundle;
	title: string;
	failureMessage: string;
	height: number | string;
	/** Set while a render({path}) call waits for this app's submit as its tool result. */
	formToolUseId?: string;
	/** The answer reached the waiting call: the card has nothing left to ask. */
	onSubmitted?: () => void;
}) {
	const { t } = useTranslation("narrator");
	// An app is code the agent wrote, running in the reader's session: nothing it sends
	// reaches the conversation, and no link opens, until the reader has seen it and said so.
	const [request, setRequest] = useState<{ kind: "prompt" | "link"; text: string } | null>(null);
	const [sendFailed, setSendFailed] = useState(false);
	const pending = useRef(false);
	const frame = useRef<HTMLIFrameElement>(null);
	const loads = useRef(0);
	const loadProbe = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [navigated, setNavigated] = useState(false);
	// Theme changes update only tokens/provider state, never recreate the user's open UI.
	const [srcDoc] = useState(() =>
		createPreviewShell(bundle, readPreviewTheme(), failureMessage, { kit: bundle.kitRuntime }),
	);
	const sendTheme = () =>
		frame.current?.contentWindow?.postMessage(
			{ type: "narrafork:preview-theme", theme: readPreviewTheme() },
			"*",
		);
	useEffect(() => {
		if (navigated) return;
		const update = () =>
			frame.current?.contentWindow?.postMessage(
				{ type: "narrafork:preview-theme", theme: readPreviewTheme() },
				"*",
			);
		const onNavigation = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			if (event.data?.type === "narrafork:preview-left") setNavigated(true);
			const data = event.data as {
				type?: unknown;
				action?: unknown;
				value?: unknown;
				fields?: unknown;
				message?: unknown;
			} | null;
			if (
				data?.type === "narrafork:ui-action" &&
				typeof data.value === "string" &&
				!pending.current
			) {
				const text = data.value.trim().slice(0, 2000);
				if (!text) return;
				if (data.action === "openLink") {
					const url = httpUrl(text);
					if (!url) return;
					pending.current = true;
					setRequest({ kind: "link", text: url });
				} else if (data.action === "sendPrompt" || data.action === "submit") {
					pending.current = true;
					// A render({path}) call waits for exactly this submit, so it becomes the
					// tool result. Only a call that already ended falls back to a chat message.
					if (
						data.action === "submit" &&
						formToolUseId &&
						data.fields &&
						typeof data.fields === "object"
					) {
						// An app loads slower than markup, so the call may not be waiting yet:
						// retry briefly before falling back to an ordinary chat message.
						const deliver = async (tries: number): Promise<void> => {
							const client = await import("./kit-client");
							const delivered = await client.answerGenUiForm(narratorId, formToolUseId, {
								status: "submitted",
								message: typeof data.message === "string" ? data.message : text,
								fields: data.fields as Record<string, unknown>,
							});
							if (delivered === "answered") {
								pending.current = false;
								onSubmitted?.();
								return;
							}
							if (tries > 0) {
								await new Promise((resume) => setTimeout(resume, 1000));
								return deliver(tries - 1);
							}
							setRequest({ kind: "prompt", text });
						};
						void deliver(5).catch(() => {
							pending.current = false;
						});
						return;
					}
					setRequest({ kind: "prompt", text });
				}
			}
			if (event.data?.type === "narrafork:preview-present" && event.data.id === loads.current)
				clearTimeout(loadProbe.current);
		};
		window.addEventListener("message", onNavigation);
		const unsubscribe = subscribeHostPresentation(update);
		return () => {
			clearTimeout(loadProbe.current);
			window.removeEventListener("message", onNavigation);
			unsubscribe();
		};
	}, [navigated, formToolUseId, narratorId, onSubmitted]);
	const done = () => {
		pending.current = false;
		setRequest(null);
	};
	const send = (text: string) => {
		done();
		setSendFailed(false);
		void api.sendNarratorMessage(narratorId, text).catch(() => setSendFailed(true));
	};
	if (navigated) return <Alert color="orange">{t("genUi.navigationStopped")}</Alert>;
	const bar = {
		position: "absolute",
		insetInline: 0,
		bottom: 0,
		minHeight: 34,
		background: "var(--mantine-color-body)",
		borderTop: "1px solid var(--mantine-color-default-border)",
	} as const;
	const barText = {
		flex: 1,
		minWidth: 0,
		maxHeight: 96,
		overflow: "auto",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere",
	} as const;
	return (
		<Box style={{ position: "relative", height }}>
			{frameElement()}
			{request?.kind === "link" ? (
				<Group gap="xs" wrap="nowrap" px="xs" style={bar}>
					<Text size="xs" style={barText} title={request.text}>
						{t("genUi.linkConfirm", { url: request.text })}
					</Text>
					<Button
						size="compact-xs"
						component="a"
						href={request.text}
						target="_blank"
						rel="noopener noreferrer"
						onClick={done}
					>
						{t("genUi.linkOpen")}
					</Button>
					<Button size="compact-xs" variant="subtle" onClick={done}>
						{t("genUi.cancel")}
					</Button>
				</Group>
			) : request ? (
				<Group gap="xs" wrap="nowrap" px="xs" style={bar}>
					<Text size="xs" style={barText} title={request.text}>
						{t("genUi.promptConfirm", { text: request.text })}
					</Text>
					<Button size="compact-xs" onClick={() => send(request.text)}>
						{t("genUi.promptSend")}
					</Button>
					<Button size="compact-xs" variant="subtle" onClick={done}>
						{t("genUi.cancel")}
					</Button>
				</Group>
			) : sendFailed ? (
				<Group gap="xs" wrap="nowrap" px="xs" style={bar} role="alert">
					<Text size="xs" c="red" truncate style={{ flex: 1, minWidth: 0 }}>
						{t("genUi.sendFailed")}
					</Text>
				</Group>
			) : null}
		</Box>
	);
	function frameElement() {
		return (
			<iframe
				ref={frame}
				title={title}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				srcDoc={srcDoc}
				onLoad={() => {
					// Best-effort teardown, NOT a network firewall: navigation has already happened.
					if (++loads.current > 1) setNavigated(true);
					else {
						// Immediate navigation can replace srcdoc before its first load. Probe only
						// for best-effort teardown, not authentication or proof of zero external IO.
						loadProbe.current = setTimeout(() => setNavigated(true), 1000);
						frame.current?.contentWindow?.postMessage(
							{ type: "narrafork:preview-check", id: loads.current },
							"*",
						);
						sendTheme();
					}
				}}
				style={{ width: "100%", height: "100%", border: 0, display: "block" }}
			/>
		);
	}
}
