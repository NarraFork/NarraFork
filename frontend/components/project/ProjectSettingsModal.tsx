import { Button, Divider, Modal, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../../hooks/usePlatform";
import { useUpdateProject } from "../../hooks/useProjects";
import { api } from "../../lib/api";
import type {
	CommandBlacklistRuleInput,
	CommandWhitelistRuleInput,
	DirectoryBlacklistRuleInput,
	DirectoryWhitelistRuleInput,
	PathFlavor,
} from "../../lib/api/types";
import { normalizeRuleTargetSelector } from "../../lib/api/types";
import { PermissionRuleEditor } from "../permissions/PermissionRuleEditor";
import { TraitLayerEditor } from "../settings/TraitLayerEditor";
import { ProjectAccessPanel } from "./ProjectAccessPanel";

interface ProjectSettingsModalProps {
	projectId: string;
	proxyDomain: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	chapterSettings: any;
	opened: boolean;
	onClose: () => void;
}

function normalizeRules<T extends { selector: ReturnType<typeof normalizeRuleTargetSelector> }>(
	rules: Array<Record<string, unknown>> | undefined,
): T[] {
	return (rules ?? []).map((rule) => ({
		...rule,
		selector: normalizeRuleTargetSelector(rule),
	})) as T[];
}

export function ProjectSettingsModal({
	projectId,
	proxyDomain,
	chapterSettings,
	opened,
	onClose,
}: ProjectSettingsModalProps) {
	const { t } = useTranslation("projects");
	const { t: ts } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const update = useUpdateProject();
	const platform = usePlatform();
	const serverPathFlavor: PathFlavor = platform === "windows" ? "windows" : "posix";
	const { data: permissionDevices = [] } = useQuery({
		queryKey: ["permission-rule-devices"],
		queryFn: api.listDevices,
		staleTime: 30_000,
		enabled: opened,
	});
	const [domain, setDomain] = useState(proxyDomain ?? "");
	const normalized = domain.trim().toLowerCase();
	const hasInvalidChars = /[^a-z0-9.-]/.test(normalized);
	const hasConsecutiveDots = normalized.includes("..");
	const validShape =
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/.test(
			normalized,
		);
	const domainError =
		normalized.length === 0
			? null
			: hasInvalidChars || hasConsecutiveDots || !validShape
				? t("proxyDomainInvalid")
				: null;

	const cs =
		typeof chapterSettings === "string"
			? (() => {
					try {
						return JSON.parse(chapterSettings);
					} catch {
						return {};
					}
				})()
			: (chapterSettings ?? {});

	const [whitelistDirs, setWhitelistDirs] = useState<DirectoryWhitelistRuleInput[]>(() =>
		normalizeRules<DirectoryWhitelistRuleInput>(cs.whitelistDirs),
	);
	const [blacklistDirs, setBlacklistDirs] = useState<DirectoryBlacklistRuleInput[]>(() =>
		normalizeRules<DirectoryBlacklistRuleInput>(cs.blacklistDirs),
	);
	const [commandWhitelist, setCommandWhitelist] = useState<CommandWhitelistRuleInput[]>(() =>
		normalizeRules<CommandWhitelistRuleInput>(cs.commandWhitelist),
	);
	const [commandBlacklist, setCommandBlacklist] = useState<CommandBlacklistRuleInput[]>(() =>
		normalizeRules<CommandBlacklistRuleInput>(cs.commandBlacklist),
	);
	const [requireReview, setRequireReview] = useState<boolean>(cs.requireReviewBeforeMerge ?? false);

	useEffect(() => {
		if (opened) {
			setDomain(proxyDomain ?? "");
			const fresh =
				typeof chapterSettings === "string"
					? (() => {
							try {
								return JSON.parse(chapterSettings);
							} catch {
								return {};
							}
						})()
					: (chapterSettings ?? {});
			setWhitelistDirs(normalizeRules<DirectoryWhitelistRuleInput>(fresh.whitelistDirs));
			setBlacklistDirs(normalizeRules<DirectoryBlacklistRuleInput>(fresh.blacklistDirs));
			setCommandWhitelist(normalizeRules<CommandWhitelistRuleInput>(fresh.commandWhitelist));
			setCommandBlacklist(normalizeRules<CommandBlacklistRuleInput>(fresh.commandBlacklist));
			setRequireReview(fresh.requireReviewBeforeMerge ?? false);
		}
	}, [opened, proxyDomain, chapterSettings]);

	const handleSave = () => {
		if (domainError) return;
		update.mutate(
			{
				id: projectId,
				data: {
					proxyDomain: normalized || null,
					chapterSettings: {
						whitelistDirs,
						blacklistDirs,
						commandWhitelist,
						commandBlacklist,
						requireReviewBeforeMerge: requireReview,
					},
				},
			},
			{ onSuccess: onClose },
		);
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("settingsTitle")} size="lg">
			<Stack>
				<TextInput
					label={t("proxyDomain")}
					description={t("proxyDomainDesc")}
					placeholder="dev.example.com"
					value={domain}
					onChange={(e) => setDomain(e.currentTarget.value)}
					error={domainError}
				/>
				<Text size="xs" c="dimmed">
					{t("proxyDomainHint")}
				</Text>

				<Title order={5} mt="sm">
					{t("projectWhitelistDirs")}
				</Title>
				<Text size="xs" c="dimmed">
					{t("projectWhitelistDirsDesc")}
				</Text>
				<PermissionRuleEditor
					rules={whitelistDirs}
					kind="directoryWhitelist"
					devices={permissionDevices}
					serverPathFlavor={serverPathFlavor}
					emptyLabel={ts("dirListEmpty")}
					placeholder={ts("dirListPlaceholder")}
					onCreate={(rule) =>
						setWhitelistDirs([...whitelistDirs, rule as DirectoryWhitelistRuleInput])
					}
					onUpdate={(index, rule) =>
						setWhitelistDirs(
							whitelistDirs.map((item, itemIndex) =>
								itemIndex === index ? (rule as DirectoryWhitelistRuleInput) : item,
							),
						)
					}
					onDelete={(index) =>
						setWhitelistDirs(whitelistDirs.filter((_, itemIndex) => itemIndex !== index))
					}
				/>

				<Title order={5} mt="sm">
					{t("projectBlacklistDirs")}
				</Title>
				<Text size="xs" c="dimmed">
					{t("projectBlacklistDirsDesc")}
				</Text>
				<PermissionRuleEditor
					rules={blacklistDirs}
					kind="directoryBlacklist"
					devices={permissionDevices}
					serverPathFlavor={serverPathFlavor}
					emptyLabel={ts("dirListEmpty")}
					placeholder={ts("dirListPlaceholder")}
					onCreate={(rule) =>
						setBlacklistDirs([...blacklistDirs, rule as DirectoryBlacklistRuleInput])
					}
					onUpdate={(index, rule) =>
						setBlacklistDirs(
							blacklistDirs.map((item, itemIndex) =>
								itemIndex === index ? (rule as DirectoryBlacklistRuleInput) : item,
							),
						)
					}
					onDelete={(index) =>
						setBlacklistDirs(blacklistDirs.filter((_, itemIndex) => itemIndex !== index))
					}
				/>

				<Title order={5} mt="sm">
					{t("projectCommandWhitelist")}
				</Title>
				<Text size="xs" c="dimmed">
					{t("projectCommandWhitelistDesc")}
				</Text>
				<PermissionRuleEditor
					rules={commandWhitelist}
					kind="commandWhitelist"
					devices={permissionDevices}
					serverPathFlavor={serverPathFlavor}
					emptyLabel={ts("cmdListEmpty")}
					placeholder={ts("cmdListPlaceholder")}
					onCreate={(rule) =>
						setCommandWhitelist([...commandWhitelist, rule as CommandWhitelistRuleInput])
					}
					onUpdate={(index, rule) =>
						setCommandWhitelist(
							commandWhitelist.map((item, itemIndex) =>
								itemIndex === index ? (rule as CommandWhitelistRuleInput) : item,
							),
						)
					}
					onDelete={(index) =>
						setCommandWhitelist(commandWhitelist.filter((_, itemIndex) => itemIndex !== index))
					}
				/>

				<Title order={5} mt="sm">
					{t("projectCommandBlacklist")}
				</Title>
				<Text size="xs" c="dimmed">
					{t("projectCommandBlacklistDesc")}
				</Text>
				<PermissionRuleEditor
					rules={commandBlacklist}
					kind="commandBlacklist"
					devices={permissionDevices}
					serverPathFlavor={serverPathFlavor}
					emptyLabel={ts("cmdListEmpty")}
					placeholder={ts("cmdListPlaceholder")}
					onCreate={(rule) =>
						setCommandBlacklist([...commandBlacklist, rule as CommandBlacklistRuleInput])
					}
					onUpdate={(index, rule) =>
						setCommandBlacklist(
							commandBlacklist.map((item, itemIndex) =>
								itemIndex === index ? (rule as CommandBlacklistRuleInput) : item,
							),
						)
					}
					onDelete={(index) =>
						setCommandBlacklist(commandBlacklist.filter((_, itemIndex) => itemIndex !== index))
					}
				/>

				<Title order={5} mt="sm">
					{t("requireReviewBeforeMerge")}
				</Title>
				<Switch
					label={t("requireReviewBeforeMergeDesc")}
					checked={requireReview}
					onChange={(e) => setRequireReview(e.currentTarget.checked)}
				/>

				<Button onClick={handleSave} loading={update.isPending} disabled={!!domainError}>
					{tc("save")}
				</Button>

				<Divider />

				{/* Membership. Like the trait layer below, it applies its own changes
				    immediately rather than through the modal's Save: revoking access is not
				    something to leave staged and ambiguous. */}
				<Title order={5}>{t("access.membersTitle")}</Title>
				<ProjectAccessPanel projectId={projectId} />

				<Divider />

				{/* Project trait layer. It has its own per-trait save buttons, so it sits
				    below the modal's main Save rather than being folded into it. */}
				<Title order={5}>{ts("traitLayerProjectTitle")}</Title>
				<Text size="sm" c="dimmed">
					{ts("traitLayerProjectDesc")}
				</Text>
				<TraitLayerEditor layer="project" ownerId={projectId} />
			</Stack>
		</Modal>
	);
}
