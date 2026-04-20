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

interface NarratorTerminalProps {
	narratorId: string;
	onSendToChat?: (text: string) => void;
	onWriteRef?: (write: ((text: string) => void) | null) => void;
	onExit?: (code: number) => void;
}

/** Extract saved tab order from panelAssignments JSON */
function getSavedOrder(
	panelAssignments: Record<string, string | string[]> | null | undefined,
): string[] | null {
	const pa = panelAssignments;
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

const LAYOUT_PANEL_COUNT: Record<TerminalLayout, number> = {
	single: 1,
	"split-h": 2,
	"split-v": 2,
	triple: 3,
	quad: 4,
};

export function NarratorTerminal({
	narratorId,
	onSendToChat,
	onWriteRef,
	onExit,
}: NarratorTerminalProps) {
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
			const needed = LAYOUT_PANEL_COUNT[newLayout] - runningTerminals.length;
			for (let i = 0; i < needed; i++) {
				createTerminal.mutate({ name: `Terminal ${runningTerminals.length + i + 1}` });
			}
		},
		[viewState, runningTerminals.length, createTerminal],
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
				panelAssignments: { tabOrder: ids },
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
			<Group gap={4} px={4} py={2} wrap="nowrap" style={{ flexShrink: 0 }}>
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
				<Box style={{ flexShrink: 0 }}>
					<LayoutSelector value={layout} onChange={handleLayoutChange} />
				</Box>
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
