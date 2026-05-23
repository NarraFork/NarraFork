import { Anchor, Group, Stack, Text } from "@mantine/core";
import { IconBrandGithub, IconHistory } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { getMcpProtocolCapability } from "../../hooks/usePlatform";

declare const __APP_VERSION__: string;

export interface AboutSectionProps {
	healthData:
		| {
				commit?: string;
				platform?: string;
				capabilities?: {
					releasePackaging?: {
						buildInfo?: string;
						frontend?: string;
						changelog?: string;
						singleFileEmbedded?: boolean;
					};
					nativeExtensions?: {
						defaultEnabled?: boolean;
						scope?: string;
						browserSessions?: { defaultEnabled?: boolean; storage?: string };
						containerBrowserToolAutoEnable?: { defaultEnabled?: boolean };
					};
					mcp?: {
						builtinProtocol?: {
							supported?: boolean;
							reason?: string;
							initialize?: boolean;
							toolsList?: boolean;
							toolsCall?: boolean;
						};
						toolsList?: {
							supported?: boolean;
							reason?: string;
							source?: string;
						};
						toolsCall?: {
							supported?: boolean;
							reason?: string;
							scope?: string;
						};
					};
					runtime?: {
						backend?: string;
						buildChannel?: string;
					};
				};
		  }
		| undefined;
}

export function AboutSection({ healthData }: AboutSectionProps) {
	const { t } = useTranslation("settings");
	const releasePackaging = healthData?.capabilities?.releasePackaging;
	const nativeExtensions = healthData?.capabilities?.nativeExtensions;
	const mcpProtocol = healthData?.capabilities?.mcp
		? getMcpProtocolCapability(healthData.capabilities)
		: undefined;
	const mcpBuiltinProtocol = mcpProtocol?.builtinProtocol;
	const mcpToolsMetadata =
		healthData?.capabilities?.mcp?.toolsList || healthData?.capabilities?.mcp?.toolsCall
			? mcpProtocol
			: undefined;
	const runtime = healthData?.capabilities?.runtime;

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
			{(releasePackaging ||
				nativeExtensions ||
				mcpBuiltinProtocol ||
				mcpToolsMetadata ||
				runtime) && (
				<Stack gap={4}>
					{runtime && (runtime.backend || runtime.buildChannel) && (
						<Text size="sm" c="dimmed">
							<Text span fw={500} c="dimmed">
								{t("runtimeBackend")}:
							</Text>{" "}
							backend={runtime.backend ?? "—"}, buildChannel={runtime.buildChannel ?? "—"}
						</Text>
					)}
					{releasePackaging && (
						<Text size="sm" c="dimmed">
							<Text span fw={500} c="dimmed">
								{t("runtimeReleasePackaging")}:
							</Text>{" "}
							buildInfo={releasePackaging.buildInfo ?? "—"}, frontend=
							{releasePackaging.frontend ?? "—"}, changelog={releasePackaging.changelog ?? "—"},
							singleFileEmbedded={releasePackaging.singleFileEmbedded ? t("yes") : t("no")}
						</Text>
					)}
					{nativeExtensions && (
						<Text size="sm" c="dimmed">
							<Text span fw={500} c="dimmed">
								{t("runtimeNativeExtensions")}:
							</Text>{" "}
							scope={nativeExtensions.scope ?? "—"}, defaultEnabled=
							{nativeExtensions.defaultEnabled ? t("yes") : t("no")},
							browserSessions.defaultEnabled=
							{nativeExtensions.browserSessions?.defaultEnabled ? t("yes") : t("no")},
							containerBrowserToolAutoEnable.defaultEnabled=
							{nativeExtensions.containerBrowserToolAutoEnable?.defaultEnabled ? t("yes") : t("no")}
						</Text>
					)}
					{mcpBuiltinProtocol && (
						<Text size="sm" c="dimmed">
							<Text span fw={500} c="dimmed">
								{t("runtimeMcpBuiltinProtocol")}:
							</Text>{" "}
							supported={mcpBuiltinProtocol.supported ? t("yes") : t("no")}, initialize=
							{mcpBuiltinProtocol.initialize ? t("yes") : t("no")}, toolsList=
							{mcpBuiltinProtocol.toolsList ? t("yes") : t("no")}, toolsCall=
							{mcpBuiltinProtocol.toolsCall ? t("yes") : t("no")}
						</Text>
					)}
					{mcpToolsMetadata && (
						<Text size="sm" c="dimmed">
							<Text span fw={500} c="dimmed">
								{t("runtimeMcpTools")}:
							</Text>{" "}
							toolsList={mcpToolsMetadata.toolsList.supported ? t("yes") : t("no")}, source=
							{mcpToolsMetadata.toolsList.source ?? "—"}, toolsCall=
							{mcpToolsMetadata.toolsCall.supported ? t("yes") : t("no")}, scope=
							{mcpToolsMetadata.toolsCall.scope ?? "—"}
						</Text>
					)}
				</Stack>
			)}
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
