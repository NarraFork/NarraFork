/**
 * Why a page is shown read only after an upgrade: this tab still runs the editor of the version
 * before, which the server no longer speaks to (`closed { code: "outdated" }`,
 * `shared/outline-live-protocol.ts`). Trying again from this tab cannot help, so there is no
 * "try again" here, only a reload. What was typed and not saved is kept by then (the
 * unsaved-text notice shows it; it is gone with the tab, so it is to be copied first).
 */
import { Alert, Button, Group, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

export function OutdatedNotice({ onReload }: { onReload?: () => void }) {
	const { t } = useTranslation("outline");
	return (
		<Alert variant="light" color="yellow" py={6} mb="xs" data-testid="outline-outdated">
			<Group gap="xs" wrap="wrap">
				<Text size="sm">{t("editor.outdated")}</Text>
				<Button
					size="compact-xs"
					variant="light"
					data-testid="outline-outdated-reload"
					onClick={onReload ?? (() => window.location.reload())}
				>
					{t("editor.reload")}
				</Button>
			</Group>
		</Alert>
	);
}
