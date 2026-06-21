import { Divider, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { Z } from "../../lib/z-index";

interface TerminalContextMenuProps {
	x: number;
	y: number;
	nodeId: string;
	terminalName: string;
	onClose: () => void;
	onRename: (nodeId: string) => void;
	onMinimize: (nodeId: string) => void;
	onCloseTerminal: (nodeId: string) => void;
}

export function TerminalContextMenu({
	x,
	y,
	nodeId,
	terminalName,
	onClose,
	onRename,
	onMinimize,
	onCloseTerminal,
}: TerminalContextMenuProps) {
	const { t } = useTranslation("graph");

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay to capture clicks */}
			<div
				style={{ position: "fixed", inset: 0, zIndex: Z.contextMenuBackdrop }}
				onClick={onClose}
				onContextMenu={(e) => {
					e.preventDefault();
					onClose();
				}}
				onKeyDown={() => {}}
				role="presentation"
			/>
			<Paper
				shadow="md"
				p="xs"
				withBorder
				style={{
					position: "fixed",
					left: x,
					top: y,
					zIndex: Z.contextMenu,
					minWidth: 180,
				}}
			>
				<Stack gap={2}>
					<Text size="xs" fw={600} c="dimmed" px="xs">
						{terminalName}
					</Text>
					<UnstyledButton
						px="xs"
						py={4}
						onClick={() => onRename(nodeId)}
						style={{ borderRadius: 4 }}
					>
						<Text size="sm">{t("terminalContextMenu.rename")}</Text>
					</UnstyledButton>
					<UnstyledButton
						px="xs"
						py={4}
						onClick={() => onMinimize(nodeId)}
						style={{ borderRadius: 4 }}
					>
						<Text size="sm">{t("terminalContextMenu.minimize")}</Text>
					</UnstyledButton>
					<Divider my={4} />
					<UnstyledButton
						px="xs"
						py={4}
						onClick={() => onCloseTerminal(nodeId)}
						style={{ borderRadius: 4 }}
					>
						<Text size="sm" c="red">
							{t("terminalContextMenu.close")}
						</Text>
					</UnstyledButton>
				</Stack>
			</Paper>
		</>
	);
}
