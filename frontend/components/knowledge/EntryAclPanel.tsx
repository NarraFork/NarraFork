import {
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Paper,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconUser, IconUserShield } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useEntryAccessibleUsers,
	useKnowledgeLevels,
	useKnowledgeTags,
	useUpdateKnowledgeEntryAcl,
} from "../../hooks/useKnowledge";
import type { KnowledgeEntry } from "../../lib/api";

/**
 * Redesigned entry ACL panel with two sections:
 *   Top:    Entry access settings (level, controlled tags, review tags, owner)
 *   Bottom: "Who can access" preview listing actual users
 */
export function EntryAclPanel({ entry }: { entry: KnowledgeEntry }) {
	const { t } = useTranslation("knowledge");
	const levels = useKnowledgeLevels();
	const tags = useKnowledgeTags();
	const update = useUpdateKnowledgeEntryAcl();
	const accessibleUsers = useEntryAccessibleUsers(entry.id);

	const [level, setLevel] = useState<string | null>(entry.classificationLevel);
	const [controlled, setControlled] = useState<string[]>(entry.controlledTagsJson ?? []);
	const [review, setReview] = useState<string[]>(entry.reviewTagsJson ?? []);
	const [owner, setOwner] = useState(entry.ownerUserId ?? "");

	useEffect(() => {
		setLevel(entry.classificationLevel);
		setControlled(entry.controlledTagsJson ?? []);
		setReview(entry.reviewTagsJson ?? []);
		setOwner(entry.ownerUserId ?? "");
	}, [
		entry.classificationLevel,
		entry.controlledTagsJson,
		entry.reviewTagsJson,
		entry.ownerUserId,
	]);

	const levelOptions = useMemo(
		() => (levels.data ?? []).map((l) => ({ value: l.name, label: l.label || l.name })),
		[levels.data],
	);

	const controlledTagOptions = useMemo(
		() =>
			(tags.data ?? [])
				.filter((tag) => tag.controlled)
				.map((tag) => ({ value: tag.id, label: tag.name })),
		[tags.data],
	);

	const allTagOptions = useMemo(
		() => (tags.data ?? []).map((tag) => ({ value: tag.id, label: tag.name })),
		[tags.data],
	);

	const normalizedOwner = owner.trim();
	const dirty =
		(level ?? null) !== (entry.classificationLevel ?? null) ||
		JSON.stringify(controlled) !== JSON.stringify(entry.controlledTagsJson ?? []) ||
		JSON.stringify(review) !== JSON.stringify(entry.reviewTagsJson ?? []) ||
		normalizedOwner !== (entry.ownerUserId ?? "");

	return (
		<Stack gap="md">
			{/* Section 1: Settings */}
			<div>
				<Title order={5}>{t("entryAcl")}</Title>
				<Text size="xs" c="dimmed">
					{t("entryAclDesc")}
				</Text>
			</div>

			<Select
				label={t("classificationLevel")}
				placeholder={t("aclLevelPlaceholder")}
				w={280}
				clearable
				data={levelOptions}
				value={levelOptions.some((o) => o.value === level) ? level : null}
				onChange={setLevel}
				size="sm"
			/>

			<div>
				<Text size="sm" fw={500} mb={4}>
					{t("controlledTags")}
				</Text>
				<Text size="xs" c="dimmed" mb="xs">
					{t("controlledTagsHint")}
				</Text>
				{controlledTagOptions.length === 0 ? (
					<Text size="xs" c="dimmed">
						{t("noControlledTags")}
					</Text>
				) : (
					<Group gap={6}>
						{controlledTagOptions.map((opt) => (
							<Badge
								key={opt.value}
								size="md"
								variant={controlled.includes(opt.value) ? "filled" : "outline"}
								color={controlled.includes(opt.value) ? "orange" : "gray"}
								style={{ cursor: "pointer" }}
								onClick={() =>
									setControlled((prev) =>
										prev.includes(opt.value)
											? prev.filter((x) => x !== opt.value)
											: [...prev, opt.value],
									)
								}
							>
								{opt.label}
							</Badge>
						))}
					</Group>
				)}
			</div>

			<div>
				<Text size="sm" fw={500} mb={4}>
					{t("reviewTags")}
				</Text>
				<Text size="xs" c="dimmed" mb="xs">
					{t("reviewTagsHint")}
				</Text>
				{allTagOptions.length === 0 ? (
					<Text size="xs" c="dimmed">
						{t("noTags")}
					</Text>
				) : (
					<Group gap={6}>
						{allTagOptions.map((opt) => (
							<Badge
								key={opt.value}
								size="md"
								variant={review.includes(opt.value) ? "filled" : "outline"}
								color={review.includes(opt.value) ? "blue" : "gray"}
								style={{ cursor: "pointer" }}
								onClick={() =>
									setReview((prev) =>
										prev.includes(opt.value)
											? prev.filter((x) => x !== opt.value)
											: [...prev, opt.value],
									)
								}
							>
								{opt.label}
							</Badge>
						))}
					</Group>
				)}
			</div>

			<TextInput
				label={t("owner")}
				description={t("aclOwnerHint")}
				value={owner}
				onChange={(e) => setOwner(e.currentTarget.value)}
				size="sm"
				w={280}
			/>

			<Group justify="flex-end">
				<Button
					size="xs"
					loading={update.isPending}
					disabled={!dirty}
					onClick={() =>
						update.mutate({
							id: entry.id,
							classificationLevel: level,
							controlledTags: controlled,
							reviewTags: review,
							ownerUserId: normalizedOwner || null,
						})
					}
				>
					{t("saveAcl")}
				</Button>
			</Group>

			{/* Section 2: Accessible Users Preview */}
			<Divider />

			<div>
				<Title order={6} mb={4}>
					{t("accessibleUsersTitle")}
				</Title>
				<Text size="xs" c="dimmed" mb="sm">
					{t("accessibleUsersDesc")}
				</Text>

				{accessibleUsers.isLoading ? (
					<Group justify="center" py="sm">
						<Loader size="sm" />
					</Group>
				) : (accessibleUsers.data?.length ?? 0) === 0 ? (
					<Text size="sm" c="dimmed">
						{t("noAccessibleUsers")}
					</Text>
				) : (
					<Paper withBorder p="sm" bg="var(--mantine-color-body)">
						<Stack gap="xs">
							{accessibleUsers.data?.map((u) => (
								<Group key={u.userId} justify="space-between" wrap="nowrap">
									<Group gap="xs" wrap="nowrap">
										{u.reason === "admin" ? (
											<IconUserShield size={14} color="var(--mantine-color-red-5)" />
										) : (
											<IconUser size={14} color="var(--mantine-color-dimmed)" />
										)}
										<Text size="sm">{u.username}</Text>
									</Group>
									<Badge
										size="xs"
										variant="light"
										color={u.reason === "admin" ? "red" : u.reason === "owner" ? "grape" : "teal"}
									>
										{t(`accessReason_${u.reason}`)}
									</Badge>
								</Group>
							))}
						</Stack>
						<Text size="xs" c="dimmed" mt="sm">
							{t("accessibleUsersCount", { count: accessibleUsers.data?.length ?? 0 })}
						</Text>
					</Paper>
				)}
			</div>
		</Stack>
	);
}
