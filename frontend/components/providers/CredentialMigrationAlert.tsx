import { Alert, List, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

interface Source {
	groupId: string;
	kind: "codex" | "api" | "nug" | "builtin";
	label?: string;
}

interface Conflict {
	id: string;
	sources: Source[];
}

interface SettingsWithConflicts {
	credentialMigrationConflicts?: Conflict[];
	customApiProviders?: Array<{ id: string; name: string }>;
	nugProviders?: Array<{ id: string; name: string }>;
}

const BUILT_IN: Record<string, string> = { tokendance: "TokenDance", CommandCode: "Command Code" };

/** Credentials that share an id stop the move to credentials.json until one is removed. */
export function CredentialMigrationAlert({ settings }: { settings: unknown }) {
	const { t } = useTranslation("settings");
	const data = settings as SettingsWithConflicts | undefined;
	const conflicts = data?.credentialMigrationConflicts ?? [];
	if (conflicts.length === 0) return null;
	const groupName = ({ kind, groupId }: Source) => {
		if (kind === "codex") return "Codex";
		if (kind === "builtin") return BUILT_IN[groupId] ?? groupId;
		const list = kind === "nug" ? data?.nugProviders : data?.customApiProviders;
		return list?.find((p) => p.id === groupId)?.name ?? groupId;
	};
	return (
		<Alert color="yellow" variant="light" title={t("credentialMigrationConflict.title")}>
			<Text size="sm">{t("credentialMigrationConflict.description")}</Text>
			<List size="sm" mt="xs">
				{conflicts.map((conflict) => (
					<List.Item key={conflict.id}>
						<code>{conflict.id}</code>:{" "}
						{conflict.sources
							.map((s) => (s.label ? `${groupName(s)} · ${s.label}` : groupName(s)))
							.join(" / ")}
					</List.Item>
				))}
			</List>
		</Alert>
	);
}
