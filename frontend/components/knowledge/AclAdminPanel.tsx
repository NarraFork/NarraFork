import {
	Accordion,
	ActionIcon,
	Badge,
	Box,
	Button,
	Checkbox,
	Group,
	Loader,
	Modal,
	MultiSelect,
	NumberInput,
	Paper,
	Progress,
	Select,
	Stack,
	Table,
	Tabs,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconPencil, IconPlus, IconSettings, IconTrash, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateKnowledgeLevel,
	useCreateKnowledgeTag,
	useCreateKnowledgeTagType,
	useDeleteKnowledgeLevel,
	useDeleteKnowledgeTag,
	useDeleteKnowledgeTagType,
	useKnowledgeGrants,
	useKnowledgeLevels,
	useKnowledgeTags,
	useKnowledgeTagTypes,
	useSetUserAcl,
	useUpdateKnowledgeLevel,
	useUpdateKnowledgeTag,
	useUserAcl,
} from "../../hooks/useKnowledge";
import { api } from "../../lib/api";

/**
 * Redesigned ACL admin panel with three logical sub-tabs:
 *   1. Levels — classification hierarchy visualization + CRUD
 *   2. Tags — grouped by tag type, controlled vs. regular
 *   3. Users — user-centric permission management with effect preview
 */
export function AclAdminPanel() {
	const { t } = useTranslation("knowledge");

	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				{t("accessControlDesc")}
			</Text>

			<Tabs defaultValue="levels" keepMounted={false}>
				<Tabs.List mb="md">
					<Tabs.Tab value="levels">{t("aclTabLevels")}</Tabs.Tab>
					<Tabs.Tab value="tags">{t("aclTabTags")}</Tabs.Tab>
					<Tabs.Tab value="users">{t("aclTabUsers")}</Tabs.Tab>
				</Tabs.List>

				<Tabs.Panel value="levels">
					<LevelsTab />
				</Tabs.Panel>
				<Tabs.Panel value="tags">
					<TagsTab />
				</Tabs.Panel>
				<Tabs.Panel value="users">
					<UsersTab />
				</Tabs.Panel>
			</Tabs>
		</Stack>
	);
}

// ─── Tab 1: Levels ───────────────────────────────────────────────────────────

