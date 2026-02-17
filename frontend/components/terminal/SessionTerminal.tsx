import { Box, Loader, Text } from "@mantine/core";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useCreateNarratorTerminal, useNarratorTerminals } from "../../hooks/useTerminals";
import { TERM_BG, TerminalPanel, type TerminalPanelHandle } from "./TerminalPanel";

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
	const { data: terminals, isLoading } = useNarratorTerminals(narratorId);
	const createTerminal = useCreateNarratorTerminal(narratorId);
	const terminalPanelRef = useRef<TerminalPanelHandle>(null);
	const { t } = useTranslation("terminal");
	const autoCreated = useRef(false);

	const runningTerminal = (terminals ?? []).find((t: any) => t.status === "running");

	// Auto-create terminal if none exists
	useEffect(() => {
		if (!isLoading && !runningTerminal && !createTerminal.isPending && !autoCreated.current) {
			autoCreated.current = true;
			createTerminal.mutate({ name: "Terminal" });
		}
	}, [isLoading, runningTerminal, createTerminal]);

	// Reset auto-create flag when narrator changes
	useEffect(() => {
		autoCreated.current = false;
	}, [narratorId]);

	// Expose write function to parent
	useEffect(() => {
		onWriteRef?.(
			runningTerminal ? (text: string) => terminalPanelRef.current?.writeToTerminal(text) : null,
		);
	}, [runningTerminal, onWriteRef]);

	if (isLoading || createTerminal.isPending) {
		return (
			<Box
				h="100%"
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: TERM_BG,
				}}
			>
				<Loader size="sm" />
			</Box>
		);
	}

	if (!runningTerminal) {
		return (
			<Box
				h="100%"
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					backgroundColor: TERM_BG,
				}}
			>
				<Text size="sm" c="dimmed">
					{t("noTerminals")}
				</Text>
			</Box>
		);
	}

	return (
		<TerminalPanel
			ref={terminalPanelRef}
			terminalId={runningTerminal.id}
			onSendToChat={onSendToChat}
			onExit={onExit}
		/>
	);
}
