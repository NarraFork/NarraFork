import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Button,
	Card,
	Container,
	Divider,
	Grid,
	Group,
	Modal,
	Paper,
	ScrollArea,
	Select,
	Stack,
	Tabs,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconArrowLeft,
	IconExternalLink,
	IconFolder,
	IconGitMerge,
	IconKey,
	IconLock,
	IconTags,
	IconTrash,
	IconUser,
	IconUserShare,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EntryAclPanel } from "../../components/knowledge/EntryAclPanel";
import { EntryMetaPanel } from "../../components/knowledge/EntryMetaPanel";
import { ReviewScopeNotice } from "../../components/knowledge/ReviewScopeNotice";
import { SubmissionAuthorActions } from "../../components/knowledge/SubmissionAuthorActions";
import { SubmissionReviewPanel } from "../../components/knowledge/SubmissionReviewPanel";
import { TransferOwnerModal } from "../../components/knowledge/TransferOwnerModal";
import { DiffView } from "../../components/narrator/diff/DiffView";
import { MarkdownContent } from "../../components/narrator/markdown/MarkdownContent";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	useAddKnowledgeRevision,
	useCreateEntryLink,
	useCreateKnowledgeDraft,
	useDeleteEntryLink,
	useDeleteKnowledgeEntry,
	useEntryLinks,
	useKnowledgeDraftDrift,
	useKnowledgeEntries,
	useKnowledgeEntry,
	useKnowledgeRevision,
	useKnowledgeRevisions,
	useKnowledgeSubmission,
	useKnowledgeSubmissions,
	useMyKnowledgeDraft,
	usePersonalEntrySubmissions,
	useRebaseKnowledgeDraft,
	useSubmitKnowledgeDraft,
	useUpdateKnowledgeDraft,
} from "../../hooks/useKnowledge";
import type { KnowledgeEntry, KnowledgeEntryLink, KnowledgeLinkType } from "../../lib/api";
import { api } from "../../lib/api";
import { formatLocaleDateTime } from "../../lib/intl-format";

function LinksSummary({ entryId }: { entryId: string }) {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const links = useEntryLinks(entryId, "both");

	const all = links.data ?? [];
	if (all.length === 0) {
		return (
			<Text size="xs" c="dimmed">
				{t("linkNoOutgoing")}
			</Text>
		);
	}

	return (
		<Stack gap="xs">
			{all.slice(0, 5).map((l) => {
				const isOut = l.direction === "out";
				const other = isOut ? l.toEntry : l.fromEntry;
				return (
					<Group key={l.id} wrap="nowrap" justify="space-between" gap="xs">
						<Group gap={4} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
							<Badge
								size="xs"
								variant="light"
								color={isOut ? "blue" : "teal"}
								style={{ flexShrink: 0 }}
							>
								{t(`linkType_${l.linkType}`)}
							</Badge>
							<Anchor
								size="xs"
								truncate="end"
								onClick={() =>
									navigate({ to: "/knowledge/$entryId", params: { entryId: other.id } })
								}
							>
								{other.title}
							</Anchor>
						</Group>
					</Group>
				);
			})}
			{all.length > 5 && (
				<Text size="xs" c="dimmed" fs="italic">
					...
				</Text>
			)}
		</Stack>
	);
}

