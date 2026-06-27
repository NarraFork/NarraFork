import { Button, Group, MultiSelect, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useKnowledgeLevels,
	useKnowledgeTags,
	useUpdateKnowledgeEntryAcl,
} from "../../hooks/useKnowledge";
import type { KnowledgeEntry } from "../../lib/api";

/**
 * Admin-only ACL editor for a single entry: classification level (clearance axis),
 * controlled tags + review tags (compartment axis), and owner.
 *
 * Stored shapes (mirror server/services/knowledge-acl.ts):
 *   - classificationLevel → level NAME (compared against the level rank map)
 *   - controlledTagsJson / reviewTagsJson → tag IDs (compared against grant.tagId)
 *   - ownerUserId → a user id (owner bypasses both axes)
 *
 * Backend enforces admin via requireAdmin on PATCH /entries/:id/acl; this panel
 * should only be rendered for admins.
 */
export function EntryAclPanel({ entry }: { entry: KnowledgeEntry }) {
	const { t } = useTranslation("knowledge");
	const levels = useKnowledgeLevels();
	const tags = useKnowledgeTags();
	const update = useUpdateKnowledgeEntryAcl();

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
	const tagOptions = useMemo(
		() =>
			(tags.data ?? []).map((tag) => ({
				value: tag.id,
				label: tag.controlled ? `${tag.name} · ${t("controlled")}` : tag.name,
			})),
		[tags.data, t],
	);

	const normalizedOwner = owner.trim();
	const dirty =
		(level ?? null) !== (entry.classificationLevel ?? null) ||
		JSON.stringify(controlled) !== JSON.stringify(entry.controlledTagsJson ?? []) ||
		JSON.stringify(review) !== JSON.stringify(entry.reviewTagsJson ?? []) ||
		normalizedOwner !== (entry.ownerUserId ?? "");

	return (
		<Stack gap="sm">
			<div>
				<Title order={5}>{t("entryAcl")}</Title>
				<Text size="xs" c="dimmed">
					{t("entryAclDesc")}
				</Text>
			</div>

			<Select
				label={t("classificationLevel")}
				placeholder={t("aclLevelPlaceholder")}
				w={260}
				clearable
				data={levelOptions}
				value={level}
				onChange={setLevel}
			/>

			<MultiSelect
				label={t("controlledTags")}
				description={t("controlledTagsHint")}
				placeholder={t("aclTagsPlaceholder")}
				data={tagOptions}
				value={controlled}
				onChange={setControlled}
				clearable
				searchable
			/>

			<MultiSelect
				label={t("reviewTags")}
				description={t("reviewTagsHint")}
				placeholder={t("aclTagsPlaceholder")}
				data={tagOptions}
				value={review}
				onChange={setReview}
				clearable
				searchable
			/>

			<TextInput
				label={t("owner")}
				description={t("aclOwnerHint")}
				value={owner}
				onChange={(e) => setOwner(e.currentTarget.value)}
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
		</Stack>
	);
}
