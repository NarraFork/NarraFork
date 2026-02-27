import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateNarratorTerminal,
	useDeleteNarratorTerminal,
	useNarratorTerminals,
	useRenameTerminal,
} from "../../hooks/useTerminals";
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

/** Extract saved tab order from panelAssignments JSON */
function getSavedOrder(
	panelAssignments: Record<string, string> | null | undefined,
): string[] | null {
	// biome-ignore lint/suspicious/noExplicitAny: stored as generic JSON
	const pa = panelAssignments as any;
	if (pa?.tabOrder && Array.isArray(pa.tabOrder)) return pa.tabOrder;
	return null;
}

/** Sort terminals by a saved order, appending any new ones at the end */
function applyOrder(
	terminals: { id: string; name: string }[],
	savedOrder: string[] | null,
): { id: string; name: string }[] {
	if (!savedOrder || savedOrder.length === 0) return terminals;
	const ordered: { id: string; name: string }[] = [];
	const termMap = new Map(terminals.map((t) => [t.id, t]));
	for (const id of savedOrder) {
		const t = termMap.get(id);
		if (t) ordered.push(t);
	}
	for (const t of terminals) {
		if (!savedOrder.includes(t.id)) ordered.push(t);
	}
	return ordered;
}

export function SessionTerminal({
	narratorId,
	onSendToChat,
	onWriteRef,
	onExit,
}: SessionTerminalProps) {
	const ctx = useMemo(() => ({ narratorId }), [narratorId]);
	const { data: terminals } = useNarratorTerminals(narratorId);
	const createTerminal = useCreateNarratorTerminal(narratorId);
	const deleteTerminal = useDeleteNarratorTerminal(narratorId);
	const renameTerminal = useRenameTerminal(ctx);
	const viewState = useTerminalViewState(ctx);
	const { t } = useTranslation("terminal");

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const runningTerminals = (terminals ?? []).filter((t: any) => t.status === "running");
	const layout = (viewState.data?.layout ?? "single") as TerminalLayout;
	const [activeId, setActiveId] = useState<string | null>(viewState.data?.activeTabId ?? null);

	// Derive tabs from running terminals, sorted by saved order
	const savedOrder = getSavedOrder(viewState.data?.panelAssignments);
	const tabs = useMemo(
		() =>
			applyOrder(
				runningTerminals.map((t: { id: string; name: string }) => ({
					id: t.id,
					name: t.name,
				})),
				savedOrder,
			),
		[runningTerminals, savedOrder],
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: only sync once when view state loads
	useEffect(() => {
		if (viewState.data?.activeTabId && !activeId) {
			setActiveId(viewState.data.activeTabId);
		}
	}, [viewState.data?.activeTabId]);

	// Auto-select first tab if current is gone or none selected
	// biome-ignore lint/correctness/useExhaustiveDependencies: viewState.update is stable
	useEffect(() => {
		if (tabs.length === 0) {
			if (activeId) {
				setActiveId(null);
				viewState.update({ activeTabId: null });
			}
			return;
		}
		if (!activeId || !tabs.some((t) => t.id === activeId)) {
			const first = tabs[0].id;
			setActiveId(first);
			viewState.update({ activeTabId: first });
		}
	}, [activeId, tabs]);

	const terminalIds = useMemo(() => tabs.map((t) => t.id), [tabs]);

	const handleCreate = useCallback(() => {
		const name = `Terminal ${runningTerminals.length + 1}`;
		createTerminal.mutate(
			{ name },
			{
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				onSuccess: (newTerm: any) => {
					setActiveId(newTerm.id);
					viewState.update({ activeTabId: newTerm.id });
				},
			},
		);
	}, [runningTerminals.length, createTerminal, viewState]);

	const handleClose = useCallback(
		(terminalId: string) => {
			deleteTerminal.mutate(terminalId);
		},
		[deleteTerminal],
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
			setActiveId(tabId);
			viewState.update({ activeTabId: tabId });
		},
		[viewState],
	);

	const handleReorder = useCallback(
		(ids: string[]) => {
			viewState.update({
				panelAssignments: { tabOrder: ids } as unknown as Record<string, string>,
			});
		},
		[viewState],
	);

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
		<Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
			<Group gap={4} px={4} py={2} justify="space-between" style={{ flexShrink: 0 }}>
				<TerminalTabBar
					tabs={tabs}
					activeTabId={activeId}
					onSelect={handleTabSelect}
					onClose={handleClose}
					onCreate={handleCreate}
					onRename={(id, name) => renameTerminal.mutate({ id, name })}
					onReorder={handleReorder}
					createPending={createTerminal.isPending}
				/>
				<LayoutSelector value={layout} onChange={handleLayoutChange} />
			</Group>
			<Box style={{ flex: 1, minHeight: 0 }}>
				<TerminalGrid
					layout={layout}
					terminalIds={terminalIds}
					activeTerminalId={activeId}
					onSendToChat={onSendToChat}
					onExit={handleExit}
				/>
			</Box>
		</Box>
	);
}
