/**
 * The editors of the project settings page (R2; moved from the old settings dialog), each saving
 * its own change at once ("更改会自动保存"):
 *
 *  - `ProjectBasicsForm`: name and description, saved when the field is left (a blank name is not
 *    sent); the project directory only on its own 保存, after a confirmation that sessions will be
 *    re-assigned (a half-typed path is never saved). A field shows the stored value again after a
 *    save, and an unsaved one says so;
 *  - `ProjectRuleList`: one permission rule list of `chapterSettings` (directory or command white /
 *    black list), saved on every add, edit or removal — only that key is sent, the server merges;
 *    a failed save puts the stored list back and shows the error;
 *  - `ProjectCommandsEditor`: the project's slash commands.
 */
import {
	Alert,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../../hooks/usePlatform";
import { useUpdateProject } from "../../hooks/useProjects";
import { api } from "../../lib/api";
import type { ApiEntity, PathFlavor } from "../../lib/api/types";
import { normalizeRuleTargetSelector } from "../../lib/api/types";
import { type CommandDef, CommandsEditor } from "../common/CommandsEditor";
import { PermissionRuleEditor } from "../permissions/PermissionRuleEditor";

/** A project's `chapterSettings`, parsed whether it arrives as text or as an object. */
export function projectChapterSettings(project: ApiEntity | undefined): Record<string, unknown> {
	const raw = project?.chapterSettings;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	}
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function SaveState({ pending, error }: { pending: boolean; error: Error | null }) {
	const { t } = useTranslation("projects");
	if (pending)
		return (
			<Group gap={6}>
				<Loader size={12} />
				<Text size="xs" c="dimmed">
					{t("settingsPage.saving")}
				</Text>
			</Group>
		);
	if (error)
		return (
			<Alert color="red" variant="light" py={6}>
				{t("settingsPage.saveFailed", { message: error.message })}
			</Alert>
		);
	return null;
}

/** A directory as typed, without the trailing separators the server drops (`/repo/` = `/repo`). */
export function comparablePath(path: string): string {
	const trimmed = path.trim();
	const stripped = trimmed.replace(/[\\/]+$/, "");
	return stripped || trimmed;
}

type BasicsField = "name" | "description";

export function ProjectBasicsForm({
	project,
	canManage,
}: {
	project: ApiEntity;
	canManage: boolean;
}) {
	const { t } = useTranslation("projects");
	const update = useUpdateProject();
	const projectId = String(project.id);
	const stored = {
		name: String(project.name ?? ""),
		description: String(project.description ?? ""),
		gitPath: String(project.gitPath ?? ""),
	};
	// A field follows the stored value until it is edited (its draft), and again once its change
	// is saved: the server stores the resolved form, which the page then shows.
	const [drafts, setDrafts] = useState<Partial<Record<BasicsField | "gitPath", string>>>({});
	const [failed, setFailed] = useState<Partial<Record<BasicsField | "gitPath", string>>>({});
	const [confirming, setConfirming] = useState(false);
	const shown = (field: BasicsField | "gitPath") => drafts[field] ?? stored[field];
	const edit = (field: BasicsField | "gitPath", value: string) =>
		setDrafts((current) => ({ ...current, [field]: value }));
	const settle = (field: BasicsField | "gitPath") => {
		setDrafts(({ [field]: _done, ...rest }) => rest);
		setFailed(({ [field]: _done, ...rest }) => rest);
	};
	const send = (field: BasicsField | "gitPath", value: string) =>
		update.mutate(
			{ id: projectId, data: { [field]: value } },
			{
				onSuccess: () => settle(field),
				// The draft stays, marked unsaved, so a failed save never looks saved.
				onError: (error: Error) => setFailed((current) => ({ ...current, [field]: error.message })),
			},
		);
	/** Name and description save when the field is left, if they changed and are valid. */
	const saveOnLeave = (field: BasicsField) => {
		const draft = drafts[field];
		if (draft === undefined) return;
		const trimmed = draft.trim();
		if (trimmed === stored[field].trim()) {
			settle(field);
			return;
		}
		if (field === "name" && !trimmed) return;
		send(field, trimmed);
	};
	const pathDraft = drafts.gitPath;
	const pathChanged =
		pathDraft !== undefined &&
		!!pathDraft.trim() &&
		comparablePath(pathDraft) !== comparablePath(stored.gitPath);
	const unsaved = (field: BasicsField | "gitPath") =>
		failed[field] ? t("settingsPage.unsaved", { message: failed[field] }) : undefined;
	return (
		<Stack gap="sm" data-testid="project-basics">
			<TextInput
				label={t("projectName")}
				value={shown("name")}
				required
				disabled={!canManage}
				error={!shown("name").trim() ? t("projectNameRequired") : unsaved("name")}
				onChange={(event) => edit("name", event.currentTarget.value)}
				onBlur={() => saveOnLeave("name")}
			/>
			<Textarea
				label={t("projectDescription")}
				value={shown("description")}
				autosize
				minRows={1}
				disabled={!canManage}
				error={unsaved("description")}
				onChange={(event) => edit("description", event.currentTarget.value)}
				onBlur={() => saveOnLeave("description")}
			/>
			{/* The project directory decides which sessions belong here: it is saved only on 保存,
			    after a confirmation, never when the field is left half typed. */}
			<Group gap="xs" align="flex-end" wrap="nowrap">
				<TextInput
					label={t("repositoryPath")}
					description={t("defaultDirectoryHint")}
					value={shown("gitPath")}
					required
					disabled={!canManage}
					style={{ flex: 1 }}
					styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
					error={!shown("gitPath").trim() ? t("repoPathRequired") : unsaved("gitPath")}
					onChange={(event) => edit("gitPath", event.currentTarget.value)}
				/>
				{canManage && pathDraft !== undefined && (
					<Button
						variant="default"
						onClick={() => settle("gitPath")}
						data-testid="project-path-cancel"
					>
						{t("settingsPage.pathCancel")}
					</Button>
				)}
				{canManage && (
					<Button
						disabled={!pathChanged}
						loading={update.isPending && update.variables?.data?.gitPath !== undefined}
						onClick={() => setConfirming(true)}
						data-testid="project-path-save"
					>
						{t("settingsPage.pathSave")}
					</Button>
				)}
			</Group>
			<Modal
				opened={confirming}
				onClose={() => setConfirming(false)}
				title={t("settingsPage.pathConfirmTitle")}
			>
				<Stack>
					<Text size="sm">
						{t("settingsPage.pathConfirm", {
							from: stored.gitPath,
							to: pathDraft?.trim() ?? "",
						})}
					</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={() => setConfirming(false)}>
							{t("settingsPage.pathCancel")}
						</Button>
						<Button
							onClick={() => {
								setConfirming(false);
								if (pathChanged && pathDraft !== undefined) send("gitPath", pathDraft.trim());
							}}
							data-testid="project-path-confirm"
						>
							{t("settingsPage.pathConfirmButton")}
						</Button>
					</Group>
				</Stack>
			</Modal>
			{update.isPending && <SaveState pending error={null} />}
		</Stack>
	);
}

export type ProjectRuleKey =
	| "whitelistDirs"
	| "blacklistDirs"
	| "commandWhitelist"
	| "commandBlacklist";

const RULE_KIND = {
	whitelistDirs: "directoryWhitelist",
	blacklistDirs: "directoryBlacklist",
	commandWhitelist: "commandWhitelist",
	commandBlacklist: "commandBlacklist",
} as const;

const RULE_TEXT = {
	whitelistDirs: ["projectWhitelistDirs", "projectWhitelistDirsDesc"],
	blacklistDirs: ["projectBlacklistDirs", "projectBlacklistDirsDesc"],
	commandWhitelist: ["projectCommandWhitelist", "projectCommandWhitelistDesc"],
	commandBlacklist: ["projectCommandBlacklist", "projectCommandBlacklistDesc"],
} as const;

type Rule = Record<string, unknown> & { selector: ReturnType<typeof normalizeRuleTargetSelector> };

function normalizeRules(rules: unknown): Rule[] {
	return (Array.isArray(rules) ? rules : []).map((rule) => ({
		...(rule as Record<string, unknown>),
		selector: normalizeRuleTargetSelector(rule as Record<string, unknown>),
	}));
}

export function ProjectRuleList({
	project,
	ruleKey,
	canManage,
}: {
	project: ApiEntity;
	ruleKey: ProjectRuleKey;
	canManage: boolean;
}) {
	const { t } = useTranslation("projects");
	const { t: ts } = useTranslation("settings");
	const update = useUpdateProject();
	const platform = usePlatform();
	const serverPathFlavor: PathFlavor = platform === "windows" ? "windows" : "posix";
	const devices = useQuery({
		queryKey: ["permission-rule-devices"],
		queryFn: api.listDevices,
		staleTime: 30_000,
		enabled: canManage,
	});
	const stored = projectChapterSettings(project)[ruleKey];
	// The list shown is the stored one, or the change being saved. On success it follows the
	// stored list again (re-read after the save); on failure the change is dropped, so an
	// unsaved list never looks saved, and the error says so.
	const [pending, setPending] = useState<Rule[] | null>(null);
	const rules = pending ?? normalizeRules(stored);
	const commit = (next: Rule[]) => {
		setPending(next);
		update.mutate(
			{ id: String(project.id), data: { chapterSettings: { [ruleKey]: next } } },
			{ onSettled: () => setPending(null) },
		);
	};
	const directory = ruleKey === "whitelistDirs" || ruleKey === "blacklistDirs";
	const [title, description] = RULE_TEXT[ruleKey];
	return (
		<Stack gap={6} data-testid={`project-rules-${ruleKey}`}>
			<Text size="sm" fw={600}>
				{t(title)}
			</Text>
			<Text size="xs" c="dimmed">
				{t(description)}
			</Text>
			{canManage ? (
				<PermissionRuleEditor
					// biome-ignore lint/suspicious/noExplicitAny: the editor's rule union is keyed by kind
					rules={rules as any}
					kind={RULE_KIND[ruleKey]}
					devices={devices.data ?? []}
					serverPathFlavor={serverPathFlavor}
					emptyLabel={ts(directory ? "dirListEmpty" : "cmdListEmpty")}
					placeholder={ts(directory ? "dirListPlaceholder" : "cmdListPlaceholder")}
					onCreate={(rule) => commit([...rules, rule as Rule])}
					onUpdate={(index, rule) =>
						commit(rules.map((item, itemIndex) => (itemIndex === index ? (rule as Rule) : item)))
					}
					onDelete={(index) => commit(rules.filter((_, itemIndex) => itemIndex !== index))}
				/>
			) : (
				<Text size="sm" c="dimmed">
					{rules.length === 0
						? ts(directory ? "dirListEmpty" : "cmdListEmpty")
						: t("settingsPage.rulesCount", { count: rules.length })}
				</Text>
			)}
			<SaveState pending={update.isPending} error={update.error} />
		</Stack>
	);
}

export function ProjectCommandsEditor({
	project,
	canManage,
}: {
	project: ApiEntity;
	canManage: boolean;
}) {
	const { t } = useTranslation("projects");
	const update = useUpdateProject();
	const stored = projectChapterSettings(project).commands;
	const commands: CommandDef[] = Array.isArray(stored) ? (stored as CommandDef[]) : [];
	if (!canManage)
		return (
			<Stack gap={4}>
				{commands.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("commandEmpty")}
					</Text>
				) : (
					commands.map((command) => (
						<Text
							key={command.name}
							size="sm"
							style={{ fontFamily: "var(--mantine-font-family-monospace)" }}
						>
							/{command.name}
						</Text>
					))
				)}
			</Stack>
		);
	return (
		<Stack gap="xs">
			<CommandsEditor
				commands={commands}
				onChange={(next) =>
					update.mutate({ id: String(project.id), data: { chapterSettings: { commands: next } } })
				}
				ns="projects"
			/>
			<SaveState pending={update.isPending} error={update.error} />
		</Stack>
	);
}
