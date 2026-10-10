import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import {
  createMermaidRenderModel,
  getMermaidRenderRequest,
  reduceMermaidRenderModel,
  type DiagramColorScheme,
  type DiagramDimensions,
  type RenderedDiagram,
} from "./render-model";
import { containsUnsafeMermaidSource } from "./source-policy";
import type { MarkdownPhase } from "../types";
import { useProtectedPresentation } from "@/components/protected-presentation";

const renderCache = new Map<string, RenderedDiagram>();
const RENDER_CACHE_LIMIT = 50;

function cacheKey(source: string, colorScheme: DiagramColorScheme): string {
  return `${colorScheme}\u0000${source}`;
}

function readCachedRender(source: string, colorScheme: DiagramColorScheme): RenderedDiagram | null {
  return renderCache.get(cacheKey(source, colorScheme)) ?? null;
}

function cacheRender(rendered: RenderedDiagram): void {
  if (renderCache.size >= RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) {
      renderCache.delete(oldest);
    }
  }
  renderCache.set(cacheKey(rendered.source, rendered.colorScheme), rendered);
}

export function useMermaidRenderModel({
  source,
  phase,
  colorScheme,
}: {
  source: string;
  phase: MarkdownPhase;
  colorScheme: DiagramColorScheme;
}) {
  const protectedPresentation = useProtectedPresentation();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const renderInput = useMemo(
    () => ({
      source,
      phase,
      colorScheme,
      rejected: containsUnsafeMermaidSource(source),
      cached: protectedPresentation ? null : readCachedRender(source, colorScheme),
    }),
    [colorScheme, phase, source, protectedPresentation],
  );
  const [state, dispatch] = useReducer(
    reduceMermaidRenderModel,
    renderInput,
    createMermaidRenderModel,
  );

  useEffect(() => {
    dispatch({ type: "inputChanged", input: renderInput });
  }, [renderInput]);

  const rendered = useCallback(
    (response: {
      revision: number;
      source: string;
      colorScheme: DiagramColorScheme;
      dimensions: DiagramDimensions;
    }) => {
      // A queued iframe/WebView completion may outlive the reading surface.
      // Never publish it into the process-wide cache after that surface is gone.
      if (!mounted.current) return;
      const cached: RenderedDiagram = {
        source: response.source,
        colorScheme: response.colorScheme,
        ...response.dimensions,
      };
      if (!protectedPresentation) cacheRender(cached);
      dispatch({
        type: "rendered",
        revision: response.revision,
        source: response.source,
        colorScheme: response.colorScheme,
        dimensions: response.dimensions,
      });
    },
    [protectedPresentation],
  );
  const renderFailed = useCallback((revision: number) => {
    if (!mounted.current) return;
    dispatch({ type: "renderFailed", revision });
  }, []);

  return {
    state,
    request: getMermaidRenderRequest(state),
    rendered,
    renderFailed,
  };
}
