import { Button, Group, Text } from "@mantine/core";
import type { IntelligentUiKitNotice, IntelligentUiKitRequest } from "@shared/intelligent-ui-kit";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	approveKitRequest,
	dismissKitRequest,
	forgetKitOverview,
	loadKitOverview,
} from "./kit-client";

/**
 * The reader's side of the kit confirmation gate: one fixed-height row asking whether the
 * agent may build or update the component kit.
 *
 * The notice a tool result carries is a snapshot from when the call ran. Whether the
 * request is still open is the server's to say, so the row asks before offering a button
 * and shows nothing for a request that was already answered.
 */
export function KitNoticeBar({
	narratorId,
	notice,
}: {
	narratorId: string;
	notice: IntelligentUiKitNotice;
}) {
	const { t } = useTranslation("narrator");
	const requestId = notice.request?.id;
	const [request, setRequest] = useState<IntelligentUiKitRequest | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		setRequest(null);
		setFailed(false);
		if (!requestId) return;
		void loadKitOverview(narratorId, controller.signal)
			.then((next) => {
				if (!controller.signal.aborted)
					setRequest(next.request?.id === requestId ? next.request : null);
			})
			// No access or no connection: there is nothing this reader could confirm.
			.catch(() => {});
		return () => controller.abort();
	}, [narratorId, requestId]);

	if (!request) return null;
	const run = (action: () => Promise<IntelligentUiKitRequest | null>) => {
		setBusy(true);
		setFailed(false);
		void action()
			.then(setRequest)
			.catch(() => setFailed(true))
			.finally(() => {
				forgetKitOverview(narratorId);
				setBusy(false);
			});
	};
	return (
		<Group gap="xs" wrap="nowrap" style={{ height: 26, minWidth: 0 }}>
			<Text
				size="xs"
				c={failed ? "red" : request.state === "approved" ? "dimmed" : undefined}
				truncate
				style={{ flex: 1, minWidth: 0 }}
			>
				{failed
					? t("intelligentUi.kit.failed")
					: request.state === "approved"
						? t("intelligentUi.kit.approved")
						: t(`intelligentUi.kit.${request.kind}Prompt`)}
			</Text>
			{request.state === "pending" && (
				<>
					<Button
						size="compact-xs"
						loading={busy}
						onClick={() =>
							run(async () => (await approveKitRequest(narratorId, request.id)).request)
						}
						style={{ flexShrink: 0 }}
					>
						{t("intelligentUi.kit.confirm")}
					</Button>
					<Button
						size="compact-xs"
						variant="subtle"
						disabled={busy}
						onClick={() =>
							run(async () => {
								await dismissKitRequest(narratorId, request.id);
								return null;
							})
						}
						style={{ flexShrink: 0 }}
					>
						{t("intelligentUi.kit.dismiss")}
					</Button>
				</>
			)}
		</Group>
	);
}
