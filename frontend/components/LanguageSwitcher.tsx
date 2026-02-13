import { Select } from "@mantine/core";
import { useTranslation } from "react-i18next";

const LANGUAGE_OPTIONS = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
];

export function LanguageSwitcher() {
	const { i18n } = useTranslation();

	return (
		<Select
			data={LANGUAGE_OPTIONS}
			value={i18n.language}
			onChange={(value) => {
				if (value) i18n.changeLanguage(value);
			}}
			size="sm"
			w={120}
			allowDeselect={false}
		/>
	);
}
