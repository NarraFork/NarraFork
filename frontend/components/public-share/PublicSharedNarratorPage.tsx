import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	SegmentedControl,
	Stack,
	Text,
	Textarea,
	Title,
} from "@mantine/core";
import type {
	PublicDiscussionMessage,
	PublicSharedMessage,
	PublicSharedTool,
	PublicSharedToolDetail,
} from "@shared/public-narrator-share";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePublicSharedNarrator } from "../../hooks/usePublicSharedNarrator";
import { changeAppLanguage } from "../../lib/i18n";
import {
	PUBLIC_SHARE_MAX_ROWS,
	type PublicShareSession,
	type PublicShareViewState,
} from "../../lib/public-share-session";
import { PublicShareMarkdown } from "./PublicShareMarkdown";
import "./public-share.css";

function usePublicDocument() {
	useEffect(() => {
		const elements = ["robots", "referrer"].map((name) => {
			const previous = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
			const content = previous?.content;
			const element = previous ?? document.createElement("meta");
			element.name = name;
			element.content = name === "robots" ? "noindex, nofollow, noarchive" : "no-referrer";
			if (!previous) document.head.append(element);
			return { element, content };
		});
		return () => {
			for (const { element, content } of elements) {
				if (content === undefined) element.remove();
				else element.content = content;
			}
		};
	}, []);
}

export function PublicSharedNarratorPage({
	shareId,
	credential,
}: {
	shareId: string;
	credential: string;
}) {
	const { t, i18n } = useTranslation("publicShare");
	const { controller, state } = usePublicSharedNarrator(shareId, credential);
	const [tab, setTab] = useState("session");
	const [languageError, setLanguageError] = useState(false);
	usePublicDocument();
	return (
		<main className="public-share-page">
			<Group justify="space-between" gap="xs">
				<Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
					<Title order={3} lineClamp={1}>
						{state.session?.title ?? t("title")}
					</Title>
					<Text size="xs" c="dimmed">
						{t("readOnly")}
					</Text>
				</Stack>
				<Button
					size="compact-xs"
					variant="subtle"
					onClick={() => {
						setLanguageError(false);
						void changeAppLanguage(i18n.resolvedLanguage === "zh-CN" ? "en" : "zh-CN", [
							"publicShare",
						]).catch(() => setLanguageError(true));
					}}
				>
					{i18n.resolvedLanguage === "zh-CN" ? "English" : "简体中文"}
				</Button>
			</Group>
			{languageError && <Alert color="red">{t("languageError")}</Alert>}
			{state.phase === "unavailable" ? (
				<Alert color="red" title={t("unavailableTitle")}>
					{t(credential ? "unavailable" : "missingToken")}
				</Alert>
			) : (
				<>
					<Group justify="space-between" aria-live="polite" gap="xs">
						<Group gap="xs">
							<Badge color={state.phase === "live" ? "teal" : "orange"}>
								{t(`connection.${state.phase}`)}
							</Badge>
							{state.session && (
								<Badge size="sm" variant="outline">
									{t("sessionStatus", {
										status: t(`status.${state.session.status}`, {
											defaultValue: state.session.status,
										}),
									})}
								</Badge>
							)}
							{state.session && (
								<Text size="xs">
									{state.session.guestName} · {t("guest")}
								</Text>
							)}
						</Group>
						{state.phase !== "loading" && (
							<Button size="compact-xs" variant="subtle" onClick={controller.reconnect}>
								{t("reconnect")}
							</Button>
						)}
					</Group>
					{["reconnecting", "limited", "error"].includes(state.phase) && (
						<Text size="xs" c="orange">
							{t(state.phase === "limited" ? "rateLimited" : "reconnectHint")}
						</Text>
					)}
					{state.session ? (
						<>
							<div className="public-share-mobile-tabs">
								<SegmentedControl
									fullWidth
									value={tab}
									onChange={setTab}
									data={[
										{ value: "session", label: t("session") },
										{ value: "discussion", label: t("discussion") },
									]}
								/>
							</div>
							<div className="public-share-columns">
								<SessionPane controller={controller} state={state} hidden={tab !== "session"} />
								<DiscussionPane
									controller={controller}
									state={state}
									hidden={tab !== "discussion"}
								/>
							</div>
						</>
					) : state.phase === "loading" ? (
						<Loader size="sm" />
					) : null}
				</>
			)}
		</main>
	);
}

