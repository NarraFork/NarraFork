import { createFileRoute } from "@tanstack/react-router";
import { StandaloneWindowLayout } from "../components/StandaloneWindowLayout";

export const Route = createFileRoute("/windows")({
	component: StandaloneWindowLayout,
});
