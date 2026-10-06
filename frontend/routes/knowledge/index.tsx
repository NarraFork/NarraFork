import {
	ActionIcon,
	Anchor,
	Badge,
	Button,
	Card,
	Container,
	Grid,
	Group,
	Modal,
	NavLink,
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
	ThemeIcon,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconBook2,
	IconFileSymlink,
	IconFileText,
	IconFolder,
	IconFolderOpen,
	IconGitMerge,
	IconGitPullRequest,
	IconLock,
	IconNotebook,
	IconPencil,
	IconPlus,
	IconSearch,
	IconTrash,
	IconUserShare,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AclAdminPanel } from "../../components/knowledge/AclAdminPanel";
import { CollectionAclPanel } from "../../components/knowledge/CollectionAclPanel";
import { SubmissionReviewPanel } from "../../components/knowledge/SubmissionReviewPanel";
import { TransferOwnerModal } from "../../components/knowledge/TransferOwnerModal";
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
	useMyOpenKnowledgeSubmissions,
	useMyPersonalEntries,
	useReviewInboxCount,
	useUpdateKnowledgeCollection,
} from "../../hooks/useKnowledge";
import type {
	KnowledgeCollection,
	KnowledgeOpenSubmission,
	KnowledgeSearchResult,
	KnowledgeSubmission,
} from "../../lib/api";
import { api } from "../../lib/api";
import { formatLocaleDateTime } from "../../lib/intl-format";

export const Route = createFileRoute("/knowledge/")({
	component: KnowledgePage,
});

