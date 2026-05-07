import { Select } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateUserPreferences } from "../hooks/useUserPreferences";
import { changeAppLanguage, getNamespacesForPath, normalizeLanguage } from "../lib/i18n";

const LANGUAGE_OPTIONS = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

export function LanguageSwitcher() {
	const { i18n } = useTranslation();
	const updatePrefs = useUpdateUserPreferences();
	const [isChangingLanguage, setIsChangingLanguage] = useState(false);
	const currentLanguage = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);

	const handleChange = (value: string | null) => {
		if (!value || normalizeLanguage(value) === currentLanguage) return;

		setIsChangingLanguage(true);
		void (async () => {
			try {
				await changeAppLanguage(value, getNamespacesForPath(window.location.pathname));
				updatePrefs.mutate({ language: value });
			} finally {
				setIsChangingLanguage(false);
			}
		})();
	};

	return (
		<Select
			data={LANGUAGE_OPTIONS}
			value={currentLanguage}
			onChange={handleChange}
			size="sm"
			w={120}
			allowDeselect={false}
			disabled={isChangingLanguage}
		/>
	);
}
