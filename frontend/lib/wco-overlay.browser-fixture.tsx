import "@mantine/core/styles.css";
import "../styles/safe-area.css";
import "../styles/wco.css";
import { Drawer, MantineProvider, Modal } from "@mantine/core";
import { createRoot } from "react-dom/client";
import { PanZoomStage } from "../components/common/PanZoomStage";
import { mantineTheme } from "./mantine-theme";
import {
	SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE,
	SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE,
	safeAreaDrawerBodyHeight,
	safeAreaFullscreenModalBodyStyle,
} from "./safe-area";

const params = new URLSearchParams(window.location.search);
const kind = params.get("kind") ?? "fullscreen";
const content = (
	<button id="footer" type="button">
		Bottom action
	</button>
);
const onClose = () => {
	document.documentElement.dataset.closed = "true";
};

function Fixture() {
	if (kind === "panzoom" || kind === "embedded") {
		return (
			<div style={{ height: 240 }}>
				<PanZoomStage embedded={kind === "embedded"} onClose={onClose}>
					<div>Image or diagram</div>
				</PanZoomStage>
			</div>
		);
	}
	if (kind.startsWith("drawer-")) {
		const position = kind.slice(7) as "left" | "right" | "top" | "bottom";
		return (
			<Drawer
				opened
				onClose={onClose}
				title="Drawer"
				position={position}
				size={position === "top" || position === "bottom" ? 200 : 320}
				transitionProps={{ duration: 0 }}
				closeButtonProps={{ "aria-label": "Close fixture" }}
				styles={{
					header: { height: 60 },
					body: {
						height: safeAreaDrawerBodyHeight(60),
						display: "flex",
						flexDirection: "column",
						justifyContent: "flex-end",
					},
				}}
			>
				{content}
			</Drawer>
		);
	}
	const fullScreen = kind !== "ordinary";
	return (
		<Modal
			opened
			onClose={onClose}
			title={kind === "headerless" ? undefined : "Modal"}
			withCloseButton={kind !== "headerless"}
			fullScreen={fullScreen}
			centered={kind === "ordinary"}
			transitionProps={{ duration: 0 }}
			closeButtonProps={{ "aria-label": "Close fixture" }}
			styles={
				fullScreen && kind !== "native"
					? {
							content: SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE,
							header: SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE,
							body: {
								...safeAreaFullscreenModalBodyStyle(),
								display: "flex",
								flexDirection: "column",
								justifyContent: "flex-end",
							},
						}
					: undefined
			}
		>
			{content}
		</Modal>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
	<MantineProvider theme={mantineTheme}>
		<Fixture />
	</MantineProvider>,
);