function KnowledgePage() {
	const { t } = useTranslation("knowledge");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	// Bounded server-side count; `capped` means "at least this many" → render "100+".
	const inbox = useReviewInboxCount();
	const inboxCount = inbox.data?.count ?? 0;
	const inboxLabel = inbox.data?.capped ? `${inboxCount}+` : String(inboxCount);

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
					<Tabs.Tab
						value="review"
						rightSection={
							inboxCount > 0 ? (
								<Tooltip label={t("reviewInboxTooltip", { count: inboxCount })}>
									<Badge size="sm" circle variant="filled" color="indigo">
										{inboxLabel}
									</Badge>
								</Tooltip>
							) : null
						}
					>
						{t("tabReview")}
					</Tabs.Tab>
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

	// Count readable entries per collection
	const countByCollection = useMemo(() => {
		const m = new Map<string, number>();
		for (const e of entries.data ?? []) {
			m.set(e.collectionId, (m.get(e.collectionId) ?? 0) + 1);
		}
		return m;
	}, [entries.data]);

	return (
		<Grid gap="md">
			{/* Left Column: Collection Navigation Sidebar */}
			<Grid.Col span={{ base: 12, sm: 4, md: 3 }}>
				<Paper withBorder p="sm" radius="md">
					<Stack gap="xs">
						<Group justify="space-between" align="center" mb={4}>
							<Text size="xs" fw={700} c="dimmed" tt="uppercase">
								{t("collections")}
							</Text>
							<Tooltip label={t("createCollection")}>
								<ActionIcon size="sm" variant="subtle" onClick={colModalH.open}>
									<IconPlus size={14} />
								</ActionIcon>
							</Tooltip>
						</Group>

						<NavLink
							label={t("allCollections")}
							leftSection={<IconFolderOpen size={16} />}
							active={collectionId === null}
							onClick={() => setCollectionId(null)}
							variant="filled"
							styles={{ label: { fontWeight: 500 } }}
							rightSection={
								<Badge size="xs" variant="light" color="gray">
									{entries.data?.length ?? 0}
								</Badge>
							}
						/>

						<ScrollArea.Autosize mah={400} type="auto">
							<Stack gap={2}>
								{collections.data?.map((c) => (
									<CollectionItem
										key={c.id}
										collection={c}
										active={collectionId === c.id}
										count={countByCollection.get(c.id) ?? 0}
										onSelect={() => setCollectionId(c.id)}
									/>
								))}
							</Stack>
						</ScrollArea.Autosize>
					</Stack>
				</Paper>
			</Grid.Col>

			{/* Right Column: Entry Search and List */}
			<Grid.Col span={{ base: 12, sm: 8, md: 9 }}>
				<Stack gap="md">
					<Paper withBorder p="sm" radius="md">
						<Group justify="space-between" align="center" gap="xs">
							<TextInput
								placeholder={t("searchPlaceholder")}
								value={q}
								onChange={(e) => setQ(e.currentTarget.value)}
								leftSection={<IconSearch size={16} />}
								style={{ flex: 1 }}
							/>
							<Button
								size="sm"
								leftSection={<IconPlus size={14} />}
								onClick={entryModalH.open}
								disabled={(collections.data?.length ?? 0) === 0}
							>
								{t("createEntry")}
							</Button>
						</Group>
					</Paper>

					{entries.isLoading ? (
						<Paper
							withBorder
							p="xl"
							radius="md"
							style={{ display: "flex", justifyContent: "center" }}
						>
							<Text size="sm" c="dimmed">
								{t("loading")}
							</Text>
						</Paper>
					) : (entries.data?.length ?? 0) === 0 ? (
						<Paper withBorder p="xl" radius="md" ta="center">
							<ThemeIcon variant="light" size="xl" radius="xl" color="gray" mb="xs">
								<IconFileText size={24} />
							</ThemeIcon>
							<Text size="sm" fw={600} c="dimmed">
								{t("noEntries")}
							</Text>
						</Paper>
					) : (
						<Stack gap="xs">
							{(entries.data as KnowledgeSearchResult[]).map((e) => (
								<Card
									key={e.id}
									withBorder
									padding="md"
									radius="md"
									style={{
										cursor: "pointer",
										transition: "transform 100ms ease, box-shadow 100ms ease",
									}}
									styles={{
										root: {
											"&:hover": {
												transform: "translateY(-1px)",
												boxShadow: "var(--mantine-shadow-xs)",
											},
										},
									}}
									onClick={() => navigate({ to: "/knowledge/$entryId", params: { entryId: e.id } })}
								>
									<Group justify="space-between" wrap="nowrap" align="flex-start">
										<div style={{ flex: 1, minWidth: 0 }}>
											<Group gap="xs" align="center" mb={4}>
												<IconFileText size={16} style={{ color: "var(--mantine-color-blue-5)" }} />
												<Text size="sm" fw={600} truncate="end">
													{e.title}
												</Text>
											</Group>
											{e.snippet ? (
												<Text size="xs" c="dimmed" lineClamp={2} style={{ wordBreak: "break-all" }}>
													{e.snippet}
												</Text>
											) : null}
										</div>
										<Group gap={4} style={{ flexShrink: 0 }}>
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
				</Stack>
			</Grid.Col>

			<CreateCollectionModal opened={colModal} onClose={colModalH.close} />
			<CreateEntryModal
				opened={entryModal}
				onClose={entryModalH.close}
				collectionId={collectionId}
				collectionOptions={collectionOptions}
			/>
		</Grid>
	);
}

function CollectionItem({
	collection,
	active,
	count,
	onSelect,
}: {
	collection: KnowledgeCollection;
	active: boolean;
	count: number;
	onSelect: () => void;
}) {
	const { t } = useTranslation("knowledge");
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const isOwner = !!user && collection.ownerUserId === user.id;
	const del = useDeleteKnowledgeCollection();
	const [editing, setEditing] = useState<KnowledgeCollection | null>(null);
	const [pendingDelete, setPendingDelete] = useState<KnowledgeCollection | null>(null);
	const [aclOpen, setAclOpen] = useState(false);
	const [transferOpen, setTransferOpen] = useState(false);
	// Owner display + transfer targets need usernames; the endpoint is admin-only, so the
	// query only runs for admins (a non-admin owner transfers by picking from nothing, which
	// the modal handles by showing an empty select — server still enforces the real rule).
	const users = useQuery({
		queryKey: ["admin", "users"],
		queryFn: api.listUsers,
		enabled: isAdmin && (aclOpen || transferOpen),
	});

	return (
		<>
			<NavLink
				label={collection.name}
				leftSection={active ? <IconFolderOpen size={16} /> : <IconFolder size={16} />}
				active={active}
				onClick={onSelect}
				rightSection={
					<Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
						<Badge size="xs" variant="light" color="gray">
							{count}
						</Badge>
						{isAdmin ? (
							<ActionIcon
								size="xs"
								variant="subtle"
								color="gray"
								onClick={() => setAclOpen(true)}
								title={t("collectionAclOpen")}
							>
								<IconLock size={12} />
							</ActionIcon>
						) : null}
						{/* Ownership transfer is admin OR current owner (enforced server-side). */}
						{isAdmin || isOwner ? (
							<ActionIcon
								size="xs"
								variant="subtle"
								color="gray"
								onClick={() => setTransferOpen(true)}
								title={t("transferOwnerOpen")}
							>
								<IconUserShare size={12} />
							</ActionIcon>
						) : null}
						<ActionIcon
							size="xs"
							variant="subtle"
							color="gray"
							onClick={() => setEditing(collection)}
							title={t("edit")}
						>
							<IconPencil size={12} />
						</ActionIcon>
						<ActionIcon
							size="xs"
							variant="subtle"
							color="red"
							onClick={() => setPendingDelete(collection)}
							title={t("delete")}
						>
							<IconTrash size={12} />
						</ActionIcon>
					</Group>
				}
			/>

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
			{isAdmin ? (
				<CollectionAclPanel
					collectionId={aclOpen ? collection.id : null}
					opened={aclOpen}
					onClose={() => setAclOpen(false)}
				/>
			) : null}
			{isAdmin || isOwner ? (
				<TransferOwnerModal
					kind="collection"
					targetId={collection.id}
					targetName={collection.name}
					currentOwnerUserId={collection.ownerUserId}
					users={(users.data ?? []) as { id: string; username: string; role: string }[]}
					opened={transferOpen}
					onClose={() => setTransferOpen(false)}
				/>
			) : null}
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
	// One bounded query badges every card with its publish state (pending / conflict /
	// changes requested), so users see progress without opening the detail page.
	const openSubs = useMyOpenKnowledgeSubmissions();
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
	// draftId → newest in-flight submission status (the list is ordered createdAt DESC).
	const openStatusByDraft = useMemo(() => {
		const m = new Map<string, KnowledgeOpenSubmission["status"]>();
		for (const s of openSubs.data ?? []) {
			if (!m.has(s.draftId)) m.set(s.draftId, s.status);
		}
		return m;
	}, [openSubs.data]);

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
		<Grid gap="lg">
			{/* Left Column: Create New Personal Entry */}
			<Grid.Col span={{ base: 12, md: 5 }}>
				<Paper withBorder p="md" radius="md" bg="var(--mantine-color-body)">
					<Stack gap="sm">
						<div>
							<Text size="sm" fw={600}>
								{t("newPersonalEntry")}
							</Text>
							<Text size="xs" c="dimmed">
								{t("myLibraryDesc")}
							</Text>
						</div>

						<TextInput
							label={t("title_field")}
							placeholder={t("title_field")}
							value={title}
							onChange={(e) => setTitle(e.currentTarget.value)}
							required
						/>

						<Select
							label={t("publishTarget")}
							placeholder={t("noTargetCollection")}
							clearable
							data={collectionOptions}
							value={target}
							onChange={setTarget}
						/>

						<Textarea
							label={t("content")}
							placeholder={t("content")}
							value={content}
							onChange={(e) => setContent(e.currentTarget.value)}
							autosize
							minRows={4}
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

						<Button
							onClick={save}
							disabled={!title.trim()}
							loading={create.isPending}
							fullWidth
							mt="xs"
						>
							{t("save")}
						</Button>
					</Stack>
				</Paper>
			</Grid.Col>

			{/* Right Column: Personal Entry List */}
			<Grid.Col span={{ base: 12, md: 7 }}>
				<Stack gap="md">
					<Text size="sm" fw={600} c="dimmed" tt="uppercase">
						{t("tabMyLibrary")}
					</Text>

					{entries.isLoading ? (
						<Paper
							withBorder
							p="xl"
							radius="md"
							style={{ display: "flex", justifyContent: "center" }}
						>
							<Text size="sm" c="dimmed">
								{t("loading")}
							</Text>
						</Paper>
					) : (entries.data?.length ?? 0) === 0 ? (
						<Paper withBorder p="xl" radius="md" ta="center">
							<ThemeIcon variant="light" size="xl" radius="xl" color="gray" mb="xs">
								<IconNotebook size={24} />
							</ThemeIcon>
							<Text size="sm" fw={600} c="dimmed">
								{t("noPersonalEntries")}
							</Text>
						</Paper>
					) : (
						<Stack gap="xs">
							{(entries.data ?? []).map((p) => {
								// Both kinds are now openable: a linked entry goes to its global entry's
								// Draft tab; a standalone entry (no global counterpart yet) has its own page.
								const openEntry = () =>
									p.entryId
										? navigate({ to: "/knowledge/$entryId", params: { entryId: p.entryId } })
										: navigate({
												to: "/knowledge/personal/$personalEntryId",
												params: { personalEntryId: p.id },
											});
								const openStatus = openStatusByDraft.get(p.id);
								return (
									<Card
										key={p.id}
										withBorder
										padding="md"
										radius="md"
										style={{ cursor: "pointer" }}
										onClick={openEntry}
									>
										<Group justify="space-between" wrap="nowrap" align="center">
											<div style={{ flex: 1, minWidth: 0 }}>
												<Group gap="xs" align="center" mb={4}>
													<IconBook2 size={16} style={{ color: "var(--mantine-color-grape-5)" }} />
													<Text size="sm" fw={600} truncate="end">
														{p.title ?? p.id.slice(0, 8)}
													</Text>
												</Group>
												<Text size="xs" c="dimmed">
													{p.entryId ? (
														<Group gap={4} wrap="nowrap">
															<IconFileSymlink size={12} />
															<span>{t("personalEntryLinked")}</span>
														</Group>
													) : p.targetCollectionId ? (
														<Group gap={4} wrap="nowrap">
															<IconFolder size={12} />
															<span>
																{t("publishTarget")}:{" "}
																{colName.get(p.targetCollectionId) ?? p.targetCollectionId}
															</span>
														</Group>
													) : (
														<span>{t("noTargetCollection")}</span>
													)}
												</Text>
											</div>
											<Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
												{/* Drift used to be visible only inside the entry's Draft tab, so a user
												    had to open every entry to discover which copies had fallen behind.
												    The list endpoint resolves it for the whole page in one query. */}
												{p.drifted ? (
													<Tooltip label={t("driftBadgeTooltip")} withArrow>
														<Badge
															size="xs"
															variant="light"
															color="orange"
															leftSection={<IconGitMerge size={10} />}
														>
															{t("driftBadge")}
														</Badge>
													</Tooltip>
												) : null}
												{openStatus ? (
													<Badge
														size="xs"
														variant="light"
														color={
															openStatus === "conflict"
																? "orange"
																: openStatus === "changes_requested"
																	? "yellow"
																	: "blue"
														}
													>
														{t(`submissionStatus_${openStatus}`)}
													</Badge>
												) : null}
												<Badge size="xs" variant="light" color={p.entryId ? "blue" : "grape"}>
													{p.entryId ? t("personalEntryLinked") : t("personalEntryStandalone")}
												</Badge>
											</Group>
										</Group>
									</Card>
								);
							})}
						</Stack>
					)}
				</Stack>
			</Grid.Col>
		</Grid>
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
		<Stack gap="md">
			<Paper withBorder p="sm" radius="md">
				<Group justify="space-between" align="center" gap="md" wrap="wrap">
					<div>
						<Text size="sm" fw={600}>
							{t("reviewCenter")}
						</Text>
						<Text size="xs" c="dimmed">
							{t("reviewCenterDesc")}
						</Text>
					</div>
					<Group gap="xs" align="center">
						<Text size="xs" c="dimmed">
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
					</Group>
				</Group>
			</Paper>

			{submissions.isLoading ? (
				<Paper withBorder p="xl" radius="md" style={{ display: "flex", justifyContent: "center" }}>
					<Text size="sm" c="dimmed">
						{t("loading")}
					</Text>
				</Paper>
			) : grouped.length === 0 ? (
				<Paper withBorder p="xl" radius="md" ta="center">
					<ThemeIcon variant="light" size="xl" radius="xl" color="gray" mb="xs">
						<IconGitPullRequest size={24} />
					</ThemeIcon>
					<Text size="sm" fw={600} c="dimmed">
						{t("noSubmissions")}
					</Text>
				</Paper>
			) : (
				<Grid gap="md">
					{grouped.map((g) => (
						<Grid.Col key={g.key} span={{ base: 12, md: 6 }}>
							{g.kind === "entry" ? (
								<Paper
									withBorder
									p="md"
									radius="md"
									h="100%"
									style={{ display: "flex", flexDirection: "column" }}
								>
									<Group justify="space-between" mb="xs" wrap="nowrap" align="center">
										<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
											<IconBook2 size={16} style={{ color: "var(--mantine-color-blue-5)" }} />
											<Anchor
												component="button"
												type="button"
												onClick={() => goEntry(g.entryId)}
												style={{ minWidth: 0, textAlign: "left" }}
											>
												<Text size="sm" fw={600} truncate="end">
													{titleById.get(g.entryId) ?? g.entryId.slice(0, 8)}
												</Text>
											</Anchor>
											<Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
												{g.subs.length}
											</Badge>
										</Group>
										<Button
											size="compact-xs"
											variant="light"
											leftSection={<IconSearch size={12} />}
											onClick={() => goEntry(g.entryId)}
											style={{ flexShrink: 0 }}
										>
											{t("reviewCenterViewEntry")}
										</Button>
									</Group>
									<Stack gap="xs" style={{ flex: 1 }}>
										{g.subs.map((s) => (
											<Card
												key={s.id}
												withBorder
												padding="xs"
												radius="sm"
												style={{
													cursor: "pointer",
													transition: "background 100ms ease",
												}}
												styles={{
													root: {
														"&:hover": {
															background: "var(--mantine-color-dark-6)",
														},
													},
												}}
												onClick={() => goEntry(g.entryId)}
											>
												<Group justify="space-between" wrap="nowrap" align="center">
													<div style={{ flex: 1, minWidth: 0 }}>
														<Text size="xs" fw={500} truncate="end">
															{s.changeNote || s.id.slice(0, 8)}
														</Text>
														<Text size="xs" c="dimmed">
															{formatLocaleDateTime(s.createdAt)}
														</Text>
													</div>
													<Badge
														size="xs"
														variant="light"
														color={statusColor(s.status)}
														style={{ flexShrink: 0 }}
													>
														{t(`submissionStatus_${s.status}`)}
													</Badge>
												</Group>
											</Card>
										))}
									</Stack>
								</Paper>
							) : (
								<Paper
									withBorder
									p="md"
									radius="md"
									h="100%"
									style={{ display: "flex", flexDirection: "column" }}
								>
									<Group justify="space-between" mb="xs" wrap="nowrap" align="center">
										<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
											<IconFolder size={16} style={{ color: "var(--mantine-color-teal-5)" }} />
											<Text size="sm" fw={600} truncate="end">
												{g.sub.title || t("reviewCenterUntitledEntry")}
											</Text>
											<Badge size="xs" variant="light" color="teal" style={{ flexShrink: 0 }}>
												{t("reviewCenterNewEntry")}
											</Badge>
										</Group>
										<Button
											size="compact-xs"
											variant="light"
											leftSection={<IconSearch size={12} />}
											onClick={() => setReviewingId(g.sub.id)}
											style={{ flexShrink: 0 }}
										>
											{t("reviewCenterReview")}
										</Button>
									</Group>
									<Card
										withBorder
										padding="xs"
										radius="sm"
										style={{
											cursor: "pointer",
											transition: "background 100ms ease",
											flex: 1,
										}}
										styles={{
											root: {
												"&:hover": {
													background: "var(--mantine-color-dark-6)",
												},
											},
										}}
										onClick={() => setReviewingId(g.sub.id)}
									>
										<Group justify="space-between" wrap="nowrap" align="center">
											<div style={{ flex: 1, minWidth: 0 }}>
												<Text size="xs" fw={500} truncate="end">
													{g.sub.changeNote ||
														(g.sub.collectionId
															? collectionNameById.get(g.sub.collectionId)
															: undefined) ||
														g.sub.id.slice(0, 8)}
												</Text>
												<Text size="xs" c="dimmed">
													{formatLocaleDateTime(g.sub.createdAt)}
												</Text>
											</div>
											<Badge
												size="xs"
												variant="light"
												color={statusColor(g.sub.status)}
												style={{ flexShrink: 0 }}
											>
												{t(`submissionStatus_${g.sub.status}`)}
											</Badge>
										</Group>
									</Card>
								</Paper>
							)}
						</Grid.Col>
					))}
				</Grid>
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
