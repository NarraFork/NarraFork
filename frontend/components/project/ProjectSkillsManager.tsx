import {
	ActionIcon,
	Badge,
	Button,
	Group,
	Modal,
	Paper,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconDownload,
	IconEye,
	IconPencil,
	IconPlus,
	IconRefresh,
	IconTrash,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateProjectSkill,
	useDeleteProjectSkill,
	useGlobalSkills,
	useProjectSkillsRefresh,
	useSkills,
	useUpdateProjectSkill,
} from "../../hooks/useSkills";
import { api } from "../../lib/api";
import { SkillLinkModal } from "./SkillLinkModal";

const MAX_SKILL_FILE_PREVIEW_ITEMS = 50;
const MAX_SKILL_FILE_PREVIEW_CHARS = 2_000;
const MAX_SKILL_TEXT_PREVIEW_CHARS = 1_000;

interface SkillSummary {
	name: string;
	description: string;
	location: string;
	files: string[];
	disabled?: boolean;
	canUpdateFromUrl?: boolean;
}

interface SkillDraft {
	name: string;
	description: string;
	content: string;
}

interface ProjectSkillsManagerProps {
	projectId: string;
	enabled?: boolean;
	disabledReason?: string;
}

function getSourceLabel(location: string): string {
	if (location.includes("/.narrafork/")) return ".narrafork";
	if (location.includes("/.claude/")) return ".claude";
	if (location.includes("/.agents/")) return ".agents";
	return "other";
}

function getSourceColor(source: string): string {
	if (source === ".narrafork") return "indigo";
	if (source === ".claude") return "violet";
	if (source === ".agents") return "teal";
	return "gray";
}

