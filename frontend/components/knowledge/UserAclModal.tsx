import { Alert, Button, Group, Loader, MultiSelect, Select, Stack, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
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
 * Admin modal to assign a user's knowledge-base permissions:
 *   - clearance level (vertical axis)
 *   - controlled tags grouped by tag type (horizontal axis)
 *   - review tags (who may review entries requiring these tags)
 */
export function UserAclModal({ userId, username, opened, onClose }: Props) {
	const { t } = useTranslation("knowledge");
	const levels = useKnowledgeLevels();
	const tags = useKnowledgeTags();
	const tagTypes = useKnowledgeTagTypes();
	const acl = useUserAcl(opened ? (userId ?? undefined) : undefined);
	const setAcl = useSetUserAcl();

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

	// Build tag options grouped by tag type (organization / position / permission / other / uncategorized).
	const { controlledGroups, allTagOptions } = useMemo(() => {
		const allTags = tags.data ?? [];
		const types = tagTypes.data ?? [];
		const typeName = new Map(types.map((tt) => [tt.id, tt.name]));
		const uncategorized = t("tagUncategorized");

		const controlled = allTags.filter((tg) => tg.controlled);
		const byGroup = new Map<string, { value: string; label: string }[]>();
		for (const tg of controlled) {
			const group = tg.typeId ? (typeName.get(tg.typeId) ?? uncategorized) : uncategorized;
			if (!byGroup.has(group)) byGroup.set(group, []);
			byGroup.get(group)?.push({ value: tg.id, label: tg.name });
		}
		const controlledGroups = [...byGroup.entries()].map(([group, items]) => ({ group, items }));

		// review tags can target any tag (not only controlled)
		const allTagOptions = allTags.map((tg) => ({ value: tg.id, label: tg.name }));
		return { controlledGroups, allTagOptions };
	}, [tags.data, tagTypes.data, t]);

	const levelOptions = (levels.data ?? []).map((l) => ({
		value: l.name,
		label: l.label ? `${l.label} (${l.rank})` : `${l.name} (${l.rank})`,
	}));

	const save = () => {
		if (!userId) return;
		setAcl.mutate({ userId, clearanceLevel, tagIds, reviewTagIds }, { onSuccess: onClose });
	};

	const loading = acl.isLoading || levels.isLoading || tags.isLoading || tagTypes.isLoading;

	return (
		<Stack>
			<Text size="sm" c="dimmed">
				{t("userAclDesc", { username })}
			</Text>

			{loading ? (
				<Group justify="center" py="md">
					<Loader size="sm" />
				</Group>
			) : (
				<>
					<Select
						label={t("classificationLevel")}
						description={t("userAclClearanceHint")}
						placeholder={t("aclLevelPlaceholder")}
						data={levelOptions}
						value={clearanceLevel}
						onChange={setClearanceLevel}
						clearable
						searchable
					/>

					{controlledGroups.length === 0 ? (
						<Alert color="gray" variant="light">
							{t("noControlledTags")}
						</Alert>
					) : (
						<MultiSelect
							label={t("controlledTags")}
							description={t("userAclTagsHint")}
							placeholder={t("aclTagsPlaceholder")}
							data={controlledGroups}
							value={tagIds}
							onChange={setTagIds}
							searchable
							clearable
						/>
					)}

					<MultiSelect
						label={t("reviewTags")}
						description={t("userAclReviewHint")}
						placeholder={t("aclTagsPlaceholder")}
						data={allTagOptions}
						value={reviewTagIds}
						onChange={setReviewTagIds}
						searchable
						clearable
					/>

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
				</>
			)}
		</Stack>
	);
}