function LevelsTab() {
	const { t } = useTranslation("knowledge");
	const levels = useKnowledgeLevels();
	const createLevel = useCreateKnowledgeLevel();
	const deleteLevel = useDeleteKnowledgeLevel();
	const updateLevel = useUpdateKnowledgeLevel();
	const grants = useKnowledgeGrants();

	const [form, setForm] = useState({ name: "", rank: 0, label: "" });
	const [editing, setEditing] = useState<string | null>(null);
	const [editForm, setEditForm] = useState({ name: "", rank: 0, label: "" });

	// Count users at each clearance level
	const userCountByLevel = useMemo(() => {
		const m = new Map<string, number>();
		for (const g of grants.data ?? []) {
			if (g.grantType === "clearance" && g.clearanceLevel) {
				m.set(g.clearanceLevel, (m.get(g.clearanceLevel) ?? 0) + 1);
			}
		}
		return m;
	}, [grants.data]);

	const maxRank = Math.max(...(levels.data ?? []).map((l) => l.rank), 1);

	const startEdit = (l: { id: string; name: string; rank: number; label: string | null }) => {
		setEditing(l.id);
		setEditForm({ name: l.name, rank: l.rank, label: l.label ?? "" });
	};

	const saveEdit = (id: string) => {
		updateLevel.mutate(
			{
				id,
				name: editForm.name.trim() || undefined,
				rank: editForm.rank,
				label: editForm.label.trim() || null,
			},
			{ onSuccess: () => setEditing(null) },
		);
	};

	return (
		<Stack gap="md">
			<Text size="xs" c="dimmed">
				{t("levelsDesc")}
			</Text>

			{levels.isLoading ? (
				<Loader size="sm" />
			) : (levels.data?.length ?? 0) === 0 ? (
				<Text size="sm" c="dimmed">
					{t("noLevels")}
				</Text>
			) : (
				<Stack gap="xs">
					{levels.data?.map((l) =>
						editing === l.id ? (
							<Paper key={l.id} withBorder p="sm">
								<Group gap="xs" align="flex-end">
									<TextInput
										size="xs"
										label={t("levelName")}
										value={editForm.name}
										onChange={(e) => {
											const v = e.currentTarget.value;
											setEditForm((f) => ({ ...f, name: v }));
										}}
										style={{ flex: 1 }}
									/>
									<NumberInput
										size="xs"
										w={80}
										label={t("levelRank")}
										value={editForm.rank}
										onChange={(v) =>
											setEditForm((f) => ({
												...f,
												rank: typeof v === "number" ? v : 0,
											}))
										}
									/>
									<TextInput
										size="xs"
										label={t("levelLabel")}
										value={editForm.label}
										onChange={(e) => {
											const v = e.currentTarget.value;
											setEditForm((f) => ({ ...f, label: v }));
										}}
										style={{ flex: 1 }}
									/>
									<Button size="xs" onClick={() => saveEdit(l.id)} loading={updateLevel.isPending}>
										{t("save")}
									</Button>
									<Button size="xs" variant="default" onClick={() => setEditing(null)}>
										{t("cancel")}
									</Button>
								</Group>
							</Paper>
						) : (
							<Paper key={l.id} withBorder p="sm">
								<Group justify="space-between" wrap="nowrap">
									<Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
										<Badge size="lg" variant="filled" color={levelColor(l.rank, maxRank)} w={44}>
											{l.rank}
										</Badge>
										<div style={{ flex: 1, minWidth: 0 }}>
											<Group gap={6}>
												<Text size="sm" fw={600}>
													{l.name}
												</Text>
												{l.label ? (
													<Text size="xs" c="dimmed">
														({l.label})
													</Text>
												) : null}
											</Group>
											<Progress
												size="xs"
												value={(l.rank / maxRank) * 100}
												color={levelColor(l.rank, maxRank)}
												mt={4}
											/>
										</div>
									</Group>
									<Group gap="xs" wrap="nowrap">
										<Tooltip
											label={t("levelUserCount", {
												count: userCountByLevel.get(l.name) ?? 0,
											})}
										>
											<Badge size="sm" variant="light" color="gray">
												{userCountByLevel.get(l.name) ?? 0} {t("levelUsers")}
											</Badge>
										</Tooltip>
										<ActionIcon variant="subtle" size="sm" onClick={() => startEdit(l)}>
											<IconPencil size={14} />
										</ActionIcon>
										{l.name === "public" ? null : (
											<ActionIcon
												variant="subtle"
												color="red"
												size="sm"
												onClick={() => deleteLevel.mutate(l.id)}
											>
												<IconTrash size={14} />
											</ActionIcon>
										)}
									</Group>
								</Group>
							</Paper>
						),
					)}
				</Stack>
			)}

			<Paper withBorder p="sm" bg="var(--mantine-color-body)">
				<Group gap="xs" align="flex-end">
					<TextInput
						size="xs"
						label={t("levelName")}
						placeholder="e.g. confidential"
						value={form.name}
						onChange={(e) => {
							const v = e.currentTarget.value;
							setForm((f) => ({ ...f, name: v }));
						}}
						style={{ flex: 1 }}
					/>
					<NumberInput
						size="xs"
						w={80}
						label={t("levelRank")}
						value={form.rank}
						onChange={(v) => setForm((f) => ({ ...f, rank: typeof v === "number" ? v : 0 }))}
					/>
					<TextInput
						size="xs"
						label={t("levelLabel")}
						placeholder={t("levelLabelPlaceholder")}
						value={form.label}
						onChange={(e) => {
							const v = e.currentTarget.value;
							setForm((f) => ({ ...f, label: v }));
						}}
						style={{ flex: 1 }}
					/>
					<Button
						size="xs"
						leftSection={<IconPlus size={14} />}
						loading={createLevel.isPending}
						disabled={!form.name.trim()}
						onClick={() =>
							createLevel.mutate(
								{
									name: form.name.trim(),
									rank: form.rank,
									label: form.label.trim() || undefined,
								},
								{ onSuccess: () => setForm({ name: "", rank: 0, label: "" }) },
							)
						}
					>
						{t("createLevel")}
					</Button>
				</Group>
			</Paper>
		</Stack>
	);
}

