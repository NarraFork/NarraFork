import { ActionIcon, Group, TextInput } from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconX } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/** Portaled beside the viewport by the painter, outside document geometry. */
export function DocumentSearch({
	query,
	onQuery,
	onFind,
	onClose,
	status,
}: {
	query: string;
	onQuery: (value: string) => void;
	onFind: (direction: 1 | -1) => void;
	onClose: () => void;
	status: "idle" | "searching" | "missing" | "error";
}) {
	const { t } = useTranslation("narrator");
	return (
		<Group
			gap={4}
			wrap="nowrap"
			data-message-selection-ignore=""
			style={{
				position: "absolute",
				top: 4,
				right: 4,
				zIndex: 5,
				padding: 4,
				borderRadius: 4,
				background: "var(--mantine-color-body)",
			}}
		>
			<TextInput
				autoFocus
				size="xs"
				value={query}
				aria-label={t("documentFind")}
				placeholder={t("documentFind")}
				error={
					status === "error"
						? t("documentSearchFailed")
						: status === "missing"
							? t("documentNotFound")
							: undefined
				}
				onChange={(event) => onQuery(event.currentTarget.value)}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === "Escape") {
						event.preventDefault();
						onClose();
					}
					if (event.key === "Enter") {
						event.preventDefault();
						onFind(event.shiftKey ? -1 : 1);
					}
				}}
			/>
			<ActionIcon size="xs" aria-label={t("documentFindPrevious")} onClick={() => onFind(-1)}>
				<IconChevronUp size={12} />
			</ActionIcon>
			<ActionIcon size="xs" aria-label={t("documentFindNext")} onClick={() => onFind(1)}>
				<IconChevronDown size={12} />
			</ActionIcon>
			<ActionIcon size="xs" aria-label={t("documentFindClose")} onClick={onClose}>
				<IconX size={12} />
			</ActionIcon>
		</Group>
	);
}
