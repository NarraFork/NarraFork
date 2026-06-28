import {
	ActionIcon,
	Anchor,
	Badge,
	Button,
	Card,
	Code,
	Container,
	Group,
	Paper,
	ScrollArea,
	Select,
	Stack,
	Tabs,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EntryAclPanel } from "../../components/knowledge/EntryAclPanel";
import { EntryMetaPanel } from "../../components/knowledge/EntryMetaPanel";
import { SubmissionReviewPanel } from "../../components/knowledge/SubmissionReviewPanel";
import { DiffView } from "../../components/narrator/DiffView";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	useAddKnowledgeRevision,
	useCreateEntryLink,
	useCreateKnowledgeDraft,
	useDeleteEntryLink,
	useEntryLinks,
	useKnowledgeEntries,
	useKnowledgeEntry,
	useKnowledgeRevisions,
	useKnowledgeSubmission,
	useKnowledgeSubmissions,
	useMyKnowledgeDraft,
	useSubmitKnowledgeDraft,
	useUpdateKnowledgeDraft,
} from "../../hooks/useKnowledge";
import type { KnowledgeEntryLink, KnowledgeLinkType } from "../../lib/api";

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
			</Group>

			<Tabs defaultValue="content" keepMounted={false}>
				<Tabs.List mb="md">
					<Tabs.Tab value="content">{t("tabContent")}</Tabs.Tab>
					<Tabs.Tab value="history">{t("tabHistory")}</Tabs.Tab>
					<Tabs.Tab value="draft">{t("tabMyDraft")}</Tabs.Tab>
					<Tabs.Tab value="submissions">{t("tabSubmissions")}</Tabs.Tab>
					<Tabs.Tab value="links">{t("tabLinks")}</Tabs.Tab>
					<Tabs.Tab value="settings">{t("tabSettings")}</Tabs.Tab>
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
				<Tabs.Panel value="settings">
					<Stack gap="xl">
						{canDirectWrite ? (
							<EntryMetaPanel entry={e} />
						) : (
							<Text size="sm" c="dimmed">
								{t("settingsReadOnlyHint")}
							</Text>
						)}
						{isAdmin ? <EntryAclPanel entry={e} /> : null}
					</Stack>
				</Tabs.Panel>
			</Tabs>
		</Container>
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
						<Code block style={{ whiteSpace: "pre-wrap" }}>
							{content}
						</Code>
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

	const revs = revisions.data ?? [];
	const options = useMemo(() => revs.map((r) => ({ value: r.id, label: `v${r.version}` })), [revs]);
	const left = revs.find((r) => r.id === leftId);
	const right = revs.find((r) => r.id === rightId);

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

			{left && right ? (
				<DiffView
					oldStr={left.content}
					newStr={right.content}
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
								<Text size="xs" c="dimmed">
									{new Date(r.createdAt).toLocaleString()}
								</Text>
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
	const createDraft = useCreateKnowledgeDraft();
	const updateDraft = useUpdateKnowledgeDraft();
	const submitDraft = useSubmitKnowledgeDraft();
	const [content, setContent] = useState("");
	const [dirty, setDirty] = useState(false);

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

	const isActive =
		draft.status === "draft" ||
		draft.status === "changes_requested" ||
		draft.status === "pending_review";

	return (
		<Stack>
			<Group justify="space-between">
				<Badge variant="light" color={draft.status === "pending_review" ? "blue" : "gray"}>
					{t(`draftStatus_${draft.status}`)}
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
							submitDraft.mutate({ draftId: draft.id, entryId });
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
					{t("draftVsMain")}
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
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const detail = useKnowledgeSubmission(selectedId ?? undefined);

	const submissions = list.data ?? [];

	return (
		<Group align="flex-start" gap="md" wrap="nowrap">
			<Stack gap="xs" w={260} style={{ flexShrink: 0 }}>
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
										<Badge
											size="xs"
											variant="light"
											color={
												s.status === "conflict"
													? "orange"
													: s.status === "pending"
														? "blue"
														: "gray"
											}
										>
											{t(`submissionStatus_${s.status}`)}
										</Badge>
									</Group>
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
							// review (or everything for admins). A user may never review their
							// OWN submission (the server rejects it), so exclude that case.
							(isAdmin || submissions.some((s) => s.id === detail.data?.id)) &&
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
