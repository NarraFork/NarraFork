import { Box, Group, Skeleton, Stack } from "@mantine/core";

/**
 * Message-shaped skeleton rows for the narrator message area.
 *
 * Shared by every stage of the message-list loading transition — the
 * panel-level skeleton (narrator record still loading), the lazy vlist chunk's
 * Suspense fallback, and the vlist's own document-loading state — so the
 * placeholder keeps the same shape the whole way through instead of switching
 * between a skeleton and a bare text line.
 */
export function NarratorMessageListSkeleton() {
	return (
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
	);
}
