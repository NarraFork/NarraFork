/**
 * The editors of the project settings page (R2; moved from the old settings dialog), each saving
 * its own change at once ("更改会自动保存"):
 *
 *  - `ProjectBasicsForm`: name, description and the project directory, saved when a field is left
 *    (a blank name or directory is not sent);
 *  - `ProjectRuleList`: one permission rule list of `chapterSettings` (directory or command white /
 *    black list), saved on every add, edit or removal — only that key is sent, the server merges;
 *  - `ProjectCommandsEditor`: the project's slash commands.
 */
import { Alert, Group, Loader, Stack, Text, Textarea, TextInput } from "@mantine/core";
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
	const [name, setName] = useState(String(project.name ?? ""));
	const [description, setDescription] = useState(String(project.description ?? ""));
	const [gitPath, setGitPath] = useState(String(project.gitPath ?? ""));
	// Follow the stored values until the person edits a field.
	const touched = useRef(false);
	useEffect(() => {
		if (touched.current) return;
		setName(String(project.name ?? ""));
		setDescription(String(project.description ?? ""));
		setGitPath(String(project.gitPath ?? ""));
	}, [project.name, project.description, project.gitPath]);
	const save = (field: "name" | "description" | "gitPath", value: string) => {
		const trimmed = value.trim();
		const current = String(project[field] ?? "");
		if (trimmed === current.trim()) return;
		if ((field === "name" || field === "gitPath") && !trimmed) return;
		update.mutate({ id: projectId, data: { [field]: trimmed } });
	};
	return (
		<Stack gap="sm" data-testid="project-basics">
			<TextInput
				label={t("projectName")}
				value={name}
				required
				disabled={!canManage}
				error={!name.trim() ? t("projectNameRequired") : undefined}
				onChange={(event) => {
					touched.current = true;
					setName(event.currentTarget.value);
				}}
				onBlur={() => save("name", name)}
			/>
			<Textarea
				label={t("projectDescription")}
				value={description}
				autosize
				minRows={1}
				disabled={!canManage}
				onChange={(event) => {
					touched.current = true;
					setDescription(event.currentTarget.value);
				}}
				onBlur={() => save("description", description)}
			/>
			<TextInput
				label={t("repositoryPath")}
				description={t("defaultDirectoryHint")}
				value={gitPath}
				required
				disabled={!canManage}
				styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
				error={!gitPath.trim() ? t("repoPathRequired") : undefined}
				onChange={(event) => {
					touched.current = true;
					setGitPath(event.currentTarget.value);
				}}
				onBlur={() => save("gitPath", gitPath)}
			/>
			<SaveState pending={update.isPending} error={update.error} />
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
	const [rules, setRules] = useState<Rule[]>(() => normalizeRules(stored));
	const touched = useRef(false);
	const storedText = JSON.stringify(stored ?? []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: follows the stored list by value
	useEffect(() => {
		if (!touched.current) setRules(normalizeRules(stored));
	}, [storedText]);
	const commit = (next: Rule[]) => {
		touched.current = true;
		setRules(next);
		update.mutate({ id: String(project.id), data: { chapterSettings: { [ruleKey]: next } } });
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
