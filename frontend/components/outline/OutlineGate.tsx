import { Alert, Center, Loader } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineEnabled } from "../../hooks/useOutline";

/**
 * Renders the outline pages only while the outline is switched on. Off, the server answers 404
 * for every outline route anyway; this says so instead of showing a broken page.
 */
export function OutlineGate({ children }: { children: ReactNode }) {
	const { t } = useTranslation("outline");
	const { enabled, loading } = useOutlineEnabled();
	if (loading) {
		return (
			<Center py="xl">
				<Loader size="sm" />
			</Center>
		);
	}
	if (!enabled) {
		return (
			<Alert color="gray" variant="light" title={t("title")}>
				{t("unavailable")}
			</Alert>
		);
	}
	return <>{children}</>;
}
