import {
	ActionIcon,
	Button,
	Collapse,
	Group,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconMessageCircle, IconTrash } from "@tabler/icons-react";
import { useState } from "react";

export interface CmdWhitelistEntry {
	pattern: string;
	enabled?: boolean;
}

export interface CmdBlacklistEntry {
	pattern: string;
	denyPrompt?: string;
	enabled?: boolean;
}

interface WhitelistEditorProps {
	commands: CmdWhitelistEntry[];
	onChange: (commands: CmdWhitelistEntry[]) => void;
	mode: "whitelist";
	labels: { empty: string; add: string; placeholder: string };
}

interface BlacklistEditorProps {
	commands: CmdBlacklistEntry[];
	onChange: (commands: CmdBlacklistEntry[]) => void;
	mode: "blacklist";
	labels: {
		empty: string;
		add: string;
		placeholder: string;
		denyPromptPlaceholder?: string;
	};
}

type CmdListEditorProps = WhitelistEditorProps | BlacklistEditorProps;

function isWhitelist(props: CmdListEditorProps): props is WhitelistEditorProps {
	return props.mode === "whitelist";
}

export function CmdListEditor(props: CmdListEditorProps) {
	const { commands, labels } = props;
	const [newPattern, setNewPattern] = useState("");
	const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

	const addCmd = () => {
		const pattern = newPattern.trim();
		if (!pattern) return;
		if (commands.some((c) => c.pattern === pattern)) return;
		if (isWhitelist(props)) {
			props.onChange([...props.commands, { pattern, enabled: true }]);
		} else {
			props.onChange([...props.commands, { pattern, enabled: true }]);
		}
		setNewPattern("");
	};

	const removeCmd = (idx: number) => {
		if (isWhitelist(props)) {
			props.onChange(props.commands.filter((_, i) => i !== idx));
		} else {
			props.onChange(props.commands.filter((_, i) => i !== idx));
		}
		if (expandedIdx === idx) setExpandedIdx(null);
		else if (expandedIdx !== null && expandedIdx > idx) {
			setExpandedIdx(expandedIdx - 1);
		}
	};

	const updateEnabled = (idx: number, enabled: boolean) => {
		if (isWhitelist(props)) {
			props.onChange(props.commands.map((item, i) => (i === idx ? { ...item, enabled } : item)));
		} else {
			props.onChange(props.commands.map((item, i) => (i === idx ? { ...item, enabled } : item)));
		}
	};

	const updateDenyPrompt = (idx: number, denyPrompt: string) => {
		if (!isWhitelist(props)) {
			props.onChange(
				props.commands.map((item, i) =>
					i === idx ? { ...item, denyPrompt: denyPrompt || undefined } : item,
				),
			);
		}
	};

	return (
		<Stack gap={8}>
			{commands.length === 0 && (
				<Text size="xs" c="dimmed">
					{labels.empty}
				</Text>
			)}
			{commands.map((cmd, idx) => (
				<Stack key={cmd.pattern} gap={0}>
					<Group gap={6} wrap="nowrap" align="center">
						<Switch
							size="xs"
							checked={cmd.enabled !== false}
							onChange={(e) => updateEnabled(idx, e.currentTarget.checked)}
							aria-label={`Toggle ${cmd.pattern}`}
						/>
						<Text
							size="xs"
							style={{
								flex: 1,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								opacity: cmd.enabled !== false ? 1 : 0.5,
							}}
							title={cmd.pattern}
						>
							{cmd.pattern}
						</Text>
						{!isWhitelist(props) && (
							<>
								{(cmd as CmdBlacklistEntry).denyPrompt && (
									<Text size="xs" c="dimmed" title="Has deny prompt">
										💬
									</Text>
								)}
								<ActionIcon
									variant="subtle"
									color="gray"
									size="xs"
									onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
									aria-label={`Toggle deny prompt for ${cmd.pattern}`}
								>
									<IconMessageCircle size={14} />
								</ActionIcon>
							</>
						)}
						<ActionIcon variant="subtle" color="red" size="xs" onClick={() => removeCmd(idx)}>
							<IconTrash size={14} />
						</ActionIcon>
					</Group>
					{!isWhitelist(props) && (
						<Collapse expanded={expandedIdx === idx}>
							<Textarea
								size="xs"
								mt={4}
								ml={30}
								autosize
								minRows={1}
								maxRows={3}
								placeholder={
									(labels as BlacklistEditorProps["labels"]).denyPromptPlaceholder ?? "Deny prompt"
								}
								value={(cmd as CmdBlacklistEntry).denyPrompt ?? ""}
								onChange={(e) => updateDenyPrompt(idx, e.currentTarget.value)}
							/>
						</Collapse>
					)}
				</Stack>
			))}
			<Group gap={4} wrap="nowrap">
				<TextInput
					size="xs"
					placeholder={labels.placeholder}
					value={newPattern}
					onChange={(e) => setNewPattern(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") addCmd();
					}}
					style={{ flex: 1 }}
				/>
				<Button
					size="xs"
					variant="light"
					color={!isWhitelist(props) ? "red" : undefined}
					disabled={!newPattern.trim()}
					onClick={addCmd}
				>
					{labels.add}
				</Button>
			</Group>
		</Stack>
	);
}
