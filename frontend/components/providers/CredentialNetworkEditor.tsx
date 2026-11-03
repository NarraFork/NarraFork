import {
	Alert,
	Button,
	Group,
	Modal,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import type { CredentialNetwork, CredentialUserAgentMode } from "@shared/credential-network";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../lib/api/client";
import type { ProxyOverride } from "../../lib/proxy";
import { Z } from "../../lib/z-index";
import { ProxyOverrideField } from "../common/ProxyOverrideField";

/** UUID v4; `crypto.randomUUID` is missing on plain-HTTP (non-secure) origins. */
function newDeviceId(): string {
	if (typeof crypto.randomUUID === "function" && globalThis.isSecureContext)
		return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function headersToText(headers: Record<string, string> | undefined): string {
	return Object.entries(headers ?? {})
		.map(([name, value]) => `${name}: ${value}`)
		.join("\n");
}

function textToHeaders(text: string): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const colon = line.indexOf(":");
		const name = (colon < 0 ? line : line.slice(0, colon)).trim();
		if (name) headers[name] = colon < 0 ? "" : line.slice(colon + 1).trim();
	}
	return Object.keys(headers).length ? headers : undefined;
}

/**
 * Edit how one credential appears on the network. Every field starts at "follow", which
 * means the provider's own setting applies; only what is set here differs per account.
 */
export function CredentialNetworkEditor({
	opened,
	onClose,
	title,
	value,
	onSave,
}: {
	opened: boolean;
	onClose: () => void;
	title: string;
	value: CredentialNetwork | undefined;
	/** `null` clears every field back to "follow". */
	onSave: (network: CredentialNetwork | null) => Promise<void>;
}) {
	const { t } = useTranslation("settings");
	const [draft, setDraft] = useState<CredentialNetwork>({});
	const [headersText, setHeadersText] = useState("");
	const [error, setError] = useState<{ field: string; message: string } | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!opened) return;
		setDraft(structuredClone(value ?? {}));
		setHeadersText(headersToText(value?.extraHeaders));
		setError(null);
	}, [opened, value]);

	const save = async (network: CredentialNetwork | null) => {
		setSaving(true);
		setError(null);
		try {
			await onSave(network);
			onClose();
		} catch (err) {
			const field =
				err instanceof ApiError && typeof err.data?.field === "string" ? err.data.field : "";
			setError({ field, message: err instanceof Error ? err.message : String(err) });
		} finally {
			setSaving(false);
		}
	};
	const fieldError = (field: string) =>
		error?.field === field ? t(`credentialNetwork.invalid.${field}`, error.message) : undefined;

	return (
		<Modal opened={opened} onClose={onClose} title={title} size="md" centered zIndex={Z.modal + 1}>
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{t("credentialNetwork.description")}
				</Text>
				<Stack gap={4}>
					<ProxyOverrideField
						label={t("credentialNetwork.proxy")}
						hideDescription
						dropdownZIndex={Z.modal + 2}
						defaultLabel={t("credentialNetwork.follow")}
						value={draft.proxy as ProxyOverride | undefined}
						onChange={(proxy) => setDraft((d) => ({ ...d, proxy }))}
					/>
					{fieldError("proxy.url") && (
						<Text size="xs" c="red">
							{fieldError("proxy.url")}
						</Text>
					)}
				</Stack>
				<Stack gap={4}>
					<Select
						label={t("credentialNetwork.userAgent")}
						allowDeselect={false}
						comboboxProps={{ zIndex: Z.modal + 2 }}
						value={draft.userAgentMode ?? "follow"}
						data={[
							{ value: "follow", label: t("credentialNetwork.follow") },
							{ value: "codex", label: "Codex" },
							{ value: "claude-code", label: "Claude Code" },
							{ value: "narrafork", label: "NarraFork" },
							{ value: "custom", label: t("credentialNetwork.custom") },
						]}
						onChange={(mode) =>
							setDraft((d) => ({
								...d,
								userAgentMode:
									mode && mode !== "follow" ? (mode as CredentialUserAgentMode) : undefined,
							}))
						}
					/>
					{draft.userAgentMode === "custom" && (
						<TextInput
							placeholder="Mozilla/5.0 …"
							value={draft.customUserAgent ?? ""}
							error={fieldError("customUserAgent")}
							onChange={(event) => {
								const customUserAgent = event.currentTarget.value;
								setDraft((d) => ({ ...d, customUserAgent }));
							}}
						/>
					)}
				</Stack>
				<Stack gap={4}>
					<Text size="sm" fw={500}>
						{t("credentialNetwork.deviceId")}
					</Text>
					<SegmentedControl
						size="xs"
						value={draft.deviceId ? "own" : "follow"}
						onChange={(choice) =>
							setDraft((d) => ({
								...d,
								deviceId: choice === "own" ? (d.deviceId ?? newDeviceId()) : undefined,
							}))
						}
						data={[
							{ value: "follow", label: t("credentialNetwork.deviceFollow") },
							{ value: "own", label: t("credentialNetwork.deviceOwn") },
						]}
					/>
					{draft.deviceId && (
						<Group gap="xs" wrap="nowrap">
							<Text size="xs" ff="monospace" style={{ minWidth: 0 }} truncate>
								{draft.deviceId}
							</Text>
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => setDraft((d) => ({ ...d, deviceId: newDeviceId() }))}
							>
								{t("credentialNetwork.regenerate")}
							</Button>
						</Group>
					)}
				</Stack>
				<Textarea
					label={t("credentialNetwork.headers")}
					description={t("credentialNetwork.headersHint")}
					autosize
					minRows={2}
					maxRows={6}
					placeholder="X-Header: value"
					value={headersText}
					error={fieldError("extraHeaders")}
					onChange={(event) => setHeadersText(event.currentTarget.value)}
				/>
				{error && !error.field && <Alert color="red">{error.message}</Alert>}
				<Group justify="space-between">
					<Button
						variant="subtle"
						color="gray"
						size="xs"
						loading={saving}
						onClick={() => void save(null)}
					>
						{t("credentialNetwork.reset")}
					</Button>
					<Group gap="xs">
						<Button variant="default" size="xs" onClick={onClose}>
							{t("credentialNetwork.cancel")}
						</Button>
						<Button
							size="xs"
							loading={saving}
							onClick={() => void save({ ...draft, extraHeaders: textToHeaders(headersText) })}
						>
							{t("credentialNetwork.save")}
						</Button>
					</Group>
				</Group>
			</Stack>
		</Modal>
	);
}
