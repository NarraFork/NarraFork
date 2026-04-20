import { Box } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { TerminalLayout } from "./LayoutSelector";
import { TerminalPanel } from "./TerminalPanel";

interface PanelConfig {
	gridArea: string;
}

const LAYOUT_CONFIGS: Record<TerminalLayout, { template: string; panels: PanelConfig[] }> = {
	single: {
		template: '"a" 1fr / 1fr',
		panels: [{ gridArea: "a" }],
	},
	"split-h": {
		template: '"a b" 1fr / 1fr 1fr',
		panels: [{ gridArea: "a" }, { gridArea: "b" }],
	},
	"split-v": {
		template: '"a" 1fr "b" 1fr / 1fr',
		panels: [{ gridArea: "a" }, { gridArea: "b" }],
	},
	triple: {
		template: '"a b" 1fr "a c" 1fr / 1fr 1fr',
		panels: [{ gridArea: "a" }, { gridArea: "b" }, { gridArea: "c" }],
	},
	quad: {
		template: '"a b" 1fr "c d" 1fr / 1fr 1fr',
		panels: [{ gridArea: "a" }, { gridArea: "b" }, { gridArea: "c" }, { gridArea: "d" }],
	},
};

interface TerminalGridProps {
	layout: TerminalLayout;
	/** Ordered list of terminal IDs to display in panels */
	terminalIds: string[];
	/** Which terminal is active (shown in single layout) */
	activeTerminalId: string | null;
	onSendToChat?: (text: string) => void;
	onExit?: (terminalId: string, code: number) => void;
}

export function TerminalGrid({
	layout,
	terminalIds,
	activeTerminalId,
	onSendToChat,
	onExit,
}: TerminalGridProps) {
	const isMobile = useMediaQuery("(max-width: 768px)");
	const effectiveLayout = isMobile ? "single" : layout;
	const config = LAYOUT_CONFIGS[effectiveLayout];

	// In single layout, show only the active terminal
	// In multi-panel layouts, distribute terminals across panels in order
	const panelTerminalIds: (string | undefined)[] =
		effectiveLayout === "single"
			? [activeTerminalId ?? terminalIds[0]]
			: config.panels.map((_, idx) => terminalIds[idx]);

	return (
		<Box
			style={{
				display: "grid",
				gridTemplate: config.template,
				gap: 2,
				height: "100%",
				minHeight: 0,
			}}
		>
			{config.panels.map((panel, idx) => {
				const terminalId = panelTerminalIds[idx];
				return (
					<Box
						key={`${effectiveLayout}-${terminalId ?? `empty-${idx}`}`}
						style={{
							gridArea: panel.gridArea,
							minHeight: 0,
							minWidth: 0,
							overflow: "hidden",
							borderRadius: 4,
						}}
					>
						{terminalId ? (
							<TerminalPanel
								terminalId={terminalId}
								onSendToChat={onSendToChat}
								onExit={onExit ? (code) => onExit(terminalId, code) : undefined}
							/>
						) : (
							<Box
								h="100%"
								style={{
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									backgroundColor: "var(--mantine-color-dark-8)",
									color: "var(--mantine-color-dimmed)",
									fontSize: 13,
								}}
							>
								Empty panel
							</Box>
						)}
					</Box>
				);
			})}
		</Box>
	);
}