function ScrollPane({
	title,
	hidden,
	children,
	footer,
	hasMore,
	count,
	loading,
	loadEarlier,
	revision,
}: {
	title: string;
	hidden: boolean;
	children: ReactNode;
	footer?: ReactNode;
	hasMore: boolean;
	count: number;
	loading: boolean;
	loadEarlier: () => Promise<void>;
	revision: string;
}) {
	const { t } = useTranslation("publicShare");
	const viewport = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);
	const loadingEarlier = useRef(false);
	// Only follow changes to the tail, never changes to the older-page count.
	useLayoutEffect(() => {
		if (revision && following && !loadingEarlier.current && viewport.current) {
			viewport.current.scrollTop = viewport.current.scrollHeight;
		}
	}, [revision, following]);
	async function earlier() {
		const element = viewport.current;
		if (!element) return;
		setFollowing(false);
		loadingEarlier.current = true;
		const height = element.scrollHeight;
		const top = element.scrollTop;
		try {
			await loadEarlier();
			requestAnimationFrame(() => {
				element.scrollTop = top + Math.max(0, element.scrollHeight - height);
			});
		} finally {
			loadingEarlier.current = false;
		}
	}
	return (
		<section className="public-share-pane" data-mobile-hidden={hidden} aria-label={title}>
			<Group className="public-share-pane-header" justify="space-between" wrap="nowrap">
				<Text fw={600} size="sm">
					{title}
				</Text>
				<Button size="compact-xs" variant="subtle" onClick={() => setFollowing(!following)}>
					{t(following ? "pauseFollow" : "follow")}
				</Button>
			</Group>
			<div
				className="public-share-scroll"
				ref={viewport}
				onScroll={(event) => {
					const element = event.currentTarget;
					if (element.scrollHeight - element.scrollTop - element.clientHeight > 80)
						setFollowing(false);
				}}
			>
				<Stack gap="sm">
					{hasMore &&
						(count >= PUBLIC_SHARE_MAX_ROWS ? (
							<Text size="xs" c="dimmed">
								{t("historyLimit", { count: PUBLIC_SHARE_MAX_ROWS })}
							</Text>
						) : (
							<Button size="xs" variant="light" loading={loading} onClick={() => void earlier()}>
								{t("loadEarlier")}
							</Button>
						))}
					{loading && count === 0 ? <Loader size="sm" /> : children}
				</Stack>
			</div>
			{footer}
		</section>
	);
}

function SessionPane({
	controller,
	state,
	hidden,
}: {
	controller: PublicShareSession;
	state: PublicShareViewState;
	hidden: boolean;
}) {
	const { t } = useTranslation("publicShare");
	const messages = state.messages?.messages ?? [];
	const last = messages.at(-1);
	const liveSize = state.live.reduce((sum, block) => sum + block.text.length, 0);
	return (
		<ScrollPane
			title={t("session")}
			hidden={hidden}
			count={messages.length}
			hasMore={state.messages?.hasMore ?? false}
			loading={state.loadingMessages}
			loadEarlier={controller.loadEarlierMessages}
			revision={`${last?.id}:${last?.text.length}:${liveSize}:${hidden}`}
		>
			{state.historyRevision > 1 && (
				<Text size="xs" c="dimmed">
					{t("historyRefreshed")}
				</Text>
			)}
			{!messages.length && !state.live.length && !state.loadingMessages && (
				<Text size="sm" c="dimmed">
					{t("emptySession")}
				</Text>
			)}
			{messages.map((message) => (
				<SessionMessage
					key={`${state.historyRevision}:${message.id}`}
					message={message}
					controller={controller}
				/>
			))}
			{state.messages && state.live.length > 0 && (
				<Card withBorder padding="sm">
					<Stack gap="xs">
						<Badge size="xs" color="teal">
							{t("live")}
						</Badge>
						{state.live.map((block) =>
							block.kind === "reasoning" ? (
								<details className="public-share-details" key={block.id}>
									<summary>{t("reasoning")}</summary>
									<PublicShareMarkdown text={block.text} />
								</details>
							) : (
								<PublicShareMarkdown key={block.id} text={block.text} />
							),
						)}
						{state.liveTruncated && (
							<Text size="xs" c="dimmed">
								{t("truncated")}
							</Text>
						)}
					</Stack>
				</Card>
			)}
		</ScrollPane>
	);
}

