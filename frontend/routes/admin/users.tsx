import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/users")({
	component: () => <Navigate to="/settings/users" replace />,
});
