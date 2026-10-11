import { subscribeHostPresentation } from "@frontend/components/plugins/host-presentation";
import { api } from "@frontend/lib/api";
import { Alert, Box, Button, Group, Loader, Text } from "@mantine/core";
import { parseUiMarkup } from "@shared/intelligent-ui-markup";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadUiRuntime, type UiRuntime } from "./kit-client";
import { createPreviewShell, readPreviewTheme } from "./preview-shell";

function httpUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * Renders UI markup in the chat row, re-rendering as the markup grows.
 *
 * The frame is created once per runtime and never reloaded for new content: each update
 * parses the text received so far and posts the resulting tree, which the frame's React
 * root reconciles. That is what keeps already-drawn components (and any state the reader
 * put into them) in place while the rest of the UI is still arriving.
 */
export function InlineRender({
	narratorId,
	source,
	live,
	height,
	title,
	runtime: recorded,
}: {
	narratorId: string;
	source: string;
	/** The markup is still streaming: an unfinished tail is expected, not an error. */
	live: boolean;
	height: number | string;
	title: string;
	/** The runtime the finished call was drawn with; absent while it is still streaming. */
	runtime?: "builtin" | "project";
}) {
	const { t } = useTranslation("narrator");
	const [runtime, setRuntime] = useState<UiRuntime | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [link, setLink] = useState<string | null>(null);
	const [sendFailed, setSendFailed] = useState(false);
	const [navigated, setNavigated] = useState(false);
	const loads = useRef(0);
	const frame = useRef<HTMLIFrameElement>(null);
	const ready = useRef(false);
	const pending = useRef(0);
	const lastSent = useRef(0);
	const latest = useRef({ source, live });
	latest.current = { source, live };

	useEffect(() => {
		const controller = new AbortController();
		void loadUiRuntime(narratorId, controller.signal, recorded)
			.then((next) => {
				if (controller.signal.aborted) return;
				setError(null);
				// The result of a streamed call names the runtime it was just drawn with.
				// That is normally the one already on screen: keep the frame, and with it
				// whatever the reader has typed or toggled, instead of reloading it.
				setRuntime((current) => (current?.id === next.id ? current : next));
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted)
					setError(reason instanceof Error ? reason.message : "Component kit unavailable");
			});
		return () => controller.abort();
	}, [narratorId, recorded]);

	// Fixed for the life of the frame: the document must only ever be replaced together
	// with its iframe (a runtime change), so that a "left" notice from this iframe's
	// window can only mean the UI navigated away.
	const failureMessage = useRef(t("intelligentUi.renderFailed")).current;
	const srcDoc = useMemo(
		() =>
			runtime
				? createPreviewShell(runtime, readPreviewTheme(), failureMessage, {
						mode: "markup",
						kit: runtime.kit,
					})
				: null,
		[runtime, failureMessage],
	);
	// A new document has not announced itself yet, whatever the previous one did.
	// biome-ignore lint/correctness/useExhaustiveDependencies: srcDoc is the trigger, not an input.
	useEffect(() => {
		ready.current = false;
		loads.current = 0;
		setNavigated(false);
	}, [srcDoc]);

	const post = useCallback(() => {
		const target = frame.current?.contentWindow;
		if (!ready.current || !target) return;
		const { nodes } = parseUiMarkup(latest.current.source, { complete: !latest.current.live });
		// The frame has an opaque origin; "*" is the only target that reaches it, and the
		// payload is the conversation's own markup.
		target.postMessage({ type: "narrafork:ui-tree", nodes }, "*");
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: source and live are read through `latest`; they are listed so each change schedules one coalesced post.
	useEffect(() => {
		cancelAnimationFrame(pending.current);
		pending.current = requestAnimationFrame(post);
		return () => cancelAnimationFrame(pending.current);
	}, [source, live, post]);

	const sendTheme = useCallback(() => {
		frame.current?.contentWindow?.postMessage(
			{ type: "narrafork:preview-theme", theme: readPreviewTheme() },
			"*",
		);
	}, []);
	// Reached from the frame's own announcement and from the iframe's load event: the
	// announcement can precede this component's listener, the load event cannot.
	const onReady = useCallback(() => {
		ready.current = true;
		sendTheme();
		post();
	}, [post, sendTheme]);
	// The document loads once. A second load means the frame went somewhere else: what is
	// in it now is not this conversation's UI and must not stay on screen as if it were.
	// Best-effort teardown, not a firewall: the navigation request has already been made.
	const onLoad = useCallback(() => {
		if (++loads.current > 1) setNavigated(true);
		else onReady();
	}, [onReady]);

	useEffect(() => {
		if (!srcDoc) return;
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame.current?.contentWindow) return;
			const data = event.data as { type?: unknown; action?: unknown; value?: unknown } | null;
			if (data?.type === "narrafork:ui-ready") {
				onReady();
				return;
			}
			if (data?.type === "narrafork:preview-left") {
				setNavigated(true);
				return;
			}
			if (data?.type !== "narrafork:ui-action" || typeof data.value !== "string") return;
			if (data.action === "openLink") {
				// Never navigate on the frame's say-so: the reader sees the URL first.
				const url = httpUrl(data.value);
				if (url) setLink(url);
				return;
			}
			const text = data.value.trim();
			// One click is one message; a double click or a held key is not two.
			if (data.action !== "sendPrompt" || !text || Date.now() - lastSent.current < 1000) return;
			lastSent.current = Date.now();
			setSendFailed(false);
			void api.sendNarratorMessage(narratorId, text.slice(0, 2000)).catch(() => {
				// The UI the reader was using stays; only the failed send is reported.
				lastSent.current = 0;
				setSendFailed(true);
			});
		};
		window.addEventListener("message", onMessage);
		const unsubscribe = subscribeHostPresentation(sendTheme);
		return () => {
			window.removeEventListener("message", onMessage);
			unsubscribe();
		};
	}, [srcDoc, narratorId, onReady, sendTheme]);

	useEffect(() => {
		if (!sendFailed) return;
		const timer = setTimeout(() => setSendFailed(false), 6000);
		return () => clearTimeout(timer);
	}, [sendFailed]);

	if (navigated)
		return (
			<Alert color="orange" p="xs" style={{ height, overflow: "auto" }}>
				<Text size="xs">{t("intelligentUi.navigationStopped")}</Text>
			</Alert>
		);
	if (error && !srcDoc)
		return (
			<Alert color="red" p="xs" style={{ height, overflow: "auto" }}>
				<Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
					{t("intelligentUi.loadFailed")}
					{"\n"}
					{error}
				</Text>
			</Alert>
		);
	if (!srcDoc)
		return (
			<Group gap="xs" style={{ height }} align="center" justify="center">
				<Loader size="xs" />
				<Text size="xs" c="dimmed">
					{t("intelligentUi.loading")}
				</Text>
			</Group>
		);
	const bar = {
		position: "absolute",
		insetInline: 0,
		bottom: 0,
		height: 34,
		background: "var(--mantine-color-body)",
		borderTop: "1px solid var(--mantine-color-default-border)",
	} as const;
	return (
		<Box style={{ position: "relative", height }}>
			<iframe
				ref={frame}
				// A different runtime is a different document: remount instead of reusing a
				// frame whose globals belong to the previous kit.
				key={runtime?.id}
				title={title}
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				srcDoc={srcDoc}
				onLoad={onLoad}
				style={{ width: "100%", height: "100%", border: 0, display: "block" }}
			/>
			{link ? (
				<Group gap="xs" wrap="nowrap" px="xs" style={bar}>
					<Text size="xs" truncate style={{ flex: 1, minWidth: 0 }} title={link}>
						{t("intelligentUi.linkConfirm", { url: link })}
					</Text>
					<Button
						size="compact-xs"
						component="a"
						href={link}
						target="_blank"
						rel="noopener noreferrer"
						onClick={() => setLink(null)}
					>
						{t("intelligentUi.linkOpen")}
					</Button>
					<Button size="compact-xs" variant="subtle" onClick={() => setLink(null)}>
						{t("intelligentUi.cancel")}
					</Button>
				</Group>
			) : sendFailed ? (
				<Group gap="xs" wrap="nowrap" px="xs" style={bar} role="alert">
					<Text size="xs" c="red" truncate style={{ flex: 1, minWidth: 0 }}>
						{t("intelligentUi.sendFailed")}
					</Text>
				</Group>
			) : null}
		</Box>
	);
}
