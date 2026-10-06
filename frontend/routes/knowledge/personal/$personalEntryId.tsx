/**
 * Standalone personal-entry detail page.
 *
 * A standalone personal entry (knowledge_drafts.entryId === null) has no global entry, so
 * it has no /knowledge/$entryId page to live on — this route is its home. It closes the
 * loop for entries the agent creates via KnowledgeCreate: edit the body, set a target
 * collection, publish for review, or delete.
 *
 * Linked personal entries (entryId set) are edited on their global entry's Draft tab, so
 * this page redirects them there instead of duplicating that UI.
 */
import {
	Alert,
	Badge,
	Button,
	Card,
	Container,
	Divider,
	Grid,
	Group,
	Modal,
	Paper,
	Select,
	Stack,
	TagsInput,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconArrowLeft,
	IconBook2,
	IconFolder,
	IconSend,
	IconTrash,
} from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SubmissionAuthorActions } from "../../../components/knowledge/SubmissionAuthorActions";
import { useCurrentUser } from "../../../hooks/useAuth";
import {
	useDeletePersonalEntry,
	useKnowledgeCollections,
	usePersonalEntry,
	usePersonalEntrySubmissions,
	usePublishPersonalEntry,
	useUpdatePersonalEntryContent,
	useUpdatePersonalEntryMeta,
} from "../../../hooks/useKnowledge";
import type { KnowledgePersonalEntry, KnowledgeSubmission } from "../../../lib/api";
import { formatLocaleDateTime } from "../../../lib/intl-format";

export const Route = createFileRoute("/knowledge/personal/$personalEntryId")({
	component: PersonalEntryPage,
});

function PersonalEntryPage() {
	const { personalEntryId } = Route.useParams();
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const entry = usePersonalEntry(personalEntryId);

	// A linked personal entry belongs on its global entry's Draft tab.
	const linkedEntryId = entry.data?.entryId ?? null;
	useEffect(() => {
		if (linkedEntryId) {
			navigate({ to: "/knowledge/$entryId", params: { entryId: linkedEntryId }, replace: true });
		}
	}, [linkedEntryId, navigate]);

	if (entry.isLoading) {
		return (
			<Container size="lg" py="lg">
				<Text size="sm" c="dimmed">
					{t("loading")}
				</Text>
			</Container>
		);
	}

	if (entry.isError || !entry.data) {
		return (
			<Container size="lg" py="lg">
				<Stack gap="md" align="flex-start">
					<Alert
						color="red"
						title={t("personalEntryNotFound")}
						icon={<IconAlertTriangle size={16} />}
					>
						{t("personalEntryNotFoundDesc")}
					</Alert>
					<Button
						variant="subtle"
						size="compact-sm"
						leftSection={<IconArrowLeft size={14} />}
						onClick={() => navigate({ to: "/knowledge" })}
					>
						{t("backToList")}
					</Button>
				</Stack>
			</Container>
		);
	}

	return <StandaloneDetail entry={entry.data} />;
}