function SessionMessage({
	message,
	controller,
}: {
	message: PublicSharedMessage;
	controller: PublicShareSession;
}) {
	const { t } = useTranslation("publicShare");
	return (
		<Card withBorder padding="sm">
			<Stack gap="xs">
				<Group justify="space-between">
					<Badge size="xs" variant="light">
						{t(`role.${message.role}`)}
					</Badge>
					<Text size="xs" c="dimmed">
						{formatDate(message.createdAt)}
					</Text>
				</Group>
				{message.text && <PublicShareMarkdown text={message.text} />}
				{message.reasoning && (
					<details className="public-share-details">
						<summary>{t("reasoning")}</summary>
						<PublicShareMarkdown text={message.reasoning} />
					</details>
				)}
				{message.tools.map((tool) => (
					<ToolDetail key={tool.id} tool={tool} controller={controller} />
				))}
				{message.mediaOmitted && (
					<Text size="xs" c="dimmed">
						{t("mediaOmitted")}
					</Text>
				)}
				{message.truncated && (
					<Text size="xs" c="dimmed">
						{t("truncated")}
					</Text>
				)}
			</Stack>
		</Card>
	);
}

function ToolDetail({
	tool,
	controller,
}: {
	tool: PublicSharedTool;
	controller: PublicShareSession;
}) {
	const { t } = useTranslation("publicShare");
	const [opened, setOpened] = useState(false);
	const [detail, setDetail] = useState<PublicSharedToolDetail | null>(null);
	const [error, setError] = useState(false);
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same bounded request.
	useEffect(() => {
		if (!opened) return;
		const abort = new AbortController();
		setError(false);
		void controller
			.tool(tool.id, abort.signal)
			.then((value) => {
				if (!abort.signal.aborted) setDetail(value);
			})
			.catch(() => {
				if (!abort.signal.aborted) setError(true);
			});
		return () => abort.abort();
	}, [opened, controller, tool.id, attempt]);
	return (
		<details
			className="public-share-details"
			onToggle={(event) => setOpened(event.currentTarget.open)}
		>
			<summary>
				{tool.name} ·{" "}
				{t("toolStatus", { status: t(`status.${tool.status}`, { defaultValue: tool.status }) })}
			</summary>
			{opened &&
				(error ? (
					<Button size="compact-xs" onClick={() => setAttempt(attempt + 1)}>
						{t("retryTool")}
					</Button>
				) : detail ? (
					<>
						<Text size="xs" fw={600}>
							{t("toolInput")}
						</Text>
						<pre className="public-share-tool-text">{detail.input || t("emptyText")}</pre>
						<Text size="xs" fw={600}>
							{t("toolOutput")}
						</Text>
						<pre className="public-share-tool-text">{detail.output || t("emptyText")}</pre>
						{detail.truncated && (
							<Text size="xs" c="dimmed">
								{t("truncated")}
							</Text>
						)}
					</>
				) : (
					<Loader size="xs" />
				))}
		</details>
	);
}

