import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	SegmentedControl,
	Stack,
	Text,
	Textarea,
	Title,
} from "@mantine/core";
import type { PublicDiscussionMessage, PublicSharedSession } from "@shared/public-narrator-share";
import { IconCornerUpLeft } from "@tabler/icons-react";
import {
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNarratorLod } from "../../hooks/useNarratorLod";
import { usePublicSharedNarrator } from "../../hooks/usePublicSharedNarrator";
import type { ChatMessage } from "../../lib/api/chat";
import { changeAppLanguage, ensureI18nNamespaces } from "../../lib/i18n";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import type { PublicShareClient } from "../../lib/public-share-api";
import type { PublicShareSession, PublicShareViewState } from "../../lib/public-share-session";
import { projectChatMessagesToTree } from "../chat/chat-vlist-adapter";
import { RenderLodCtx } from "../narrator/lod/RenderLodCtx";
import type { CustomMessageMenuItem } from "../narrator/message/MessageContextMenuCtx";
import "./public-share.css";

/**
 * The shared message renderer: the SAME PretextExactMessageList the narrator
 * panel runs, fed through its dataSource seam with share-credentialed fetches.
 * Realtime (streaming, live patches, structural events, discussion messages)
 * rides `/ws/narrator` in share-auth mode — the controller flips the manager's
 * credential on mount. The lazy import is required by the vlist isolation guard.
 */
const PretextExactMessageListLazy = lazy(() =>
	import("../narrator/vlist/PretextExactMessageList").then((module) => ({
		default: module.PretextExactMessageList,
	})),
);
const NarratorLodMenuLazy = lazy(() =>
	import("../narrator/lod/NarratorLodMenu").then((module) => ({ default: module.NarratorLodMenu })),
);

type VListDataSource = import("../narrator/vlist/vlist-data-source").VListDataSource;
type NarratorWSCallbacks = import("../../hooks/useNarratorWS").NarratorWSCallbacks;
type TreeMessage = import("../../lib/api/types").TreeMessage;

/** Synthetic viewer identity: a discussion row authored by THIS link's guest. */
const SHARE_SELF_ID = "$share-self";

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

/** The vlist chrome strings live in the narrator bundle; load it with the list. */
function useNarratorLabels() {
	const { i18n } = useTranslation();
	const [ready, setReady] = useState(() =>
		i18n.hasResourceBundle(i18n.resolvedLanguage ?? "en", "narrator"),
	);
	useEffect(() => {
		let cancelled = false;
		void ensureI18nNamespaces(["narrator"]).then(() => {
			if (!cancelled) setReady(true);
		});
		return () => {
			cancelled = true;
		};
		// Mount-once: later language switches load the bundle through
		// changeAppLanguage's own namespace list (see the language button below).
	}, []);
	return ready;
}

export function PublicSharedNarratorPage({
	shareId,
	credential,
}: {
	shareId: string;
	credential: string;
}) {
	const { t, i18n } = useTranslation("publicShare");
	const { client, controller, state } = usePublicSharedNarrator(shareId, credential);
	const [tab, setTab] = useState("session");
	const [languageError, setLanguageError] = useState(false);
	const narratorLabelsReady = useNarratorLabels();
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
							"narrator",
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
			) : state.phase === "error" ? (
				<Alert color="red" title={t("connection.error")}>
					<Button variant="light" onClick={controller.reconnect}>
						{t("reconnect")}
					</Button>
				</Alert>
			) : state.session && narratorLabelsReady ? (
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
						<SessionPane client={client} session={state.session} hidden={tab !== "session"} />
						<DiscussionPane
							client={client}
							session={state.session}
							controller={controller}
							state={state}
							hidden={tab !== "discussion"}
						/>
					</div>
				</>
			) : (
				<Group justify="center" py="xl">
					<Loader size="sm" />
				</Group>
			)}
		</main>
	);
}

/**
 * One pane of the share page: a bordered section with a header and the shared
 * vlist inside. LOD switching rides the same context the narrator panel uses.
 */
function PaneShell({
	title,
	hidden,
	headerAside,
	footer,
	children,
}: {
	title: string;
	hidden: boolean;
	headerAside?: ReactNode;
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="public-share-pane" data-mobile-hidden={hidden} aria-label={title}>
			<Group className="public-share-pane-header" justify="space-between" wrap="nowrap">
				<Text fw={600} size="sm">
					{title}
				</Text>
				{headerAside}
			</Group>
			<div className="public-share-list">{children}</div>
			{footer}
		</section>
	);
}

