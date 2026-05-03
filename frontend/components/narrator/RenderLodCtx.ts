import { createContext, useContext } from "react";

export type RenderLod = "full" | "preview";

export const RenderLodCtx = createContext<RenderLod>("full");

export function useRenderLod() {
	return useContext(RenderLodCtx);
}
