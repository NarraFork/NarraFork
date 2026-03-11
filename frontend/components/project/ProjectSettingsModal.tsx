import { Button, Modal, Stack, Text, TextInput, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateProject } from "../../hooks/useProjects";
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

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
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

	useEffect(() => {
		if (opened) {
			setDomain(proxyDomain ?? "");
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
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
		}
	}, [opened, proxyDomain, chapterSettings]);

	const handleSave = () => {
		if (domainError) return;
		update.mutate(
			{
				id: projectId,
				data: {
					proxyDomain: normalized || null,
					chapterSettings: { whitelistDirs, blacklistDirs },
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

				<Button onClick={handleSave} loading={update.isPending} disabled={!!domainError}>
					{tc("save")}
				</Button>
			</Stack>
		</Modal>
	);
}
