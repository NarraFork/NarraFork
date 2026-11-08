import { ActionIcon, Box, Group, ScrollArea, Stack, Text, Title } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import React from "react";
import { useTranslation } from "react-i18next";

export interface ProviderConfigViewProps {
	providerLabel: string;
	onClose: () => void;
	/** Settings every provider shares, shown above its own sections (e.g. "join auto"). */
	header?: React.ReactNode;
	children: React.ReactNode;
}

export const ProviderConfigView = React.memo(function ProviderConfigView({
	providerLabel,
	onClose,
	header,
	children,
}: ProviderConfigViewProps) {
	const { t } = useTranslation("settings");

	return (
		<Stack gap="md" style={{ height: "100%" }}>
			<Group gap="xs">
				<ActionIcon variant="subtle" onClick={onClose}>
					<IconArrowLeft size={18} />
				</ActionIcon>
				<Title order={3}>{providerLabel}</Title>
			</Group>

			<Text size="sm" c="dimmed">
				{t("providerConfigDesc")}
			</Text>

			<ScrollArea style={{ flex: 1 }} offsetScrollbars scrollbarSize={10}>
				<Box pb="xl" pr="sm">
					{header && <Box mb="md">{header}</Box>}
					{children}
				</Box>
			</ScrollArea>
		</Stack>
	);
});
