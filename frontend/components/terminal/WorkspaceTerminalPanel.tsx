import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconTerminal, IconX } from "@tabler/icons-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../hooks/useNarrator";
import type { TerminalLeafConfig } from "../narrator/split-tree";
import { NarratorTerminal } from "./NarratorTerminal";

interface WorkspaceTerminalPanelProps {
	config: TerminalLeafConfig;
	leafId: string;
	onClose?: () => void;
	/** Called on pointerdown on the header — allows parent to initiate drag. */
	onHeaderPointerDown?: (e: React.PointerEvent) => void;
}

/**
 * Terminal panel for use inside workspace split-tree.
 * Wraps NarratorTerminal with a small header bar showing context.
 */
export function WorkspaceTerminalPanel({
	config,
	leafId,
	onClose,
	onHeaderPointerDown,
}: WorkspaceTerminalPanelProps) {
	const { t } = useTranslation("terminal");

	const narratorId = config.narratorId ?? "";
	const { data: narrator } = useNarrator(narratorId);
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const narratorTitle = (narrator as any)?.title as string | undefined;

	const headerLabel = narratorTitle
		? t("terminalOf", { name: narratorTitle })
		: narratorId
			? t("terminalOf", { name: narratorId.slice(0, 8) })
			: t("terminal");

	const handleExit = useCallback((_code: number) => {
		// Terminal exited — keep the panel open (user can close manually)
	}, []);

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
			{/* Header bar */}
			<Group
				gap={6}
				px="xs"
				py={3}
				wrap="nowrap"
				onPointerDown={onHeaderPointerDown}
				style={{
					flexShrink: 0,
					borderBottom: "1px solid var(--mantine-color-default-border)",
					backgroundColor: "var(--mantine-color-dark-7)",
					cursor: onHeaderPointerDown ? "grab" : undefined,
				}}
			>
				<IconTerminal size={14} color="var(--mantine-color-dimmed)" />
				<Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
					{headerLabel}
				</Text>
				{onClose && (
					<Tooltip label={t("closeTerminal")}>
						<ActionIcon size="xs" variant="subtle" color="gray" onClick={onClose}>
							<IconX size={12} />
						</ActionIcon>
					</Tooltip>
				)}
			</Group>

			{/* Terminal content */}
			<Box style={{ flex: 1, minHeight: 0 }}>
				{narratorId ? (
					<NarratorTerminal
						key={`${leafId}-${narratorId}`}
						narratorId={narratorId}
						onExit={handleExit}
					/>
				) : (
					<Group justify="center" align="center" h="100%">
						<Text size="sm" c="dimmed">
							{t("noTerminals")}
						</Text>
					</Group>
				)}
			</Box>
		</Box>
	);
}
