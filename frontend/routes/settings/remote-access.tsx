import { createFileRoute } from "@tanstack/react-router";
import { RemoteAccessSettingsPanel } from "../../components/settings/RemoteAccessSettingsPanel";

export const Route = createFileRoute("/settings/remote-access")({
	component: RemoteAccessSettingsPanel,
});
