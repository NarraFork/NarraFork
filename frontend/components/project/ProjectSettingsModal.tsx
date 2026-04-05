import { Button, Modal, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateProject } from "../../hooks/useProjects";
import { CmdListEditor } from "../common/CmdListEditor";
import { DirListEditor } from "../common/DirListEditor";

interface ProjectSettingsModalProps {
	projectId: string;
	proxyDomain: string | null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	chapterSettings: any;
	opened: boolean;
	onClose: () => void;
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

	const [whitelistDirs, setWhitelistDirs] = useState<
		Array<{ path: string; accessLevel: string; enabled?: boolean }>
	>(cs.whitelistDirs ?? []);
	const [blacklistDirs, setBlacklistDirs] = useState<
		Array<{ path: string; denyLevel: string; enabled?: boolean }>
	>(cs.blacklistDirs ?? []);
	const [commandWhitelist, setCommandWhitelist] = useState<
		Array<{ pattern: string; enabled?: boolean }>
	>(cs.commandWhitelist ?? []);
	const [commandBlacklist, setCommandBlacklist] = useState<
		Array<{ pattern: string; denyPrompt?: string; enabled?: boolean }>
	>(cs.commandBlacklist ?? []);
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
			setWhitelistDirs(fresh.whitelistDirs ?? []);
			setBlacklistDirs(fresh.blacklistDirs ?? []);
			setCommandWhitelist(fresh.commandWhitelist ?? []);
			setCommandBlacklist(fresh.commandBlacklist ?? []);
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
				<DirListEditor
					dirs={whitelistDirs}
					onChange={setWhitelistDirs}
					mode="whitelist"
					labels={{
						empty: ts("dirListEmpty"),
						add: ts("dirListAdd"),
						placeholder: ts("dirListPlaceholder"),
						levels: {
							readOnly: ts("dirAccessReadOnly"),
							readWrite: ts("dirAccessReadWrite"),
							full: ts("dirAccessFull"),
						},
					}}
				/>

				<Title order={5} mt="sm">
					{t("projectBlacklistDirs")}
				</Title>
				<Text size="xs" c="dimmed">
					{t("projectBlacklistDirsDesc")}
				</Text>
				<DirListEditor
					dirs={blacklistDirs}
					onChange={setBlacklistDirs}
					mode="blacklist"
					labels={{
						empty: ts("dirListEmpty"),
						add: ts("dirListAdd"),
						placeholder: ts("dirListPlaceholder"),
						levels: {
							denyWrite: ts("dirDenyWrite"),
							denyAll: ts("dirDenyAll"),
						},
					}}
				/>

				<Title order={5} mt="sm">
					{t("projectCommandWhitelist")}
				</Title>
				<Text size="xs" c="dimmed">
					{t("projectCommandWhitelistDesc")}
				</Text>
				<CmdListEditor
					commands={commandWhitelist}
					onChange={setCommandWhitelist}
					mode="whitelist"
					labels={{
						empty: ts("cmdListEmpty"),
						add: ts("cmdListAdd"),
						placeholder: ts("cmdListPlaceholder"),
					}}
				/>

				<Title order={5} mt="sm">
					{t("projectCommandBlacklist")}
				</Title>
				<Text size="xs" c="dimmed">
					{t("projectCommandBlacklistDesc")}
				</Text>
				<CmdListEditor
					commands={commandBlacklist}
					onChange={setCommandBlacklist}
					mode="blacklist"
					labels={{
						empty: ts("cmdListEmpty"),
						add: ts("cmdListAdd"),
						placeholder: ts("cmdListPlaceholder"),
						denyPromptPlaceholder: ts("cmdDenyPromptPlaceholder"),
					}}
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
			</Stack>
		</Modal>
	);
}
