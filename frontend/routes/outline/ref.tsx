/**
 * `/outline/ref?a=<key/sid>[&space=<key>]` and `/outline/ref?space=<key>&commit=<seq>`: what a
 * tool card's address or commit names, opened as a page. Inside a session these links open an
 * outline panel instead (`lib/outline-opener.tsx`); this route is where they lead anywhere else
 * (a new tab, a copied link). It asks the server where the reference points and replaces itself
 * with that page; a reference that names nothing readable says so.
 */
import { Alert, Center, Container, Loader } from "@mantine/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { OutlineGate } from "../../components/outline/OutlineGate";
import { type OutlineHrefTarget, parseOutlineHref } from "../../lib/outline-href";
import { outlineStateForHref } from "../../lib/outline-opener";

export const Route = createFileRoute("/outline/ref")({
	component: OutlineRefRoute,
	validateSearch: (search: Record<string, unknown>) => ({
		a: typeof search.a === "string" ? search.a : undefined,
		space: typeof search.space === "string" ? search.space : undefined,
		commit:
			typeof search.commit === "number" || typeof search.commit === "string"
				? String(search.commit)
				: undefined,
	}),
});

function targetOf(search: {
	a?: string;
	space?: string;
	commit?: string;
}): OutlineHrefTarget | null {
	const query = new URLSearchParams();
	if (search.a) query.set("a", search.a);
	if (search.space) query.set("space", search.space);
	if (search.commit) query.set("commit", search.commit);
	return parseOutlineHref(`/outline/ref?${query.toString()}`);
}

function OutlineRefRoute() {
	return (
		<Container size="lg" py="md" px={0}>
			<OutlineGate>
				<OutlineRef />
			</OutlineGate>
		</Container>
	);
}

function OutlineRef() {
	const search = Route.useSearch();
	const navigate = useNavigate();
	const { t } = useTranslation("outline");
	const [missing, setMissing] = useState(false);
	useEffect(() => {
		const target = targetOf(search);
		if (!target) {
			setMissing(true);
			return;
		}
		let alive = true;
		void outlineStateForHref(target)
			.then((state) => {
				if (!alive) return;
				if (!state?.spaceId || !state.blockId) {
					setMissing(true);
					return;
				}
				void navigate({
					to: "/outline/$spaceId/$blockId",
					params: { spaceId: state.spaceId, blockId: state.blockId },
					search: state.asOf !== undefined ? { asOf: state.asOf } : {},
					replace: true,
				});
			})
			.catch(() => {
				if (alive) setMissing(true);
			});
		return () => {
			alive = false;
		};
	}, [search, navigate]);
	if (missing) {
		return (
			<Alert color="gray" variant="light">
				{t("link.notFound")}
			</Alert>
		);
	}
	return (
		<Center py="xl">
			<Loader size="sm" />
		</Center>
	);
}
