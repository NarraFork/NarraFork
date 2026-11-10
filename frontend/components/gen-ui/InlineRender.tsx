import { subscribeHostPresentation } from "@frontend/components/plugins/host-presentation";
import { api } from "@frontend/lib/api";
import { Alert, Box, Button, Group, Loader, Text } from "@mantine/core";
import { parseUiMarkup } from "@shared/gen-ui-markup";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { answerGenUiForm, loadUiRuntime, type UiRuntime } from "./kit-client";
import { createPreviewShell, readPreviewTheme } from "./preview-shell";
import { readUiState, subscribeUiState, writeUiState } from "./shared-state";

function httpUrl(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

interface SubmittedForm {
	message: string;
	fields: Record<string, unknown>;
}

/** Forms this page has answered: each waiting call takes one answer. */
const answeredForms = new Set<string>();

type FormValue = string | number | boolean | null | FormValue[];
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function flatValue(value: unknown): string | number | boolean | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "boolean") return value;
	return (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).slice(0, 2000);
}

/**
 * The values a submit() carried, in the shape the server accepts: named fields of plain
 * values or flat lists, small enough to send. The frame is not trusted to have done it.
 */
export function readSubmittedForm(data: {
	message?: unknown;
	fields?: unknown;
}): SubmittedForm | null {
	const { message, fields } = data;
	if (typeof message !== "string" || !fields || typeof fields !== "object" || Array.isArray(fields))
		return null;
	const out: Record<string, FormValue> = {};
	for (const name of Object.keys(fields).slice(0, 200)) {
		if (!FIELD_NAME.test(name) || name === "__proto__") continue;
		const value = (fields as Record<string, unknown>)[name];
		out[name] = Array.isArray(value) ? value.slice(0, 200).map(flatValue) : flatValue(value);
	}
	// Long answers are cut evenly rather than the whole submit being refused.
	const names = Object.keys(out);
	const room = Math.floor(28_000 / Math.max(1, names.length) / 2);
	if (JSON.stringify(out).length > 30_000)
		for (const name of names) {
			const value = out[name];
			out[name] = Array.isArray(value)
				? value.map((item) => (typeof item === "string" ? item.slice(0, 40) : item))
				: typeof value === "string"
					? value.slice(0, room)
					: (value ?? null);
		}
	return { message: message.trim().slice(0, 2000), fields: out };
}

const shownValue = (value: unknown): string =>
	value === null || value === undefined
		? ""
		: Array.isArray(value)
			? value.map(shownValue).join(", ")
			: String(value);

/**
 * What a submit says, built here from the values that will actually be sent: the reader
 * confirms, and the chat or the agent receives, the same thing.
 */
