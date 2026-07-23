import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { ActionIcon, Box, CloseButton, Drawer, Group, ScrollArea, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconArrowLeft } from "@tabler/icons-react";
import React from "react";
import { useTranslation } from "react-i18next";

export interface ProviderDetailPanelProps {
	/** Currently selected provider prefix, or null if none. */
	selectedProvider: string | null;
	/** Display name for the selected provider. */
	providerLabel: string;
	onClose: () => void;
	children: React.ReactNode;
}

/**
 * Right-side detail panel for provider configuration.
 * - Desktop (≥ Mantine sm): inline side panel with border
 * - Mobile (< Mantine sm): full-screen Drawer
 */
export const ProviderDetailPanel = React.memo(function ProviderDetailPanel({
	selectedProvider,
	providerLabel,
	onClose,
	children,
}: ProviderDetailPanelProps) {
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const { t } = useTranslation("settings");

	if (!selectedProvider) return null;

	if (isMobile) {
		return (
			<Drawer
				opened
				onClose={onClose}
				position="right"
				size="100%"
				title={
					<Group gap="xs">
						<ActionIcon variant="subtle" onClick={onClose}>
							<IconArrowLeft size={18} />
						</ActionIcon>
						<Text fw={600}>{providerLabel}</Text>
					</Group>
				}
				styles={{
					body: { padding: "0 16px 16px" },
					header: { paddingBottom: 0 },
				}}
			>
				{children}
			</Drawer>
		);
	}

	return (
		<Box
			w={520}
			miw={520}
			h="100%"
			style={{
				borderLeft: "1px solid var(--mantine-color-dark-4)",
				display: "flex",
				flexDirection: "column",
				flexShrink: 0,
			}}
		>
			<Group gap="xs" p="sm" pb="xs" wrap="nowrap">
				<Text fw={600} size="sm" style={{ flex: 1 }}>
					{providerLabel} {t("overviewSettings")}
				</Text>
				<CloseButton size="sm" onClick={onClose} />
			</Group>
			<ScrollArea style={{ flex: 1 }} p="sm" pt={0}>
				{children}
			</ScrollArea>
		</Box>
	);
});
