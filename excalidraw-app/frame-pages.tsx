import {
  CaptureUpdateAction,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import { isFrameElement, newFrameElement } from "@excalidraw/element";
import { useEffect, useState } from "react";

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
  getNextFramePosition,
  resolveSelectedFrameId,
  sortFramesForPlayback,
} from "./frank/frame-utils";

import type { FrankSceneLifecycle } from "./frank/scene-lifecycle";

const getFrames = (excalidrawAPI: ExcalidrawImperativeAPI) =>
  sortFramesForPlayback(
    excalidrawAPI.getSceneElements().filter(isFrameElement),
  );

export const FramePages = ({
  excalidrawAPI,
  sceneLifecycle,
  theme,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  sceneLifecycle: FrankSceneLifecycle;
  theme: AppState["theme"];
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
  const [showSizes, setShowSizes] = useState(false);
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
      setSelectedFrameId((previousFrameId) => {
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

  const selectFrame = (frame: NonDeleted<ExcalidrawFrameElement>) => {
    setSelectedFrameId(frame.id);
    setShowSizes(false);
    excalidrawAPI.updateScene({
      appState: { selectedElementIds: { [frame.id]: true } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    excalidrawAPI.setViewport({
      target: [frame],
      fit: "scale-down",
      animation: true,
      offsets: { ui: true },
    });
  };

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
    const frame = newFrameElement({
      ...position,
      ...size,
      name: `Page ${frames.length + 1}`,
      strokeColor: currentFrame?.strokeColor || "#002fa7",
      backgroundColor: "transparent",
      fillStyle: currentFrame?.fillStyle,
      strokeWidth: currentFrame?.strokeWidth,
      strokeStyle: currentFrame?.strokeStyle,
      roughness: 0,
      opacity: currentFrame?.opacity,
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

  return (
    <nav className={`frank-pages frank-pages--${theme}`} aria-label="Pages">
      <div className="frank-pages__heading">
        <span>Pages</span>
        <output aria-live="polite">{frames.length}</output>
      </div>
      <div className="frank-pages__list">
        {frames.map((frame, index) => (
          <button
            key={frame.id}
            type="button"
            aria-label={`Open page ${index + 1}, ${Math.round(
              frame.width,
            )} by ${Math.round(frame.height)}`}
            aria-current={frame.id === selectedFrameId ? "page" : undefined}
            title={frame.name || `Page ${index + 1}`}
            onClick={() => selectFrame(frame)}
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
        aria-label="Add page"
        aria-expanded={showSizes}
        onClick={() => setShowSizes((isVisible) => !isVisible)}
      >
        <span aria-hidden="true">+</span>
      </button>
      {showSizes ? (
        <div className="frank-pages__sizes" role="group" aria-label="Page size">
          <div className="frank-pages__sizes-heading">
            <span>New Page</span>
            <button
              type="button"
              aria-label="Close page sizes"
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
