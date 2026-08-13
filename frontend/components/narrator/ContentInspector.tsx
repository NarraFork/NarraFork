/**
 * ContentInspector.tsx — a generic "what the model actually saw" viewer.
 *
 * The tool-call inspector answers "what did this tool call do" with a structured dump.
 * A system injection needs the sibling question: "what text did the model actually
 * receive here". The bubble body shows a READER projection (boilerplate stripped,
 * structure projected); this shows the verbatim model-facing copy, so the reader can
 * audit what the agent was told without trusting the projection to be faithful.
 *
 * Deliberately NOT a reuse of ToolCallInspector: that one is bound to a toolUseId and
 * fetches a raw tool dump. This one takes plain text the caller already holds.
 */

import { ActionIcon, CopyButton, Group, Modal, ScrollArea, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export interface ContentInspectorProps {
	opened: boolean;
	onClose: () => void;
	/** What produced the content (e.g. the localized source label). */
	title: string;
	/** The verbatim model-facing text. */
	content: string;
}

export function ContentInspector({ opened, onClose, title, content }: ContentInspectorProps) {
	const { t } = useTranslation("narrator");
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("contentInspector.title")}
			size="xl"
			overlayProps={{ backgroundOpacity: 0.55, blur: 2 }}
		>
			<Group justify="space-between" align="center" gap="xs" mb="sm">
				<Text fw={600} size="sm" truncate>
					{title}
				</Text>
				<CopyButton value={content} timeout={1500}>
					{({ copied, copy }) => (
						<Tooltip
							label={copied ? t("contentInspector.copied") : t("contentInspector.copy")}
							withArrow
						>
							<ActionIcon
								size="sm"
								variant="subtle"
								color={copied ? "teal" : "gray"}
								onClick={copy}
								aria-label={t("contentInspector.copy")}
							>
								{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
							</ActionIcon>
						</Tooltip>
					)}
				</CopyButton>
			</Group>
			<ScrollArea.Autosize mah={480}>
				<Text
					component="pre"
					size="xs"
					style={{
						margin: 0,
						whiteSpace: "pre-wrap",
						overflowWrap: "anywhere",
						fontFamily: "monospace",
					}}
				>
					{content}
				</Text>
			</ScrollArea.Autosize>
		</Modal>
	);
}
