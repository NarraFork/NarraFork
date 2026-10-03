import { useTranslation } from "react-i18next";

export function DocumentSourceStatus({
	failed,
	onRetry,
}: {
	failed?: boolean;
	onRetry?: () => void;
}) {
	const { t } = useTranslation("narrator");
	return (
		<div
			role={failed ? "alert" : "status"}
			style={{
				position: "absolute",
				top: 2,
				left: 4,
				right: 4,
				zIndex: 2,
				padding: 4,
				borderRadius: 3,
				background: "var(--mantine-color-body)",
				color: failed ? "var(--mantine-color-red-6)" : "var(--mantine-color-dimmed)",
				fontSize: 11,
			}}
		>
			{t(failed ? "documentLoadFailed" : "documentLoading")}
			{failed && onRetry ? (
				<button type="button" onClick={onRetry}>
					{t("documentRetry")}
				</button>
			) : null}
		</div>
	);
}
