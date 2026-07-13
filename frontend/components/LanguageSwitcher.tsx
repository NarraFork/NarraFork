import { Select } from "@mantine/core";
import { LOCALE_OPTIONS } from "@shared/i18n-locales";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useUpdateUserPreferences } from "../hooks/useUserPreferences";
import { changeAppLanguage, getNamespacesForPath, normalizeLanguage } from "../lib/i18n";

export function LanguageSwitcher() {
	const { i18n } = useTranslation();
	const updatePrefs = useUpdateUserPreferences();
	const [isChangingLanguage, setIsChangingLanguage] = useState(false);
	const currentLanguage = normalizeLanguage(i18n.resolvedLanguage ?? i18n.language);

	const handleChange = (value: string | null) => {
		if (!value) return;
		const locale = normalizeLanguage(value);
		if (locale === currentLanguage) return;

		setIsChangingLanguage(true);
		void (async () => {
			try {
				await changeAppLanguage(locale, getNamespacesForPath(window.location.pathname));
				updatePrefs.mutate({ language: locale });
			} finally {
				setIsChangingLanguage(false);
			}
		})();
	};

	return (
		<Select
			data={LOCALE_OPTIONS}
			value={currentLanguage}
			onChange={handleChange}
			size="sm"
			w={120}
			allowDeselect={false}
			disabled={isChangingLanguage}
		/>
	);
}
