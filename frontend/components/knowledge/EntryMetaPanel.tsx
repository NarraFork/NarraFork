import { Button, Group, Select, Stack, TagsInput, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateKnowledgeEntryMeta } from "../../hooks/useKnowledge";
import type { KnowledgeEntry } from "../../lib/api";

type EntryStatus = "active" | "archived";

/**
 * Edit an entry's metadata: title, free-form tags, and status.
 * Backend gate: PATCH /entries/:id has no extra role check, so this mirrors the
 * direct-write audience (admin / owner) for a coherent UX — the panel is only
 * mounted by the detail page when the viewer can direct-write.
 */
export function EntryMetaPanel({ entry }: { entry: KnowledgeEntry }) {
	const { t } = useTranslation("knowledge");
	const update = useUpdateKnowledgeEntryMeta();

	const [title, setTitle] = useState(entry.title);
	const [tags, setTags] = useState<string[]>(entry.tagsJson ?? []);
	const [status, setStatus] = useState<EntryStatus>(entry.status);

	useEffect(() => {
		setTitle(entry.title);
		setTags(entry.tagsJson ?? []);
		setStatus(entry.status);
	}, [entry.title, entry.tagsJson, entry.status]);

	const dirty =
		title !== entry.title ||
		status !== entry.status ||
		JSON.stringify(tags) !== JSON.stringify(entry.tagsJson ?? []);

	return (
		<Stack gap="sm">
			<div>
				<Title order={5}>{t("metaSettings")}</Title>
				<Text size="xs" c="dimmed">
					{t("metaDesc")}
				</Text>
			</div>

			<TextInput
				label={t("title_field")}
				value={title}
				onChange={(e) => setTitle(e.currentTarget.value)}
			/>

			<TagsInput
				label={t("tags")}
				placeholder={t("tagsPlaceholder")}
				value={tags}
				onChange={setTags}
				clearable
			/>

			<Select
				label={t("status")}
				w={200}
				allowDeselect={false}
				data={[
					{ value: "active", label: t("statusActive") },
					{ value: "archived", label: t("statusArchived") },
				]}
				value={status}
				onChange={(v) => v && setStatus(v as EntryStatus)}
			/>

			<Group justify="flex-end">
				<Button
					size="xs"
					loading={update.isPending}
					disabled={!dirty || !title.trim()}
					onClick={() =>
						update.mutate({
							id: entry.id,
							title: title.trim(),
							tags,
							status,
						})
					}
				>
					{t("save")}
				</Button>
			</Group>
		</Stack>
	);
}
