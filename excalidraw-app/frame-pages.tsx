import { removeDarkModeFilter } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import { isFrameElement, newFrameElement } from "@excalidraw/element";
import { useEffect, useRef, useState } from "react";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  clampFrameDimension,
  FRAME_PRESETS,
  getFrameNavigationDelta,
  getNextFramePosition,
  isKeyboardInputTarget,
  resolveSelectedFrameId,
  resolveSelectedFrameIds,
  sortFramesForPlayback,
} from "./frank/frame-utils";
import { MAX_AI_CONTEXT_FRAMES } from "./frank/frame-context";
import { getFrankThemeColorData } from "./frank/accent-colors";

import type { FrankSceneLifecycle } from "./frank/scene-lifecycle";

const getFrames = (excalidrawAPI: ExcalidrawImperativeAPI) =>
  sortFramesForPlayback(
    excalidrawAPI.getSceneElements().filter(isFrameElement),
  );

const areIdSetsEqual = (
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
) => left.size === right.size && [...left].every((id) => right.has(id));

export const FramePages = ({
  excalidrawAPI,
  sceneLifecycle,
  theme,
  accentColor,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  sceneLifecycle: FrankSceneLifecycle;
  theme: AppState["theme"];
  accentColor: string;
}) => {
  const [frames, setFrames] = useState<NonDeleted<ExcalidrawFrameElement>[]>(
    () => getFrames(excalidrawAPI),
  );
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(() =>
    resolveSelectedFrameId(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState().selectedElementIds,
    ),
  );
  const [selectedFrameIds, setSelectedFrameIds] = useState<ReadonlySet<string>>(
    () =>
      resolveSelectedFrameIds(
        excalidrawAPI.getSceneElements(),
        excalidrawAPI.getAppState().selectedElementIds,
      ),
  );
  const [showSizes, setShowSizes] = useState(false);
  const selectFrameRef = useRef<
    (frame: NonDeleted<ExcalidrawFrameElement>, additive: boolean) => void
  >(() => {});
  const [customSize, setCustomSize] = useState({
    width: "1080",
    height: "1350",
  });

  useEffect(() => {
    return sceneLifecycle.subscribe((snapshot) => {
      const nextFrames = sortFramesForPlayback(
        snapshot.elements.filter(
          (element): element is NonDeleted<ExcalidrawFrameElement> =>
            !element.isDeleted && isFrameElement(element),
        ),
      );
      setFrames((previousFrames) => {
        const changed =
          previousFrames.length !== nextFrames.length ||
          previousFrames.some(
            (frame, index) => frame.id !== nextFrames[index]?.id,
          );
        return changed ? nextFrames : previousFrames;
      });
      const nextSelectedFrameId = resolveSelectedFrameId(
        snapshot.elements,
        snapshot.selectedElementIds,
      );
      const nextSelectedFrameIds = resolveSelectedFrameIds(
        snapshot.elements,
        snapshot.selectedElementIds,
      );
      setSelectedFrameIds((previousIds) =>
        areIdSetsEqual(previousIds, nextSelectedFrameIds)
          ? previousIds
          : nextSelectedFrameIds,
      );
      setSelectedFrameId((previousFrameId) => {
        if (previousFrameId && nextSelectedFrameIds.has(previousFrameId)) {
          return previousFrameId;
        }
        if (nextSelectedFrameId) {
          return nextSelectedFrameId;
        }
        return previousFrameId &&
          nextFrames.some((frame) => frame.id === previousFrameId)
          ? previousFrameId
          : nextFrames[0]?.id || null;
      });
    });
  }, [sceneLifecycle]);

  const selectFrame = (
    frame: NonDeleted<ExcalidrawFrameElement>,
    additive: boolean,
  ) => {
    setSelectedFrameId(frame.id);
    setShowSizes(false);
    const elements = excalidrawAPI.getSceneElements();
    const currentSelection = excalidrawAPI.getAppState().selectedElementIds;
    const currentlySelectedFrameIds = resolveSelectedFrameIds(
      elements,
      currentSelection,
    );
    const nextSelection = additive ? { ...currentSelection } : {};
    if (
      additive &&
      !currentlySelectedFrameIds.has(frame.id) &&
      currentlySelectedFrameIds.size >= MAX_AI_CONTEXT_FRAMES
    ) {
      excalidrawAPI.setToast({
        message: `Use up to ${MAX_AI_CONTEXT_FRAMES} frames as AI context.`,
      });
      excalidrawAPI.setViewport({
        target: [frame],
        fit: "scale-down",
        animation: true,
        offsets: { ui: true },
      });
      return;
    }
    if (additive && currentlySelectedFrameIds.has(frame.id)) {
      for (const element of elements) {
        const selectedFrameId =
          element.type === "frame" ? element.id : element.frameId;
        if (selectedFrameId === frame.id) {
          delete nextSelection[element.id];
        }
      }
    } else {
      nextSelection[frame.id] = true;
    }
    excalidrawAPI.updateScene({
      appState: { selectedElementIds: nextSelection },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    excalidrawAPI.setViewport({
      target: [frame],
      fit: "scale-down",
      animation: true,
      offsets: { ui: true },
    });
  };
  selectFrameRef.current = selectFrame;

  const createFrame = (
    size: { width: number; height: number },
    currentFrame: NonDeleted<ExcalidrawFrameElement> | undefined,
  ) => {
    const appState = excalidrawAPI.getAppState();
    const position = currentFrame
      ? getNextFramePosition(frames, currentFrame)
      : (() => {
          const center = viewportCoordsToSceneCoords(
            {
              clientX: appState.offsetLeft + appState.width / 2,
              clientY: appState.offsetTop + appState.height / 2,
            },
            appState,
          );
          return {
            x: center.x - size.width / 2,
            y: center.y - size.height / 2,
          };
        })();
    const frameStrokeColor =
      currentFrame?.strokeColor ||
      (theme === "dark" ? removeDarkModeFilter(accentColor) : accentColor);
    const frame = newFrameElement({
      ...position,
      ...size,
      name: `Frame ${frames.length + 1}`,
      strokeColor: frameStrokeColor,
      backgroundColor: "transparent",
      fillStyle: currentFrame?.fillStyle,
      strokeWidth: currentFrame?.strokeWidth,
      strokeStyle: currentFrame?.strokeStyle,
      roughness: 0,
      opacity: currentFrame?.opacity,
      customData: currentFrame?.customData
        ? { ...currentFrame.customData }
        : currentFrame
        ? undefined
        : getFrankThemeColorData({ strokeColor: frameStrokeColor }),
    });
    excalidrawAPI.updateScene({
      elements: [
        ...excalidrawAPI.getSceneElementsIncludingDeleted(),
        frame,
      ] as OrderedExcalidrawElement[],
      appState: { selectedElementIds: { [frame.id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    setSelectedFrameId(frame.id);
    setShowSizes(false);
    excalidrawAPI.setViewport({
      target: [frame],
      fit: "scale-down",
      animation: true,
      offsets: { ui: true },
    });
  };

  const currentFrame =
    frames.find((frame) => frame.id === selectedFrameId) || frames.at(-1);

  useEffect(() => {
    const navigateFrames = (event: KeyboardEvent) => {
      const delta = getFrameNavigationDelta(event);
      if (!delta || !frames.length || isKeyboardInputTarget(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const activeFrameId = resolveSelectedFrameId(
        excalidrawAPI.getSceneElements(),
        excalidrawAPI.getAppState().selectedElementIds,
      );
      const currentIndex = Math.max(
        0,
        frames.findIndex(
          (frame) => frame.id === (activeFrameId || selectedFrameId),
        ),
      );
      const nextIndex = Math.min(
        frames.length - 1,
        Math.max(0, currentIndex + delta),
      );
      if (nextIndex !== currentIndex) {
        selectFrameRef.current(frames[nextIndex], false);
      }
    };
    window.addEventListener("keydown", navigateFrames, true);
    return () => window.removeEventListener("keydown", navigateFrames, true);
  }, [excalidrawAPI, frames, selectedFrameId]);

  return (
    <nav className={`frank-pages frank-pages--${theme}`} aria-label="Frames">
      <div className="frank-pages__heading">
        <span>Frames</span>
        <output aria-live="polite">{frames.length}</output>
      </div>
      <div className="frank-pages__list">
        {frames.map((frame, index) => (
          <button
            key={frame.id}
            type="button"
            aria-label={`Open frame ${index + 1}, ${Math.round(
              frame.width,
            )} by ${Math.round(frame.height)}`}
            aria-current={frame.id === selectedFrameId ? "page" : undefined}
            aria-pressed={selectedFrameIds.has(frame.id)}
            title={`${
              frame.name || `Frame ${index + 1}`
            } · Shift-click to add as AI context`}
            onClick={(event) => selectFrame(frame, event.shiftKey)}
          >
            <span
              className="frank-pages__ratio"
              aria-hidden="true"
              style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
            />
            <span>{index + 1}</span>
          </button>
        ))}
      </div>
      <button
        className="frank-pages__add"
        type="button"
        aria-label="Add frame"
        aria-expanded={showSizes}
        onClick={() => setShowSizes((isVisible) => !isVisible)}
      >
        <span aria-hidden="true">+</span>
      </button>
      {showSizes ? (
        <div
          className="frank-pages__sizes"
          role="group"
          aria-label="Frame size"
        >
          <div className="frank-pages__sizes-heading">
            <span>New Frame</span>
            <button
              type="button"
              aria-label="Close frame sizes"
              onClick={() => setShowSizes(false)}
            >
              ×
            </button>
          </div>
          {currentFrame ? (
            <button
              type="button"
              onClick={() =>
                createFrame(
                  { width: currentFrame.width, height: currentFrame.height },
                  currentFrame,
                )
              }
            >
              <span>Same as Current</span>
              <small>
                {Math.round(currentFrame.width)} ×{" "}
                {Math.round(currentFrame.height)}
              </small>
            </button>
          ) : null}
          {Object.entries(FRAME_PRESETS).map(([value, preset]) => (
            <button
              key={value}
              type="button"
              onClick={() => createFrame(preset, currentFrame)}
            >
              <span>{preset.label}</span>
              <small>
                {preset.width} × {preset.height}
              </small>
            </button>
          ))}
          <div className="frank-pages__custom">
            <label>
              <span>W</span>
              <input
                type="number"
                name="frame-width"
                min="480"
                max="3000"
                autoComplete="off"
                value={customSize.width}
                onChange={(event) =>
                  setCustomSize((size) => ({
                    ...size,
                    width: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              <span>H</span>
              <input
                type="number"
                name="frame-height"
                min="480"
                max="3000"
                autoComplete="off"
                value={customSize.height}
                onChange={(event) =>
                  setCustomSize((size) => ({
                    ...size,
                    height: event.target.value,
                  }))
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                createFrame(
                  {
                    width: clampFrameDimension(customSize.width, 1080),
                    height: clampFrameDimension(customSize.height, 1350),
                  },
                  currentFrame,
                )
              }
            >
              Create
            </button>
          </div>
        </div>
      ) : null}
    </nav>
  );
};