function StandaloneDetail({ entry }: { entry: KnowledgePersonalEntry }) {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const { data: user } = useCurrentUser();
	const collections = useKnowledgeCollections();
	const submissions = usePersonalEntrySubmissions(entry.id);
	const saveContent = useUpdatePersonalEntryContent();
	const saveMeta = useUpdatePersonalEntryMeta();
	const publish = usePublishPersonalEntry();
	const remove = useDeletePersonalEntry();

	// Body editor: local until saved. `dirty` stops server refetches from clobbering edits.
	const [content, setContent] = useState(entry.content);
	const [dirty, setDirty] = useState(false);
	useEffect(() => {
		if (!dirty) setContent(entry.content);
	}, [entry.content, dirty]);

	// Metadata editor (title / target collection / keywords).
	const [title, setTitle] = useState(entry.title ?? "");
	const [target, setTarget] = useState<string | null>(entry.targetCollectionId);
	const [keywords, setKeywords] = useState<string[]>(entry.keywordsJson ?? []);
	const [metaDirty, setMetaDirty] = useState(false);
	useEffect(() => {
		if (metaDirty) return;
		setTitle(entry.title ?? "");
		setTarget(entry.targetCollectionId);
		setKeywords(entry.keywordsJson ?? []);
	}, [entry.title, entry.targetCollectionId, entry.keywordsJson, metaDirty]);

	const [changeNote, setChangeNote] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);

	const collectionOptions = useMemo(
		() => (collections.data ?? []).map((c) => ({ value: c.id, label: c.name })),
		[collections.data],
	);
	const targetName = useMemo(
		() => (collections.data ?? []).find((c) => c.id === entry.targetCollectionId)?.name ?? null,
		[collections.data, entry.targetCollectionId],
	);

	const isArchived = entry.status === "archived";
	const rows = submissions.data ?? [];
	// Only one publish request may be open at a time (enforced server-side in submitForReview).
	const openSubmission = rows.find((s) => s.status === "pending" || s.status === "conflict");

	// Publish preconditions mirror the backend guards in submitForReview.
	const missingTarget = !entry.targetCollectionId;
	const missingTitle = !entry.title?.trim();
	const publishBlockedReason = isArchived
		? t("personalEntryArchivedHint")
		: missingTarget
			? t("publishNeedsTarget")
			: missingTitle
				? t("publishNeedsTitle")
				: openSubmission
					? t("publishAlreadyOpen")
					: null;

	const onSaveContent = () =>
		saveContent.mutate({ id: entry.id, content }, { onSuccess: () => setDirty(false) });

	const onSaveMeta = () =>
		saveMeta.mutate(
			{
				id: entry.id,
				title: title.trim() || undefined,
				targetCollectionId: target,
				keywords,
			},
			{ onSuccess: () => setMetaDirty(false) },
		);

	const onPublish = async () => {
		// Persist unsaved body edits first so the publish request carries the latest content.
		if (dirty) {
			await saveContent.mutateAsync({ id: entry.id, content });
			setDirty(false);
		}
		publish.mutate(
			{ id: entry.id, changeNote: changeNote.trim() || undefined },
			{ onSuccess: () => setChangeNote("") },
		);
	};

	const onDelete = () =>
		remove.mutate(entry.id, {
			onSuccess: () => {
				setConfirmDelete(false);
				navigate({ to: "/knowledge" });
			},
		});

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

			<Group justify="space-between" align="flex-start" mb="md" wrap="nowrap">
				<div style={{ minWidth: 0 }}>
					<Group gap="xs" align="center">
						<IconBook2 size={20} style={{ color: "var(--mantine-color-grape-5)" }} />
						<Title order={3}>{entry.title ?? entry.id.slice(0, 8)}</Title>
					</Group>
					<Group gap="xs" mt={6}>
						<Badge size="sm" variant="light" color="grape">
							{t("personalEntryStandalone")}
						</Badge>
						<Badge size="sm" variant="light" color={isArchived ? "gray" : "green"}>
							{t(`personalEntryStatus_${entry.status}`)}
						</Badge>
						{openSubmission ? (
							<Badge
								size="sm"
								variant="light"
								color={openSubmission.status === "conflict" ? "orange" : "blue"}
							>
								{t(`submissionStatus_${openSubmission.status}`)}
							</Badge>
						) : null}
						<Text size="xs" c="dimmed">
							{targetName ? (
								<Group gap={4} wrap="nowrap">
									<IconFolder size={12} />
									<span>
										{t("publishTarget")}: {targetName}
									</span>
								</Group>
							) : (
								t("noTargetCollection")
							)}
						</Text>
					</Group>
				</div>
				<Button
					variant="subtle"
					color="red"
					size="compact-sm"
					leftSection={<IconTrash size={14} />}
					onClick={() => setConfirmDelete(true)}
				>
					{t("delete")}
				</Button>
			</Group>

			{isArchived ? (
				<Alert
					color="gray"
					mb="md"
					title={t("personalEntryArchived")}
					icon={<IconAlertTriangle size={16} />}
				>
					{t("personalEntryArchivedHint")}
				</Alert>
			) : null}

			<Grid gap="lg">
				{/* Left: body editor + publish + history */}
				<Grid.Col span={{ base: 12, md: 8 }}>
					<Stack gap="md">
						<Paper withBorder p="md" radius="md">
							<Stack gap="sm">
								<Group justify="space-between" align="center">
									<Text size="sm" fw={600}>
										{t("personalEntryContent")}
									</Text>
									<Button
										size="xs"
										variant="light"
										loading={saveContent.isPending}
										disabled={isArchived || !dirty}
										onClick={onSaveContent}
									>
										{t("save")}
									</Button>
								</Group>
								<Textarea
									value={content}
									onChange={(e) => {
										setContent(e.currentTarget.value);
										setDirty(true);
									}}
									placeholder={t("content")}
									autosize
									minRows={10}
									maxRows={28}
									disabled={isArchived}
								/>
								{saveContent.isError ? (
									<Text size="xs" c="red">
										{(saveContent.error as Error).message}
									</Text>
								) : null}
								{openSubmission ? (
									<Text size="xs" c="dimmed">
										{t("editInvalidatesOpenSubmission")}
									</Text>
								) : null}
							</Stack>
						</Paper>

						<Paper withBorder p="md" radius="md">
							<Stack gap="sm">
								<div>
									<Text size="sm" fw={600}>
										{t("publishPersonalEntry")}
									</Text>
									<Text size="xs" c="dimmed">
										{t("publishPersonalEntryDesc")}
									</Text>
								</div>
								<TextInput
									label={t("changeNote")}
									placeholder={t("changeNotePlaceholder")}
									value={changeNote}
									onChange={(e) => setChangeNote(e.currentTarget.value)}
									disabled={isArchived}
								/>
								<Group justify="space-between" align="center">
									<Text size="xs" c={publishBlockedReason ? "orange" : "dimmed"}>
										{publishBlockedReason ?? t("publishReady")}
									</Text>
									<Button
										size="xs"
										leftSection={<IconSend size={14} />}
										loading={publish.isPending || saveContent.isPending}
										disabled={!!publishBlockedReason}
										onClick={onPublish}
									>
										{t("submitForReview")}
									</Button>
								</Group>
								{publish.isError ? (
									<Text size="xs" c="red">
										{(publish.error as Error).message}
									</Text>
								) : null}
							</Stack>
						</Paper>

						<Paper withBorder p="md" radius="md">
							<Stack gap="sm">
								<Text size="sm" fw={600}>
									{t("tabSubmissions")}
								</Text>
								<Divider />
								<SubmissionHistory
									rows={rows}
									loading={submissions.isLoading}
									personalEntryId={entry.id}
									currentUserId={user?.id}
									isAdmin={user?.role === "admin"}
									// Re-submit builds the new request from the SAVED draft, so flush any
									// unsaved body edits first (same rule as publish).
									onBeforeResubmit={async () => {
										if (!dirty) return;
										await saveContent.mutateAsync({ id: entry.id, content });
										setDirty(false);
									}}
								/>
							</Stack>
						</Paper>
					</Stack>
				</Grid.Col>

				{/* Right: metadata */}
				<Grid.Col span={{ base: 12, md: 4 }}>
					<Paper withBorder p="md" radius="md" style={{ position: "sticky", top: 80 }}>
						<Stack gap="sm">
							<Text size="xs" fw={700} c="dimmed" tt="uppercase">
								{t("metaSettings")}
							</Text>
							<Divider />
							<TextInput
								label={t("title_field")}
								value={title}
								onChange={(e) => {
									setTitle(e.currentTarget.value);
									setMetaDirty(true);
								}}
								disabled={isArchived}
								required
							/>
							<Select
								label={t("publishTarget")}
								placeholder={t("noTargetCollection")}
								description={t("publishTargetHint")}
								data={collectionOptions}
								value={target}
								onChange={(v) => {
									setTarget(v);
									setMetaDirty(true);
								}}
								clearable
								disabled={isArchived}
							/>
							<TagsInput
								label={t("keywords")}
								description={t("keywordsHint")}
								placeholder={t("keywordsPlaceholder")}
								value={keywords}
								onChange={(v) => {
									setKeywords(v);
									setMetaDirty(true);
								}}
								clearable
								disabled={isArchived}
							/>
							<Button
								size="xs"
								variant="light"
								loading={saveMeta.isPending}
								disabled={isArchived || !metaDirty || !title.trim()}
								onClick={onSaveMeta}
								fullWidth
							>
								{t("save")}
							</Button>
							{saveMeta.isError ? (
								<Text size="xs" c="red">
									{(saveMeta.error as Error).message}
								</Text>
							) : null}
							<Divider />
							<Text size="xs" c="dimmed">
								{t("personalEntryUpdatedAt", {
									time: formatLocaleDateTime(entry.updatedAt),
								})}
							</Text>
						</Stack>
					</Paper>
				</Grid.Col>
			</Grid>

			<Modal
				opened={confirmDelete}
				onClose={() => setConfirmDelete(false)}
				title={t("deleteConfirmTitle")}
			>
				<Stack>
					<Text size="sm">
						{t("deletePersonalEntryConfirm", {
							name: entry.title ?? entry.id.slice(0, 8),
						})}
					</Text>
					{openSubmission ? (
						<Alert color="orange" icon={<IconAlertTriangle size={16} />}>
							{t("deletePersonalEntryOpenSubmission")}
						</Alert>
					) : null}
					{remove.isError ? (
						<Text size="xs" c="red">
							{(remove.error as Error).message}
						</Text>
					) : null}
					<Group justify="flex-end">
						<Button variant="subtle" onClick={() => setConfirmDelete(false)}>
							{t("cancel")}
						</Button>
						<Button color="red" loading={remove.isPending} onClick={onDelete}>
							{t("delete")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Container>
	);
}

