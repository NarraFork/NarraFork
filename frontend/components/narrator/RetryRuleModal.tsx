/**
 * RetryRuleModal.tsx — "Mark as retryable" dialog for a narrator error notice.
 *
 * Extracted from MessageBubble's ErrorNotice so BOTH message-list renderers can
 * drive the same flow:
 *   - chunked path  → ErrorNotice owns one modal per error card
 *   - virtual list  → the vlist paints error cards as zero-DOM copies, so the
 *                     shell hosts ONE modal for the whole list and opens it with
 *                     the clicked row's error text (see vlist-error-actions).
 *
 * The dialog itself is the single source of truth for the rule form: at least one
 * of domain / status code / keyword must be filled, the keyword is prefilled with
 * the error message, and a successful POST invalidates the settings query so the
 * new rule shows up in the settings page's rule list.
 */

import { api } from "@frontend/lib/api";
import { Button, Modal, NumberInput, Stack, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export interface RetryRuleModalProps {
	opened: boolean;
	onClose: () => void;
	/** The error text this rule is being created for; prefills the keyword field. */
	errorMessage: string;
}

/**
 * The rule form. Mounted controlled (`opened`) so a host can keep a single
 * instance for many error rows; the fields reset whenever the target error text
 * changes or the dialog is reopened.
 */
export function RetryRuleModal({ opened, onClose, errorMessage }: RetryRuleModalProps) {
	const { t } = useTranslation("narrator");
	const { t: ts } = useTranslation("settings");
	const { t: tc } = useTranslation("common");
	const qc = useQueryClient();
	const [domain, setDomain] = useState("");
	const [statusCode, setStatusCode] = useState<number | string>("");
	const [keyword, setKeyword] = useState(errorMessage);
	const [note, setNote] = useState("");
	const [submitting, setSubmitting] = useState(false);

	// A shared host reuses one modal for every error row, so the draft must follow
	// the row that opened it instead of keeping the first error's text forever.
	useEffect(() => {
		if (!opened) return;
		setDomain("");
		setStatusCode("");
		setKeyword(errorMessage);
		setNote("");
	}, [opened, errorMessage]);

	const handleAddRule = async () => {
		const code = typeof statusCode === "number" ? statusCode : undefined;
		const trimmedDomain = domain.trim() || undefined;
		const trimmedKeyword = keyword.trim() || undefined;
		if (!trimmedDomain && !code && !trimmedKeyword) {
			notifications.show({ message: ts("retryRuleAtLeastOne"), color: "yellow" });
			return;
		}
		setSubmitting(true);
		try {
			await api.addRetryRule({
				domain: trimmedDomain,
				statusCode: code,
				keyword: trimmedKeyword,
				note: note.trim() || undefined,
			});
			qc.invalidateQueries({ queryKey: ["settings"] });
			notifications.show({
				message: t("markRetryableSuccess"),
				color: "green",
				autoClose: 5000,
			});
			onClose();
		} catch (err) {
			notifications.show({
				title: t("narratorError"),
				message: err instanceof Error ? err.message : tc("unknownError"),
				color: "red",
			});
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Modal opened={opened} onClose={onClose} title={t("markRetryableTitle")} size="sm">
			<Stack gap="sm">
				<TextInput
					label={ts("retryRuleDomain")}
					placeholder={ts("retryRuleDomainPlaceholder")}
					value={domain}
					onChange={(e) => setDomain(e.currentTarget.value)}
				/>
				<NumberInput
					label={ts("retryRuleStatusCode")}
					placeholder={ts("retryRuleStatusCodePlaceholder")}
					value={statusCode}
					onChange={setStatusCode}
					min={100}
					max={599}
					allowDecimal={false}
				/>
				<TextInput
					label={ts("retryRuleKeyword")}
					placeholder={ts("retryRuleKeywordPlaceholder")}
					value={keyword}
					onChange={(e) => setKeyword(e.currentTarget.value)}
				/>
				<TextInput
					label={ts("retryRuleNote")}
					placeholder={ts("retryRuleNotePlaceholder")}
					value={note}
					onChange={(e) => setNote(e.currentTarget.value)}
				/>
				<Button onClick={handleAddRule} loading={submitting} fullWidth>
					{ts("retryRuleAdd")}
				</Button>
			</Stack>
		</Modal>
	);
}
