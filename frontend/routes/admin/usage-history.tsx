import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/usage-history")({
	component: () => <Navigate to="/settings/usage" replace />,
});