function SubmissionHistory({
	rows,
	loading,
	personalEntryId,
	currentUserId,
	isAdmin,
	onBeforeResubmit,
}: {
	rows: KnowledgeSubmission[];
	loading: boolean;
	personalEntryId: string;
	currentUserId: string | undefined;
	isAdmin: boolean;
	onBeforeResubmit: () => Promise<void>;
}) {
	const { t } = useTranslation("knowledge");

	if (loading) {
		return (
			<Text size="sm" c="dimmed">
				{t("loading")}
			</Text>
		);
	}
	if (rows.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{t("noSubmissions")}
			</Text>
		);
	}

	return (
		<Stack gap="xs">
			{rows.map((s) => (
				<Card key={s.id} withBorder padding="xs" radius="sm">
					<Group justify="space-between" wrap="nowrap" align="center">
						<div style={{ minWidth: 0, flex: 1 }}>
							<Text size="xs" truncate="end">
								{s.changeNote || s.id.slice(0, 8)}
							</Text>
							<Text size="xs" c="dimmed">
								{formatLocaleDateTime(s.createdAt)}
							</Text>
						</div>
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
											: s.status === "approved"
												? "green"
												: s.status === "changes_requested"
													? "yellow"
													: "gray"
								}
							>
								{t(`submissionStatus_${s.status}`)}
							</Badge>
						</Group>
					</Group>
					{(s.findingsJson ?? []).length > 0 ? (
						<Stack gap={2} mt={6}>
							{/* Findings have no id; they're immutable once reviewed, so key on content. */}
							{(s.findingsJson ?? []).map((f) => (
								<Text key={`${s.id}-${f.severity}-${f.message}`} size="xs" c="dimmed">
									[{t(`severity_${f.severity}`)}] {f.message}
								</Text>
							))}
						</Stack>
					) : null}
					{s.status === "superseded" ? (
						<Text size="xs" c="dimmed" mt={4}>
							{t("subFlowSupersededHint")}
						</Text>
					) : null}
					{/* Withdraw an open request / re-submit a bounced one. The component hides
					    itself for statuses and identities where the server would refuse. */}
					<Group mt={6}>
						<SubmissionAuthorActions
							submissionId={s.id}
							status={s.status}
							submitterUserId={s.submitterUserId}
							currentUserId={currentUserId}
							isAdmin={isAdmin}
							personalEntryId={personalEntryId}
							onBeforeResubmit={onBeforeResubmit}
						/>
					</Group>
				</Card>
			))}
		</Stack>
	);
}
