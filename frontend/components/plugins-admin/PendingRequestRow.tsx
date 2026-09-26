import { Badge, Button, Group, Paper, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconBan, IconCheck, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { PluginPermissionRequestSummary } from "../../lib/api/plugins";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { useConfirmDialog } from "../common/confirm-dialog-context";

// Capabilities that carry meaningful host-security implications and warrant an
// inline warning. Shown both when approving a pending request and when the
// manifest declares a capability that is not yet granted.
const HIGH_RISK_CAPABILITIES: Record<string, string> = {
	"network.egress.allowlist": "highRiskNetworkEgressAllowlist",
};

export function HighRiskWarning({ capability }: { capability: string }) {
	const { t } = useTranslation("plugins");
	const key = HIGH_RISK_CAPABILITIES[capability];
	if (!key) return null;
	const label = t(`admin.detail.grants.highRisk.${key}`);
	return (
		<Tooltip label={label} multiline w={320} withArrow>
			<IconAlertTriangle
				size={15}
				color="var(--mantine-color-orange-5)"
				style={{ flexShrink: 0, cursor: "help" }}
			/>
		</Tooltip>
	);
}

export interface PendingRequestRowProps {
	request: PluginPermissionRequestSummary;
	busy?: boolean;
	onApprove: (requestId: string) => void;
	onDeny: (requestId: string) => void;
	/**
	 * "Deny and never ask again". When omitted the action is hidden. The row runs
	 * the confirmation itself so every surface prompts with the same wording.
	 */
	onDenyPermanent?: (requestId: string) => void;
}

/**
 * One pending permission request with its decision buttons. Shared by the
 * grants tab on the plugin detail page and the global admin prompt modal, so
 * both surfaces present the same decision the same way.
 */
export function PendingRequestRow({
	request,
	busy,
	onApprove,
	onDeny,
	onDenyPermanent,
}: PendingRequestRowProps) {
	const { t } = useTranslation("plugins");
	const confirm = useConfirmDialog();

	const denyPermanent = async () => {
		if (!onDenyPermanent) return;
		const ok = await confirm({
			title: t("admin.detail.grants.denyPermanentConfirmTitle"),
			message: t("admin.detail.grants.denyPermanentConfirmMessage", {
				capability: request.capability,
			}),
			confirmLabel: t("admin.detail.grants.denyPermanent"),
		});
		if (ok) onDenyPermanent(request.requestId);
	};

	return (
		<Paper withBorder p="xs" radius="md">
			<Group justify="space-between" wrap="nowrap">
				<Group gap="sm" wrap="wrap">
					<Badge color="indigo" variant="light" size="sm">
						{request.capability}
					</Badge>
					<Badge color="gray" variant="light" size="sm">
						{request.scope.type}
						{request.scope.id ? `:${request.scope.id}` : ""}
					</Badge>
					{/* An upgrade request is a different decision from a runtime prompt: the
					    plugin did not ask for the capability, a NEW VERSION declared it and the
					    host withheld it. An unlabelled row reads as "the plugin needs this",
					    which is exactly the framing that makes silent widening feel acceptable. */}
					{request.source === "upgrade" ? (
						<Badge color="yellow" variant="light" size="sm">
							{request.requestedForVersion
								? t("admin.detail.grants.pendingSourceUpgradeVersion", {
										version: request.requestedForVersion,
									})
								: t("admin.detail.grants.pendingSourceUpgrade")}
						</Badge>
					) : (
						<Badge color="blue" variant="light" size="sm">
							{t("admin.detail.grants.pendingSourceRuntime")}
						</Badge>
					)}
					<HighRiskWarning capability={request.capability} />
					<Text size="xs" c="dimmed">
						{formatLocaleDateTime(request.requestedAt)}
					</Text>
				</Group>
				<Group gap="xs" wrap="nowrap">
					<Button
						size="compact-xs"
						variant="light"
						color="green"
						leftSection={<IconCheck size={14} />}
						onClick={() => onApprove(request.requestId)}
						disabled={busy}
					>
						{t("admin.detail.grants.approve")}
					</Button>
					<Button
						size="compact-xs"
						variant="light"
						color="red"
						leftSection={<IconX size={14} />}
						onClick={() => onDeny(request.requestId)}
						disabled={busy}
					>
						{t("admin.detail.grants.deny")}
					</Button>
					{onDenyPermanent && (
						<Tooltip label={t("admin.detail.grants.denyPermanentHint")} multiline w={280} withArrow>
							<Button
								size="compact-xs"
								variant="subtle"
								color="red"
								leftSection={<IconBan size={14} />}
								onClick={() => void denyPermanent()}
								disabled={busy}
							>
								{t("admin.detail.grants.denyPermanent")}
							</Button>
						</Tooltip>
					)}
				</Group>
			</Group>
		</Paper>
	);
}