export function submittedText(form: SubmittedForm): string {
	const names = Object.keys(form.fields);
	const room = Math.max(40, Math.floor((1900 - form.message.length) / Math.max(1, names.length)));
	const lines = names.map((name) => {
		const text = shownValue(form.fields[name]);
		return `${name}: ${text.length > room ? `${text.slice(0, room - 1)}…` : text}`;
	});
	return [form.message, ...lines].filter(Boolean).join("\n").slice(0, 2000);
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
	formToolUseId,
	stateKey,
	onSubmitted,
}: {
	narratorId: string;
	source: string;
	/** The markup is still streaming: an unfinished tail is expected, not an error. */
	live: boolean;
	height: number | string;
	title: string;
	/** The runtime the finished call was drawn with; absent while it is still streaming. */
	runtime?: "builtin" | "project";
	/** A `wait: true` call is holding open for this UI: submit() answers it. */
	formToolUseId?: string;
	/** Identifies the card: frames with the same key share what the reader entered. */
	stateKey?: string;
	/** The answer reached the waiting call: the card has nothing left to ask. */
	onSubmitted?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [runtime, setRuntime] = useState<UiRuntime | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [link, setLink] = useState<string | null>(null);
	const [prompt, setPrompt] = useState<string | null>(null);
	// What a confirmed prompt delivers: a submit() also carries the form's values.
	const promptForm = useRef<SubmittedForm | null>(null);
	const [sendFailed, setSendFailed] = useState(false);
	const [navigated, setNavigated] = useState(false);
	const loads = useRef(0);
	const frame = useRef<HTMLIFrameElement>(null);
	const ready = useRef(false);
	const pending = useRef(0);
	const lastSent = useRef(0);
	const latest = useRef({ source, live });
	// Set in the message handler, not after render: a second action in the same turn
	// must not replace the text the reader is already being asked to confirm.
	const confirming = useRef(false);
	// Read at event time, not from the listener's closure. The iframe can post during
	// commit, before the effect that binds the listener runs again, and that listener
	// would otherwise still see the previous runtime and send a project-kit prompt.
	const runtimeNow = useRef(runtime);
	runtimeNow.current = runtime;
	// Read at click time too: the call stops waiting while the card stays on screen.
	const formNow = useRef(formToolUseId);
	formNow.current = formToolUseId;
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
	const failureMessage = useRef(t("genUi.renderFailed")).current;
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
		confirming.current = false;
		setNavigated(false);
		setLink(null);
		setPrompt(null);
		promptForm.current = null;
	}, [srcDoc]);

	const send = useCallback(
		(text: string): boolean => {
			// One click is one message; a double click or a held key is not two.
			if (Date.now() - lastSent.current < 1000) return false;
			lastSent.current = Date.now();
			setSendFailed(false);
			void api.sendNarratorMessage(narratorId, text.slice(0, 2000)).catch(() => {
				// The UI the reader was using stays; only the failed send is reported.
				lastSent.current = 0;
				setSendFailed(true);
			});
			return true;
		},
		[narratorId],
	);

	// A submit() answers the call waiting on this form when there is one; once that call
	// has ended (answered, timed out, stopped) the click is a chat message like any other.
	const deliver = useCallback(
		(text: string, form: SubmittedForm | null): boolean => {
			const toolUseId = formNow.current;
			if (!form || !toolUseId) return send(text);
			// The call takes one answer; a later click on this form while its row still says
			// it waits (or from the expanded view) is not a second message.
			if (answeredForms.has(toolUseId)) return false;
			if (Date.now() - lastSent.current < 1000) return false;
			lastSent.current = Date.now();
			setSendFailed(false);
			// The card shows the form as soon as the markup has streamed, a moment before the
			// call starts waiting: while the row still says it waits, try again shortly.
			const attempt = async (tries: number): Promise<void> => {
				const result = await answerGenUiForm(narratorId, toolUseId, {
					status: "submitted",
					...form,
				});
				if (result === "answered") {
					answeredForms.add(toolUseId);
					if (answeredForms.size > 100)
						answeredForms.delete(answeredForms.values().next().value as string);
					onSubmitted?.();
					return;
				}
				if (tries > 0 && formNow.current === toolUseId) {
					await new Promise((done) => setTimeout(done, 1000));
					return attempt(tries - 1);
				}
				lastSent.current = 0;
				send(text);
			};
			void attempt(formNow.current === toolUseId ? 5 : 0).catch(() => {
				lastSent.current = 0;
				setSendFailed(true);
			});
			return true;
		},
		[narratorId, send, onSubmitted],
	);

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
		const saved = stateKey ? readUiState(stateKey) : undefined;
		if (saved)
			frame.current?.contentWindow?.postMessage({ type: "narrafork:ui-state", values: saved }, "*");
	}, [post, sendTheme, stateKey]);

	useEffect(() => {
		if (!stateKey) return;
		return subscribeUiState(stateKey, (values, from) => {
			const target = frame.current?.contentWindow;
			if (from === target || !ready.current || !target) return;
			target.postMessage({ type: "narrafork:ui-state", values }, "*");
		});
	}, [stateKey]);
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
			const data = event.data as {
				type?: unknown;
				action?: unknown;
				value?: unknown;
				message?: unknown;
				fields?: unknown;
			} | null;
			if (data?.type === "narrafork:ui-ready") {
				onReady();
				return;
			}
			if (data?.type === "narrafork:preview-left") {
				setNavigated(true);
				return;
			}
			if (data?.type === "narrafork:ui-state") {
				const values = (data as { values?: unknown }).values;
				if (stateKey && values && typeof values === "object" && !Array.isArray(values))
					writeUiState(stateKey, values as Record<string, unknown>, event.source);
				return;
			}
			const current = runtimeNow.current;
			if (data?.type !== "narrafork:ui-action" || typeof data.value !== "string" || !current)
				return;
			if (data.action === "openLink") {
				// Never navigate on the frame's say-so: the reader sees the URL first.
				// A bar already on screen keeps its text until the reader answers it.
				const url = httpUrl(data.value);
				if (!url || confirming.current) return;
				confirming.current = true;
				setPrompt(null);
				setLink(url);
				return;
			}
			// submit() arrives as the text the frame composed from the bound fields: to the
			// chat it is the same as a sendPrompt the reader triggered.
			if (data.action !== "sendPrompt" && data.action !== "submit") return;
			const form = data.action === "submit" ? readSubmittedForm(data) : null;
			const text = form ? submittedText(form) : data.value.trim();
			if (!text) return;
			// The frame's gesture check guards markup, but a project kit's own code runs
			// in that frame and can post this message itself: the reader confirms it.
			if (current.kit) {
				if (confirming.current) return;
				confirming.current = true;
				setLink(null);
				promptForm.current = form;
				setPrompt(text.slice(0, 2000));
				return;
			}
			deliver(text, form);
		};
		window.addEventListener("message", onMessage);
		const unsubscribe = subscribeHostPresentation(sendTheme);
		return () => {
			window.removeEventListener("message", onMessage);
			unsubscribe();
		};
	}, [srcDoc, onReady, sendTheme, deliver, stateKey]);

	useEffect(() => {
		if (!sendFailed) return;
		const timer = setTimeout(() => setSendFailed(false), 6000);
		return () => clearTimeout(timer);
	}, [sendFailed]);

	if (navigated)
		return (
			<Alert color="orange" p="xs" style={{ height, overflow: "auto" }}>
				<Text size="xs">{t("genUi.navigationStopped")}</Text>
			</Alert>
		);
	if (error && !srcDoc)
		return (
			<Alert color="red" p="xs" style={{ height, overflow: "auto" }}>
				<Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
					{t("genUi.loadFailed")}
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
					{t("genUi.loading")}
				</Text>
			</Group>
		);
	const bar = {
		position: "absolute",
		insetInline: 0,
		bottom: 0,
		minHeight: 34,
		background: "var(--mantine-color-body)",
		borderTop: "1px solid var(--mantine-color-default-border)",
	} as const;
	const confirmText = {
		flex: 1,
		minWidth: 0,
		maxHeight: 96,
		overflow: "auto",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere",
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
					<Text size="xs" style={confirmText} title={link}>
						{t("genUi.linkConfirm", { url: link })}
					</Text>
					<Button
						size="compact-xs"
						component="a"
						href={link}
						target="_blank"
						rel="noopener noreferrer"
						onClick={() => {
							confirming.current = false;
							setLink(null);
						}}
					>
						{t("genUi.linkOpen")}
					</Button>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={() => {
							confirming.current = false;
							setLink(null);
						}}
					>
						{t("genUi.cancel")}
					</Button>
				</Group>
			) : prompt ? (
				<Group gap="xs" wrap="nowrap" px="xs" style={bar}>
					<Text size="xs" style={confirmText} title={prompt}>
						{t("genUi.promptConfirm", { text: prompt })}
					</Text>
					<Button
						size="compact-xs"
						onClick={() => {
							// A click inside the quiet period leaves the bar up, so the
							// reader can see that this text has not been sent yet.
							if (!deliver(prompt, promptForm.current)) return;
							confirming.current = false;
							setPrompt(null);
						}}
					>
						{t("genUi.promptSend")}
					</Button>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={() => {
							confirming.current = false;
							setPrompt(null);
						}}
					>
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
}
