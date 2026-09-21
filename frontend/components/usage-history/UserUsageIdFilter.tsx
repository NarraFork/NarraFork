import { TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";

/** Keep typing local; only an explicit Enter or leaving the field changes queries. */
export function UserUsageIdFilter({
	value,
	onChange,
	isMobile,
}: {
	value?: string;
	onChange: (userId: string | undefined) => void;
	isMobile: boolean;
}) {
	const { t } = useTranslation("common");
	const apply = (draft: string) => {
		const userId = draft.trim() || undefined;
		if (userId !== value) onChange(userId);
	};
	return (
		<TextInput
			key={value ?? ""}
			size="xs"
			label={t("usageHistoryUserId")}
			placeholder={t("usageHistoryUserIdPlaceholder")}
			title={t("usageHistoryUserIdHint")}
			defaultValue={value ?? ""}
			w={isMobile ? "100%" : 180}
			onBlur={(event) => apply(event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					apply(event.currentTarget.value);
				}
			}}
		/>
	);
}
