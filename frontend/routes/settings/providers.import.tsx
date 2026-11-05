import { Alert } from "@mantine/core";
import {
	importInputFromPageLocation,
	selfTestNonceFromPageLocation,
} from "@shared/provider-import";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProviderImportPage } from "../../components/providers/ProviderImportPage";
import { answerProtocolSelfTest } from "../../components/providers/protocol-handler";
import { useGatewayProvidersImported } from "../../components/providers/provider-add-context";
import { useCurrentUser } from "../../hooks/useAuth";

export const Route = createFileRoute("/settings/providers/import")({
	component: ImportProviderRoutePage,
});

function ImportProviderRoutePage() {
	const { t } = useTranslation("settings");
	const navigate = useNavigate();
	const onImported = useGatewayProvidersImported();
	const { data: user } = useCurrentUser();
	// Read the protocol-handler payload once, before the address bar is cleaned.
	const [selfTestNonce] = useState(() =>
		selfTestNonceFromPageLocation(window.location.search, window.location.hash),
	);
	const [initialInput] = useState(() =>
		selfTestNonce
			? null
			: importInputFromPageLocation(window.location.search, window.location.hash),
	);
	const [isSelfTestVisit, setIsSelfTestVisit] = useState(!!selfTestNonce);
	useEffect(() => {
		// Answer the import page that is testing the link handler (it may close this tab).
		if (answerProtocolSelfTest(selfTestNonce)) setIsSelfTestVisit(true);
	}, [selfTestNonce]);
	useEffect(() => {
		// Links may carry an API key: drop it from the address bar and this history entry.
		if (window.location.search || window.location.hash) {
			void navigate({ to: "/settings/providers/import", replace: true });
		}
	}, [navigate]);

	const close = (providerId?: string) =>
		void navigate({
			to: "/settings/providers",
			search: providerId ? { provider: providerId } : {},
			replace: true,
		});
	if (isSelfTestVisit) {
		return <Alert color="green">{t("providerImportSelfTestVisit")}</Alert>;
	}
	if (user && user.role !== "admin") {
		return <Alert color="yellow">{t("providerImportAdminOnly")}</Alert>;
	}
	return <ProviderImportPage initialInput={initialInput} onClose={close} onImported={onImported} />;
}
