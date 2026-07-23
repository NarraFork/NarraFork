import { Alert, Center, Loader, Stack, Text } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

export const Route = createFileRoute("/dev-vlist-harness")({
	component: DevVListHarnessPage,
});

const LazyVListHarness = lazy(() =>
	import("../components/narrator/vlist/VListHarness").then((module) => ({
		default: module.VListHarness,
	})),
);

function DevVListHarnessPage() {
	if (!import.meta.env.DEV) {
		return (
			<Center mih="50vh" p="md">
				<Alert color="gray" title="Development-only page">
					The vlist calibration harness is available only in development builds.
				</Alert>
			</Center>
		);
	}

	return (
		<Suspense
			fallback={
				<Center mih="50vh">
					<Stack align="center" gap="xs">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							Loading vlist calibration harness…
						</Text>
					</Stack>
				</Center>
			}
		>
			<LazyVListHarness />
		</Suspense>
	);
}