function ReadOnlyMetaView({ entry }: { entry: KnowledgeEntry }) {
	const { t } = useTranslation("knowledge");

	return (
		<Stack gap="xs">
			<Group gap="xs" wrap="nowrap">
				<IconFolder size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
				<Text size="xs" c="dimmed" style={{ width: 80, flexShrink: 0 }}>
					{t("collections")}
				</Text>
				<Text size="xs" truncate fw={500}>
					{entry.collectionId}
				</Text>
			</Group>

			<Group gap="xs" wrap="nowrap">
				<IconLock size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
				<Text size="xs" c="dimmed" style={{ width: 80, flexShrink: 0 }}>
					{t("classificationLevel")}
				</Text>
				{entry.classificationLevel ? (
					<Badge size="xs" color="grape" variant="light">
						{entry.classificationLevel}
					</Badge>
				) : (
					<Text size="xs">-</Text>
				)}
			</Group>

			<Group gap="xs" wrap="nowrap">
				<IconUser size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
				<Text size="xs" c="dimmed" style={{ width: 80, flexShrink: 0 }}>
					{t("owner")}
				</Text>
				<Text size="xs" truncate>
					{entry.ownerUserId || "-"}
				</Text>
			</Group>

			<Group gap="xs" wrap="nowrap" align="flex-start">
				<IconTags size={14} style={{ color: "var(--mantine-color-dimmed)", marginTop: 2 }} />
				<Text size="xs" c="dimmed" style={{ width: 80, flexShrink: 0 }}>
					{t("tags")}
				</Text>
				<Group gap={4} wrap="wrap">
					{(entry.tagsJson ?? []).length > 0 ? (
						(entry.tagsJson ?? []).map((tag: string) => (
							<Badge key={tag} size="xs" variant="light">
								{tag}
							</Badge>
						))
					) : (
						<Text size="xs" c="dimmed">
							-
						</Text>
					)}
				</Group>
			</Group>

			<Group gap="xs" wrap="nowrap" align="flex-start">
				<IconKey size={14} style={{ color: "var(--mantine-color-dimmed)", marginTop: 2 }} />
				<Text size="xs" c="dimmed" style={{ width: 80, flexShrink: 0 }}>
					{t("keywords")}
				</Text>
				<Group gap={4} wrap="wrap">
					{(entry.keywordsJson ?? []).length > 0 ? (
						(entry.keywordsJson ?? []).map((k: string) => (
							<Badge key={k} size="xs" variant="outline" color="indigo">
								{k}
							</Badge>
						))
					) : (
						<Text size="xs" c="dimmed">
							-
						</Text>
					)}
				</Group>
			</Group>

			<Group gap="xs" wrap="nowrap">
				<IconGitMerge size={14} style={{ color: "var(--mantine-color-dimmed)" }} />
				<Text size="xs" c="dimmed" style={{ width: 80, flexShrink: 0 }}>
					{t("status")}
				</Text>
				<Badge size="xs" variant="light" color={entry.status === "active" ? "green" : "gray"}>
					{t(`statusActive`)}
				</Badge>
			</Group>
		</Stack>
	);
}

export const Route = createFileRoute("/knowledge/$entryId")({
	component: EntryDetailPage,
});

function EntryDetailPage() {
	const { t } = useTranslation("knowledge");
	const { entryId } = Route.useParams();
	const navigate = useNavigate();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const entry = useKnowledgeEntry(entryId);
	const [activeTab, setActiveTab] = useState<string | null>("content");

	if (entry.isLoading) {
		return (
			<Container size="lg" py="lg">
				<Text c="dimmed">{t("loading")}</Text>
			</Container>
		);
	}
	if (!entry.data) {
		return (
			<Container size="lg" py="lg">
				<Anchor onClick={() => navigate({ to: "/knowledge" })}>{t("backToList")}</Anchor>
			</Container>
		);
	}

	const e = entry.data;
	const isOwner = !!user && e.ownerUserId === user.id;
	const canDirectWrite = isAdmin || isOwner;

	return (
		<Container size="lg" py="lg">
			<Group mb="xs">
				<Button
					variant="subtle"
					size="compact-sm"
					leftSection={<IconArrowLeft size={14} />}
					onClick={() => navigate({ to: "/knowledge" })}
				>
					{t("backToList")}
				</Button>
			</Group>

			<Group justify="space-between" align="flex-start" mb="md">
				<div>
					<Title order={3}>{e.title}</Title>
					<Group gap="xs" mt={4}>
						{e.classificationLevel ? (
							<Badge size="sm" color="grape" variant="light">
								{e.classificationLevel}
							</Badge>
						) : null}
						{(e.tagsJson ?? []).map((tag) => (
							<Badge key={tag} size="sm" variant="light">
								{tag}
							</Badge>
						))}
					</Group>
				</div>
				{/* Ownership transfer is admin OR current owner; delete follows the write gate. */}
				<EntryOwnerActions entry={e} isAdmin={isAdmin} isOwner={isOwner} />
			</Group>

			<Grid gap="lg">
				{/* Left Column: Content, Draft, History, Submissions, Links tabs */}
				<Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
					<Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
						<Tabs.List mb="md">
							<Tabs.Tab value="content">{t("tabContent")}</Tabs.Tab>
							<Tabs.Tab value="draft">{t("tabMyDraft")}</Tabs.Tab>
							<Tabs.Tab value="history">{t("tabHistory")}</Tabs.Tab>
							<Tabs.Tab value="submissions">{t("tabSubmissions")}</Tabs.Tab>
							<Tabs.Tab value="links">{t("tabLinks")}</Tabs.Tab>
						</Tabs.List>

						<Tabs.Panel value="content">
							<ContentTab
								content={e.currentContent ?? ""}
								canDirectWrite={canDirectWrite}
								entryId={entryId}
							/>
						</Tabs.Panel>
						<Tabs.Panel value="history">
							<HistoryTab entryId={entryId} />
						</Tabs.Panel>
						<Tabs.Panel value="draft">
							<DraftTab entryId={entryId} mainContent={e.currentContent ?? ""} />
						</Tabs.Panel>
						<Tabs.Panel value="submissions">
							<SubmissionsTab entryId={entryId} mainContent={e.currentContent ?? ""} />
						</Tabs.Panel>
						<Tabs.Panel value="links">
							<LinksTab entryId={entryId} collectionId={e.collectionId} />
						</Tabs.Panel>
					</Tabs>
				</Grid.Col>

				{/* Right Column: Sticky Sidebar with Meta, Link summary, ACL */}
				<Grid.Col span={{ base: 12, md: 4, lg: 3 }}>
					<Stack gap="md" style={{ position: "sticky", top: 80 }}>
						<Paper withBorder p="md" radius="md">
							<Stack gap="sm">
								<Text size="xs" fw={700} c="dimmed" tt="uppercase">
									{t("metaSettings")}
								</Text>
								<Divider />
								{canDirectWrite ? <EntryMetaPanel entry={e} /> : <ReadOnlyMetaView entry={e} />}
							</Stack>
						</Paper>

						<Paper withBorder p="md" radius="md">
							<Stack gap="sm">
								<Group justify="space-between" align="center">
									<Text size="xs" fw={700} c="dimmed" tt="uppercase">
										{t("tabLinks")}
									</Text>
									<Tooltip label={t("linkAdd")}>
										<ActionIcon size="xs" variant="subtle" onClick={() => setActiveTab("links")}>
											<IconExternalLink size={12} />
										</ActionIcon>
									</Tooltip>
								</Group>
								<Divider />
								<LinksSummary entryId={entryId} />
							</Stack>
						</Paper>

						{isAdmin && (
							<Paper withBorder p="md" radius="md">
								<EntryAclPanel entry={e} />
							</Paper>
						)}
					</Stack>
				</Grid.Col>
			</Grid>
		</Container>
	);
}

