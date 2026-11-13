import { useTranslation } from "react-i18next";

/** Keep the historical record visible without mounting an unsupported resource host. */
export function RemoteUnsupported(_props: Record<string, unknown>) {
	const { t } = useTranslation("remote");
	return (
		<div role="note" data-remote-unsupported="true">
			{t("unsupported")}
		</div>
	);
}
