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
 *  - `ProjectCommandsEditor`: the project's slash commands;
 *  - `ProjectTeamDefaults`: the base branch and work start new teams of the project start from.
 */
import {
	Alert,
	Button,
	Group,
	Loader,
	Modal,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
	// Each edit bumps its field's revision; a save settles the field only if nothing was typed
	// after it was sent, so a late success never discards a newer edit.
	const revisions = useRef<Record<string, number>>({});
	const [failed, setFailed] = useState<Partial<Record<BasicsField | "gitPath", string>>>({});
	const [confirming, setConfirming] = useState(false);
	const shown = (field: BasicsField | "gitPath") => drafts[field] ?? stored[field];
	const edit = (field: BasicsField | "gitPath", value: string) => {
		revisions.current[field] = (revisions.current[field] ?? 0) + 1;
		setDrafts((current) => ({ ...current, [field]: value }));
	};
	const settle = (field: BasicsField | "gitPath") => {
		setDrafts(({ [field]: _done, ...rest }) => rest);
		setFailed(({ [field]: _done, ...rest }) => rest);
	};
	const send = (field: BasicsField | "gitPath", value: string) => {
		const revision = revisions.current[field] ?? 0;
		const current = () => (revisions.current[field] ?? 0) === revision;
		update.mutate(
			{ id: projectId, data: { [field]: value } },
			{
				// Typed more since: that newer draft stays, to be saved when the field is left.
				onSuccess: () => {
					if (current()) settle(field);
				},
				// The draft stays, marked unsaved, so a failed save never looks saved.
				onError: (error: Error) => {
					if (current()) setFailed((failedNow) => ({ ...failedNow, [field]: error.message }));
				},
			},
		);
	};
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
	const storedText = JSON.stringify(stored ?? []);
	// The list shown is the stored one, or the person's latest list while it is being saved and
	// until the stored list moves past what it was when they first changed it (the saved row is
	// written to the cache; a refetch follows). Every edit builds on the list shown, so a second
	// deletion right after a first one never brings the first back. Saves are serialized: an
	// edit made while one is in flight is sent after it (only the latest). A failed save puts the
	// stored list back, and the error says so.
	const [local, setLocal] = useState<{ rules: Rule[]; base: string } | null>(null);
	const saving = useRef(false);
	const queued = useRef<Rule[] | null>(null);
	useEffect(() => {
		if (local && !saving.current && storedText !== local.base) setLocal(null);
	}, [storedText, local]);
	const rules = local?.rules ?? normalizeRules(stored);
	// The queue drains from the mutation's promise, not a per-call observer callback: TanStack
	// Query drops those once the page unmounts, so leaving settings mid-save would lose the
	// queued list. The promise settles whatever the page's lifetime.
	const send = (next: Rule[]) => {
		saving.current = true;
		update
			.mutateAsync({ id: String(project.id), data: { chapterSettings: { [ruleKey]: next } } })
			.then(
				() => {
					const after = queued.current;
					queued.current = null;
					if (after) send(after);
					else saving.current = false;
				},
				() => {
					saving.current = false;
					queued.current = null;
					setLocal(null);
				},
			);
	};
	const commit = (next: Rule[]) => {
		setLocal((current) => ({ rules: next, base: current?.base ?? storedText }));
		if (saving.current) queued.current = next;
		else send(next);
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

type WorkStartDefault = "auto" | "remote" | "local";

/** The project's default work start from its `chapterSettings.teams` (`auto` when unset). */
export function projectWorkStartDefault(project: ApiEntity | undefined): WorkStartDefault {
	const teams = projectChapterSettings(project).teams as { workStart?: unknown } | undefined;
	return teams?.workStart === "remote" || teams?.workStart === "local" ? teams.workStart : "auto";
}

/**
 * The project's `chapterSettings.teams` with a new default work start, its other team settings
 * (exclusive paths) kept: the server merges `chapterSettings` one key deep.
 */
export function teamsWithWorkStart(
	project: ApiEntity | undefined,
	value: WorkStartDefault,
): Record<string, unknown> {
	const teams = projectChapterSettings(project).teams;
	const { workStart: _previous, ...rest } =
		teams && typeof teams === "object" ? (teams as Record<string, unknown>) : {};
	return value === "auto" ? rest : { ...rest, workStart: value };
}

/**
 * The defaults new teams of this project start from (W): the base branch (`defaultBranch`, saved
 * when the field is left) and where their work items start (`chapterSettings.teams.workStart`:
 * from `origin/<base>`, the local base, or by hosting — origin on GitHub starts from origin).
 * Only the `teams` key is sent, with the project's other team settings kept.
 */
export function ProjectTeamDefaults({
	project,
	canManage,
}: {
	project: ApiEntity;
	canManage: boolean;
}) {
	const { t } = useTranslation("projects");
	const update = useUpdateProject();
	const projectId = String(project.id);
	const storedBranch = String(project.defaultBranch ?? "main");
	const [branch, setBranch] = useState<string | null>(null);
	const shownBranch = branch ?? storedBranch;
	const branchInvalid = !!shownBranch.trim() && !/^[^\s~^:?*[\\]+$/.test(shownBranch.trim());
	const saveBranch = () => {
		if (branch === null) return;
		const next = branch.trim();
		if (!next || next === storedBranch || branchInvalid) {
			if (next === storedBranch) setBranch(null);
			return;
		}
		update.mutate(
			{ id: projectId, data: { defaultBranch: next } },
			{ onSuccess: () => setBranch(null) },
		);
	};
	const workStart = projectWorkStartDefault(project);
	const saveWorkStart = (value: WorkStartDefault) =>
		update.mutate({
			id: projectId,
			data: { chapterSettings: { teams: teamsWithWorkStart(project, value) } },
		});
	const base = shownBranch.trim() || "main";
	return (
		<Stack gap="sm" data-testid="project-team-defaults">
			<Text size="sm" fw={600}>
				{t("settingsPage.teamDefaults.title")}
			</Text>
			<TextInput
				label={t("settingsPage.teamDefaults.baseBranch")}
				description={t("settingsPage.teamDefaults.baseBranchHint")}
				value={shownBranch}
				disabled={!canManage}
				error={branchInvalid ? t("teams.create.baseBranchInvalid") : undefined}
				onChange={(event) => setBranch(event.currentTarget.value)}
				onBlur={saveBranch}
				data-testid="project-default-branch"
			/>
			<Select
				label={t("settingsPage.teamDefaults.workStart")}
				description={t("settingsPage.teamDefaults.workStartHint")}
				value={workStart}
				allowDeselect={false}
				disabled={!canManage}
				onChange={(value) => {
					if (value === "auto" || value === "remote" || value === "local") saveWorkStart(value);
				}}
				data={[
					{ value: "auto", label: t("settingsPage.teamDefaults.auto") },
					{ value: "remote", label: t("teams.page.settings.workStart.remote", { base }) },
					{ value: "local", label: t("teams.page.settings.workStart.local", { base }) },
				]}
				data-testid="project-work-start"
			/>
			<SaveState pending={update.isPending} error={update.error} />
		</Stack>
	);
}