function SessionPane({
	client,
	session,
	hidden,
}: {
	client: PublicShareClient;
	session: PublicSharedSession;
	hidden: boolean;
}) {
	const { t } = useTranslation("publicShare");
	// The share page has no per-narrator preference to honor — the global default
	// LOD applies, and the menu writes it back for the session's own tabs too.
	const { lod, isDefault, setLod, setAsDefault } = useNarratorLod(undefined);
	const dataSource = useMemo<VListDataSource>(
		() => ({
			// The reader is a guest: every user bubble belongs to somebody else.
			viewerId: null,
			fetchPage: (_id, opts) =>
				client.pretextDocument(opts.signal ?? new AbortController().signal, opts),
			locateMessage: (_id, messageId, signal) =>
				client.messageLocation(messageId, signal ?? new AbortController().signal),
			fetchToolDetail: (_id, toolUseId, ref, signal) =>
				client.toolCallDetail(toolUseId, ref, signal),
		}),
		[client],
	);
	// Read-only: guests watch the transcript, they do not operate it. interactive:false
	// strips the hover toolbars, swipe menus and the row context menu (fork / delete /
	// compact all target operations the share token cannot perform anyway).
	const lodValue = useMemo(() => ({ lod, interactive: false }), [lod]);
	return (
		<PaneShell
			title={t("session")}
			hidden={hidden}
			headerAside={
				<Suspense fallback={null}>
					<NarratorLodMenuLazy
						lod={lod}
						isDefault={isDefault}
						onSelectLod={setLod}
						onSetAsDefault={setAsDefault}
					/>
				</Suspense>
			}
		>
			<Suspense
				fallback={
					<Group justify="center" py="xl">
						<Loader size="sm" />
					</Group>
				}
			>
				<RenderLodCtx.Provider value={lodValue}>
					<PretextExactMessageListLazy
						narratorId={session.narratorId}
						isActive={session.status === "working"}
						dataSource={dataSource}
					/>
				</RenderLodCtx.Provider>
			</Suspense>
		</PaneShell>
	);
}

