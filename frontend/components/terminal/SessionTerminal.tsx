import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateNarratorTerminal,
	useDeleteNarratorTerminal,
	useNarratorTerminals,
} from "../../hooks/useTerminals";
import {
	useCreateTerminalTab,
	useDeleteTerminalTab,
	useReorderTerminalTabs,
	useTerminalTabs,
	useUpdateTerminalTab,
} from "../../hooks/useTerminalTabs";
import { useTerminalViewState } from "../../hooks/useTerminalViewState";
import { getTerminalWSManager } from "../../hooks/useTerminalWS";
import { LayoutSelector, type TerminalLayout } from "./LayoutSelector";
import { TerminalGrid } from "./TerminalGrid";
import { TerminalTabBar } from "./TerminalTabBar";

interface SessionTerminalProps {
	narratorId: string;
	onSendToChat?: (text: string) => void;
	onWriteRef?: (write: ((text: string) => void) | null) => void;
	onExit?: (code: number) => void;
}

export function SessionTerminal({
	narratorId,
	onSendToChat,
	onWriteRef,
	onExit,
}: SessionTerminalProps) {
	const ctx = useMemo(() => ({ narratorId }), [narratorId]);
	const { data: terminals } = useNarratorTerminals(narratorId);
	const { data: tabs } = useTerminalTabs(ctx);
	const createTerminal = useCreateNarratorTerminal(narratorId);
	const deleteTerminal = useDeleteNarratorTerminal(narratorId);
	const createTab = useCreateTerminalTab(ctx);
	const updateTab = useUpdateTerminalTab(ctx);
	const deleteTab = useDeleteTerminalTab(ctx);
	const reorderTabs = useReorderTerminalTabs(ctx);
	const viewState = useTerminalViewState(ctx);
	const { t } = useTranslation("terminal");

	const runningTerminals = (terminals ?? []).filter((t: any) => t.status === "running");
	const tabList = tabs ?? [];
	const layout = (viewState.data?.layout ?? "single") as TerminalLayout;
	const [activeTabId, setActiveTabId] = useState<string | null>(
		viewState.data?.activeTabId ?? null,
	);

	// Expose write function to parent — writes to the first running terminal
	const writeRef = useRef(onWriteRef);
	writeRef.current = onWriteRef;
	useEffect(() => {
		if (runningTerminals.length > 0) {
			const termId = runningTerminals[0].id;
			writeRef.current?.((text: string) => getTerminalWSManager().sendInput(termId, text));
		} else {
			writeRef.current?.(null);
		}
	}, [runningTerminals]);

	// Sync active tab from view state on load
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeTabId intentionally excluded — only sync once when view state loads
	useEffect(() => {
		if (viewState.data?.activeTabId && !activeTabId) {
			setActiveTabId(viewState.data.activeTabId);
		}
	}, [viewState.data?.activeTabId]);

	// Auto-select first tab if current is gone
	// biome-ignore lint/correctness/useExhaustiveDependencies: viewState.update is stable, adding it would cause unnecessary re-renders
	useEffect(() => {
		if (activeTabId && !tabList.some((t: any) => t.id === activeTabId)) {
			const first = tabList[0]?.id ?? null;
			setActiveTabId(first);
			viewState.update({ activeTabId: first });
		}
	}, [activeTabId, tabList]);

	// Build panel → terminal mapping
	const panelTerminals = useMemo(() => {
		const map = new Map<number, string>();
		for (let i = 0; i < runningTerminals.length; i++) {
			map.set(i, runningTerminals[i].id);
		}
		return map;
	}, [runningTerminals]);

	const handleCreate = useCallback(() => {
		const name = `Terminal ${(tabList.length ?? 0) + 1}`;
		createTerminal.mutate(
			{ name },
			{
				onSuccess: () => {
					createTab.mutate(
						{ name },
						{
							onSuccess: (newTab: any) => {
								setActiveTabId(newTab.id);
								viewState.update({ activeTabId: newTab.id });
							},
						},
					);
				},
			},
		);
	}, [tabList, createTerminal, createTab, viewState]);

	const handleClose = useCallback(
		(tabId: string) => {
			const tabIdx = tabList.findIndex((t: any) => t.id === tabId);
			const terminal = runningTerminals[tabIdx];
			if (terminal) {
				deleteTerminal.mutate(terminal.id);
			}
			deleteTab.mutate(tabId);
		},
		[tabList, runningTerminals, deleteTerminal, deleteTab],
	);

	const handleExit = useCallback(
		(_terminalId: string, code: number) => {
			onExit?.(code);
		},
		[onExit],
	);

	const handleLayoutChange = useCallback(
		(newLayout: TerminalLayout) => {
			viewState.update({ layout: newLayout });
		},
		[viewState],
	);

	const handleTabSelect = useCallback(
		(tabId: string) => {
			setActiveTabId(tabId);
			viewState.update({ activeTabId: tabId });
		},
		[viewState],
	);

	if (runningTerminals.length === 0 && tabList.length === 0) {
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
		<Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
			<Group gap={4} px={4} py={2} justify="space-between" style={{ flexShrink: 0 }}>
				<TerminalTabBar
					tabs={tabList}
					activeTabId={activeTabId}
					onSelect={handleTabSelect}
					onClose={handleClose}
					onCreate={handleCreate}
					onRename={(tabId, name) => updateTab.mutate({ id: tabId, name })}
					onReorder={(ids) => reorderTabs.mutate(ids)}
					createPending={createTerminal.isPending}
				/>
				<LayoutSelector value={layout} onChange={handleLayoutChange} />
			</Group>
			<Box style={{ flex: 1, minHeight: 0 }}>
				<TerminalGrid
					layout={layout}
					panelTerminals={panelTerminals}
					onSendToChat={onSendToChat}
					onExit={handleExit}
				/>
			</Box>
		</Box>
	);
}
