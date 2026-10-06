import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/containers")({
	component: () => <Navigate to="/settings/chapters" replace />,
});
