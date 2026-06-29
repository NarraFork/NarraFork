import {
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	MultiSelect,
	Paper,
	Progress,
	Select,
	SimpleGrid,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useKnowledgeEntries,
	useKnowledgeLevels,
	useKnowledgeTags,
	useKnowledgeTagTypes,
	useSetUserAcl,
	useUserAcl,
} from "../../hooks/useKnowledge";

interface Props {
	userId: string | null;
	username: string;
	opened: boolean;
	onClose: () => void;
}

/**
 * Redesigned user ACL modal with two-column layout:
 *   Left:  Permission configuration (clearance + grouped tag chips)
 *   Right: Real-time effect preview (accessible entry counts by collection)
 */
export function UserAclModal({ userId, username, opened, onClose }: Props) {
	const { t } = useTranslation("knowledge");
	const levels = useKnowledgeLevels();
	const tags = useKnowledgeTags();
	const tagTypes = useKnowledgeTagTypes();
	const acl = useUserAcl(opened ? (userId ?? undefined) : undefined);
	const setAcl = useSetUserAcl();
	const entries = useKnowledgeEntries({});

	const [clearanceLevel, setClearanceLevel] = useState<string | null>(null);
	const [tagIds, setTagIds] = useState<string[]>([]);
	const [reviewTagIds, setReviewTagIds] = useState<string[]>([]);

	// Load current ACL into local state when modal opens / data arrives.
	useEffect(() => {
		if (acl.data) {
			setClearanceLevel(acl.data.clearanceLevel);
			setTagIds(acl.data.tagIds);
			setReviewTagIds(acl.data.reviewTagIds);
		}
	}, [acl.data]);

	// Build controlled tags grouped by type
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

	// Client-side preview: simulate access check using current selections
	// Note: entry list data may not contain full ACL fields; this is an approximation.
	const preview = useMemo(() => {
		const allEntries = entries.data ?? [];
		const allLevels = levels.data ?? [];
		const levelRankMap = new Map(allLevels.map((l) => [l.name, l.rank]));
		levelRankMap.set("public", 0);
		const selectedRank = clearanceLevel ? (levelRankMap.get(clearanceLevel) ?? 0) : 0;
		const grantedSet = new Set(tagIds);

		type AnyEntry = Record<string, unknown>;
		const accessible: AnyEntry[] = [];
		for (const entry of allEntries) {
			const e = entry as unknown as AnyEntry;
			const entryLevel = (e.classificationLevel as string | null | undefined) ?? null;
			const entryRank = entryLevel ? (levelRankMap.get(entryLevel) ?? Number.POSITIVE_INFINITY) : 0;
			if (selectedRank < entryRank) continue;

			// Check controlled tags (entry-level)
			const controlled: string[] = Array.isArray(e.controlledTagsJson)
				? (e.controlledTagsJson as string[])
				: [];
			if (controlled.some((t) => !grantedSet.has(t))) continue;

			accessible.push(e);
		}

		// Group by collection
		const byCollection = new Map<string, number>();
		const totalByCollection = new Map<string, number>();
		for (const e of allEntries) {
			const colId = (e as unknown as AnyEntry).collectionId as string;
			totalByCollection.set(colId, (totalByCollection.get(colId) ?? 0) + 1);
		}
		for (const e of accessible) {
			const colId = e.collectionId as string;
			byCollection.set(colId, (byCollection.get(colId) ?? 0) + 1);
		}

		return {
			accessible: accessible.length,
			total: allEntries.length,
			byCollection,
			totalByCollection,
		};
	}, [entries.data, levels.data, clearanceLevel, tagIds]);

	const levelOptions = useMemo(
		() =>
			(levels.data ?? []).map((l) => ({
				value: l.name,
				label: l.label ? `${l.label} (${l.rank})` : `${l.name} (${l.rank})`,
			})),
		[levels.data],
	);

	const allTagOptions = useMemo(
		() => (tags.data ?? []).map((tg) => ({ value: tg.id, label: tg.name })),
		[tags.data],
	);

	// Ensure Select value exists in data to prevent Mantine crash
	const safeLevel = levelOptions.some((o) => o.value === clearanceLevel) ? clearanceLevel : null;

	const toggleTag = (tagId: string) => {
		setTagIds((ids) => (ids.includes(tagId) ? ids.filter((x) => x !== tagId) : [...ids, tagId]));
	};

	const save = () => {
		if (!userId) return;
		setAcl.mutate({ userId, clearanceLevel, tagIds, reviewTagIds }, { onSuccess: onClose });
	};

	const loading = acl.isLoading || levels.isLoading || tags.isLoading || tagTypes.isLoading;

	return (
		<Stack gap="md">
			<Text size="sm" c="dimmed">
				{t("userAclDesc", { username })}
			</Text>

			{loading ? (
				<Group justify="center" py="lg">
					<Loader size="sm" />
				</Group>
			) : (
				<SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
					{/* Left column: Configuration */}
					<Stack gap="md">
						<Title order={6}>{t("permissionConfig")}</Title>

						<Select
							label={t("classificationLevel")}
							description={t("userAclClearanceHint")}
							placeholder={t("aclLevelPlaceholder")}
							data={levelOptions}
							value={safeLevel}
							onChange={setClearanceLevel}
							clearable
							searchable
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
										<Paper key={group} withBorder p="xs">
											<Text size="xs" c="dimmed" mb={4}>
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
										</Paper>
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
					</Stack>

					{/* Right column: Effect Preview */}
					<Stack gap="md">
						<Title order={6}>{t("accessPreview")}</Title>

						<Paper withBorder p="sm" bg="var(--mantine-color-body)">
							<Group justify="space-between" mb="xs">
								<Text size="sm" fw={500}>
									{t("accessibleEntries")}
								</Text>
								<Badge size="lg" variant="light" color="indigo">
									{preview.accessible} / {preview.total}
								</Badge>
							</Group>
							<Progress
								value={preview.total > 0 ? (preview.accessible / preview.total) * 100 : 0}
								color="indigo"
								size="sm"
								mb="md"
							/>

							{preview.byCollection.size === 0 && preview.accessible === 0 ? (
								<Text size="xs" c="dimmed">
									{t("noAccessibleEntries")}
								</Text>
							) : (
								<Stack gap="xs">
									{[...preview.totalByCollection.entries()].map(([colId, total]) => {
										const accessible = preview.byCollection.get(colId) ?? 0;
										return (
											<Group key={colId} justify="space-between" wrap="nowrap">
												<Text size="xs" truncate="end" style={{ flex: 1, minWidth: 0 }}>
													{colId.slice(0, 8)}...
												</Text>
												<Group gap={4} wrap="nowrap">
													<Text size="xs" c="dimmed">
														{accessible}/{total}
													</Text>
													<Progress
														value={total > 0 ? (accessible / total) * 100 : 0}
														color="teal"
														size="xs"
														w={60}
													/>
												</Group>
											</Group>
										);
									})}
								</Stack>
							)}
						</Paper>

						<Text size="xs" c="dimmed">
							{t("previewDisclaimer")}
						</Text>
					</Stack>
				</SimpleGrid>
			)}

			<Divider />

			{setAcl.isError ? (
				<Text c="red" size="sm">
					{(setAcl.error as Error).message}
				</Text>
			) : null}

			<Group justify="flex-end">
				<Button variant="default" onClick={onClose}>
					{t("cancel")}
				</Button>
				<Button onClick={save} loading={setAcl.isPending}>
					{t("save")}
				</Button>
			</Group>
		</Stack>
	);
}
