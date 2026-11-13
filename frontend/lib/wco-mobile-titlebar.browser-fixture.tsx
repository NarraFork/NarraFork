import "@mantine/core/styles.css";
import "../styles/safe-area.css";
import "../styles/wco.css";
import { AppShell, Box, MantineProvider } from "@mantine/core";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NarratorHeaderLayout } from "../components/narrator/header/NarratorHeaderLayout";
import { useMobileViewport } from "../hooks/useMobileViewport";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "./safe-area";
import { useWcoTitlebarRows } from "./wco-titlebar";

function Fixture() {
	const ref = useWcoTitlebarRows(true);
	const mobile = useMobileViewport();
	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState("A title with selectable words");
	const [clicks, setClicks] = useState(0);
	return (
		<AppShell
			className="nf-app-shell"
			layout="alt"
			header={{ height: 0 }}
			navbar={{ width: 80, breakpoint: "sm", collapsed: { mobile: true } }}
			padding="md"
			transitionDuration={0}
		>
			<AppShell.Navbar />
			<AppShell.Main className="nf-app-shell-main">
				<div className="nf-wco-top-gap" />
				<div className="nf-wco-main-strip" />
				<Box
					ref={ref}
					id="fixture-page"
					data-nf-wco-titlebar
					h={APP_SHELL_FULL_BLEED_HEIGHT}
					mx="calc(var(--mantine-spacing-md) * -1)"
					my="calc(var(--mantine-spacing-md) * -1)"
					style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
				>
					<NarratorHeaderLayout
						titleFullWidth={220}
						surfacedToolCount={8}
						showMenu={mobile}
						showTitleActions
					>
						{({ titleWidth, visibleToolCount, unmeasured }) => (
							<>
								{mobile && (
									<button
										type="button"
										id="menu"
										style={{ width: 28, flexShrink: 0 }}
										onClick={() => setClicks((n) => n + 1)}
									>
										M
									</button>
								)}
								<div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
									{editing ? (
										<input
											id="title-input"
											aria-label="Edit title"
											value={title}
											onChange={(event) => setTitle(event.currentTarget.value)}
											style={{ width: titleWidth, minWidth: 0, boxSizing: "border-box" }}
										/>
									) : (
										<span
											id="title"
											style={{
												width: titleWidth,
												overflow: "hidden",
												whiteSpace: "nowrap",
												flexShrink: 0,
											}}
										>
											{title}
										</span>
									)}
									<button
										type="button"
										id="edit"
										aria-label="Start editing"
										style={{ width: 18, padding: 0 }}
										onClick={() => setEditing((value) => !value)}
									>
										E
									</button>
									<button
										type="button"
										id="generate"
										aria-label="Generate title"
										style={{ width: 18, padding: 0 }}
										onClick={() => setClicks((n) => n + 1)}
									>
										G
									</button>
								</div>
								<div
									id="toolbar"
									data-visible-tools={visibleToolCount}
									data-unmeasured={unmeasured}
									style={{ display: "flex", gap: 10, marginLeft: "auto", flexShrink: 0 }}
								>
									{["one", "two", "three", "four", "five", "six", "seven", "eight"]
										.slice(0, visibleToolCount)
										.map((tool) => (
											<button
												type="button"
												key={tool}
												aria-label={`Tool ${tool}`}
												style={{ width: 22, padding: 0 }}
												onClick={() => setClicks((n) => n + 1)}
											>
												T
											</button>
										))}
									<button
										type="button"
										id="overflow"
										aria-label="More tools"
										style={{ width: 22, padding: 0 }}
										onClick={() => setClicks((n) => n + 1)}
									>
										+
									</button>
								</div>
							</>
						)}
					</NarratorHeaderLayout>
					<output id="clicks">{clicks}</output>
				</Box>
			</AppShell.Main>
		</AppShell>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
document.documentElement.setAttribute("data-nf-authenticated-app-shell", "true");
createRoot(root).render(
	<MantineProvider>
		<Fixture />
	</MantineProvider>,
);
