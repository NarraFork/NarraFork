import { NavLink, Switch, Text, Tooltip } from "@mantine/core";
import { IconEye } from "@tabler/icons-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useGlobalOverseer, useUpdateOverseer } from "../../hooks/useOverseers";
import { statusRegistry } from "../../lib/status-registry";

function mantineVar(color: string) {
	return `var(--mantine-color-${color}-filled)`;
}

interface OverseerNavItemProps {
	onNavigate?: () => void;
	collapsed?: boolean;
}

export function OverseerNavItem({ onNavigate, collapsed }: OverseerNavItemProps) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const { data: overseer } = useGlobalOverseer();
	const updateOverseer = useUpdateOverseer();
	const pathname = useRouterState({ select: (s) => s.location.pathname });

	const narratorStatus = overseer?.narrator?.status as string | undefined;
	const isEnabled = overseer?.enabled === true;
	const isActive = narratorStatus === "thinking" || narratorStatus === "waiting";
	const isCurrentPage = !!overseer?.narratorId && pathname === `/narrators/${overseer.narratorId}`;

	const statusColor = narratorStatus
		? mantineVar(statusRegistry.narratorStatus(narratorStatus).color)
		: undefined;

	const handleClick = useCallback(() => {
		if (!overseer) return;
		navigate({ to: "/narrators/$narratorId", params: { narratorId: overseer.narratorId } });
		onNavigate?.();
	}, [overseer, navigate, onNavigate]);

	const handleToggle = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (!overseer) return;
			updateOverseer.mutate({ id: overseer.id, enabled: !isEnabled });
		},
		[overseer, isEnabled, updateOverseer],
	);

	return (
		<Tooltip label={t("overseer")} position="right" disabled={!collapsed}>
			<NavLink
				active={isCurrentPage}
				label={
					collapsed ? undefined : (
						<Text size="sm" truncate>
							{t("overseer")}
						</Text>
					)
				}
				description={
					collapsed ? undefined : isEnabled && narratorStatus && narratorStatus !== "idle" ? (
						<Text size="xs" c={isActive ? statusColor : "dimmed"}>
							{narratorStatus}
						</Text>
					) : undefined
				}
				leftSection={
					<IconEye
						size={16}
						color={isActive && isEnabled ? statusColor : undefined}
						style={{ opacity: isEnabled ? 1 : 0.4 }}
					/>
				}
				onClick={handleClick}
				rightSection={
					collapsed ? undefined : (
						<Switch
							size="xs"
							checked={isEnabled}
							onChange={() => {}}
							onClick={handleToggle}
							disabled={!overseer || updateOverseer.isPending}
						/>
					)
				}
				styles={{ root: { cursor: overseer ? "pointer" : "default" } }}
			/>
		</Tooltip>
	);
}
