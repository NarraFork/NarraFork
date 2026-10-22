import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import type { GitWorkspace } from "@shared/git-workspace";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NarratorGitBar } from "./NarratorGitBar";

declare global {
	interface Window {
		gitFixtureWorkspace: { data?: GitWorkspace; isPending: boolean; isError: boolean };
		gitFixtureContext: { cwd: string; deviceId: string; revision: number };
	}
}
const root = createRoot(document.getElementById("root") as HTMLElement);
const qc = new QueryClient();
let generation = 0;
let completed = false;
let gitOpenCount = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function workspace(state: GitWorkspace["state"], branch?: string): GitWorkspace {
	return {
		state,
		branch,
		deviceId: window.gitFixtureContext.deviceId,
		cwd: window.gitFixtureContext.cwd,
		rootPath: state === "ready" ? window.gitFixtureContext.cwd : null,
		workspaceKey: state === "ready" ? `remote:${window.gitFixtureContext.cwd}` : null,
		repositoryKey: state === "ready" ? `remote:${window.gitFixtureContext.cwd}` : null,
		capabilities: { read: state === "ready", write: state === "ready" },
	};
}
function render() {
	root.render(
		<MantineProvider>
			<QueryClientProvider client={qc}>
				<div
					style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}
				>
					<div style={{ height: 45, flexShrink: 0 }}>Narrator header</div>
					<div id="messages" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
						First-screen messages already adopted
					</div>
					<NarratorGitBar
						key={generation}
						narratorId="n"
						onOpenGitPanel={() => {
							gitOpenCount++;
						}}
					/>
					<div style={{ height: 29, flexShrink: 0 }}>Status</div>
					<div style={{ height: 54, flexShrink: 0 }}>Composer</div>
				</div>
			</QueryClientProvider>
		</MantineProvider>,
	);
}
export function start(scenario: string) {
	clearTimeout(timer);
	generation++;
	completed = false;
	gitOpenCount = 0;
	window.gitFixtureContext = { cwd: "/repo", deviceId: "remote", revision: 1 };
	window.gitFixtureWorkspace = {
		isPending: true,
		isError: false,
		...(scenario.includes("cached-notgit") ? { data: workspace("not_git") } : {}),
	};
	render();
	timer = setTimeout(() => {
		window.gitFixtureWorkspace = {
			isPending: false,
			isError: false,
			data: workspace(scenario.includes("notgit") ? "not_git" : "ready", "branch-ready"),
		};
		completed = true;
		render();
	}, 2000);
}
export function initializeGit() {
	clearTimeout(timer);
	completed = false;
	window.gitFixtureContext = {
		...window.gitFixtureContext,
		revision: window.gitFixtureContext.revision + 1,
	};
	timer = setTimeout(() => {
		window.gitFixtureWorkspace = {
			isPending: false,
			isError: false,
			data: {
				...workspace("ready", "initialized-branch"),
				capabilities: { read: true, write: false },
			},
		};
		completed = true;
		render();
	}, 2000);
}
export function revise() {
	clearTimeout(timer);
	completed = false;
	window.gitFixtureContext = {
		...window.gitFixtureContext,
		cwd: "/new-repo",
		revision: window.gitFixtureContext.revision + 1,
	};
	window.gitFixtureWorkspace = { isPending: true, isError: false };
	render();
	timer = setTimeout(() => {
		window.gitFixtureWorkspace = {
			isPending: false,
			isError: false,
			data: workspace("ready", "new-revision-branch"),
		};
		completed = true;
		render();
	}, 2000);
}
export function snapshot() {
	const viewport = document.getElementById("messages");
	const slot = document.querySelector("[data-git-slot]");
	const rect = viewport?.getBoundingClientRect();
	return {
		ready: !!rect,
		completed,
		top: rect?.top,
		height: rect?.height,
		slotHeight: slot?.getBoundingClientRect().height ?? 0,
		text: slot?.textContent ?? "",
		canOpen: slot?.getAttribute("role") === "button" || !!slot?.querySelector('[role="button"]'),
		gitOpenCount,
		cwdTitle: slot?.querySelector("p[title]")?.getAttribute("title") ?? null,
	};
}
start("git");
