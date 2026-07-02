import {
	ActionIcon,
	Anchor,
	Badge,
	Button,
	Card,
	Container,
	Group,
	Modal,
	Paper,
	ScrollArea,
	SegmentedControl,
	Select,
	Stack,
	Tabs,
	TagsInput,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AclAdminPanel } from "../../components/knowledge/AclAdminPanel";
import { SubmissionReviewPanel } from "../../components/knowledge/SubmissionReviewPanel";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	useCreateKnowledgeCollection,
	useCreateKnowledgeEntry,
	useCreatePersonalEntry,
	useDeleteKnowledgeCollection,
	useKnowledgeCollections,
	useKnowledgeEntries,
	useKnowledgeSubmission,
	useKnowledgeSubmissions,
	useMyPersonalEntries,
	useUpdateKnowledgeCollection,
} from "../../hooks/useKnowledge";
import type {
	KnowledgeCollection,
	KnowledgePersonalEntry,
	KnowledgeSearchResult,
	KnowledgeSubmission,
} from "../../lib/api";

export const Route = createFileRoute("/knowledge/")({
	component: KnowledgePage,
});

function KnowledgePage() {
	const { t } = useTranslation("knowledge");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";

	return (
		<Container size="lg" py="lg">
			<Stack gap="xs" mb="md">
				<Title order={2}>{t("title")}</Title>
				<Text size="sm" c="dimmed">
					{t("subtitle")}
				</Text>
			</Stack>

			<Tabs defaultValue="browse" keepMounted={false}>
				<Tabs.List mb="md">
					<Tabs.Tab value="browse">{t("tabEntries")}</Tabs.Tab>
					<Tabs.Tab value="mylibrary">{t("tabMyLibrary")}</Tabs.Tab>
					<Tabs.Tab value="review">{t("tabReview")}</Tabs.Tab>
					{isAdmin ? <Tabs.Tab value="admin">{t("tabAdmin")}</Tabs.Tab> : null}
				</Tabs.List>

				<Tabs.Panel value="browse">
					<BrowseTab />
				</Tabs.Panel>
				<Tabs.Panel value="mylibrary">
					<MyLibraryTab />
				</Tabs.Panel>
				<Tabs.Panel value="review">
					<ReviewCenterTab />
				</Tabs.Panel>
				{isAdmin ? (
					<Tabs.Panel value="admin">
						<AclAdminPanel />
					</Tabs.Panel>
				) : null}
			</Tabs>
		</Container>
	);
}

function BrowseTab() {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const collections = useKnowledgeCollections();
	const [collectionId, setCollectionId] = useState<string | null>(null);
	const [q, setQ] = useState("");
	const entries = useKnowledgeEntries({
		collectionId: collectionId ?? undefined,
		q: q.trim() || undefined,
	});

	const [colModal, colModalH] = useDisclosure(false);
	const [entryModal, entryModalH] = useDisclosure(false);

	const collectionOptions = useMemo(
		() => (collections.data ?? []).map((c) => ({ value: c.id, label: c.name })),
		[collections.data],
	);

	return (
		<Stack>
			<Group justify="space-between" align="flex-end">
				<Group gap="xs" align="flex-end">
					<Select
						label={t("collections")}
						placeholder={t("allCollections")}
						clearable
						data={collectionOptions}
						value={collectionId}
						onChange={setCollectionId}
						w={220}
					/>
					<TextInput
						label={t("searchPlaceholder")}
						placeholder={t("searchPlaceholder")}
						value={q}
						onChange={(e) => setQ(e.currentTarget.value)}
						w={260}
					/>
				</Group>
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						onClick={colModalH.open}
					>
						{t("createCollection")}
					</Button>
					<Button
						size="xs"
						leftSection={<IconPlus size={14} />}
						onClick={entryModalH.open}
						disabled={(collections.data?.length ?? 0) === 0}
					>
						{t("createEntry")}
					</Button>
				</Group>
			</Group>

			<CollectionStrip />

			{entries.isLoading ? (
				<Text size="sm" c="dimmed">
					{t("loading")}
				</Text>
			) : (entries.data?.length ?? 0) === 0 ? (
				<Text size="sm" c="dimmed">
					{t("noEntries")}
				</Text>
			) : (
				<Stack gap="xs">
					{(entries.data as KnowledgeSearchResult[]).map((e) => (
						<Card
							key={e.id}
							withBorder
							padding="sm"
							style={{ cursor: "pointer" }}
							onClick={() => navigate({ to: "/knowledge/$entryId", params: { entryId: e.id } })}
						>
							<Group justify="space-between" wrap="nowrap">
								<div style={{ flex: 1, minWidth: 0 }}>
									<Text size="sm" fw={600} truncate="end">
										{e.title}
									</Text>
									{e.snippet ? (
										<Text size="xs" c="dimmed" truncate="end">
											{e.snippet}
										</Text>
									) : null}
								</div>
								<Group gap={4}>
									{(e.tags ?? []).slice(0, 4).map((tag) => (
										<Badge key={tag} size="xs" variant="light">
											{tag}
										</Badge>
									))}
								</Group>
							</Group>
						</Card>
					))}
				</Stack>
			)}

			<CreateCollectionModal opened={colModal} onClose={colModalH.close} />
			<CreateEntryModal
				opened={entryModal}
				onClose={entryModalH.close}
				collectionId={collectionId}
				collectionOptions={collectionOptions}
			/>
		</Stack>
	);
}

