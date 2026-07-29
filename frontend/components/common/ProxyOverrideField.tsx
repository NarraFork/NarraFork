import { Select, Stack, TextInput } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProxyOverride, ProxyOverrideMode } from "../../lib/proxy";
import {
	buildProxyOverride,
	commitProxyUrlDraft,
	normalizeProxyOverrideMode,
	normalizeProxyUrl,
} from "../../lib/proxy";

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
	/**
	 * Disables the mode selector only. The URL input stays editable on purpose:
	 * toggling `disabled` while a save is in flight would rip keyboard focus out
	 * of the field the user is still typing in.
	 */
	disabled?: boolean;
}

/**
 * Reusable four-state proxy override control: default (inherit global) / direct /
 * system / custom. When "custom" is selected a URL input is shown. Emits
 * undefined for "default" so callers omit the field and inherit the global policy.
 *
 * The custom URL is kept as local draft state and only committed on blur or Enter.
 * Committing per keystroke used to fire a save on every character, which both
 * rewrote the input from the server-normalized value mid-typing and briefly
 * disabled the field, costing the user their keyboard focus.
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
	// "custom" chosen in the selector but not yet persisted (URL still empty/invalid).
	const [customDraftActive, setCustomDraftActive] = useState(false);
	const [draftUrl, setDraftUrl] = useState(persistedUrl);
	// Live-typing flag. A ref rather than state because it never affects the
	// render output — it only decides whether the prop-sync effect below is
	// allowed to overwrite the draft.
	const editingRef = useRef(false);
	const mode = customDraftActive ? "custom" : persistedMode;
	const showCustomUrl = mode === "custom";
	// Only complain once there is actually something wrong to complain about; a
	// half-typed address is not an error yet.
	const customUrlInvalid = showCustomUrl && !!draftUrl.trim() && !normalizeProxyUrl(draftUrl);

	// The URL input only exists in custom mode. When it disappears React fires no
	// blur, so clear the typing flag explicitly — otherwise the sync effect below
	// would stay disabled forever and the draft would go stale. Declared first so
	// it runs before the sync effect in the same commit.
	useEffect(() => {
		if (!showCustomUrl) editingRef.current = false;
	}, [showCustomUrl]);

	// Re-sync the draft from props only while the user is not editing, so an
	// in-flight save (or a settings refetch) never overwrites live input.
	useEffect(() => {
		if (editingRef.current) return;
		setCustomDraftActive(false);
		setDraftUrl(persistedMode === "custom" ? persistedUrl : "");
	}, [persistedMode, persistedUrl]);

	const handleMode = (nextMode: ProxyOverrideMode) => {
		// Picking a mode ends the typing session: the draft is either committed
		// below or superseded by the newly selected mode.
		editingRef.current = false;
		const next = buildProxyOverride(nextMode, draftUrl || persistedUrl);
		if (next === null) {
			// Custom selected without a usable URL yet: reveal the input and wait.
			setCustomDraftActive(true);
			return;
		}
		setCustomDraftActive(false);
		onChange(next);
	};

	const commitUrl = useCallback(() => {
		editingRef.current = false;
		const result = commitProxyUrlDraft(draftUrl, value);
		if (result.action === "keep-draft") {
			// Nothing valid to persist yet; keep the typed text and the input visible.
			setCustomDraftActive(true);
			return;
		}
		// Reflect the normalized form locally so blur causes no visual jump.
		setDraftUrl(result.normalizedUrl);
		setCustomDraftActive(false);
		if (result.action === "save") onChange(result.override);
	}, [draftUrl, onChange, value]);

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
			{showCustomUrl && (
				<TextInput
					size={size}
					placeholder={t("proxyPlaceholder")}
					description={hideDescription ? undefined : t("proxyOverrideUrlCommitHint")}
					value={draftUrl}
					error={customUrlInvalid ? t("proxyInvalidUrl") : undefined}
					onChange={(e) => {
						editingRef.current = true;
						setDraftUrl(e.currentTarget.value);
					}}
					onBlur={commitUrl}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitUrl();
						}
					}}
				/>
			)}
		</Stack>
	);
}
