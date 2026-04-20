import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/providers")({
	component: () => <Navigate to="/settings/providers" replace />,
});