function CollectionStrip() {
	const { t } = useTranslation("knowledge");
	const collections = useKnowledgeCollections();
	const entries = useKnowledgeEntries({});
	const del = useDeleteKnowledgeCollection();
	const [editing, setEditing] = useState<KnowledgeCollection | null>(null);
	const [pendingDelete, setPendingDelete] = useState<KnowledgeCollection | null>(null);

	// Count readable entries per collection (list view omits content, stays light).
	const countByCollection = useMemo(() => {
		const m = new Map<string, number>();
		for (const e of entries.data ?? []) {
			m.set(e.collectionId, (m.get(e.collectionId) ?? 0) + 1);
		}
		return m;
	}, [entries.data]);

	if ((collections.data?.length ?? 0) === 0) return null;

	return (
		<>
			<ScrollArea type="auto">
				<Group gap="xs" wrap="nowrap" py={4}>
					{collections.data?.map((c) => (
						<Paper key={c.id} withBorder px="xs" py={4}>
							<Group gap={6} wrap="nowrap">
								<Text size="xs">{c.name}</Text>
								<Badge size="xs" variant="light" color="gray">
									{t("collectionEntryCount", { count: countByCollection.get(c.id) ?? 0 })}
								</Badge>
								<ActionIcon
									size="xs"
									variant="subtle"
									onClick={() => setEditing(c)}
									title={t("edit")}
								>
									<IconPencil size={12} />
								</ActionIcon>
								<ActionIcon
									size="xs"
									variant="subtle"
									color="red"
									onClick={() => setPendingDelete(c)}
									title={t("delete")}
								>
									<IconTrash size={12} />
								</ActionIcon>
							</Group>
						</Paper>
					))}
				</Group>
			</ScrollArea>

			<EditCollectionModal collection={editing} onClose={() => setEditing(null)} />
			<DeleteCollectionConfirm
				collection={pendingDelete}
				loading={del.isPending}
				onClose={() => setPendingDelete(null)}
				onConfirm={() => {
					if (pendingDelete) {
						del.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
					}
				}}
			/>
		</>
	);
}

function CreateCollectionModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
	const { t } = useTranslation("knowledge");
	const create = useCreateKnowledgeCollection();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const save = () => {
		if (!name.trim()) return;
		create.mutate(
			{ name: name.trim(), description: description.trim() || undefined },
			{
				onSuccess: () => {
					setName("");
					setDescription("");
					onClose();
				},
			},
		);
	};
	return (
		<Modal opened={opened} onClose={onClose} title={t("createCollection")}>
			<Stack>
				<TextInput
					label={t("name")}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
				/>
				<Textarea
					label={t("description")}
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
					autosize
					minRows={2}
				/>
				<Group justify="flex-end">
					<Button variant="subtle" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button onClick={save} disabled={!name.trim()} loading={create.isPending}>
						{t("save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function EditCollectionModal({
	collection,
	onClose,
}: {
	collection: KnowledgeCollection | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("knowledge");
	const update = useUpdateKnowledgeCollection();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");

	useEffect(() => {
		if (collection) {
			setName(collection.name);
			setDescription(collection.description ?? "");
		}
	}, [collection]);

	const save = () => {
		if (!collection || !name.trim()) return;
		update.mutate(
			{ id: collection.id, name: name.trim(), description: description.trim() || null },
			{ onSuccess: onClose },
		);
	};

	return (
		<Modal opened={!!collection} onClose={onClose} title={t("editCollection")}>
			<Stack>
				<TextInput
					label={t("name")}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
				/>
				<Textarea
					label={t("description")}
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
					autosize
					minRows={2}
				/>
				<Group justify="flex-end">
					<Button variant="subtle" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button onClick={save} disabled={!name.trim()} loading={update.isPending}>
						{t("save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function DeleteCollectionConfirm({
	collection,
	loading,
	onClose,
	onConfirm,
}: {
	collection: KnowledgeCollection | null;
	loading: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	const { t } = useTranslation("knowledge");
	return (
		<Modal opened={!!collection} onClose={onClose} title={t("deleteConfirmTitle")}>
			<Stack>
				<Text size="sm">{t("deleteCollectionConfirm", { name: collection?.name ?? "" })}</Text>
				<Group justify="flex-end">
					<Button variant="subtle" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button color="red" onClick={onConfirm} loading={loading}>
						{t("delete")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function CreateEntryModal({
	opened,
	onClose,
	collectionId,
	collectionOptions,
}: {
	opened: boolean;
	onClose: () => void;
	collectionId: string | null;
	collectionOptions: { value: string; label: string }[];
}) {
	const { t } = useTranslation("knowledge");
	const create = useCreateKnowledgeEntry();
	const navigate = useNavigate();
	const [target, setTarget] = useState<string | null>(collectionId);
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [tags, setTags] = useState("");

	const effectiveTarget = target ?? collectionId ?? collectionOptions[0]?.value ?? null;

	const save = () => {
		if (!effectiveTarget || !title.trim()) return;
		create.mutate(
			{
				collectionId: effectiveTarget,
				title: title.trim(),
				content,
				tags: tags
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			},
			{
				onSuccess: (entry) => {
					setTitle("");
					setContent("");
					setTags("");
					onClose();
					navigate({ to: "/knowledge/$entryId", params: { entryId: entry.id } });
				},
			},
		);
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("createEntry")} size="lg">
			<Stack>
				<Select
					label={t("collections")}
					data={collectionOptions}
					value={effectiveTarget}
					onChange={setTarget}
				/>
				<TextInput
					label={t("title_field")}
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
				/>
				<TextInput
					label={t("tags")}
					placeholder={t("tagsPlaceholder")}
					value={tags}
					onChange={(e) => setTags(e.currentTarget.value)}
				/>
				<Textarea
					label={t("content")}
					value={content}
					onChange={(e) => setContent(e.currentTarget.value)}
					autosize
					minRows={6}
					maxRows={18}
				/>
				<Group justify="flex-end">
					<Button variant="subtle" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button
						onClick={save}
						disabled={!effectiveTarget || !title.trim()}
						loading={create.isPending}
					>
						{t("save")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

type ReviewFilter = "all" | "pending" | "conflict";

function MyLibraryTab() {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const entries = useMyPersonalEntries({ status: "active" });
	const collections = useKnowledgeCollections();
	const create = useCreatePersonalEntry();
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [target, setTarget] = useState<string | null>(null);
	const [keywords, setKeywords] = useState<string[]>([]);

	const collectionOptions = useMemo(
		() => (collections.data ?? []).map((c) => ({ value: c.id, label: c.name })),
		[collections.data],
	);
	const colName = useMemo(() => {
		const m = new Map<string, string>();
		for (const c of collections.data ?? []) m.set(c.id, c.name);
		return m;
	}, [collections.data]);

	const save = () => {
		if (!title.trim()) return;
		create.mutate(
			{
				title: title.trim(),
				content: content || undefined,
				targetCollectionId: target ?? undefined,
				keywords: keywords.length > 0 ? keywords : undefined,
			},
			{
				onSuccess: () => {
					setTitle("");
					setContent("");
					setTarget(null);
					setKeywords([]);
				},
			},
		);
	};

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("myLibraryDesc")}
			</Text>

			<Paper withBorder p="sm">
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{t("newPersonalEntry")}
					</Text>
					<Group align="flex-end" gap="xs">
						<TextInput
							label={t("title_field")}
							value={title}
							onChange={(e) => setTitle(e.currentTarget.value)}
							w={260}
						/>
						<Select
							label={t("publishTarget")}
							placeholder={t("noTargetCollection")}
							clearable
							data={collectionOptions}
							value={target}
							onChange={setTarget}
							w={220}
						/>
						<Button onClick={save} disabled={!title.trim()} loading={create.isPending}>
							{t("save")}
						</Button>
					</Group>
					<Textarea
						label={t("content")}
						value={content}
						onChange={(e) => setContent(e.currentTarget.value)}
						autosize
						minRows={3}
						maxRows={12}
					/>
					<TagsInput
						label={t("keywords")}
						description={t("keywordsHint")}
						placeholder={t("keywordsPlaceholder")}
						value={keywords}
						onChange={setKeywords}
						clearable
					/>
				</Stack>
			</Paper>

			{entries.isLoading ? (
				<Text size="sm" c="dimmed">
					{t("loading")}
				</Text>
			) : (entries.data?.length ?? 0) === 0 ? (
				<Text size="sm" c="dimmed">
					{t("noPersonalEntries")}
				</Text>
			) : (
				<Stack gap="xs">
					{(entries.data as KnowledgePersonalEntry[]).map((p) => (
						<Card
							key={p.id}
							withBorder
							padding="sm"
							style={{ cursor: p.entryId ? "pointer" : "default" }}
							onClick={() =>
								p.entryId
									? navigate({ to: "/knowledge/$entryId", params: { entryId: p.entryId } })
									: undefined
							}
						>
							<Group justify="space-between" wrap="nowrap">
								<div style={{ flex: 1, minWidth: 0 }}>
									<Text size="sm" fw={600} truncate="end">
										{p.title ?? p.id.slice(0, 8)}
									</Text>
									<Text size="xs" c="dimmed" truncate="end">
										{p.entryId
											? t("personalEntryLinked")
											: p.targetCollectionId
												? `${t("publishTarget")}: ${colName.get(p.targetCollectionId) ?? p.targetCollectionId}`
												: t("noTargetCollection")}
									</Text>
								</div>
								<Badge size="xs" variant="light" color={p.entryId ? "blue" : "grape"}>
									{p.entryId ? t("personalEntryLinked") : t("personalEntryStandalone")}
								</Badge>
							</Group>
						</Card>
					))}
				</Stack>
			)}
		</Stack>
	);
}

/**
 * A review-center group is either a set of submissions targeting one existing global
 * entry (linked) or a single new-entry proposal targeting a collection (standalone,
 * entryId === null). Standalone proposals have no entry page yet, so they are reviewed
 * inline via a modal instead of navigating away.
 */
type ReviewGroup =
	| { kind: "entry"; key: string; entryId: string; subs: KnowledgeSubmission[] }
	| { kind: "standalone"; key: string; sub: KnowledgeSubmission };

function ReviewCenterTab() {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const [status, setStatus] = useState<ReviewFilter>("all");
	const submissions = useKnowledgeSubmissions({ status: status === "all" ? undefined : status });
	const entries = useKnowledgeEntries({});
	const collections = useKnowledgeCollections();
	// Standalone submission opened for inline review (no entry page exists yet).
	const [reviewingId, setReviewingId] = useState<string | null>(null);

	// Map entryId → title for readable entries (falls back to id prefix when not visible).
	const titleById = useMemo(() => {
		const m = new Map<string, string>();
		for (const e of entries.data ?? []) m.set(e.id, e.title);
		return m;
	}, [entries.data]);
	const collectionNameById = useMemo(() => {
		const m = new Map<string, string>();
		for (const c of collections.data ?? []) m.set(c.id, c.name);
		return m;
	}, [collections.data]);

	// Group linked submissions by entry so reviewers see a per-entry to-do list; each
	// standalone submission (entryId null) becomes its own group.
	const grouped = useMemo<ReviewGroup[]>(() => {
		const linked = new Map<string, KnowledgeSubmission[]>();
		const groups: ReviewGroup[] = [];
		for (const s of submissions.data ?? []) {
			if (s.entryId) {
				const arr = linked.get(s.entryId);
				if (arr) arr.push(s);
				else {
					const list = [s];
					linked.set(s.entryId, list);
					groups.push({ kind: "entry", key: `entry:${s.entryId}`, entryId: s.entryId, subs: list });
				}
			} else {
				groups.push({ kind: "standalone", key: `sub:${s.id}`, sub: s });
			}
		}
		return groups;
	}, [submissions.data]);

	const goEntry = (entryId: string) =>
		navigate({ to: "/knowledge/$entryId", params: { entryId }, hash: "submissions" });

	const statusColor = (s: KnowledgeSubmission["status"]) =>
		s === "conflict" ? "orange" : s === "pending" ? "blue" : "gray";

	return (
		<Stack>
			<Group justify="space-between" align="flex-end" wrap="nowrap">
				<Text size="sm" c="dimmed">
					{t("reviewCenterDesc")}
				</Text>
				<div>
					<Text size="xs" c="dimmed" mb={4}>
						{t("reviewCenterFilterLabel")}
					</Text>
					<SegmentedControl
						size="xs"
						value={status}
						onChange={(v) => setStatus(v as ReviewFilter)}
						data={[
							{ value: "all", label: t("reviewCenterAll") },
							{ value: "pending", label: t("submissionStatus_pending") },
							{ value: "conflict", label: t("submissionStatus_conflict") },
						]}
					/>
				</div>
			</Group>

			{submissions.isLoading ? (
				<Text size="sm" c="dimmed">
					{t("loading")}
				</Text>
			) : grouped.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("noSubmissions")}
				</Text>
			) : (
				<Stack gap="md">
					{grouped.map((g) =>
						g.kind === "entry" ? (
							<Paper key={g.key} withBorder p="sm">
								<Group justify="space-between" mb="xs" wrap="nowrap">
									<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
										<Anchor
											component="button"
											type="button"
											onClick={() => goEntry(g.entryId)}
											style={{ minWidth: 0 }}
										>
											<Text size="sm" fw={600} truncate="end">
												{titleById.get(g.entryId) ?? g.entryId.slice(0, 8)}
											</Text>
										</Anchor>
										<Badge size="xs" variant="light" color="gray">
											{g.subs.length}
										</Badge>
									</Group>
									<Button size="compact-xs" variant="subtle" onClick={() => goEntry(g.entryId)}>
										{t("reviewCenterViewEntry")}
									</Button>
								</Group>
								<Stack gap="xs">
									{g.subs.map((s) => (
										<Card
											key={s.id}
											withBorder
											padding="xs"
											style={{ cursor: "pointer" }}
											onClick={() => goEntry(g.entryId)}
										>
											<Group justify="space-between" wrap="nowrap">
												<div style={{ flex: 1, minWidth: 0 }}>
													<Text size="xs" truncate="end">
														{s.changeNote || s.id.slice(0, 8)}
													</Text>
													<Text size="xs" c="dimmed">
														{new Date(s.createdAt).toLocaleString()}
													</Text>
												</div>
												<Badge size="sm" variant="light" color={statusColor(s.status)}>
													{t(`submissionStatus_${s.status}`)}
												</Badge>
											</Group>
										</Card>
									))}
								</Stack>
							</Paper>
						) : (
							<Paper key={g.key} withBorder p="sm">
								<Group justify="space-between" mb="xs" wrap="nowrap">
									<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
										<Text size="sm" fw={600} truncate="end">
											{g.sub.title || t("reviewCenterUntitledEntry")}
										</Text>
										<Badge size="xs" variant="light" color="teal">
											{t("reviewCenterNewEntry")}
										</Badge>
									</Group>
									<Button
										size="compact-xs"
										variant="subtle"
										onClick={() => setReviewingId(g.sub.id)}
									>
										{t("reviewCenterReview")}
									</Button>
								</Group>
								<Card
									withBorder
									padding="xs"
									style={{ cursor: "pointer" }}
									onClick={() => setReviewingId(g.sub.id)}
								>
									<Group justify="space-between" wrap="nowrap">
										<div style={{ flex: 1, minWidth: 0 }}>
											<Text size="xs" truncate="end">
												{g.sub.changeNote ||
													(g.sub.collectionId
														? collectionNameById.get(g.sub.collectionId)
														: undefined) ||
													g.sub.id.slice(0, 8)}
											</Text>
											<Text size="xs" c="dimmed">
												{new Date(g.sub.createdAt).toLocaleString()}
											</Text>
										</div>
										<Badge size="sm" variant="light" color={statusColor(g.sub.status)}>
											{t(`submissionStatus_${g.sub.status}`)}
										</Badge>
									</Group>
								</Card>
							</Paper>
						),
					)}
				</Stack>
			)}

			<StandaloneReviewModal
				submissionId={reviewingId}
				isAdmin={isAdmin}
				currentUserId={user?.id}
				onClose={() => setReviewingId(null)}
			/>
		</Stack>
	);
}

/** Inline reviewer for a standalone (new-entry) submission, which has no entry page. */
function StandaloneReviewModal({
	submissionId,
	isAdmin,
	currentUserId,
	onClose,
}: {
	submissionId: string | null;
	isAdmin: boolean;
	currentUserId?: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("knowledge");
	const detail = useKnowledgeSubmission(submissionId ?? undefined);
	const sub = detail.data;
	// A new entry has no existing main content, so the diff's "old" side is empty.
	const canReview = !!sub && sub.submitterUserId !== currentUserId;

	return (
		<Modal
			opened={!!submissionId}
			onClose={onClose}
			size="xl"
			title={sub?.title || t("reviewCenterUntitledEntry")}
		>
			{detail.isLoading ? (
				<Text size="sm" c="dimmed">
					{t("loading")}
				</Text>
			) : sub ? (
				<SubmissionReviewPanel
					submission={sub}
					currentContent=""
					canReview={isAdmin || canReview}
					onDone={onClose}
				/>
			) : (
				<Text size="sm" c="dimmed">
					{t("selectSubmissionHint")}
				</Text>
			)}
		</Modal>
	);
}
