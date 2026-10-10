import { ActionIcon, Anchor, Code, Collapse, Group, Stack, Text } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type DescribedApiError,
	describeApiError,
	hasDistinctRawMessage,
} from "../../lib/api-error";
import { CopyButton } from "./CopyButton";

export interface ErrorDetailProps {
	error: unknown;
	/** Shown when the error carries no usable text at all (transport failure, empty body). */
	fallback?: string;
}

/**
 * A localized error message with the server's original wording available on demand.
 *
 * Both halves are needed and they serve different people. The translated sentence is what lets
 * a user understand and act; the raw English + codes are what makes a bug report actionable and
 * what an operator matches against logs. Collapsing the second behind a disclosure keeps the
 * first uncluttered without discarding it — which is what showing only one of the two does.
 *
 * The disclosure appears only for a translated error (one carrying a `messageCode`), and the raw
 * block inside it only when the raw text actually differs from what is shown. Those are two
 * separate conditions because they fail in opposite directions: several catalog entries translate
 * into English identical to the server's template (`FORBIDDEN_ACTION`, the `MERGE_DIRTY_*`
 * family), so rendering the block there printed the same sentence twice under a link promising
 * the "original" — while an un-migrated error has no second version at all, and offering a link
 * for its coarse `code` alone would put a near-empty panel on almost every error in the app.
 */
/**
 * What the disclosure should contain, given a described error.
 *
 * Extracted as a pure function because this is where the bug was: the raw block used to be
 * rendered whenever the disclosure was open, and the disclosure opened whenever a
 * `messageCode` existed — so the several catalog entries whose English translation equals
 * the server's template printed their sentence twice, under a link offering the "original".
 *
 * `showRaw` and `showDisclosure` are separate answers on purpose: the codes are worth a
 * disclosure on their own, the duplicated sentence never is.
 */
export function errorDetailDisclosure(described: DescribedApiError): {
	showRaw: boolean;
	showDisclosure: boolean;
} {
	const showRaw = hasDistinctRawMessage(described);
	return {
		showRaw,
		// Deliberately NOT `|| code !== null`. Almost every error carries a coarse code, so
		// that would attach a disclosure to all of them — including the un-migrated majority,
		// where the sentence shown IS the server's own text and the panel would hold nothing
		// but an error code nobody asked for. A `messageCode` is the honest signal that a
		// translation happened and therefore that an original exists to reveal.
		showDisclosure: showRaw || described.messageCode !== null,
	};
}

export function ErrorDetail({ error, fallback }: ErrorDetailProps) {
	const { t } = useTranslation("errors");
	const [expanded, setExpanded] = useState(false);
	const described = describeApiError(error, t, fallback);
	const { showRaw: showRawMessage, showDisclosure } = errorDetailDisclosure(described);

	const copyPayload = [
		described.raw ?? described.message,
		described.code ? `code: ${described.code}` : null,
		described.messageCode ? `messageCode: ${described.messageCode}` : null,
		described.status !== null ? `status: ${described.status}` : null,
	]
		.filter(Boolean)
		.join("\n");

	return (
		<Stack gap={4}>
			<Text size="sm">{described.message}</Text>

			{showDisclosure && (
				<>
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						onClick={() => setExpanded((value) => !value)}
					>
						{expanded ? t("hideOriginal") : t("showOriginal")}
					</Anchor>

					<Collapse expanded={expanded}>
						<Stack gap={4} mt={4}>
							{showRawMessage && described.raw && (
								<Group gap={4} align="flex-start" wrap="nowrap">
									<Code
										block
										style={{
											flex: 1,
											fontSize: "var(--mantine-font-size-xs)",
											whiteSpace: "pre-wrap",
										}}
									>
										{described.raw}
									</Code>
									<CopyButton value={copyPayload}>
										{({ copied, copy }) => (
											<ActionIcon
												variant="subtle"
												size="sm"
												color={copied ? "teal" : "gray"}
												onClick={copy}
												aria-label={t("originalMessage")}
											>
												{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
											</ActionIcon>
										)}
									</CopyButton>
								</Group>
							)}
							{described.code && (
								<Text size="xs" c="dimmed">
									{t("errorCode")}: {described.code}
									{described.status !== null ? ` (HTTP ${described.status})` : ""}
								</Text>
							)}
							{described.messageCode && (
								<Text size="xs" c="dimmed">
									{t("messageCode")}: {described.messageCode}
								</Text>
							)}
						</Stack>
					</Collapse>
				</>
			)}
		</Stack>
	);
}
