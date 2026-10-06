import { createFileRoute, useLocation } from "@tanstack/react-router";
import { PublicSharedNarratorPage } from "../components/public-share/PublicSharedNarratorPage";
import { readPublicShareToken } from "../lib/public-share-api";

export const Route = createFileRoute("/shared/narrators/$shareId")({
	component: PublicNarratorShareRoute,
});

function PublicNarratorShareRoute() {
	const { shareId } = Route.useParams();
	const hash = useLocation({ select: (location) => location.hash });
	const credential = readPublicShareToken(hash);
	return (
		<PublicSharedNarratorPage
			key={`${shareId}:${credential}`}
			shareId={shareId}
			credential={credential}
		/>
	);
}
