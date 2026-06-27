import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Group,
	NumberInput,
	Paper,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateKnowledgeGrant,
	useCreateKnowledgeLevel,
	useCreateKnowledgeTag,
	useCreateKnowledgeTagType,
	useDeleteKnowledgeGrant,
	useDeleteKnowledgeLevel,
	useDeleteKnowledgeTag,
	useDeleteKnowledgeTagType,
	useKnowledgeGrants,
	useKnowledgeLevels,
	useKnowledgeTags,
	useKnowledgeTagTypes,
} from "../../hooks/useKnowledge";
import type { KnowledgeGrantType } from "../../lib/api";

export function AclAdminPanel() {
	const { t } = useTranslation("knowledge");
	const levels = useKnowledgeLevels();
	const tags = useKnowledgeTags();
	const grants = useKnowledgeGrants();
	const createLevel = useCreateKnowledgeLevel();
	const deleteLevel = useDeleteKnowledgeLevel();
	const createTag = useCreateKnowledgeTag();
	const deleteTag = useDeleteKnowledgeTag();
	const tagTypes = useKnowledgeTagTypes();
	const createTagType = useCreateKnowledgeTagType();
	const deleteTagType = useDeleteKnowledgeTagType();
	const createGrant = useCreateKnowledgeGrant();
	const deleteGrant = useDeleteKnowledgeGrant();

	const [levelForm, setLevelForm] = useState({ name: "", rank: 0, label: "" });
	const [tagForm, setTagForm] = useState<{
		name: string;
		controlled: boolean;
		typeId: string | null;
	}>({ name: "", controlled: false, typeId: null });
	const [typeForm, setTypeForm] = useState("");
	const [grantForm, setGrantForm] = useState({
		principalType: "role" as "user" | "role",
		principalId: "user",
		grantType: "clearance" as KnowledgeGrantType,
		clearanceLevel: "",
		tagId: "",
		canWrite: false,
	});

	return (
		<Stack gap="lg">
			<Text size="sm" c="dimmed">
				{t("accessControlDesc")}
			</Text>

			{/* Levels */}
			<Stack gap="xs">
				<Title order={5}>{t("levels")}</Title>
				{levels.data?.length ? (
					levels.data.map((l) => (
						<Paper key={l.id} withBorder p="xs">
							<Group justify="space-between">
								<Group gap="xs">
									<Badge variant="light">{l.rank}</Badge>
									<Text size="sm" fw={600}>
										{l.name}
									</Text>
									{l.label ? (
										<Text size="xs" c="dimmed">
											{l.label}
										</Text>
									) : null}
								</Group>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => deleteLevel.mutate(l.id)}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						</Paper>
					))
				) : (
					<Text size="xs" c="dimmed">
						{t("noLevels")}
					</Text>
				)}
				<Group gap="xs" align="flex-end">
					<TextInput
						size="xs"
						label={t("levelName")}
						value={levelForm.name}
						onChange={(e) => setLevelForm((f) => ({ ...f, name: e.currentTarget.value }))}
					/>
					<NumberInput
						size="xs"
						w={90}
						label={t("levelRank")}
						value={levelForm.rank}
						onChange={(v) => setLevelForm((f) => ({ ...f, rank: Number(v) || 0 }))}
					/>
					<TextInput
						size="xs"
						label={t("levelLabel")}
						value={levelForm.label}
						onChange={(e) => setLevelForm((f) => ({ ...f, label: e.currentTarget.value }))}
					/>
					<Button
						size="xs"
						loading={createLevel.isPending}
						disabled={!levelForm.name.trim()}
						onClick={() =>
							createLevel.mutate(
								{
									name: levelForm.name.trim(),
									rank: levelForm.rank,
									label: levelForm.label.trim() || undefined,
								},
								{ onSuccess: () => setLevelForm({ name: "", rank: 0, label: "" }) },
							)
						}
					>
						{t("createLevel")}
					</Button>
				</Group>
			</Stack>

			{/* Tags */}
			<Stack gap="xs">
				<Title order={5}>{t("knowledgeTags")}</Title>
				{tags.data?.length ? (
					tags.data.map((tag) => (
						<Paper key={tag.id} withBorder p="xs">
							<Group justify="space-between">
								<Group gap="xs">
									<Text size="sm" fw={600}>
										{tag.name}
									</Text>
									{tag.typeId ? (
										<Badge size="xs" color="blue" variant="light">
											{tagTypes.data?.find((tt) => tt.id === tag.typeId)?.name ?? tag.typeId}
										</Badge>
									) : null}
									{tag.controlled ? (
										<Badge size="xs" color="orange" variant="light">
											{t("controlled")}
										</Badge>
									) : null}
								</Group>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => deleteTag.mutate(tag.id)}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						</Paper>
					))
				) : (
					<Text size="xs" c="dimmed">
						{t("noTags")}
					</Text>
				)}
				<Group gap="xs" align="flex-end">
					<TextInput
						size="xs"
						label={t("tagName")}
						value={tagForm.name}
						onChange={(e) => setTagForm((f) => ({ ...f, name: e.currentTarget.value }))}
					/>
					<Select
						size="xs"
						w={130}
						label={t("tagType")}
						placeholder={t("tagUncategorized")}
						clearable
						value={tagForm.typeId}
						onChange={(v) => setTagForm((f) => ({ ...f, typeId: v }))}
						data={(tagTypes.data ?? []).map((tt) => ({ value: tt.id, label: tt.name }))}
					/>
					<Checkbox
						size="xs"
						label={t("controlled")}
						checked={tagForm.controlled}
						onChange={(e) => setTagForm((f) => ({ ...f, controlled: e.currentTarget.checked }))}
					/>
					<Button
						size="xs"
						loading={createTag.isPending}
						disabled={!tagForm.name.trim()}
						onClick={() =>
							createTag.mutate(
								{
									name: tagForm.name.trim(),
									controlled: tagForm.controlled,
									typeId: tagForm.typeId ?? undefined,
								},
								{ onSuccess: () => setTagForm({ name: "", controlled: false, typeId: null }) },
							)
						}
					>
						{t("createTag")}
					</Button>
				</Group>
			</Stack>

			{/* Tag types */}
			<Stack gap="xs">
				<Title order={5}>{t("tagTypes")}</Title>
				<Text size="xs" c="dimmed">
					{t("tagTypesDesc")}
				</Text>
				{tagTypes.data?.length ? (
					tagTypes.data.map((tt) => (
						<Paper key={tt.id} withBorder p="xs">
							<Group justify="space-between">
								<Group gap="xs">
									<Text size="sm" fw={600}>
										{tt.name}
									</Text>
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
										size="sm"
										onClick={() => deleteTagType.mutate(tt.id)}
									>
										<IconTrash size={14} />
									</ActionIcon>
								)}
							</Group>
						</Paper>
					))
				) : (
					<Text size="xs" c="dimmed">
						{t("noTagTypes")}
					</Text>
				)}
				<Group gap="xs" align="flex-end">
					<TextInput
						size="xs"
						label={t("tagTypeName")}
						value={typeForm}
						onChange={(e) => setTypeForm(e.currentTarget.value)}
					/>
					<Button
						size="xs"
						loading={createTagType.isPending}
						disabled={!typeForm.trim()}
						onClick={() =>
							createTagType.mutate({ name: typeForm.trim() }, { onSuccess: () => setTypeForm("") })
						}
					>
						{t("createTagType")}
					</Button>
				</Group>
			</Stack>

			{/* Grants */}
			<Stack gap="xs">
				<Title order={5}>{t("grants")}</Title>
				{grants.data?.length ? (
					grants.data.map((g) => (
						<Paper key={g.id} withBorder p="xs">
							<Group justify="space-between">
								<Group gap="xs">
									<Badge size="xs" variant="light">
										{g.principalType}:{g.principalId}
									</Badge>
									<Text size="sm">{t(`grantType_${g.grantType}`)}</Text>
									{g.clearanceLevel ? (
										<Badge size="xs" color="grape" variant="light">
											{g.clearanceLevel}
										</Badge>
									) : null}
									{g.tagId ? (
										<Badge size="xs" color="teal" variant="light">
											tag
										</Badge>
									) : null}
									{g.canWrite ? (
										<Badge size="xs" color="red" variant="light">
											write
										</Badge>
									) : null}
								</Group>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => deleteGrant.mutate(g.id)}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						</Paper>
					))
				) : (
					<Text size="xs" c="dimmed">
						{t("noGrants")}
					</Text>
				)}
				<Paper withBorder p="sm">
					<Stack gap="xs">
						<Group gap="xs" grow>
							<Select
								size="xs"
								label={t("grantPrincipalType")}
								value={grantForm.principalType}
								onChange={(v) =>
									v && setGrantForm((f) => ({ ...f, principalType: v as "user" | "role" }))
								}
								data={[
									{ value: "role", label: t("principalRole") },
									{ value: "user", label: t("principalUser") },
								]}
							/>
							<TextInput
								size="xs"
								label={t("grantPrincipalId")}
								value={grantForm.principalId}
								onChange={(e) =>
									setGrantForm((f) => ({ ...f, principalId: e.currentTarget.value }))
								}
							/>
							<Select
								size="xs"
								label={t("grantType")}
								value={grantForm.grantType}
								onChange={(v) =>
									v && setGrantForm((f) => ({ ...f, grantType: v as KnowledgeGrantType }))
								}
								data={[
									{ value: "clearance", label: t("grantType_clearance") },
									{ value: "tag", label: t("grantType_tag") },
									{ value: "review", label: t("grantType_review") },
								]}
							/>
						</Group>
						<Group gap="xs" grow align="flex-end">
							{grantForm.grantType === "clearance" ? (
								<Select
									size="xs"
									label={t("classificationLevel")}
									value={grantForm.clearanceLevel}
									onChange={(v) => setGrantForm((f) => ({ ...f, clearanceLevel: v ?? "" }))}
									data={(levels.data ?? []).map((l) => ({ value: l.name, label: l.name }))}
								/>
							) : (
								<Select
									size="xs"
									label={t("knowledgeTags")}
									value={grantForm.tagId}
									onChange={(v) => setGrantForm((f) => ({ ...f, tagId: v ?? "" }))}
									data={(tags.data ?? []).map((tg) => ({ value: tg.id, label: tg.name }))}
								/>
							)}
							<Checkbox
								size="xs"
								label={t("grantCanWrite")}
								checked={grantForm.canWrite}
								onChange={(e) => setGrantForm((f) => ({ ...f, canWrite: e.currentTarget.checked }))}
							/>
							<Button
								size="xs"
								loading={createGrant.isPending}
								disabled={!grantForm.principalId.trim()}
								onClick={() =>
									createGrant.mutate({
										principalType: grantForm.principalType,
										principalId: grantForm.principalId.trim(),
										grantType: grantForm.grantType,
										clearanceLevel:
											grantForm.grantType === "clearance" ? grantForm.clearanceLevel : undefined,
										tagId: grantForm.grantType !== "clearance" ? grantForm.tagId : undefined,
										canWrite: grantForm.canWrite,
									})
								}
							>
								{t("createGrant")}
							</Button>
						</Group>
					</Stack>
				</Paper>
			</Stack>
		</Stack>
	);
}
