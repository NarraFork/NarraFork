import { Select, Stack, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProxyOverride, ProxyOverrideMode } from "../../lib/proxy";
import { buildProxyOverride, normalizeProxyOverrideMode, normalizeProxyUrl } from "../../lib/proxy";

interface ProxyOverrideFieldProps {
	/** Current override value (undefined = inherit the global policy). */
	value: ProxyOverride | undefined;
	/** Called with the new override (undefined when mode is "default"). */
	onChange: (next: ProxyOverride | undefined) => void;
	/** Compact size for inline provider forms. */
	size?: "xs" | "sm";
	/** Optional label override; defaults to the shared proxy-override label. */
	label?: string;
	/** Hide the description line (useful in dense aggregated lists). */
	hideDescription?: boolean;
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
	hideDescription,
	disabled,
}: ProxyOverrideFieldProps) {
	const { t } = useTranslation("settings");
	const persistedMode = normalizeProxyOverrideMode(value?.mode);
	const persistedUrl = value?.url ?? "";
	const [customDraftActive, setCustomDraftActive] = useState(false);
	const [customDraftUrl, setCustomDraftUrl] = useState(persistedUrl);
	const mode = customDraftActive ? "custom" : persistedMode;
	const url = customDraftActive ? customDraftUrl : persistedUrl;
	const customUrlInvalid = mode === "custom" && !normalizeProxyUrl(url);

	useEffect(() => {
		setCustomDraftActive(false);
		setCustomDraftUrl(persistedMode === "custom" ? persistedUrl : "");
	}, [persistedMode, persistedUrl]);

	const handleMode = (nextMode: ProxyOverrideMode) => {
		const next = buildProxyOverride(nextMode, customDraftUrl || persistedUrl);
		if (next === null) {
			setCustomDraftActive(true);
			return;
		}
		setCustomDraftActive(false);
		onChange(next);
	};

	const handleCustomUrl = (nextUrl: string) => {
		setCustomDraftActive(true);
		setCustomDraftUrl(nextUrl);
		const next = buildProxyOverride("custom", nextUrl);
		if (next !== null) onChange(next);
	};

	return (
		<Stack gap={4}>
			<Select
				size={size}
				label={label ?? t("proxyOverrideLabel")}
				description={hideDescription ? undefined : t("proxyOverrideDesc")}
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
					error={customUrlInvalid ? t("proxyInvalidUrl") : undefined}
					onChange={(e) => handleCustomUrl(e.currentTarget.value)}
				/>
			)}
		</Stack>
	);
}
