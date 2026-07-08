import { Select, Stack, TextInput } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { ProxyOverride, ProxyOverrideMode } from "../../lib/proxy";
import { normalizeProxyOverrideMode } from "../../lib/proxy";

interface ProxyOverrideFieldProps {
	/** Current override value (undefined = inherit the global policy). */
	value: ProxyOverride | undefined;
	/** Called with the new override (undefined when mode is "default"). */
	onChange: (next: ProxyOverride | undefined) => void;
	/** Compact size for inline provider forms. */
	size?: "xs" | "sm";
	/** Optional label override; defaults to the shared proxy-override label. */
	label?: string;
	disabled?: boolean;
}

/**
 * Reusable four-state proxy override control: default (inherit global) / direct /
 * system / custom. When "custom" is selected a URL input is shown. Emits
 * undefined for "default" so callers omit the field and inherit the global policy.
 */
export function ProxyOverrideField({
	value,
	onChange,
	size = "xs",
	label,
	disabled,
}: ProxyOverrideFieldProps) {
	const { t } = useTranslation("settings");
	const mode = normalizeProxyOverrideMode(value?.mode);
	const url = value?.url ?? "";

	const handleMode = (next: ProxyOverrideMode) => {
		if (next === "default") return onChange(undefined);
		if (next === "custom") return onChange({ mode: "custom", url });
		onChange({ mode: next });
	};

	return (
		<Stack gap={4}>
			<Select
				size={size}
				label={label ?? t("proxyOverrideLabel")}
				description={t("proxyOverrideDesc")}
				disabled={disabled}
				allowDeselect={false}
				data={[
					{ value: "default", label: t("proxyOverrideDefault") },
					{ value: "direct", label: t("proxyModeDirect") },
					{ value: "system", label: t("proxyModeSystem") },
					{ value: "custom", label: t("proxyModeCustom") },
				]}
				value={mode}
				onChange={(v) => handleMode(normalizeProxyOverrideMode(v))}
			/>
			{mode === "custom" && (
				<TextInput
					size={size}
					placeholder={t("proxyPlaceholder")}
					disabled={disabled}
					value={url}
					onChange={(e) => onChange({ mode: "custom", url: e.currentTarget.value })}
				/>
			)}
		</Stack>
	);
}
