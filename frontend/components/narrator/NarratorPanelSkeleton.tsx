import { Box, Group, Skeleton, Stack } from "@mantine/core";
import { NarratorMessageListSkeleton } from "./NarratorMessageListSkeleton";

/**
 * Skeleton placeholder that mimics the NarratorPanel message list layout.
 * Used as a loading transition when switching between narrators to prevent
 * content area jitter caused by hydration delays and progressive rendering.
 */
export function NarratorPanelSkeleton() {
	return (
		<Stack h="100%" gap={0} style={{ overflow: "hidden" }}>
			{/* Header skeleton */}
			<Group
				justify="space-between"
				py="xs"
				px="md"
				style={{
					borderBottom: "1px solid var(--mantine-color-default-border)",
					flexShrink: 0,
				}}
			>
				<Group gap="xs" style={{ flex: 1 }}>
					<Skeleton height={24} width={24} radius="sm" />
					<Skeleton height={16} width={180} radius="sm" />
				</Group>
				<Group gap="xs">
					<Skeleton height={24} width={24} radius="sm" />
					<Skeleton height={24} width={24} radius="sm" />
				</Group>
			</Group>

			{/* Message area skeleton */}
			<Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }} py="sm" px="md">
				<NarratorMessageListSkeleton />
			</Box>

			{/* Status bar skeleton */}
			<Group
				px="md"
				py="xs"
				gap="xs"
				justify="space-between"
				style={{
					borderTop: "1px solid var(--mantine-color-default-border)",
					flexShrink: 0,
				}}
			>
				<Skeleton height={14} width={100} radius="sm" />
				<Skeleton height={22} width={120} radius="sm" />
			</Group>

			{/* Input area skeleton */}
			<Group
				px="md"
				py="xs"
				gap="xs"
				align="flex-end"
				style={{
					borderTop: "1px solid var(--mantine-color-default-border)",
					flexShrink: 0,
				}}
			>
				<Skeleton height={36} style={{ flex: 1 }} radius="sm" />
				<Skeleton height={36} width={36} radius="sm" />
			</Group>
		</Stack>
	);
}
