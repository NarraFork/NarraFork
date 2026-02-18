import { ActionIcon, Tooltip } from "@mantine/core";
import {
	IconLayout,
	IconLayoutColumns,
	IconLayoutGrid,
	IconLayoutRows,
	IconSquare,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export type TerminalLayout = "single" | "split-h" | "split-v" | "triple" | "quad";

interface LayoutSelectorProps {
	value: TerminalLayout;
	onChange: (layout: TerminalLayout) => void;
}

const layouts: { value: TerminalLayout; icon: typeof IconSquare; labelKey: string }[] = [
	{ value: "single", icon: IconSquare, labelKey: "layoutSingle" },
	{ value: "split-h", icon: IconLayoutColumns, labelKey: "layoutSplitH" },
	{ value: "split-v", icon: IconLayoutRows, labelKey: "layoutSplitV" },
	{ value: "triple", icon: IconLayout, labelKey: "layoutTriple" },
	{ value: "quad", icon: IconLayoutGrid, labelKey: "layoutQuad" },
];

export function LayoutSelector({ value, onChange }: LayoutSelectorProps) {
	const { t } = useTranslation("terminal");

	return (
		<ActionIcon.Group>
			{layouts.map(({ value: v, icon: Icon, labelKey }) => (
				<Tooltip key={v} label={t(labelKey)}>
					<ActionIcon
						size="sm"
						variant={value === v ? "filled" : "subtle"}
						onClick={() => onChange(v)}
					>
						<Icon size={14} />
					</ActionIcon>
				</Tooltip>
			))}
		</ActionIcon.Group>
	);
}
