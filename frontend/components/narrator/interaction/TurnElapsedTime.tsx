import { Popover, Stack, Text, UnstyledButton } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { TruncatedText } from "../../common/TruncatedText";

export function TurnElapsedTime({
	text,
	startedAtLabel,
	isMobile,
}: {
	text: string;
	startedAtLabel: string | null;
	isMobile: boolean;
}) {
	const [opened, setOpened] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelClose = useCallback(() => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
	}, []);
	const scheduleClose = useCallback(() => {
		cancelClose();
		closeTimer.current = setTimeout(() => {
			setOpened(false);
			closeTimer.current = null;
		}, 150);
	}, [cancelClose]);
	useEffect(() => () => cancelClose(), [cancelClose]);

	// Without a popover the row has nothing else to reveal the clipped tail, so
	// the text carries its own overflow tooltip. With a popover the full string
	// goes into the dropdown instead — nesting a tooltip inside a popover target
	// would open two overlapping bubbles for the same gesture.
	if (!startedAtLabel)
		return <TruncatedText size="xs" c="dimmed" text={text} style={{ maxWidth: "100%" }} />;

	const elapsedText = (
		<Text size="xs" c="dimmed" truncate style={{ minWidth: 0, maxWidth: "100%" }}>
			{text}
		</Text>
	);

	return (
		<Popover opened={opened} onChange={setOpened} position="top" withArrow withinPortal shadow="md">
			<Popover.Target>
				<UnstyledButton
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						cancelClose();
						setOpened((opened) => !opened);
					}}
					onPointerDown={(event) => event.stopPropagation()}
					onPointerEnter={() => {
						if (!isMobile) {
							cancelClose();
							setOpened(true);
						}
					}}
					onPointerLeave={() => {
						if (!isMobile) scheduleClose();
					}}
					aria-label={`${text}, ${startedAtLabel}`}
					style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%", cursor: "pointer" }}
				>
					{elapsedText}
				</UnstyledButton>
			</Popover.Target>
			<Popover.Dropdown
				onPointerEnter={() => {
					if (!isMobile) cancelClose();
				}}
				onPointerLeave={() => {
					if (!isMobile) scheduleClose();
				}}
			>
				{/* The inline label is the part the row clips, so repeat it in full here:
				    the popover is the only reveal affordance this control has. */}
				<Stack gap={2}>
					<Text size="xs" style={{ overflowWrap: "anywhere" }}>
						{text}
					</Text>
					<Text size="xs" c="dimmed">
						{startedAtLabel}
					</Text>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}
