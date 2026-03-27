import { Anchor, Group, Stack, Text } from "@mantine/core";
import { IconBrandGithub, IconHistory } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

declare const __APP_VERSION__: string;

export interface AboutSectionProps {
	healthData:
		| {
				commit?: string;
				platform?: string;
		  }
		| undefined;
}

export function AboutSection({ healthData }: AboutSectionProps) {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			<Group gap="lg">
				<Text size="sm">
					<Text span c="dimmed">
						{t("versionLabel")}:
					</Text>{" "}
					v{__APP_VERSION__}
				</Text>
				{healthData?.commit && (
					<Text size="sm">
						<Text span c="dimmed">
							{t("versionCommit")}:
						</Text>{" "}
						{healthData.commit}
					</Text>
				)}
				{healthData?.platform && (
					<Text size="sm">
						<Text span c="dimmed">
							{t("versionPlatform")}:
						</Text>{" "}
						{healthData.platform}
					</Text>
				)}
			</Group>
			<Group gap="xs">
				<Text size="sm" c="dimmed">
					{t("authorsLabel")}:
				</Text>
				<Group gap="xs">
					<Anchor href="https://github.com/domexie" target="_blank" size="sm">
						<Group gap={4}>
							<IconBrandGithub size={14} />
							domexie
						</Group>
					</Anchor>
					<Anchor href="https://github.com/FxRayHughes" target="_blank" size="sm">
						<Group gap={4}>
							<IconBrandGithub size={14} />
							FxRayHughes
						</Group>
					</Anchor>
					<Anchor href="https://github.com/FoskyM" target="_blank" size="sm">
						<Group gap={4}>
							<IconBrandGithub size={14} />
							FoskyM
						</Group>
					</Anchor>
				</Group>
			</Group>
			<Anchor component={Link} to="/changelog" size="sm">
				<Group gap={4}>
					<IconHistory size={14} />
					{t("changelogLink")}
				</Group>
			</Anchor>
		</Stack>
	);
}
