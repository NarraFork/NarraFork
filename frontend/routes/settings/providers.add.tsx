import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AddProviderPage } from "../../components/providers/AddProviderPage";
import { useAddProvider } from "../../components/providers/provider-add-context";

export const Route = createFileRoute("/settings/providers/add")({
	component: AddProviderRoutePage,
});

function AddProviderRoutePage() {
	const navigate = useNavigate();
	const addProvider = useAddProvider();
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	const close = () => void navigate({ to: "/settings/providers", replace: true });
	return (
		<AddProviderPage
			onClose={close}
			onAdd={async (draft) => {
				await addProvider(draft);
				if (mountedRef.current) close();
			}}
		/>
	);
}
