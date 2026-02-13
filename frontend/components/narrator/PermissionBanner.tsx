import { Alert, Button, Code, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

interface PermissionBannerProps {
	request: {
		id: string;
		toolName: string;
		inputJson: any;
		decisionReason?: string;
	};
	onDecision: (requestId: string, decision: "allow" | "deny") => void;
}

export function PermissionBanner({ request, onDecision }: PermissionBannerProps) {
	const inputPreview = JSON.stringify(request.inputJson ?? {}, null, 2) ?? "";
	const truncated = inputPreview.length > 300 ? `${inputPreview.slice(0, 300)}...` : inputPreview;
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	return (
		<Alert color="yellow" title={t("permissionRequest")} radius="md">
			<Text size="sm" fw={500} mb={4}>
				{t("tool")} <Code>{request.toolName}</Code>
			</Text>
			{request.decisionReason && (
				<Text size="xs" c="dimmed" mb={4}>
					{request.decisionReason}
				</Text>
			)}
			<Code block style={{ fontSize: 11, maxHeight: 120, overflow: "auto" }} mb="sm">
				{truncated}
			</Code>
			<Group>
				<Button size="xs" color="green" onClick={() => onDecision(request.id, "allow")}>
					{tc("allow")}
				</Button>
				<Button
					size="xs"
					color="red"
					variant="light"
					onClick={() => onDecision(request.id, "deny")}
				>
					{tc("deny")}
				</Button>
			</Group>
		</Alert>
	);
}