function formatTextPreview(value: string | undefined, maxChars: number): string {
	if (!value) return "";
	return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function formatSkillFilesPreview(files: string[]): string {
	let text = "";
	let hidden = Math.max(0, files.length - MAX_SKILL_FILE_PREVIEW_ITEMS);
	for (const file of files.slice(0, MAX_SKILL_FILE_PREVIEW_ITEMS)) {
		const prefix = text ? ", " : "";
		if (text.length + prefix.length + file.length > MAX_SKILL_FILE_PREVIEW_CHARS) {
			hidden += 1;
			break;
		}
		text += `${prefix}${file}`;
	}
	return hidden > 0 ? `${text}, … (+${hidden})` : text;
}

export function ProjectSkillsManager({
	projectId,
	enabled = true,
	disabledReason,
}: ProjectSkillsManagerProps) {
	const { t } = useTranslation("routines");
	const canManage = enabled && !!projectId;
	const { data: skills, isLoading } = useSkills(projectId, canManage);
	const { data: globalSkills } = useGlobalSkills(canManage);
	const createMutation = useCreateProjectSkill(projectId);
	const updateMutation = useUpdateProjectSkill(projectId);
	const deleteMutation = useDeleteProjectSkill(projectId);
	const refreshMutation = useProjectSkillsRefresh(projectId);

	const [editOpened, { open: openEdit, close: closeEdit }] = useDisclosure(false);
	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [viewOpened, { open: openView, close: closeView }] = useDisclosure(false);
	const [linkTarget, setLinkTarget] = useState<{
		projectId: string;
		skill?: SkillSummary;
	} | null>(null);
	const closeLink = useCallback(() => setLinkTarget(null), []);
	useEffect(() => {
		if (!canManage || linkTarget?.projectId !== projectId) closeLink();
	}, [canManage, linkTarget?.projectId, projectId, closeLink]);

	const editLoadSeqRef = useRef(0);
	const editProjectIdRef = useRef(projectId);
	const draftTouchedRef = useRef(false);
	const [editingSkill, setEditingSkill] = useState<string | null>(null);
	const [draft, setDraft] = useState<SkillDraft>({ name: "", description: "", content: "" });
	const [editContentLoading, setEditContentLoading] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState("");
	const [viewTarget, setViewTarget] = useState<SkillSummary | null>(null);

	const globalNames = useMemo(
		() => new Set(globalSkills?.map((skill) => skill.name) ?? []),
		[globalSkills],
	);

	const handleCloseEdit = useCallback(() => {
		editLoadSeqRef.current++;
		draftTouchedRef.current = false;
		setEditContentLoading(false);
		closeEdit();
	}, [closeEdit]);

	useEffect(() => {
		const projectChanged = editProjectIdRef.current !== projectId;
		editProjectIdRef.current = projectId;
		if (!canManage || projectChanged) handleCloseEdit();
		return () => {
			editLoadSeqRef.current++;
		};
	}, [canManage, projectId, handleCloseEdit]);

	const updateDraft = useCallback((updater: (current: SkillDraft) => SkillDraft) => {
		draftTouchedRef.current = true;
		setDraft(updater);
	}, []);

	const handleCreate = useCallback(() => {
		if (!canManage) return;
		editLoadSeqRef.current++;
		draftTouchedRef.current = false;
		setEditContentLoading(false);
		setEditingSkill(null);
		setDraft({ name: "", description: "", content: "" });
		setLinkTarget({ projectId });
	}, [canManage, projectId]);

	const handleEdit = useCallback(
		(skill: SkillSummary) => {
			if (!canManage) return;
			const loadSeq = ++editLoadSeqRef.current;
			draftTouchedRef.current = false;
			setEditContentLoading(true);
			setEditingSkill(skill.name);
			setDraft({ name: skill.name, description: skill.description, content: "" });
			api
				.getSkill(projectId, skill.name)
				.then((full) => {
					if (editLoadSeqRef.current !== loadSeq) return;
					setEditContentLoading(false);
					if (draftTouchedRef.current) return;
					setDraft({ name: full.name, description: full.description, content: full.content });
				})
				.catch(() => {
					if (editLoadSeqRef.current === loadSeq) {
						setEditContentLoading(false);
					}
					// Keep the summary fields visible; save will surface any later API error.
				});
			openEdit();
		},
		[canManage, projectId, openEdit],
	);

	const handleSave = useCallback(() => {
		if (!canManage) return;
		const data = {
			name: draft.name.trim(),
			description: draft.description.trim(),
			content: draft.content.trim(),
		};
		if (!data.name || !data.description) return;

		if (editingSkill) {
			updateMutation.mutate({ currentName: editingSkill, ...data }, { onSuccess: handleCloseEdit });
		} else {
			createMutation.mutate(data, {
				onSuccess: () => setLinkTarget((current) => (current === linkTarget ? null : current)),
			});
		}
	}, [canManage, createMutation, draft, editingSkill, handleCloseEdit, linkTarget, updateMutation]);

	const handleDelete = useCallback(
		(name: string) => {
			if (!canManage) return;
			setDeleteTarget(name);
			openDelete();
		},
		[canManage, openDelete],
	);

	const confirmDelete = useCallback(() => {
		if (!deleteTarget) return;
		deleteMutation.mutate(deleteTarget, { onSuccess: () => closeDelete() });
	}, [closeDelete, deleteMutation, deleteTarget]);

	const handleView = useCallback(
		(skill: SkillSummary) => {
			if (!canManage) return;
			setViewTarget(skill);
			openView();
		},
		[canManage, openView],
	);

	const handleRefresh = useCallback(() => {
		if (!canManage) return;
		refreshMutation.mutate();
	}, [canManage, refreshMutation]);

	const disabledTitle = canManage ? undefined : disabledReason;
	const editorForm = (
		<Stack>
			<Text size="xs" c="dimmed">
				{t("projectSkillWritePath")}
			</Text>
			<TextInput
				label={t("skillName")}
				placeholder={t("skillNamePlaceholder")}
				value={draft.name}
				onChange={(e) => {
					// Read the value before the updater runs: React nulls out
					// currentTarget once the event handler returns.
					const val = e.currentTarget.value;
					updateDraft((d) => ({ ...d, name: val }));
				}}
			/>
			<TextInput
				label={t("skillDescription")}
				placeholder={t("skillDescriptionPlaceholder")}
				value={draft.description}
				onChange={(e) => {
					const val = e.currentTarget.value;
					updateDraft((d) => ({ ...d, description: val }));
				}}
			/>
			<Textarea
				label={t("skillContent")}
				placeholder={t("skillContentPlaceholder")}
				value={draft.content}
				onChange={(e) => {
					const val = e.currentTarget.value;
					updateDraft((d) => ({ ...d, content: val }));
				}}
				autosize
				minRows={8}
				maxRows={20}
			/>
			<Group justify="flex-end" gap="xs">
				<Button
					variant="subtle"
					onClick={editingSkill ? handleCloseEdit : closeLink}
					disabled={createMutation.isPending || updateMutation.isPending}
				>
					{t("cancel")}
				</Button>
				<Button
					onClick={handleSave}
					disabled={
						!canManage || editContentLoading || !draft.name.trim() || !draft.description.trim()
					}
					loading={createMutation.isPending || updateMutation.isPending}
					title={disabledTitle}
				>
					{t("save")}
				</Button>
			</Group>
		</Stack>
	);

	return (
		<Stack>
			<Group justify="space-between" align="flex-start">
				<Text size="sm" c="dimmed" style={{ flex: 1 }}>
					{t("projectSkillWritePath")}
				</Text>
				<Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
					<ActionIcon
						variant="subtle"
						size="sm"
						onClick={handleRefresh}
						loading={refreshMutation.isPending}
						disabled={!canManage}
						aria-label={t("refreshSkills")}
						title={disabledTitle ?? t("refreshSkills")}
					>
						<IconRefresh size={14} />
					</ActionIcon>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconPlus size={14} />}
						onClick={handleCreate}
						disabled={!canManage}
						title={disabledTitle}
					>
						{t("addSkill")}
					</Button>
				</Group>
			</Group>

			{isLoading && (
				<Text size="sm" c="dimmed">
					Loading...
				</Text>
			)}

			{!isLoading && (!skills || skills.length === 0) && (
				<Text size="sm" c="dimmed">
					{t("noProjectSkills")}
				</Text>
			)}

			{skills?.map((skill) => {
				const source = getSourceLabel(skill.location);
				const overridesGlobal = globalNames.has(skill.name);
				const isDisabled = !!skill.disabled;
				return (
					<Paper
						key={skill.name}
						withBorder
						p="sm"
						style={isDisabled ? { opacity: 0.55 } : undefined}
					>
						<Group justify="space-between" wrap="nowrap" align="flex-start">
							<div style={{ flex: 1, minWidth: 0 }}>
								<Group gap="xs">
									<Text size="sm" fw={600}>
										{skill.name}
									</Text>
									<Badge size="xs" variant="light" color={getSourceColor(source)}>
										{source}
									</Badge>
									{overridesGlobal && (
										<Badge size="xs" variant="outline" color="yellow">
											{t("overriddenByProject")}
										</Badge>
									)}
									{isDisabled && (
										<Badge size="xs" variant="outline" color="gray">
											{t("skillDisabled")}
										</Badge>
									)}
								</Group>
								<Text size="xs" c="dimmed" truncate="end">
									{formatTextPreview(skill.description, MAX_SKILL_TEXT_PREVIEW_CHARS)}
								</Text>
								<Text size="xs" c="dimmed" truncate="end" mt={2}>
									{skill.location}
								</Text>
								{skill.files.length > 0 && (
									<Text size="xs" c="dimmed" truncate="end" mt={2}>
										{t("skillFiles")}: {formatSkillFilesPreview(skill.files)}
									</Text>
								)}
							</div>
							<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
								<ActionIcon
									variant="subtle"
									size="sm"
									onClick={() => handleView(skill)}
									disabled={!canManage}
									aria-label={t("viewSkill")}
									title={disabledTitle ?? t("viewSkill")}
								>
									<IconEye size={14} />
								</ActionIcon>
								<ActionIcon
									variant="subtle"
									size="sm"
									onClick={() => handleEdit(skill)}
									disabled={!canManage}
									aria-label={t("editSkill")}
									title={disabledTitle ?? t("editSkill")}
								>
									<IconPencil size={14} />
								</ActionIcon>
								<ActionIcon
									variant="subtle"
									size="sm"
									onClick={() => {
										if (canManage && skill.canUpdateFromUrl) setLinkTarget({ projectId, skill });
									}}
									disabled={!canManage || !skill.canUpdateFromUrl}
									aria-label={t("updateSkillFromLink")}
									title={
										!canManage
											? (disabledReason ?? t("skillLinkManagementUnavailable"))
											: !skill.canUpdateFromUrl
												? t("skillLinkUpdateUnsupported")
												: t("updateSkillFromLink")
									}
								>
									<IconDownload size={14} />
								</ActionIcon>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => handleDelete(skill.name)}
									disabled={!canManage}
									aria-label={t("deleteSkill")}
									title={disabledTitle ?? t("deleteSkill")}
								>
									<IconTrash size={14} />
								</ActionIcon>
							</Group>
						</Group>
					</Paper>
				);
			})}

			<SkillLinkModal
				opened={linkTarget?.projectId === projectId}
				onClose={closeLink}
				projectId={projectId}
				skill={linkTarget?.skill}
				enabled={canManage}
				manualForm={!linkTarget?.skill ? editorForm : undefined}
				manualPending={createMutation.isPending}
			/>

			<Modal opened={editOpened} onClose={handleCloseEdit} title={t("editSkill")} size="lg">
				{editorForm}
			</Modal>

			<Modal
				opened={deleteOpened}
				onClose={closeDelete}
				title={t("deleteConfirmTitle")}
				size="sm"
				centered
			>
				<Stack>
					<Text size="sm">{t("deleteConfirm", { name: deleteTarget })}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeDelete}>
							{t("cancel")}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteMutation.isPending}>
							{t("deleteSkill")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal opened={viewOpened} onClose={closeView} title={viewTarget?.name ?? ""} size="lg">
				{viewTarget && (
					<Stack>
						<Text size="sm" c="dimmed">
							{formatTextPreview(viewTarget.description, MAX_SKILL_TEXT_PREVIEW_CHARS)}
						</Text>
						<Text size="xs" c="dimmed">
							{t("skillLocation")}: {viewTarget.location}
						</Text>
						{viewTarget.files.length > 0 && (
							<Text size="xs" c="dimmed">
								{t("skillFiles")}: {formatSkillFilesPreview(viewTarget.files)}
							</Text>
						)}
					</Stack>
				)}
			</Modal>
		</Stack>
	);
}
