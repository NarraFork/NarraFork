import { Box, Button } from "@mantine/core";

interface ManualOlderHistoryLoadProps {
	autoLoadEnabled: boolean;
	hasOlder: boolean;
	loading: boolean;
	label: string;
	onLoad: () => void;
}

export function ManualOlderHistoryLoad({
	autoLoadEnabled,
	hasOlder,
	loading,
	label,
	onLoad,
}: ManualOlderHistoryLoadProps) {
	if (autoLoadEnabled || !hasOlder) return null;

	return (
		<Box ta="center" py={4}>
			<Button size="compact-xs" variant="light" onClick={onLoad} loading={loading}>
				{label}
			</Button>
		</Box>
	);
}
