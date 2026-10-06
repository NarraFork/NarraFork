import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/runtime")({
	component: () => <Navigate to="/settings/runtime" replace />,
});