function levelColor(rank: number, max: number): string {
	const ratio = rank / max;
	if (ratio <= 0.25) return "green";
	if (ratio <= 0.5) return "blue";
	if (ratio <= 0.75) return "orange";
	return "red";
}

// ─── Tab 2: Tags ─────────────────────────────────────────────────────────────

function TagsTab() {
	const { t } = useTranslation("knowledge");
	const tags = useKnowledgeTags();
	const tagTypes = useKnowledgeTagTypes();
	const createTag = useCreateKnowledgeTag();
	const deleteTag = useDeleteKnowledgeTag();
	const updateTag = useUpdateKnowledgeTag();
	const [typeModal, typeModalH] = useDisclosure(false);

	const [form, setForm] = useState<{
		name: string;
		controlled: boolean;
		typeId: string | null;
	}>({ name: "", controlled: false, typeId: null });

	// Group tags by type
	const grouped = useMemo(() => {
		const types = tagTypes.data ?? [];
		const allTags = tags.data ?? [];
		const groups = new Map<
			string,
			{ typeId: string | null; typeName: string; tags: typeof allTags }
		>();

		const uncategorized = t("tagUncategorized");
		groups.set("__uncategorized", { typeId: null, typeName: uncategorized, tags: [] });
		for (const tt of types) {
			groups.set(tt.id, { typeId: tt.id, typeName: tt.name, tags: [] });
		}

		for (const tag of allTags) {
			const key = tag.typeId ?? "__uncategorized";
			const group = groups.get(key);
			if (group) group.tags.push(tag);
			else {
				// Type was deleted — put in uncategorized
				groups.get("__uncategorized")?.tags.push(tag);
			}
		}

		return [...groups.values()].filter((g) => g.tags.length > 0 || g.typeId !== null);
	}, [tags.data, tagTypes.data, t]);

	return (
		<Stack gap="md">
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t("tagsDesc")}
				</Text>
				<Button
					size="xs"
					variant="subtle"
					leftSection={<IconSettings size={14} />}
					onClick={typeModalH.open}
				>
					{t("manageTagTypes")}
				</Button>
			</Group>

			{tags.isLoading ? (
				<Loader size="sm" />
			) : grouped.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("noTags")}
				</Text>
			) : (
				<Accordion variant="separated" multiple defaultValue={grouped.map((g) => g.typeName)}>
					{grouped.map((g) => (
						<Accordion.Item key={g.typeName} value={g.typeName}>
							<Accordion.Control>
								<Group gap="xs">
									<Text size="sm" fw={600}>
										{g.typeName}
									</Text>
									<Badge size="xs" variant="light" color="gray">
										{g.tags.length}
									</Badge>
								</Group>
							</Accordion.Control>
							<Accordion.Panel>
								<Stack gap="xs">
									{g.tags.map((tag) => (
										<Group key={tag.id} justify="space-between" wrap="nowrap">
											<Group gap="xs" wrap="nowrap">
												<Box
													w={3}
													h={20}
													style={{
														borderRadius: 2,
														backgroundColor: tag.controlled
															? "var(--mantine-color-orange-6)"
															: "var(--mantine-color-default-border)",
													}}
												/>
												<Text size="sm">{tag.name}</Text>
												{tag.controlled ? (
													<Badge size="xs" color="orange" variant="light">
														{t("controlled")}
													</Badge>
												) : null}
											</Group>
											<Group gap="xs" wrap="nowrap">
												<ActionIcon
													variant="subtle"
													size="xs"
													onClick={() =>
														updateTag.mutate({
															id: tag.id,
															controlled: !tag.controlled,
														})
													}
													title={tag.controlled ? t("tagMakeNormal") : t("tagMakeControlled")}
												>
													<Badge
														size="xs"
														variant="outline"
														color={tag.controlled ? "gray" : "orange"}
														style={{ cursor: "pointer" }}
													>
														{tag.controlled ? "→ N" : "→ C"}
													</Badge>
												</ActionIcon>
												<ActionIcon
													variant="subtle"
													color="red"
													size="xs"
													onClick={() => deleteTag.mutate(tag.id)}
												>
													<IconTrash size={12} />
												</ActionIcon>
											</Group>
										</Group>
									))}
								</Stack>
							</Accordion.Panel>
						</Accordion.Item>
					))}
				</Accordion>
			)}

			<Paper withBorder p="sm" bg="var(--mantine-color-body)">
				<Group gap="xs" align="flex-end">
					<TextInput
						size="xs"
						label={t("tagName")}
						placeholder={t("tagNamePlaceholder")}
						value={form.name}
						onChange={(e) => {
							const v = e.currentTarget.value;
							setForm((f) => ({ ...f, name: v }));
						}}
						style={{ flex: 1 }}
					/>
					<Select
						size="xs"
						w={140}
						label={t("tagType")}
						placeholder={t("tagUncategorized")}
						clearable
						value={form.typeId}
						onChange={(v) => setForm((f) => ({ ...f, typeId: v }))}
						data={(tagTypes.data ?? []).map((tt) => ({ value: tt.id, label: tt.name }))}
					/>
					<Checkbox
						size="xs"
						label={t("controlled")}
						checked={form.controlled}
						onChange={(e) => {
							const checked = e.currentTarget.checked;
							setForm((f) => ({ ...f, controlled: checked }));
						}}
						mt={22}
					/>
					<Button
						size="xs"
						leftSection={<IconPlus size={14} />}
						loading={createTag.isPending}
						disabled={!form.name.trim()}
						onClick={() =>
							createTag.mutate(
								{
									name: form.name.trim(),
									controlled: form.controlled,
									typeId: form.typeId ?? undefined,
								},
								{ onSuccess: () => setForm({ name: "", controlled: false, typeId: null }) },
							)
						}
					>
						{t("createTag")}
					</Button>
				</Group>
			</Paper>

			<TagTypesModal opened={typeModal} onClose={typeModalH.close} />
		</Stack>
	);
}

function TagTypesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
	const { t } = useTranslation("knowledge");
	const tagTypes = useKnowledgeTagTypes();
	const createTagType = useCreateKnowledgeTagType();
	const deleteTagType = useDeleteKnowledgeTagType();
	const [name, setName] = useState("");

	return (
		<Modal opened={opened} onClose={onClose} title={t("tagTypes")} size="sm">
			<Stack gap="sm">
				<Text size="xs" c="dimmed">
					{t("tagTypesDesc")}
				</Text>
				{tagTypes.data?.map((tt) => (
					<Group key={tt.id} justify="space-between">
						<Group gap="xs">
							<Text size="sm">{tt.name}</Text>
							{tt.builtin ? (
								<Badge size="xs" color="gray" variant="light">
									{t("tagTypeBuiltin")}
								</Badge>
							) : null}
						</Group>
						{tt.builtin ? null : (
							<ActionIcon
								variant="subtle"
								color="red"
								size="xs"
								onClick={() => deleteTagType.mutate(tt.id)}
							>
								<IconTrash size={12} />
							</ActionIcon>
						)}
					</Group>
				))}
				<Group gap="xs" align="flex-end">
					<TextInput
						size="xs"
						label={t("tagTypeName")}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						style={{ flex: 1 }}
					/>
					<Button
						size="xs"
						loading={createTagType.isPending}
						disabled={!name.trim()}
						onClick={() =>
							createTagType.mutate({ name: name.trim() }, { onSuccess: () => setName("") })
						}
					>
						{t("createTagType")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

// ─── Tab 3: Users ────────────────────────────────────────────────────────────

function UsersTab() {
	const { t } = useTranslation("knowledge");
	const users = useQuery({
		queryKey: ["admin", "users"],
		queryFn: api.listUsers,
	});
	const levels = useKnowledgeLevels();
	const grants = useKnowledgeGrants();

	const [selectedUser, setSelectedUser] = useState<{
		id: string;
		username: string;
	} | null>(null);

	// Aggregate clearance per user from grants
	const userClearance = useMemo(() => {
		const m = new Map<string, string>();
		const levelMap = new Map((levels.data ?? []).map((l) => [l.name, l.rank]));
		for (const g of grants.data ?? []) {
			if (g.grantType === "clearance" && g.clearanceLevel && g.principalType === "user") {
				const current = m.get(g.principalId);
				const currentRank = current ? (levelMap.get(current) ?? 0) : -1;
				const newRank = levelMap.get(g.clearanceLevel) ?? 0;
				if (newRank > currentRank) m.set(g.principalId, g.clearanceLevel);
			}
		}
		return m;
	}, [grants.data, levels.data]);

	// Count controlled tags per user
	const userTagCount = useMemo(() => {
		const m = new Map<string, number>();
		for (const g of grants.data ?? []) {
			if (g.grantType === "tag" && g.principalType === "user") {
				m.set(g.principalId, (m.get(g.principalId) ?? 0) + 1);
			}
		}
		return m;
	}, [grants.data]);

	// Count review tags per user
	const userReviewCount = useMemo(() => {
		const m = new Map<string, number>();
		for (const g of grants.data ?? []) {
			if (g.grantType === "review" && g.principalType === "user") {
				m.set(g.principalId, (m.get(g.principalId) ?? 0) + 1);
			}
		}
		return m;
	}, [grants.data]);

	if (users.isLoading) return <Loader size="sm" />;

	return (
		<Stack gap="md">
			<Text size="xs" c="dimmed">
				{t("usersTabDesc")}
			</Text>

			<Table highlightOnHover>
				<Table.Thead>
					<Table.Tr>
						<Table.Th>{t("username")}</Table.Th>
						<Table.Th>{t("userRole")}</Table.Th>
						<Table.Th>{t("classificationLevel")}</Table.Th>
						<Table.Th>{t("controlledTags")}</Table.Th>
						<Table.Th>{t("reviewTags")}</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{(users.data ?? []).map((u: { id: string; username: string; role: string }) => (
						<Table.Tr
							key={u.id}
							onClick={() => setSelectedUser(u)}
							style={{ cursor: "pointer" }}
							bg={selectedUser?.id === u.id ? "var(--mantine-primary-color-light)" : undefined}
						>
							<Table.Td>
								<Text size="sm" fw={500}>
									{u.username}
								</Text>
							</Table.Td>
							<Table.Td>
								{u.role === "admin" ? (
									<Badge size="sm" color="red" variant="light">
										admin
									</Badge>
								) : (
									<Badge size="sm" color="gray" variant="light">
										user
									</Badge>
								)}
							</Table.Td>
							<Table.Td>
								{u.role === "admin" ? (
									<Text size="xs" c="dimmed" fs="italic">
										{t("adminBypass")}
									</Text>
								) : (
									<Badge
										size="sm"
										variant="light"
										color={userClearance.get(u.id) ? "grape" : "gray"}
									>
										{userClearance.get(u.id) ?? "public"}
									</Badge>
								)}
							</Table.Td>
							<Table.Td>
								<Badge size="sm" variant="light" color="teal">
									{u.role === "admin" ? "∞" : (userTagCount.get(u.id) ?? 0)}
								</Badge>
							</Table.Td>
							<Table.Td>
								<Badge size="sm" variant="light" color="blue">
									{u.role === "admin" ? "∞" : (userReviewCount.get(u.id) ?? 0)}
								</Badge>
							</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>

			{selectedUser ? (
				<UserPermissionDetail
					userId={selectedUser.id}
					username={selectedUser.username}
					onClose={() => setSelectedUser(null)}
				/>
			) : (
				<Text size="sm" c="dimmed" ta="center" py="md">
					{t("selectUserHint")}
				</Text>
			)}
		</Stack>
	);
}

function UserPermissionDetail({
	userId,
	username,
	onClose,
}: {
	userId: string;
	username: string;
	onClose: () => void;
}) {
	const { t } = useTranslation("knowledge");
	const levels = useKnowledgeLevels();
	const tags = useKnowledgeTags();
	const tagTypes = useKnowledgeTagTypes();
	const acl = useUserAcl(userId);
	const setAcl = useSetUserAcl();

	const [clearanceLevel, setClearanceLevel] = useState<string | null>(null);
	const [tagIds, setTagIds] = useState<string[]>([]);
	const [reviewTagIds, setReviewTagIds] = useState<string[]>([]);

	// Sync from server when data arrives
	useEffect(() => {
		if (acl.data) {
			setClearanceLevel(acl.data.clearanceLevel);
			setTagIds(acl.data.tagIds);
			setReviewTagIds(acl.data.reviewTagIds);
		}
	}, [acl.data]);

	// Group controlled tags by type for visual chip groups
	const controlledGroups = useMemo(() => {
		const allTags = tags.data ?? [];
		const types = tagTypes.data ?? [];
		const typeName = new Map(types.map((tt) => [tt.id, tt.name]));
		const uncategorized = t("tagUncategorized");

		const controlled = allTags.filter((tg) => tg.controlled);
		const byGroup = new Map<string, { id: string; name: string }[]>();
		for (const tg of controlled) {
			const group = tg.typeId ? (typeName.get(tg.typeId) ?? uncategorized) : uncategorized;
			if (!byGroup.has(group)) byGroup.set(group, []);
			byGroup.get(group)?.push({ id: tg.id, name: tg.name });
		}
		return [...byGroup.entries()];
	}, [tags.data, tagTypes.data, t]);

	const levelOptions = useMemo(
		() =>
			(levels.data ?? []).map((l) => ({
				value: l.name,
				label: l.label ? `${l.label} (${l.name})` : l.name,
			})),
		[levels.data],
	);

	const allTagOptions = useMemo(
		() => (tags.data ?? []).map((tg) => ({ value: tg.id, label: tg.name })),
		[tags.data],
	);

	const toggleTag = (tagId: string) => {
		setTagIds((ids) => (ids.includes(tagId) ? ids.filter((x) => x !== tagId) : [...ids, tagId]));
	};

	const save = () => {
		setAcl.mutate({ userId, clearanceLevel, tagIds, reviewTagIds });
	};

	if (acl.isLoading || levels.isLoading || tags.isLoading || tagTypes.isLoading)
		return (
			<Group justify="center" py="md">
				<Loader size="sm" />
			</Group>
		);

	// Ensure value is valid (exists in data) to prevent Mantine crash
	const safeLevel = levelOptions.some((o) => o.value === clearanceLevel) ? clearanceLevel : null;

	return (
		<Paper withBorder p="md">
			<Stack gap="md">
				<Group justify="space-between">
					<Title order={5}>{t("userPermissionsFor", { username })}</Title>
					<ActionIcon variant="subtle" onClick={onClose}>
						<IconX size={14} />
					</ActionIcon>
				</Group>

				<Select
					label={t("classificationLevel")}
					description={t("userAclClearanceHint")}
					placeholder={t("aclLevelPlaceholder")}
					data={levelOptions}
					value={safeLevel}
					onChange={setClearanceLevel}
					clearable
					size="sm"
				/>

				{controlledGroups.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("noControlledTags")}
					</Text>
				) : (
					<div>
						<Text size="sm" fw={500} mb={4}>
							{t("controlledTags")}
						</Text>
						<Text size="xs" c="dimmed" mb="xs">
							{t("userAclTagsHint")}
						</Text>
						<Stack gap="xs">
							{controlledGroups.map(([group, items]) => (
								<div key={group}>
									<Text size="xs" c="dimmed" mb={2}>
										{group}
									</Text>
									<Group gap={6}>
										{items.map((item) => (
											<Badge
												key={item.id}
												size="md"
												variant={tagIds.includes(item.id) ? "filled" : "outline"}
												color={tagIds.includes(item.id) ? "teal" : "gray"}
												style={{ cursor: "pointer" }}
												onClick={() => toggleTag(item.id)}
											>
												{item.name}
											</Badge>
										))}
									</Group>
								</div>
							))}
						</Stack>
					</div>
				)}

				<MultiSelect
					label={t("reviewTags")}
					description={t("userAclReviewHint")}
					placeholder={t("aclTagsPlaceholder")}
					data={allTagOptions}
					value={reviewTagIds.filter((id) => allTagOptions.some((o) => o.value === id))}
					onChange={setReviewTagIds}
					searchable
					clearable
					size="sm"
				/>

				{setAcl.isError ? (
					<Text c="red" size="sm">
						{(setAcl.error as Error).message}
					</Text>
				) : null}

				<Group justify="flex-end">
					<Button onClick={save} loading={setAcl.isPending} size="sm">
						{t("save")}
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}
