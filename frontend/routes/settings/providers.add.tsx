import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AddProviderPage } from "../../components/providers/AddProviderPage";
import { useAddProvider } from "../../components/providers/provider-add-context";

export const Route = createFileRoute("/settings/providers/add")({
	component: AddProviderRoutePage,
});

function AddProviderRoutePage() {
	const navigate = useNavigate();
	const addProvider = useAddProvider();
	const close = () => void navigate({ to: "/settings/providers", replace: true });
	return (
		<AddProviderPage
			onClose={close}
			onAdd={(draft) => {
				addProvider(draft);
				close();
			}}
		/>
	);
}