function DiscussionPane({
	client,
	session,
	controller,
	state,
	hidden,
}: {
	client: PublicShareClient;
	session: PublicSharedSession;
	controller: PublicShareSession;
	state: PublicShareViewState;
	hidden: boolean;
}) {
	const { t } = useTranslation("publicShare");
	const [draft, setDraft] = useState("");
	const [reply, setReply] = useState<{ id: string; authorName: string } | null>(null);
	const labels = useMemo(
		() => ({
			messageDeleted: t("deleted"),
			replyToDeleted: t("deleted"),
			replyUnavailable: t("deleted"),
			guestMarker: t("guest"),
			mediaOmitted: t("mediaOmitted"),
		}),
		[t],
	);
	const labelsRef = useRef(labels);
	labelsRef.current = labels;
	const guestNameRef = useRef(session.guestName);
	guestNameRef.current = session.guestName;
	// Row actions resolve a message id back to its author; the cache is filled by both
	// the paged fetch and the live broadcast so a reply always finds its target.
	const messageCacheRef = useRef(new Map<string, { id: string; authorName: string }>());

	const dataSource = useMemo<VListDataSource>(
		() => ({
			viewerId: SHARE_SELF_ID,
			fetchPage: async (_id, opts) => {
				const page = await client.discussion(
					opts.signal ?? new AbortController().signal,
					opts.beforeSeq,
				);
				for (const message of page.messages)
					messageCacheRef.current.set(message.id, {
						id: message.id,
						authorName: message.author.name,
					});
				return {
					messages: page.messages.map((message) =>
						projectDiscussionMessage(
							message,
							session.roomId,
							guestNameRef.current,
							labelsRef.current,
						),
					),
					minSeq: page.messages[0]?.seq ?? null,
					maxSeq: page.messages.at(-1)?.seq ?? null,
					hasNext: false,
					hasPrev: page.hasMore,
					messageVersion: 0,
				};
			},
			subscribeMessages: (handlers: NarratorWSCallbacks) => {
				const handleId = narratorWSManager.allocateId();
				narratorWSManager.joinChatRoom(session.roomId, handleId);
				const listener = narratorWSManager.addListener(
					{ narratorIds: "*", types: ["chat:message", "chat:message_deleted"] },
					(data) => {
						if (data.roomId !== session.roomId) return;
						if (data.type === "chat:message") {
							const broadcast = data.message as ChatMessage;
							messageCacheRef.current.set(broadcast.id, {
								id: broadcast.id,
								authorName: broadcast.sender?.username ?? "",
							});
							const projected = projectChatBroadcast(
								broadcast,
								session.roomId,
								guestNameRef.current,
								labelsRef.current,
							);
							if (projected) handlers.onMessage?.({ message: projected });
							return;
						}
						if (data.type === "chat:message_deleted") handlers.onFullReload?.();
					},
				);
				const unsubscribeConnection = narratorWSManager.onConnectionChange(
					(connected, isReconnect) => {
						if (connected && isReconnect) handlers.onFullReload?.();
					},
				);
				return () => {
					unsubscribeConnection();
					narratorWSManager.removeListener(listener);
					narratorWSManager.leaveChatRoom(session.roomId, handleId);
				};
			},
		}),
		[client, session.roomId],
	);

	// Guests may answer a message but never delete or edit one — the only row action
	// the discussion pane offers is "reply".
	const customMessageActions = useCallback(
		(messageId: string): CustomMessageMenuItem[] | undefined => {
			const target = messageCacheRef.current.get(messageId);
			if (!target) return undefined;
			return [
				{
					key: "reply",
					label: t("reply"),
					icon: <IconCornerUpLeft size={14} />,
					onClick: () => setReply({ id: target.id, authorName: target.authorName }),
				},
			];
		},
		[t],
	);

	async function submit() {
		const sentDraft = draft;
		if (await controller.post(sentDraft.trim(), reply?.id)) {
			setDraft((current) => (current === sentDraft ? "" : current));
			setReply(null);
		}
	}

	return (
		<PaneShell
			title={t("discussion")}
			hidden={hidden}
			footer={
				<div className="public-share-composer">
					<Stack gap="xs">
						<Text size="xs">{t("fixedIdentity", { name: session.guestName })}</Text>
						<Text size="xs" c="dimmed">
							{t("discussionHint")}
						</Text>
						{reply && (
							<Group justify="space-between">
								<Text size="xs" lineClamp={1}>
									{t("replyingTo", { name: reply.authorName })}
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
			<Suspense
				fallback={
					<Group justify="center" py="xl">
						<Loader size="sm" />
					</Group>
				}
			>
				<PretextExactMessageListLazy
					narratorId={session.roomId}
					isActive={false}
					dataSource={dataSource}
					rowHandlers={{ customMessageActions }}
				/>
			</Suspense>
		</PaneShell>
	);
}

/** Discussion labels shared by the projection (cache-keyed upstream). */
interface DiscussionLabels {
	messageDeleted: string;
	replyToDeleted: string;
	replyUnavailable: string;
	guestMarker: string;
	mediaOmitted: string;
}

/**
 * One discussion DTO → one TreeMessage. Author identity: this link's own guest
 * gets the synthetic self id (right-hand bubble); every other author is a guest
 * keyed by the row (their display ids are not stable across the DTO boundary).
 */
function projectDiscussionMessage(
	message: PublicDiscussionMessage,
	roomId: string,
	guestName: string,
	labels: DiscussionLabels,
): TreeMessage {
	const chatLike: ChatMessage = {
		id: message.id,
		roomId,
		seq: message.seq,
		kind: "text",
		contentText: message.deletedAt
			? ""
			: message.hasAttachments
				? `${message.text}${message.text ? "\n\n" : ""}${labels.mediaOmitted}`
				: message.text,
		replyToMessageId: message.replyTo?.id ?? null,
		replyToSeq: message.replyTo?.seq ?? null,
		replyToSender: message.replyTo
			? {
					id: `guest:${message.replyTo.id}`,
					username: message.replyTo.name,
					avatarColor: null,
					avatarImageId: null,
					isGuest: true,
				}
			: null,
		replyToPreview: message.replyTo ? (message.replyTo.text ?? "") : null,
		attachments: [],
		editedAt: null,
		deletedAt: message.deletedAt,
		createdAt: message.createdAt,
		sender: {
			id: message.author.isSelf ? SHARE_SELF_ID : `guest:${message.id}`,
			username: message.author.name,
			avatarColor: null,
			avatarImageId: null,
			isGuest: message.author.isGuest,
		},
	};
	return projectChatLikeMessage(chatLike, labels);
}

/**
 * A live discussion broadcast arrives in the room's ChatMessage shape (the same
 * channel logged-in members use); "self" is the guest whose name matches this
 * link's fixed identity.
 */
function projectChatBroadcast(
	message: ChatMessage,
	roomId: string,
	guestName: string,
	labels: DiscussionLabels,
): TreeMessage {
	const isSelf = message.sender?.isGuest === true && message.sender.username === guestName;
	const chatLike: ChatMessage = {
		...message,
		sender: message.sender
			? { ...message.sender, id: isSelf ? SHARE_SELF_ID : message.sender.id }
			: message.sender,
	};
	return projectChatLikeMessage(chatLike, labels);
}

/** Shared with the chat room's projection (same TreeMessage shape). */
function projectChatLikeMessage(message: ChatMessage, labels: DiscussionLabels): TreeMessage {
	const projected = projectChatMessagesToTree([message], {
		messageDeleted: labels.messageDeleted,
		replyToDeleted: labels.replyToDeleted,
		replyUnavailable: labels.replyUnavailable,
		guestMarker: labels.guestMarker,
	});
	if (!projected[0]) throw new Error("discussion projection produced no row");
	return projected[0];
}
