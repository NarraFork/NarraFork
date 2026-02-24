import { Divider, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

interface NodeContextMenuProps {
	x: number;
	y: number;
	nodeId: string;
	nodeData: {
		title: string;
		status: string;
		role: string;
	};
	onClose: () => void;
	onFork: (nodeId: string) => void;
	onSetRole: (nodeId: string, role: string) => void;
	onDormant: (nodeId: string) => void;
	onWake: (nodeId: string) => void;
}

export function NodeContextMenu({
	x,
	y,
	nodeId,
	nodeData,
	onClose,
	onFork,
	onSetRole,
	onDormant,
	onWake,
}: NodeContextMenuProps) {
	const { t } = useTranslation("graph");

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay to capture clicks */}
			<div
				style={{ position: "fixed", inset: 0, zIndex: 999 }}
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
					zIndex: 1000,
					minWidth: 180,
				}}
			>
				<Stack gap={2}>
					<Text size="xs" fw={600} c="dimmed" px="xs">
						{nodeData.title}
					</Text>
					<UnstyledButton px="xs" py={4} onClick={() => onFork(nodeId)} style={{ borderRadius: 4 }}>
						<Text size="sm">{t("contextMenu.fork")}</Text>
					</UnstyledButton>
					<Divider my={4} />
					<Text size="xs" fw={600} c="dimmed" px="xs">
						{t("contextMenu.setRole")}
					</Text>
					{(["trunk", "branch", "exploration"] as const).map((role) => (
						<UnstyledButton
							key={role}
							px="xs"
							py={4}
							disabled={nodeData.role === role}
							onClick={() => onSetRole(nodeId, role)}
							style={{
								borderRadius: 4,
								opacity: nodeData.role === role ? 0.5 : 1,
							}}
						>
							<Text size="sm">{t(`contextMenu.role.${role}`)}</Text>
						</UnstyledButton>
					))}
					<Divider my={4} />
					{nodeData.status === "active" && (
						<UnstyledButton
							px="xs"
							py={4}
							onClick={() => onDormant(nodeId)}
							style={{ borderRadius: 4 }}
						>
							<Text size="sm">{t("contextMenu.dormant")}</Text>
						</UnstyledButton>
					)}
					{nodeData.status === "dormant" && (
						<UnstyledButton
							px="xs"
							py={4}
							onClick={() => onWake(nodeId)}
							style={{ borderRadius: 4 }}
						>
							<Text size="sm">{t("contextMenu.wake")}</Text>
						</UnstyledButton>
					)}
				</Stack>
			</Paper>
		</>
	);
}