/**
 * Owner-scoped actions in the entry header: transfer ownership and delete.
 *
 * Both are gated to admin-or-owner. Transfer matches the server rule exactly (the route is
 * NOT requireAdmin — the service accepts admin OR the current owner). Delete goes through the
 * write gate server-side, so a write-grant holder's attempt is accepted there even though this
 * header only surfaces the button for admin/owner.
 */
function EntryOwnerActions({
	entry,
	isAdmin,
	isOwner,
}: {
	entry: KnowledgeEntry;
	isAdmin: boolean;
	isOwner: boolean;
}) {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const del = useDeleteKnowledgeEntry();
	const [transferOpen, setTransferOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [confirmText, setConfirmText] = useState("");
	// Transfer targets come from the admin user list; only fetched when the modal opens.
	const users = useQuery({
		queryKey: ["admin", "users"],
		queryFn: api.listUsers,
		enabled: isAdmin && transferOpen,
	});

	if (!isAdmin && !isOwner) return null;

	// Typing the title is required so a mis-click can't destroy an entry and its whole
	// revision history (the DELETE cascades to revisions and links).
	const confirmed = confirmText.trim() === entry.title.trim();

	return (
		<>
			<Group gap="xs">
				<Button
					size="compact-xs"
					variant="light"
					leftSection={<IconUserShare size={12} />}
					onClick={() => setTransferOpen(true)}
				>
					{t("transferOwnerOpen")}
				</Button>
				<Button
					size="compact-xs"
					variant="light"
					color="red"
					leftSection={<IconTrash size={12} />}
					onClick={() => {
						setConfirmText("");
						setDeleteOpen(true);
					}}
				>
					{t("deleteEntry")}
				</Button>
			</Group>

			<TransferOwnerModal
				kind="entry"
				targetId={entry.id}
				targetName={entry.title}
				currentOwnerUserId={entry.ownerUserId}
				users={(users.data ?? []) as { id: string; username: string; role: string }[]}
				opened={transferOpen}
				onClose={() => setTransferOpen(false)}
			/>

			<Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title={t("deleteEntryTitle")}>
				<Stack gap="md">
					<Alert color="red" icon={<IconAlertTriangle size={16} />} p="xs">
						<Text size="xs">{t("deleteEntryWarning")}</Text>
					</Alert>
					<TextInput
						label={t("deleteEntryConfirmLabel")}
						placeholder={entry.title}
						value={confirmText}
						onChange={(ev) => setConfirmText(ev.currentTarget.value)}
						size="sm"
					/>
					{del.isError ? (
						<Text size="sm" c="red">
							{(del.error as Error).message}
						</Text>
					) : null}
					<Group justify="flex-end">
						<Button variant="subtle" size="xs" onClick={() => setDeleteOpen(false)}>
							{t("cancel")}
						</Button>
						<Button
							size="xs"
							color="red"
							loading={del.isPending}
							disabled={!confirmed}
							onClick={() =>
								del.mutate(entry.id, {
									onSuccess: () => {
										setDeleteOpen(false);
										navigate({ to: "/knowledge" });
									},
								})
							}
						>
							{t("delete")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}

function ContentTab({
	content,
	canDirectWrite,
	entryId,
}: {
	content: string;
	canDirectWrite: boolean;
	entryId: string;
}) {
	const { t } = useTranslation("knowledge");
	const addRev = useAddKnowledgeRevision();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(content);

	useEffect(() => {
		setDraft(content);
	}, [content]);

	return (
		<Stack>
			{canDirectWrite ? (
				<Group justify="space-between">
					<Text size="xs" c="dimmed">
						{t("directEditDesc")}
					</Text>
					{editing ? (
						<Group gap="xs">
							<Button variant="subtle" size="xs" onClick={() => setEditing(false)}>
								{t("cancel")}
							</Button>
							<Button
								size="xs"
								loading={addRev.isPending}
								onClick={() =>
									addRev.mutate({ entryId, content: draft }, { onSuccess: () => setEditing(false) })
								}
							>
								{t("save")}
							</Button>
						</Group>
					) : (
						<Button size="xs" variant="light" onClick={() => setEditing(true)}>
							{t("directEdit")}
						</Button>
					)}
				</Group>
			) : (
				<Text size="xs" c="dimmed">
					{t("directEditHint")}
				</Text>
			)}

			{editing ? (
				<Textarea
					value={draft}
					onChange={(ev) => setDraft(ev.currentTarget.value)}
					autosize
					minRows={10}
					maxRows={30}
				/>
			) : (
				<Paper withBorder p="md">
					{content ? (
						<MarkdownContent text={content} />
					) : (
						<Text c="dimmed" size="sm">
							{t("noContent")}
						</Text>
					)}
				</Paper>
			)}
		</Stack>
	);
}

function HistoryTab({ entryId }: { entryId: string }) {
	const { t } = useTranslation("knowledge");
	const revisions = useKnowledgeRevisions(entryId);
	const [leftId, setLeftId] = useState<string | null>(null);
	const [rightId, setRightId] = useState<string | null>(null);
	// The history list is metadata-only (it would otherwise carry every version's full body), so
	// the two sides of the diff are fetched on demand — and only once each, since both queries are
	// cached by revision id.
	const leftRev = useKnowledgeRevision(leftId ?? undefined);
	const rightRev = useKnowledgeRevision(rightId ?? undefined);

	const revs = revisions.data ?? [];
	const options = useMemo(() => revs.map((r) => ({ value: r.id, label: `v${r.version}` })), [revs]);
	const bothSelected = !!leftId && !!rightId;
	const diffLoading = bothSelected && (leftRev.isLoading || rightRev.isLoading);
	const diffReady = bothSelected && !!leftRev.data && !!rightRev.data;

	if ((revs.length ?? 0) === 0) {
		return (
			<Text size="sm" c="dimmed">
				{t("noRevisions")}
			</Text>
		);
	}

	return (
		<Stack>
			<Group gap="xs" align="flex-end">
				<Select label={t("version")} data={options} value={leftId} onChange={setLeftId} w={140} />
				<Text mt="lg">→</Text>
				<Select
					label={t("compareWith")}
					data={options}
					value={rightId}
					onChange={setRightId}
					w={140}
				/>
			</Group>

			{diffLoading ? (
				<Text size="sm" c="dimmed">
					{t("loading")}
				</Text>
			) : diffReady ? (
				<DiffView
					oldStr={leftRev.data?.content ?? ""}
					newStr={rightRev.data?.content ?? ""}
					language="markdown"
					maxHeight={400}
					wordWrap
				/>
			) : (
				<Stack gap="xs">
					<Text size="xs" c="dimmed">
						{t("compareSelectHint")}
					</Text>
					{revs.map((r) => (
						<Paper key={r.id} withBorder p="xs">
							<Group justify="space-between">
								<Group gap="xs">
									<Badge variant="light">v{r.version}</Badge>
									{r.changeNote ? <Text size="sm">{r.changeNote}</Text> : null}
								</Group>
								<Group gap="xs">
									{/* Size comes from the SQL projection, so the list still conveys how big
									    each version is without shipping any bodies. */}
									<Text size="xs" c="dimmed">
										{t("revisionSize", { count: r.contentLength })}
									</Text>
									<Text size="xs" c="dimmed">
										{formatLocaleDateTime(r.createdAt)}
									</Text>
								</Group>
							</Group>
						</Paper>
					))}
				</Stack>
			)}
		</Stack>
	);
}

function DraftTab({ entryId, mainContent }: { entryId: string; mainContent: string }) {
	const { t } = useTranslation("knowledge");
	const myDraft = useMyKnowledgeDraft(entryId);
	const drift = useKnowledgeDraftDrift(entryId);
	const createDraft = useCreateKnowledgeDraft();
	const updateDraft = useUpdateKnowledgeDraft();
	const submitDraft = useSubmitKnowledgeDraft();
	const rebaseDraft = useRebaseKnowledgeDraft();
	const [content, setContent] = useState("");
	const [dirty, setDirty] = useState(false);
	const [conflict, setConflict] = useState<{ theirs: string; yours: string } | null>(null);
	// "Take main" discards the author's edits irreversibly → always confirm first.
	const [takeMainOpen, setTakeMainOpen] = useState(false);
	// Set when a submit went through on a stale base. The drift banner above warns BEFORE
	// submitting, but it is dismissible-by-scrolling and easy to walk past; this confirms
	// after the fact that the reviewer may hit a conflict, while rebasing is still an option.
	const [submittedDrift, setSubmittedDrift] = useState<number | null>(null);

	const draft = myDraft.data;
	useEffect(() => {
		if (draft && !dirty) setContent(draft.content);
	}, [draft, dirty]);

	if (myDraft.isLoading) {
		return (
			<Text size="sm" c="dimmed">
				{t("loading")}
			</Text>
		);
	}

	if (!draft) {
		return (
			<Stack>
				<Text size="sm" c="dimmed">
					{t("noDraft")}
				</Text>
				<Group>
					<Button
						size="xs"
						loading={createDraft.isPending}
						onClick={() => createDraft.mutate({ entryId })}
					>
						{t("createDraft")}
					</Button>
				</Group>
			</Stack>
		);
	}

	// A personal entry is editable while it is in use; `archived` means it was retired
	// (e.g. after a successful publish) and no longer accepts edits or submissions.
	const isActive = draft.status === "active";

	const driftData = drift.data;
	const isDrifted = !!driftData && driftData.hasDraft && driftData.drifted;
	const versionsBehind = driftData?.hasDraft && driftData.drifted ? driftData.versionsBehind : 0;

	const onRebase = () => {
		setConflict(null);
		rebaseDraft.mutate(
			{ draftId: draft.id, entryId },
			{
				onSuccess: (res) => {
					if (res.ok) {
						// Merged content is now persisted; drop local edits so the fresh draft shows.
						setDirty(false);
					} else if (res.conflict) {
						setConflict({ theirs: res.conflict.theirs, yours: res.conflict.yours });
					}
				},
			},
		);
	};

	// strategy=theirs replaces the draft with main verbatim — it never conflicts, and it
	// throws away the local edits, which is exactly the point (catching up when main already
	// covers what you were writing).
	const onTakeMain = () => {
		setConflict(null);
		rebaseDraft.mutate(
			{ draftId: draft.id, entryId, strategy: "theirs" },
			{
				onSuccess: () => {
					setDirty(false);
					setTakeMainOpen(false);
				},
			},
		);
	};

	return (
		<Stack>
			{isDrifted ? (
				<Alert color="orange" title={t("driftBanner")} icon={<IconGitMerge size={16} />}>
					<Stack gap="xs">
						<Text size="sm">
							{versionsBehind > 0 ? t("driftDesc", { count: versionsBehind }) : t("driftDesc_zero")}
						</Text>
						<Group>
							<Button
								size="xs"
								color="orange"
								leftSection={<IconGitMerge size={14} />}
								loading={rebaseDraft.isPending}
								onClick={onRebase}
							>
								{rebaseDraft.isPending ? t("rebasing") : t("rebaseDraft")}
							</Button>
							{/* Escape hatch when the merge conflicts (or you simply want main): take
							    main verbatim. Confirmed in a modal because local edits are lost. */}
							<Button
								size="xs"
								variant="light"
								color="gray"
								leftSection={<IconArrowBackUp size={14} />}
								disabled={rebaseDraft.isPending}
								onClick={() => setTakeMainOpen(true)}
							>
								{t("driftTakeMain")}
							</Button>
							<Text size="xs" c="dimmed">
								{t("rebaseHint")}
							</Text>
						</Group>
					</Stack>
				</Alert>
			) : null}

			{submittedDrift !== null ? (
				<Alert
					color="yellow"
					title={t("submitDriftTitle")}
					icon={<IconAlertTriangle size={16} />}
					withCloseButton
					onClose={() => setSubmittedDrift(null)}
				>
					<Text size="sm">{t("submitDriftDesc", { count: submittedDrift })}</Text>
				</Alert>
			) : null}

			<Modal
				opened={takeMainOpen}
				onClose={() => setTakeMainOpen(false)}
				title={t("driftTakeMainTitle")}
			>
				<Stack gap="md">
					<Alert color="red" icon={<IconAlertTriangle size={16} />} p="xs">
						<Text size="xs">{t("driftTakeMainDesc")}</Text>
					</Alert>
					<Text size="xs" c="dimmed">
						{t("driftTakeMainHint")}
					</Text>
					{rebaseDraft.isError ? (
						<Text size="xs" c="red">
							{(rebaseDraft.error as Error).message}
						</Text>
					) : null}
					<Group justify="flex-end">
						<Button variant="subtle" size="xs" onClick={() => setTakeMainOpen(false)}>
							{t("cancel")}
						</Button>
						<Button size="xs" color="red" loading={rebaseDraft.isPending} onClick={onTakeMain}>
							{t("driftTakeMain")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			{conflict ? (
				<Alert
					color="red"
					title={t("rebaseConflict")}
					withCloseButton
					onClose={() => setConflict(null)}
				>
					<Stack gap="xs">
						<Text size="sm">{t("rebaseConflictDesc")}</Text>
						<Text size="xs" c="dimmed">
							{t("rebaseConflictMain")} → {t("rebaseConflictYours")}
						</Text>
						<DiffView
							oldStr={conflict.theirs}
							newStr={conflict.yours}
							language="markdown"
							maxHeight={280}
							wordWrap
						/>
					</Stack>
				</Alert>
			) : null}

			<Group justify="space-between">
				<Badge variant="light" color={isActive ? "blue" : "gray"}>
					{t(`personalEntryStatus_${draft.status}`)}
				</Badge>
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						loading={updateDraft.isPending}
						disabled={!isActive}
						onClick={() =>
							updateDraft.mutate(
								{ draftId: draft.id, entryId, content },
								{ onSuccess: () => setDirty(false) },
							)
						}
					>
						{t("saveDraft")}
					</Button>
					<Button
						size="xs"
						loading={submitDraft.isPending || updateDraft.isPending}
						disabled={!isActive}
						onClick={async () => {
							// Persist any unsaved edits before submitting, so the submission
							// always carries the latest draft content (not the stale DB copy).
							if (dirty) {
								await updateDraft.mutateAsync({ draftId: draft.id, entryId, content });
								setDirty(false);
							}
							setSubmittedDrift(null);
							submitDraft.mutate(
								{ draftId: draft.id, entryId },
								{
									onSuccess: (res) => setSubmittedDrift(res.driftWarning?.versionsBehind ?? null),
								},
							);
						}}
					>
						{t("submitForReview")}
					</Button>
				</Group>
			</Group>

			<Textarea
				label={t("draftContent")}
				value={content}
				onChange={(e) => {
					setContent(e.currentTarget.value);
					setDirty(true);
				}}
				autosize
				minRows={8}
				maxRows={24}
			/>

			<div>
				<Text size="xs" c="dimmed" mb={4}>
					{isDrifted ? t("mainVsDraft") : t("draftVsMain")}
				</Text>
				<DiffView
					oldStr={mainContent}
					newStr={content}
					language="markdown"
					maxHeight={320}
					wordWrap
				/>
			</div>
		</Stack>
	);
}

function SubmissionsTab({ entryId, mainContent }: { entryId: string; mainContent: string }) {
	const { t } = useTranslation("knowledge");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const list = useKnowledgeSubmissions({ entryId });
	// The caller's OWN publish requests on this entry. Needed because listSubmissions is the
	// REVIEWER view — it filters to submissions the caller may review, and nobody may review
	// their own, so an author never sees their own request there (and thus could not withdraw
	// or re-submit it from this tab).
	const myDraft = useMyKnowledgeDraft(entryId);
	const mine = usePersonalEntrySubmissions(myDraft.data?.id);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const detail = useKnowledgeSubmission(selectedId ?? undefined);

	const reviewable = list.data ?? [];
	const ownRows = mine.data ?? [];
	// Merge both views, de-duplicated (an admin sees their own request in both), newest first.
	const submissions = useMemo(() => {
		const byId = new Map(reviewable.map((s) => [s.id, s]));
		for (const s of ownRows) if (!byId.has(s.id)) byId.set(s.id, s);
		return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}, [reviewable, ownRows]);

	return (
		<Group align="flex-start" gap="md" wrap="nowrap">
			<Stack gap="xs" w={260} style={{ flexShrink: 0 }}>
				<ReviewScopeNotice />
				{submissions.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("noSubmissions")}
					</Text>
				) : (
					<ScrollArea.Autosize mah={500}>
						<Stack gap="xs">
							{submissions.map((s) => (
								<Card
									key={s.id}
									withBorder
									padding="xs"
									style={{
										cursor: "pointer",
										borderColor: s.id === selectedId ? "var(--mantine-color-blue-5)" : undefined,
									}}
									onClick={() => setSelectedId(s.id)}
								>
									<Group justify="space-between" wrap="nowrap">
										<Text size="xs" truncate="end">
											{s.changeNote || s.id.slice(0, 8)}
										</Text>
										<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
											{(s.round ?? 1) > 1 ? (
												<Badge size="xs" variant="outline" color="grape">
													{t("subFlowRound", { round: s.round })}
												</Badge>
											) : null}
											<Badge
												size="xs"
												variant="light"
												color={
													s.status === "conflict"
														? "orange"
														: s.status === "pending"
															? "blue"
															: s.status === "changes_requested"
																? "yellow"
																: "gray"
												}
											>
												{t(`submissionStatus_${s.status}`)}
											</Badge>
										</Group>
									</Group>
									{/* Author-side actions: withdraw an open request, re-submit a bounced one.
									    Rendered per row so they are reachable without opening the detail
									    panel (which is the reviewer surface). */}
									<SubmissionAuthorActions
										submissionId={s.id}
										status={s.status}
										submitterUserId={s.submitterUserId}
										currentUserId={user?.id}
										isAdmin={isAdmin}
										personalEntryId={s.draftId}
									/>
								</Card>
							))}
						</Stack>
					</ScrollArea.Autosize>
				)}
			</Stack>

			<div style={{ flex: 1, minWidth: 0 }}>
				{detail.data ? (
					<SubmissionReviewPanel
						submission={detail.data}
						currentContent={mainContent}
						canReview={
							// Backend listSubmissions only returns submissions the user may
							// review (or everything for admins). Checked against `reviewable`,
							// NOT the merged list, which also holds the caller's own requests.
							// A user may never review their OWN submission (the server rejects
							// it), so exclude that case.
							(isAdmin || reviewable.some((s) => s.id === detail.data?.id)) &&
							detail.data.submitterUserId !== user?.id
						}
						onDone={() => setSelectedId(null)}
					/>
				) : (
					<Text size="sm" c="dimmed">
						{t("selectSubmissionHint")}
					</Text>
				)}
			</div>
		</Group>
	);
}

const LINK_TYPES: KnowledgeLinkType[] = [
	"related",
	"expands",
	"supersedes",
	"depends_on",
	"parent",
	"custom",
];

function LinksTab({ entryId, collectionId }: { entryId: string; collectionId: string }) {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const links = useEntryLinks(entryId, "both");
	const createLink = useCreateEntryLink();
	const deleteLink = useDeleteEntryLink();
	// Candidate targets: readable entries in the same collection (excluding self).
	const candidates = useKnowledgeEntries({ collectionId });

	const [targetId, setTargetId] = useState<string | null>(null);
	const [linkType, setLinkType] = useState<KnowledgeLinkType>("related");
	const [label, setLabel] = useState("");

	const all = links.data ?? [];
	const outLinks = all.filter((l) => l.direction === "out");
	const inLinks = all.filter((l) => l.direction === "in");

	const targetOptions = useMemo(() => {
		const rows = candidates.data ?? [];
		return rows.filter((r) => r.id !== entryId).map((r) => ({ value: r.id, label: r.title }));
	}, [candidates.data, entryId]);

	const linkTypeOptions = LINK_TYPES.map((lt) => ({ value: lt, label: t(`linkType_${lt}`) }));

	const submit = () => {
		if (!targetId) return;
		createLink.mutate(
			{
				entryId,
				toEntryId: targetId,
				linkType,
				label: label.trim() || undefined,
			},
			{
				onSuccess: () => {
					setTargetId(null);
					setLabel("");
					setLinkType("related");
				},
			},
		);
	};

	return (
		<Stack gap="lg">
			<Paper withBorder p="md">
				<Text fw={600} size="sm" mb={4}>
					{t("linkAdd")}
				</Text>
				<Text size="xs" c="dimmed" mb="sm">
					{t("linkAddDesc")}
				</Text>
				<Group align="flex-end" gap="xs" wrap="wrap">
					<Select
						label={t("linkTarget")}
						placeholder={t("linkTargetPlaceholder")}
						data={targetOptions}
						value={targetId}
						onChange={setTargetId}
						searchable
						w={260}
						nothingFoundMessage={t("linkNoCandidates")}
					/>
					<Select
						label={t("linkType")}
						data={linkTypeOptions}
						value={linkType}
						onChange={(v) => setLinkType((v as KnowledgeLinkType) ?? "related")}
						w={160}
					/>
					<TextInput
						label={t("linkLabel")}
						placeholder={t("linkLabelPlaceholder")}
						value={label}
						onChange={(ev) => setLabel(ev.currentTarget.value)}
						w={200}
					/>
					<Button size="sm" loading={createLink.isPending} disabled={!targetId} onClick={submit}>
						{t("linkCreate")}
					</Button>
				</Group>
				{createLink.isError ? (
					<Text size="xs" c="red" mt="xs">
						{(createLink.error as Error).message}
					</Text>
				) : null}
			</Paper>

			<div>
				<Text fw={600} size="sm" mb="xs">
					{t("linkOutgoing")}
				</Text>
				<LinkList
					links={outLinks}
					emptyLabel={t("linkNoOutgoing")}
					otherEndOf={(l) => l.toEntry}
					onOpen={(id) => navigate({ to: "/knowledge/$entryId", params: { entryId: id } })}
					onDelete={(id) => deleteLink.mutate({ linkId: id, entryId })}
					deleting={deleteLink.isPending}
				/>
			</div>

			<div>
				<Text fw={600} size="sm" mb="xs">
					{t("linkIncoming")}
				</Text>
				<LinkList
					links={inLinks}
					emptyLabel={t("linkNoIncoming")}
					otherEndOf={(l) => l.fromEntry}
					onOpen={(id) => navigate({ to: "/knowledge/$entryId", params: { entryId: id } })}
					onDelete={(id) => deleteLink.mutate({ linkId: id, entryId })}
					deleting={deleteLink.isPending}
				/>
			</div>
		</Stack>
	);
}

function LinkList({
	links,
	emptyLabel,
	otherEndOf,
	onOpen,
	onDelete,
	deleting,
}: {
	links: KnowledgeEntryLink[];
	emptyLabel: string;
	otherEndOf: (l: KnowledgeEntryLink) => KnowledgeEntryLink["toEntry"];
	onOpen: (entryId: string) => void;
	onDelete: (linkId: string) => void;
	deleting: boolean;
}) {
	const { t } = useTranslation("knowledge");
	if (links.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{emptyLabel}
			</Text>
		);
	}
	return (
		<Stack gap="xs">
			{links.map((l) => {
				const other = otherEndOf(l);
				return (
					<Paper key={l.id} withBorder p="xs">
						<Group justify="space-between" wrap="nowrap">
							<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
								<Badge size="sm" variant="light" color="indigo">
									{t(`linkType_${l.linkType}`)}
								</Badge>
								<Anchor size="sm" truncate="end" onClick={() => onOpen(other.id)}>
									{other.title}
								</Anchor>
								{l.label ? (
									<Text size="xs" c="dimmed" truncate="end">
										{l.label}
									</Text>
								) : null}
							</Group>
							<ActionIcon
								variant="subtle"
								color="red"
								size="sm"
								disabled={deleting}
								aria-label={t("linkDelete")}
								onClick={() => onDelete(l.id)}
							>
								<IconTrash size={14} />
							</ActionIcon>
						</Group>
					</Paper>
				);
			})}
		</Stack>
	);
}