function DiscussionPane({
	controller,
	state,
	hidden,
}: {
	controller: PublicShareSession;
	state: PublicShareViewState;
	hidden: boolean;
}) {
	const { t } = useTranslation("publicShare");
	// This component only exists after validation. Credential changes/revocation unmount it,
	// disposing draft + reply together; nothing is put in localStorage or the private cache.
	const [draft, setDraft] = useState("");
	const [reply, setReply] = useState<PublicDiscussionMessage | null>(null);
	const messages = state.discussion?.messages ?? [];
	const last = messages.at(-1);
	useEffect(() => {
		if (!state.discussion) setReply(null);
	}, [state.discussion]);
	async function submit() {
		const sentDraft = draft;
		if (await controller.post(sentDraft.trim(), reply?.id)) {
			setDraft((current) => (current === sentDraft ? "" : current));
			setReply(null);
		}
	}
	return (
		<ScrollPane
			title={t("discussion")}
			hidden={hidden}
			count={messages.length}
			hasMore={state.discussion?.hasMore ?? false}
			loading={state.loadingDiscussion}
			loadEarlier={controller.loadEarlierDiscussion}
			revision={`${last?.id}:${last?.text.length}:${hidden}`}
			footer={
				<div className="public-share-composer">
					<Stack gap="xs">
						<Text size="xs">{t("fixedIdentity", { name: state.session?.guestName })}</Text>
						<Text size="xs" c="dimmed">
							{t("discussionHint")}
						</Text>
						{reply && (
							<Group justify="space-between">
								<Text size="xs" lineClamp={1}>
									{t("replyingTo", { name: reply.author.name })}
								</Text>
								<Button size="compact-xs" variant="subtle" onClick={() => setReply(null)}>
									{t("cancelReply")}
								</Button>
							</Group>
						)}
						<Textarea
							aria-label={t("compose")}
							placeholder={t("compose")}
							value={draft}
							onChange={(event) => setDraft(event.currentTarget.value)}
							maxLength={8000}
							minRows={2}
							maxRows={5}
							autosize
							disabled={state.phase !== "live" || state.sending}
						/>
						{state.sendError && (
							<Text size="xs" c="red" role="alert">
								{t("sendError")}
							</Text>
						)}
						<Group justify="space-between">
							<Text size="xs" c="dimmed">
								{draft.length}/8000
							</Text>
							<Button
								size="xs"
								onClick={() => void submit()}
								loading={state.sending}
								disabled={!draft.trim() || state.phase !== "live"}
							>
								{t("send")}
							</Button>
						</Group>
					</Stack>
				</div>
			}
		>
			{!messages.length && !state.loadingDiscussion && (
				<Text size="sm" c="dimmed">
					{t("emptyDiscussion")}
				</Text>
			)}
			{messages.map((message) => (
				<Card key={message.id} withBorder padding="sm">
					<Stack gap={6}>
						<Group justify="space-between" gap="xs">
							<Group gap={6}>
								<Text size="sm" fw={600}>
									{message.author.name}
								</Text>
								{message.author.isGuest && <Badge size="xs">{t("guest")}</Badge>}
								{message.author.isSelf && (
									<Badge size="xs" variant="outline">
										{t("you")}
									</Badge>
								)}
							</Group>
							<Text size="xs" c="dimmed">
								{formatDate(message.createdAt)}
							</Text>
						</Group>
						{message.replyTo && (
							<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
								{t("replyPreview", {
									name: message.replyTo.name,
									text: message.replyTo.text ?? t("deleted"),
								})}
							</Text>
						)}
						<Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
							{message.deletedAt ? t("deleted") : message.text}
						</Text>
						{message.hasAttachments && (
							<Text size="xs" c="dimmed">
								{t("mediaOmitted")}
							</Text>
						)}
						{!message.deletedAt && (
							<Button
								size="compact-xs"
								variant="subtle"
								style={{ alignSelf: "flex-start" }}
								disabled={state.phase !== "live"}
								onClick={() => setReply(message)}
							>
								{t("reply")}
							</Button>
						)}
					</Stack>
				</Card>
			))}
		</ScrollPane>
	);
}

function formatDate(value: string) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}
