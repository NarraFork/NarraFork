import {
	ActionIcon,
	Button,
	Group,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../common/CopyButton";
import type { UserAgentMode } from "./types";

/** Editable client-fingerprint config shared across provider sections. */
export interface ClientFingerprintValue {
	userAgentMode?: UserAgentMode;
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
	emulateCodexHeaders?: boolean;
}

interface ClientFingerprintFieldsProps {
	value: ClientFingerprintValue;
	onChange: (next: Partial<ClientFingerprintValue>) => void;
	/** Show the "emulate Codex headers" toggle (Codex + OpenAI-style providers). */
	showEmulateToggle?: boolean;
	/**
	 * Effective emulation state when `emulateCodexHeaders` is unset (tri-state):
	 * codex-mode providers default to on, others off. Used so the toggle reflects
	 * the real backend behaviour instead of always appearing off.
	 */
	emulateCodexDefault?: boolean;
	/** Show the persisted installation id + regenerate control. */
	showInstallationId?: boolean;
	installationId?: string;
	onRegenerateInstallationId?: () => void;
	regenerating?: boolean;
	disabled?: boolean;
}

/** Convert edited rows back into a record, keeping only non-empty keys. */
function rowsToRecord(rows: Array<{ key: string; value: string }>): Record<string, string> {
	const record: Record<string, string> = {};
	for (const { key, value } of rows) {
		const trimmed = key.trim();
		if (trimmed) record[trimmed] = value;
	}
	return record;
}

// Row shape used in local editing state.
interface HeaderRow {
	id: number;
	key: string;
	value: string;
}

/** Serialize a record to a comparable string (order-independent). */
function recordSignature(record?: Record<string, string>): string {
	return JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

export function ClientFingerprintFields({
	value,
	onChange,
	showEmulateToggle,
	emulateCodexDefault = false,
	showInstallationId,
	installationId,
	onRegenerateInstallationId,
	regenerating,
	disabled,
}: ClientFingerprintFieldsProps) {
	const { t } = useTranslation("settings");
	// Tri-state: explicit flag wins, otherwise fall back to the provider default.
	const emulateActive = value.emulateCodexHeaders ?? emulateCodexDefault;

	// Local rows allow editing empty keys/values without losing focus; the parent
	// record is only updated with committed (non-empty-key) rows. Each row carries
	// a stable id so React keys survive key/value edits and reordering.
	const rowIdRef = useRef(0);
	const nextRowId = () => {
		rowIdRef.current += 1;
		return rowIdRef.current;
	};
	const [rows, setRows] = useState<HeaderRow[]>(() =>
		Object.entries(value.extraHeaders ?? {}).map(([key, val]) => ({
			id: nextRowId(),
			key,
			value: val,
		})),
	);

	// Re-seed local rows when the external record changes from a different source
	// (e.g. loading a different provider / server refresh), but not when the
	// change originated from our own edits.
	const lastCommittedRef = useRef(recordSignature(value.extraHeaders));
	// biome-ignore lint/correctness/useExhaustiveDependencies: nextRowId is a stable id allocator
	useEffect(() => {
		const incoming = recordSignature(value.extraHeaders);
		if (incoming !== lastCommittedRef.current) {
			lastCommittedRef.current = incoming;
			setRows(
				Object.entries(value.extraHeaders ?? {}).map(([key, val]) => ({
					id: nextRowId(),
					key,
					value: val,
				})),
			);
		}
	}, [value.extraHeaders]);

	const commitRows = (next: HeaderRow[]) => {
		setRows(next);
		const record = rowsToRecord(next);
		lastCommittedRef.current = recordSignature(record);
		onChange({ extraHeaders: record });
	};

	const updateRow = (id: number, patch: Partial<{ key: string; value: string }>) => {
		commitRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	};
	const addRow = () => {
		setRows([...rows, { id: nextRowId(), key: "", value: "" }]);
	};
	const removeRow = (id: number) => {
		commitRows(rows.filter((row) => row.id !== id));
	};

	return (
		<Stack gap="xs">
			<Select
				label={t("fingerprintUserAgent")}
				description={t("fingerprintUserAgentDesc")}
				size="xs"
				disabled={disabled}
				data={[
					{ value: "narrafork", label: t("fingerprintUaNarrafork") },
					{ value: "claude-code", label: t("fingerprintUaClaudeCode") },
					{ value: "codex", label: t("fingerprintUaCodex") },
					{ value: "custom", label: t("fingerprintUaCustom") },
				]}
				value={value.userAgentMode ?? "narrafork"}
				onChange={(v) => onChange({ userAgentMode: (v as UserAgentMode | null) ?? "narrafork" })}
			/>
			{value.userAgentMode === "custom" && (
				<TextInput
					label={t("fingerprintCustomUaLabel")}
					placeholder={t("fingerprintCustomUaPlaceholder")}
					value={value.customUserAgent ?? ""}
					size="xs"
					disabled={disabled}
					onChange={(e) => onChange({ customUserAgent: e.currentTarget.value })}
				/>
			)}

			{showEmulateToggle && (
				<Switch
					size="xs"
					label={t("fingerprintEmulateCodex")}
					description={t("fingerprintEmulateCodexDesc")}
					checked={emulateActive}
					disabled={disabled}
					onChange={(e) => onChange({ emulateCodexHeaders: e.currentTarget.checked })}
				/>
			)}

			<Stack gap={4}>
				<Text size="xs" fw={500}>
					{t("fingerprintExtraHeaders")}
				</Text>
				<Text size="xs" c="dimmed">
					{emulateActive
						? t("fingerprintExtraHeadersDescEmulating")
						: t("fingerprintExtraHeadersDesc")}
				</Text>
				{rows.map((row) => (
					<Group key={row.id} gap="xs" align="flex-end" wrap="nowrap">
						<TextInput
							size="xs"
							style={{ flex: 1 }}
							placeholder={t("fingerprintHeaderNamePlaceholder")}
							value={row.key}
							disabled={disabled}
							onChange={(e) => updateRow(row.id, { key: e.currentTarget.value })}
						/>
						<TextInput
							size="xs"
							style={{ flex: 2 }}
							placeholder={t("fingerprintHeaderValuePlaceholder")}
							value={row.value}
							disabled={disabled}
							onChange={(e) => updateRow(row.id, { value: e.currentTarget.value })}
						/>
						<ActionIcon
							size="md"
							variant="subtle"
							color="red"
							disabled={disabled}
							aria-label={t("fingerprintRemoveHeader")}
							onClick={() => removeRow(row.id)}
						>
							<IconTrash size={16} />
						</ActionIcon>
					</Group>
				))}
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlus size={14} />}
					disabled={disabled}
					onClick={addRow}
				>
					{t("fingerprintAddHeader")}
				</Button>
			</Stack>

			{showInstallationId && (
				<Stack gap={4}>
					<Text size="xs" fw={500}>
						{t("fingerprintInstallationId")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("fingerprintInstallationIdDesc")}
					</Text>
					<Group gap="xs" wrap="nowrap">
						<TextInput
							size="xs"
							style={{ flex: 1 }}
							value={installationId ?? ""}
							readOnly
							rightSection={
								<CopyButton value={installationId ?? ""}>
									{({ copied, copy }) => (
										<Tooltip label={copied ? t("copied") : t("copy")} withArrow>
											<ActionIcon
												size="sm"
												variant="subtle"
												color={copied ? "teal" : "gray"}
												onClick={copy}
											>
												{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
											</ActionIcon>
										</Tooltip>
									)}
								</CopyButton>
							}
						/>
						<Button
							size="xs"
							variant="default"
							leftSection={<IconRefresh size={14} />}
							loading={regenerating}
							disabled={disabled || !onRegenerateInstallationId}
							onClick={onRegenerateInstallationId}
						>
							{t("fingerprintRegenerate")}
						</Button>
					</Group>
				</Stack>
			)}
		</Stack>
	);
}
