import { usePermissions } from "@frontend/hooks/usePermissions";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import { Alert, Badge, Group, Stack, Text } from "@mantine/core";
import type { PermissionPolicyChangedEvent } from "@shared/permission-policy-events";
import type { PermissionRuleRequestResult } from "@shared/permission-rule-request";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export type PermissionRuleReceiptView = Pick<
	PermissionRuleRequestResult,
	"status" | "requestId" | "ruleId" | "deviceId" | "scope"
> &
	Partial<Pick<PermissionRuleRequestResult, "approvalSource" | "approvalUserId" | "rule">>;

/** Never treat approval or pending as policy activation; only successful execution receipts count. */
export function readPermissionRuleReceipt(output: unknown): PermissionRuleReceiptView | null {
	try {
		let value = output;
		if (typeof value === "string") {
			if (value.length > 32_000) return null;
			value = JSON.parse(value);
		}
		if (value && typeof value === "object" && "output" in value) {
			value = (value as { output: unknown }).output;
			if (typeof value === "string") {
				if (value.length > 32_000) return null;
				value = JSON.parse(value);
			}
		}
		if (!value || typeof value !== "object") return null;
		const row = value as Record<string, unknown>;
		if (
			(row.status !== "applied" && row.status !== "alreadyExists") ||
			row.scope !== "narrator" ||
			typeof row.requestId !== "string" ||
			typeof row.ruleId !== "string" ||
			typeof row.deviceId !== "string"
		)
			return null;
		return {
			status: row.status,
			requestId: row.requestId,
			ruleId: row.ruleId,
			deviceId: row.deviceId,
			scope: "narrator",
			...(row.approvalSource === "user" || row.approvalSource === "reflection"
				? { approvalSource: row.approvalSource }
				: {}),
			...(typeof row.approvalUserId === "string" ? { approvalUserId: row.approvalUserId } : {}),
			...(row.rule && typeof row.rule === "object"
				? { rule: row.rule as PermissionRuleRequestResult["rule"] }
				: {}),
		};
	} catch {
		return null;
	}
}

export function PermissionRuleReceiptDetails({
	receipt,
	narratorId,
}: {
	receipt: PermissionRuleReceiptView;
	narratorId: string;
}) {
	const { t } = useTranslation("narrator");
	const source =
		receipt.approvalSource === "user"
			? t("permissionRuleRequest.human")
			: receipt.approvalSource === "reflection"
				? t("permissionRuleRequest.automatic")
				: t("permissionRuleRequest.unknown");
	const rule = receipt.rule;
	const path = rule && "path" in rule ? rule.path : undefined;
	const pattern = rule && "pattern" in rule ? rule.pattern : undefined;
	const access =
		rule && "accessLevel" in rule
			? rule.accessLevel
			: rule && "denyLevel" in rule
				? rule.denyLevel
				: undefined;
	return (
		<Stack gap={4} style={{ overflowWrap: "anywhere" }}>
			<Group gap="xs">
				<Badge color="green">{t(`permissionRuleRequest.${receipt.status}`)}</Badge>
				<Text size="xs">{receipt.ruleId}</Text>
			</Group>
			<Text size="xs">{t("permissionRuleRequest.scope", { narratorId })}</Text>
			<Text size="xs">{t("permissionRuleRequest.device", { deviceId: receipt.deviceId })}</Text>
			{typeof rule?.ruleType === "string" && (
				<Text size="xs">{t(`permissionRuleRequest.${rule.ruleType}`)}</Text>
			)}
			{path && <Text size="xs">{t("permissionRuleRequest.path", { path })}</Text>}
			{pattern && <Text size="xs">{t("permissionRuleRequest.pattern", { pattern })}</Text>}
			{access && <Text size="xs">{t(`permissionRuleRequest.${access}`)}</Text>}
			<Text size="xs">
				{t("permissionRuleRequest.approval", { source })}
				{receipt.approvalUserId ? ` · ${receipt.approvalUserId}` : ""}
			</Text>
		</Stack>
	);
}

/** Existing tool events suffice; do not invent an approval event that says a pending rule is live. */
export function PermissionRuleResultNotice({ narratorId }: { narratorId: string }) {
	const [receipt, setReceipt] = useState<{
		view: PermissionRuleReceiptView;
		ownerId: string;
	} | null>(null);
	const qc = useQueryClient();
	const { data: pending } = usePermissions(narratorId);
	const requestedRef = useRef(new Set<string>());
	useEffect(() => {
		for (const request of pending ?? []) {
			if (request.toolName === "RequestPermissionRule" && typeof request.toolUseId === "string")
				requestedRef.current.add(request.toolUseId);
		}
	}, [pending]);
	useEffect(() => {
		const requested = requestedRef.current;
		const refresh = (ownerId: string) => {
			for (const key of ["whitelist-dirs", "blacklist-dirs", "cmd-whitelist", "cmd-blacklist"])
				void qc.invalidateQueries({ queryKey: [key, ownerId] });
		};
		const handle = narratorWSManager.addListener(
			{
				narratorIds: [narratorId],
				types: [
					"tool_started",
					"tool_completed",
					"permission_request",
					"narrator_access_changed",
					"permission:policy_changed",
				],
			},
			(event) => {
				if (event.type === "narrator_access_changed") {
					refresh(narratorId);
					return;
				}
				if (event.type === "permission:policy_changed") {
					const changed = event as unknown as PermissionPolicyChangedEvent;
					refresh(changed.narratorId);
					return;
				}
				if (event.type === "permission_request") {
					const request = event.request as { toolName?: string; toolUseId?: string } | undefined;
					if (request?.toolName === "RequestPermissionRule" && request.toolUseId)
						requested.add(request.toolUseId);
				}
				if (
					event.type === "tool_started" &&
					event.toolName === "RequestPermissionRule" &&
					typeof event.toolUseId === "string"
				) {
					if (requested.size >= 128) requested.clear();
					requested.add(event.toolUseId);
				}
				if (
					event.type !== "tool_completed" ||
					typeof event.toolUseId !== "string" ||
					!requested.delete(event.toolUseId)
				)
					return;
				const completed = readPermissionRuleReceipt(event.output);
				if (!completed || event.status !== "success") return;
				const ownerId =
					typeof event.subagentNarratorId === "string" ? event.subagentNarratorId : narratorId;
				setReceipt({ view: completed, ownerId });
				refresh(ownerId);
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [qc, narratorId]);
	return receipt ? (
		<Alert color="green" withCloseButton onClose={() => setReceipt(null)} mx="md" my={4}>
			<PermissionRuleReceiptDetails receipt={receipt.view} narratorId={receipt.ownerId} />
		</Alert>
	) : null;
}
