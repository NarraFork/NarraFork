import { SegmentedControl, useMantineColorScheme } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { appearanceStore } from "../lib/appearance-preference-store";

export function ThemeSwitcher() {
	const { colorScheme, setColorScheme } = useMantineColorScheme();
	const { t } = useTranslation("settings");

	return (
		<SegmentedControl
			value={colorScheme}
			onChange={(value) => {
				appearanceStore.set("colorScheme", value);
				setColorScheme(value as "light" | "dark" | "auto");
			}}
			data={[
				{ value: "light", label: t("themeLight") },
				{ value: "dark", label: t("themeDark") },
				{ value: "auto", label: t("themeAuto") },
			]}
		/>
	);
}
