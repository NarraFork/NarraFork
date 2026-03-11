import { Box, Group, Skeleton, Stack } from "@mantine/core";

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
				<Stack gap="md">
					{/* User message bubble */}
					<Group align="flex-start" gap="sm">
						<Skeleton height={28} width={28} circle />
						<Box style={{ flex: 1 }}>
							<Skeleton height={14} width={60} mb={6} radius="sm" />
							<Skeleton height={36} radius="sm" />
						</Box>
					</Group>

					{/* Assistant message bubble — longer */}
					<Group align="flex-start" gap="sm">
						<Skeleton height={28} width={28} circle />
						<Box style={{ flex: 1 }}>
							<Skeleton height={14} width={80} mb={6} radius="sm" />
							<Skeleton height={16} width="95%" mb={4} radius="sm" />
							<Skeleton height={16} width="88%" mb={4} radius="sm" />
							<Skeleton height={16} width="72%" mb={4} radius="sm" />
							<Skeleton height={80} width="100%" mt={8} radius="sm" />
							<Skeleton height={16} width="90%" mt={8} radius="sm" />
							<Skeleton height={16} width="60%" radius="sm" />
						</Box>
					</Group>

					{/* Another user message */}
					<Group align="flex-start" gap="sm">
						<Skeleton height={28} width={28} circle />
						<Box style={{ flex: 1 }}>
							<Skeleton height={14} width={60} mb={6} radius="sm" />
							<Skeleton height={24} width="70%" radius="sm" />
						</Box>
					</Group>

					{/* Another assistant response */}
					<Group align="flex-start" gap="sm">
						<Skeleton height={28} width={28} circle />
						<Box style={{ flex: 1 }}>
							<Skeleton height={14} width={80} mb={6} radius="sm" />
							<Skeleton height={16} width="92%" mb={4} radius="sm" />
							<Skeleton height={16} width="85%" mb={4} radius="sm" />
							<Skeleton height={16} width="45%" radius="sm" />
						</Box>
					</Group>
				</Stack>
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
