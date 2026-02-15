import { ActionIcon, Group, Tabs, Text, Tooltip } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateTerminal, useDeleteTerminal, useTerminals } from "../../hooks/useTerminals";
import { TerminalPanel } from "./TerminalPanel";

interface TerminalTabsProps {
	chapterId: string;
}

export function TerminalTabs({ chapterId }: TerminalTabsProps) {
	const { data: terminals } = useTerminals(chapterId);
	const createTerminal = useCreateTerminal(chapterId);
	const deleteTerminal = useDeleteTerminal(chapterId);
	const [activeTab, setActiveTab] = useState<string | null>(null);
	const { t } = useTranslation("terminal");

	const runningTerminals = (terminals ?? []).filter((t: any) => t.status === "running");

	// Auto-select first terminal if current selection is gone
	useEffect(() => {
		if (activeTab && !runningTerminals.some((t: any) => t.id === activeTab)) {
			setActiveTab(runningTerminals[0]?.id ?? null);
		}
		if (!activeTab && runningTerminals.length > 0) {
			setActiveTab(runningTerminals[0].id);
		}
	}, [activeTab, runningTerminals]);

	const handleCreate = () => {
		const name = `Terminal ${(terminals?.length ?? 0) + 1}`;
		createTerminal.mutate(
			{ name },
			{
				onSuccess: (newTerm: any) => setActiveTab(newTerm.id),
			},
		);
	};

	const handleClose = (e: React.MouseEvent, terminalId: string) => {
		e.stopPropagation();
		deleteTerminal.mutate(terminalId);
	};

	if (runningTerminals.length === 0) {
		return (
			<Group justify="center" align="center" h="100%" gap="xs">
				<Text size="sm" c="dimmed">
					{t("noTerminals")}
				</Text>
				<Tooltip label={t("newTerminal")}>
					<ActionIcon variant="light" onClick={handleCreate} loading={createTerminal.isPending}>
						<IconPlus size={16} />
					</ActionIcon>
				</Tooltip>
			</Group>
		);
	}

	return (
		<Tabs
			value={activeTab}
			onChange={setActiveTab}
			style={{ height: "100%", display: "flex", flexDirection: "column" }}
		>
			<Group gap={0}>
				<Tabs.List>
					{runningTerminals.map((t: any) => (
						<Tabs.Tab
							key={t.id}
							value={t.id}
							rightSection={
								<ActionIcon size="xs" variant="subtle" onClick={(e) => handleClose(e, t.id)}>
									<IconX size={12} />
								</ActionIcon>
							}
						>
							{t.name}
						</Tabs.Tab>
					))}
				</Tabs.List>
				<Tooltip label={t("newTerminal")}>
					<ActionIcon
						variant="subtle"
						onClick={handleCreate}
						loading={createTerminal.isPending}
						ml={4}
					>
						<IconPlus size={16} />
					</ActionIcon>
				</Tooltip>
			</Group>

			{runningTerminals.map((t: any) => (
				<Tabs.Panel key={t.id} value={t.id} style={{ flex: 1, minHeight: 0 }}>
					<TerminalPanel terminalId={t.id} />
				</Tabs.Panel>
			))}
		</Tabs>
	);
}
