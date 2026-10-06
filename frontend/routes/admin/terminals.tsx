import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/terminals")({
	component: () => <Navigate to="/settings/terminals" replace />,
});
