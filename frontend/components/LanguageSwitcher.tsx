import { Select } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useUpdateUserPreferences } from "../hooks/useUserPreferences";

const LANGUAGE_OPTIONS = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

export function LanguageSwitcher() {
	const { i18n } = useTranslation();
	const updatePrefs = useUpdateUserPreferences();

	return (
		<Select
			data={LANGUAGE_OPTIONS}
			value={i18n.language}
			onChange={(value) => {
				if (value) {
					i18n.changeLanguage(value);
					updatePrefs.mutate({ language: value });
				}
			}}
			size="sm"
			w={120}
			allowDeselect={false}
		/>
	);
}
