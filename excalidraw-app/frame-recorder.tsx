import {
  exportToCanvas,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import {
  CloseIcon,
  settingsIcon,
} from "@excalidraw/excalidraw/components/icons";
import { isFrameElement } from "@excalidraw/element";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  resolveSelectedFrameId,
  sortFramesForPlayback,
} from "./frank/frame-utils";

import type { FrankSceneLifecycle } from "./frank/scene-lifecycle";

type RecorderStatus = "idle" | "preview" | "recording" | "paused";
type CameraPosition = { x: number; y: number };
type ViewportRect = { x: number; y: number; width: number; height: number };
export type RecorderScope = "frame" | "canvas";
export type RecorderLayout = "full-camera" | "split" | "canvas-pip";
type SplitPosition = "top" | "bottom";
type RecorderSettings = {
  scope: RecorderScope;
  layout: RecorderLayout;
  cameraSize: number;
  cameraPosition: CameraPosition;
  splitPosition: SplitPosition;
  splitRatio: number;
};
type RecordingAudioPipeline = {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  delay: DelayNode;
  destination: MediaStreamAudioDestinationNode;
  inputLatency: number;
};

const MAX_RECORDING_SIDE = 1920;
const MAX_AUDIO_SYNC_DELAY_SECONDS = 0.35;
const AUDIO_SYNC_SMOOTHING = 0.16;
const DEFAULT_CAMERA_SIZE = 0.18;
const RECORDER_SETTINGS_KEY = "frank-canvas-recorder-settings";
const DEFAULT_RECORDER_LAYOUT: RecorderLayout = "split";

const RECORDER_MODES: readonly {
  scope: RecorderScope;
  value: RecorderLayout;
  label: string;
}[] = [
  { scope: "frame", value: "full-camera", label: "Full camera" },
  { scope: "frame", value: "split", label: "Split" },
  { scope: "frame", value: "canvas-pip", label: "Frame PIP" },
  { scope: "canvas", value: "canvas-pip", label: "Canvas PIP" },
];

const CAMERA_POSITIONS = {
  "top-left": { x: 0.14, y: 0.16 },
  "top-right": { x: 0.86, y: 0.16 },
  "bottom-left": { x: 0.14, y: 0.84 },
  "bottom-right": { x: 0.86, y: 0.84 },
} as const;

type CameraPositionName = keyof typeof CAMERA_POSITIONS;

export const formatRecordingTime = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;

export const getCameraFrameDelay = (
  now: DOMHighResTimeStamp,
  metadata: Pick<
    VideoFrameCallbackMetadata,
    "captureTime" | "expectedDisplayTime"
  >,
) => {
  if (
    typeof metadata.captureTime !== "number" ||
    !Number.isFinite(metadata.captureTime)
  ) {
    return null;
  }
  const displayTime = Math.max(now, metadata.expectedDisplayTime);
  return Math.min(
    MAX_AUDIO_SYNC_DELAY_SECONDS,
    Math.max(0, (displayTime - metadata.captureTime) / 1000),
  );
};

export const smoothCameraFrameDelay = (
  previousDelay: number | null,
  nextDelay: number,
) =>
  previousDelay === null
    ? nextDelay
    : previousDelay + (nextDelay - previousDelay) * AUDIO_SYNC_SMOOTHING;

export const getAudioSyncDelay = (
  cameraFrameDelay: number | null,
  microphoneLatency = 0,
) =>
  Math.min(
    MAX_AUDIO_SYNC_DELAY_SECONDS,
    Math.max(0, (cameraFrameDelay || 0) - Math.max(0, microphoneLatency)),
  );

export const shouldRenderRecordingComposite = (
  _scope: RecorderScope,
  _layout: RecorderLayout,
  isRecording: boolean,
) => isRecording;

export const usesNativeFullCamera = (
  scope: RecorderScope,
  layout: RecorderLayout,
) => scope === "frame" && layout === "full-camera";

export const shouldRefreshRecordingExport = (
  scope: RecorderScope,
  layout: RecorderLayout,
  isRecording: boolean,
) =>
  shouldRenderRecordingComposite(scope, layout, isRecording) &&
  !usesNativeFullCamera(scope, layout);

const readRecorderSettings = (): RecorderSettings => {
  const fallback: RecorderSettings = {
    scope: "frame",
    layout: DEFAULT_RECORDER_LAYOUT,
    cameraSize: DEFAULT_CAMERA_SIZE,
    cameraPosition: CAMERA_POSITIONS["bottom-right"],
    splitPosition: "top",
    splitRatio: 0.45,
  };
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(RECORDER_SETTINGS_KEY) || "null",
    );
    const scope: RecorderScope = saved?.scope === "canvas" ? "canvas" : "frame";
    const layout: RecorderLayout =
      scope === "canvas"
        ? "canvas-pip"
        : saved?.layout === "full-camera"
        ? "full-camera"
        : saved?.layout === "canvas-pip"
        ? "canvas-pip"
        : "split";
    return {
      scope,
      layout,
      cameraSize:
        typeof saved?.cameraSize === "number"
          ? Math.min(0.32, Math.max(0.12, saved.cameraSize))
          : fallback.cameraSize,
      cameraPosition:
        typeof saved?.cameraPosition?.x === "number" &&
        typeof saved?.cameraPosition?.y === "number"
          ? saved.cameraPosition
          : fallback.cameraPosition,
      splitPosition:
        saved?.splitPosition === "bottom" || saved?.layout === "canvas-camera"
          ? "bottom"
          : fallback.splitPosition,
      splitRatio:
        typeof saved?.splitRatio === "number"
          ? Math.min(0.7, Math.max(0.3, saved.splitRatio))
          : saved?.layout === "camera-canvas"
          ? 0.55
          : saved?.layout === "canvas-camera"
          ? 0.4
          : fallback.splitRatio,
    };
  } catch {
    return fallback;
  }
};

export const clampCameraPosition = (
  position: CameraPosition,
  frame: ViewportRect,
  diameter: number,
) => {
  const marginX = Math.min(0.5, diameter / 2 / frame.width);
  const marginY = Math.min(0.5, diameter / 2 / frame.height);
  return {
    x: Math.min(1 - marginX, Math.max(marginX, position.x)),
    y: Math.min(1 - marginY, Math.max(marginY, position.y)),
  };
};

export const getRecordingDimensions = ({
  width,
  height,
}: {
  width: number;
  height: number;
}) => {
  const scale = Math.min(1, MAX_RECORDING_SIDE / Math.max(width, height));
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
};

export const getRecordingLayoutRects = (
  layout: RecorderLayout,
  width: number,
  height: number,
  cameraPosition: CameraPosition,
  cameraSize: number,
  splitPosition: SplitPosition = "top",
  splitRatio = 0.45,
) => {
  const full = { x: 0, y: 0, width, height };
  if (layout === "full-camera") {
    return {
      canvas: full,
      camera: full,
      cameraShape: "rectangle",
      canvasLayer: "above",
    } as const;
  }
  if (layout === "split") {
    const cameraHeight = Math.round(
      height * Math.min(0.7, Math.max(0.3, splitRatio)),
    );
    const cameraIsAbove = splitPosition === "top";
    return {
      canvas: full,
      camera: {
        x: 0,
        y: cameraIsAbove ? 0 : height - cameraHeight,
        width,
        height: cameraHeight,
      },
      cameraShape: "rectangle",
      canvasLayer: "below",
    } as const;
  }
  const diameter = Math.min(width, height) * cameraSize;
  return {
    canvas: full,
    camera: {
      x: width * cameraPosition.x - diameter / 2,
      y: height * cameraPosition.y - diameter / 2,
      width: diameter,
      height: diameter,
    },
    cameraShape: "circle",
    canvasLayer: "below",
  } as const;
};

export const getCameraPreviewLayoutRects = (
  layout: RecorderLayout,
  bounds: ViewportRect,
  cameraPosition: CameraPosition,
  cameraSize: number,
  splitPosition: SplitPosition = "top",
  splitRatio = 0.45,
) => {
  const previewPosition =
    layout === "canvas-pip"
      ? clampCameraPosition(
          cameraPosition,
          bounds,
          Math.min(bounds.width, bounds.height) * cameraSize,
        )
      : cameraPosition;
  return getRecordingLayoutRects(
    layout,
    bounds.width,
    bounds.height,
    previewPosition,
    cameraSize,
    splitPosition,
    splitRatio,
  );
};

export const getClipInsets = (child: ViewportRect, bounds: ViewportRect) => ({
  top: Math.max(0, bounds.y - child.y),
  right: Math.max(0, child.x + child.width - (bounds.x + bounds.width)),
  bottom: Math.max(0, child.y + child.height - (bounds.y + bounds.height)),
  left: Math.max(0, bounds.x - child.x),
});

export const getFrameSceneSignature = (
  elements: readonly ExcalidrawElement[],
  frameId: string,
) =>
  elements
    .filter(
      (element) =>
        !element.isDeleted &&
        (element.id === frameId || element.frameId === frameId),
    )
    .map(
      (element) =>
        `${element.id}:${element.version}:${element.width}:${element.height}`,
    )
    .join("|");

export const getRecorderMimeType = (
  isTypeSupported = MediaRecorder.isTypeSupported.bind(MediaRecorder),
) => {
  const types = [
    "video/mp4;codecs=avc1.64003E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return types.find(isTypeSupported) || "";
};

export const getRecordingDownloadMetadata = (
  mimeType: string,
  now = new Date(),
) => {
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  return {
    extension,
    filename: `frank-canvas-${now
      .toISOString()
      .replace(/[:.]/g, "-")}.${extension}`,
  } as const;
};

const getFrameViewportRect = (
  frame: NonDeleted<ExcalidrawFrameElement>,
  appState: AppState,
) => {
  const topLeft = sceneCoordsToViewportCoords(
    { sceneX: frame.x, sceneY: frame.y },
    appState,
  );
  const bottomRight = sceneCoordsToViewportCoords(
    { sceneX: frame.x + frame.width, sceneY: frame.y + frame.height },
    appState,
  );
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
};

const getCanvasViewportRect = (appState: AppState): ViewportRect => ({
  x: appState.offsetLeft,
  y: appState.offsetTop,
  width: appState.width,
  height: appState.height,
});

const fitInside = (
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
) => {
  const scale = Math.min(
    targetWidth / sourceWidth,
    targetHeight / sourceHeight,
  );
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
};

type RecorderTextLine = {
  end: number;
  start: number;
  text: string;
};

export const getRecorderTextLines = (
  value: string,
  maxWidth: number,
  shouldWrap: boolean,
  measureText: (value: string) => number,
): RecorderTextLine[] => {
  const lines: RecorderTextLine[] = [];
  let hardLineStart = 0;

  value.split("\n").forEach((hardLine, hardLineIndex, hardLines) => {
    if (!shouldWrap || maxWidth <= 0 || measureText(hardLine) <= maxWidth) {
      lines.push({
        start: hardLineStart,
        end: hardLineStart + hardLine.length,
        text: hardLine,
      });
    } else {
      let lineStart = 0;
      let lineEnd = 0;
      const pushLine = (start: number, end: number) => {
        lines.push({
          start: hardLineStart + start,
          end: hardLineStart + end,
          text: hardLine.slice(start, end),
        });
      };
      const pushLongToken = (tokenStart: number, tokenEnd: number) => {
        let partStart = tokenStart;
        let partEnd = tokenStart;
        for (const character of hardLine.slice(tokenStart, tokenEnd)) {
          const characterEnd = partEnd + character.length;
          if (
            partEnd > partStart &&
            measureText(hardLine.slice(partStart, characterEnd)) > maxWidth
          ) {
            pushLine(partStart, partEnd);
            partStart = partEnd;
          }
          partEnd = characterEnd;
        }
        lineStart = partStart;
        lineEnd = partEnd;
      };

      for (const match of hardLine.matchAll(/\s+|\S+/gu)) {
        const tokenStart = match.index;
        const tokenEnd = tokenStart + match[0].length;
        const tokenWidth = measureText(match[0]);
        if (
          lineEnd > lineStart &&
          measureText(hardLine.slice(lineStart, tokenEnd)) > maxWidth
        ) {
          pushLine(lineStart, tokenStart);
          lineStart = tokenStart;
          lineEnd = tokenStart;
        }
        if (tokenWidth > maxWidth) {
          pushLongToken(tokenStart, tokenEnd);
        } else {
          lineEnd = tokenEnd;
        }
      }

      pushLine(lineStart, lineEnd);
    }

    hardLineStart += hardLine.length;
    if (hardLineIndex < hardLines.length - 1) {
      hardLineStart += 1;
    }
  });

  return lines;
};

const getCssPixel = (value: string | undefined, fallback = 0) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

const drawNativeTextEditor = (
  context: CanvasRenderingContext2D,
  destination: ViewportRect,
  frameRect: ViewportRect,
) => {
  const editor = document.querySelector<HTMLTextAreaElement>(
    ".excalidraw-app .excalidraw-wysiwyg",
  );
  if (!editor || !editor.offsetParent || !editor.value) {
    return;
  }

  const style = window.getComputedStyle(editor);
  const parentRect = editor.offsetParent.getBoundingClientRect();
  const editorWidth = editor.offsetWidth;
  const editorHeight = editor.offsetHeight;
  if (editorWidth <= 0 || editorHeight <= 0) {
    return;
  }

  const fitted = fitInside(
    frameRect.width,
    frameRect.height,
    destination.width,
    destination.height,
  );
  const target = {
    x: destination.x + fitted.x,
    y: destination.y + fitted.y,
    width: fitted.width,
    height: fitted.height,
  };
  const transformOrigin = style.transformOrigin.split(" ");
  const originX = getCssPixel(transformOrigin[0], editorWidth / 2);
  const originY = getCssPixel(transformOrigin[1], editorHeight / 2);
  const transform = new DOMMatrix(
    style.transform === "none" ? undefined : style.transform,
  );
  const viewportScaleX = target.width / frameRect.width;
  const viewportScaleY = target.height / frameRect.height;
  const fontSize = getCssPixel(style.fontSize, 20);
  const lineHeight = getCssPixel(style.lineHeight, fontSize * 1.2);

  context.save();
  context.beginPath();
  context.rect(target.x, target.y, target.width, target.height);
  context.clip();
  context.translate(
    target.x - frameRect.x * viewportScaleX,
    target.y - frameRect.y * viewportScaleY,
  );
  context.scale(viewportScaleX, viewportScaleY);
  context.translate(
    parentRect.left + editor.offsetLeft + originX,
    parentRect.top + editor.offsetTop + originY,
  );
  context.transform(
    transform.a,
    transform.b,
    transform.c,
    transform.d,
    transform.e,
    transform.f,
  );
  context.translate(-originX, -originY);
  context.beginPath();
  context.rect(0, 0, editorWidth, editorHeight);
  context.clip();

  context.globalAlpha = getCssPixel(style.opacity, 1);
  context.fillStyle = style.color;
  context.font =
    style.font ||
    `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  context.textAlign = style.textAlign as CanvasTextAlign;
  context.textBaseline = "alphabetic";
  context.direction = style.direction as CanvasDirection;

  const lines = getRecorderTextLines(
    editor.value,
    editor.clientWidth,
    style.whiteSpace !== "pre",
    (value) => context.measureText(value).width,
  );
  const metrics = context.measureText("Mg");
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.8;
  const lineTopOffset = Math.max(0, (lineHeight - fontSize) / 2);
  const alignedX =
    style.textAlign === "center"
      ? editor.clientWidth / 2
      : style.textAlign === "right" || style.textAlign === "end"
      ? editor.clientWidth
      : 0;

  lines.forEach((line, index) => {
    const baseline = index * lineHeight + lineTopOffset + ascent;
    context.fillText(line.text, alignedX, baseline);
  });

  const caretIndex = editor.selectionStart;
  const caretLineIndex = lines.findIndex(
    (line, index) =>
      caretIndex >= line.start &&
      (caretIndex <= line.end || index === lines.length - 1),
  );
  if (
    document.activeElement === editor &&
    editor.selectionStart === editor.selectionEnd &&
    caretLineIndex >= 0 &&
    Math.floor(performance.now() / 500) % 2 === 0
  ) {
    const caretLine = lines[caretLineIndex];
    const lineWidth = context.measureText(caretLine.text).width;
    const prefixWidth = context.measureText(
      editor.value.slice(caretLine.start, caretIndex),
    ).width;
    const lineLeft =
      style.textAlign === "center"
        ? (editor.clientWidth - lineWidth) / 2
        : style.textAlign === "right" || style.textAlign === "end"
        ? editor.clientWidth - lineWidth
        : 0;
    const caretX =
      style.direction === "rtl"
        ? lineLeft + lineWidth - prefixWidth
        : lineLeft + prefixWidth;
    const caretTop = caretLineIndex * lineHeight + lineTopOffset;
    context.fillRect(caretX, caretTop, 1, fontSize);
  }

  context.restore();
};

const drawNativeFrameCanvases = (
  context: CanvasRenderingContext2D,
  destination: ViewportRect,
  frameRect: ViewportRect,
  theme: AppState["theme"],
) => {
  if (
    frameRect.width <= 0 ||
    frameRect.height <= 0 ||
    destination.width <= 0 ||
    destination.height <= 0
  ) {
    return;
  }

  const fitted = fitInside(
    frameRect.width,
    frameRect.height,
    destination.width,
    destination.height,
  );
  const target = {
    x: destination.x + fitted.x,
    y: destination.y + fitted.y,
    width: fitted.width,
    height: fitted.height,
  };
  const canvases = document.querySelectorAll<HTMLCanvasElement>(
    ".excalidraw-app .excalidraw__canvas",
  );

  context.save();
  context.beginPath();
  context.rect(target.x, target.y, target.width, target.height);
  context.clip();
  // The static Excalidraw canvas includes its paper color. Blending it over
  // the camera turns that paper into transparency while retaining the native
  // scene and the in-progress interactive canvas exactly as the editor draws
  // them.
  context.globalCompositeOperation = theme === "dark" ? "screen" : "multiply";

  canvases.forEach((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    if (
      canvas.width <= 0 ||
      canvas.height <= 0 ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return;
    }

    const left = Math.max(bounds.left, frameRect.x);
    const top = Math.max(bounds.top, frameRect.y);
    const right = Math.min(bounds.right, frameRect.x + frameRect.width);
    const bottom = Math.min(bounds.bottom, frameRect.y + frameRect.height);
    if (right <= left || bottom <= top) {
      return;
    }

    const sourceScaleX = canvas.width / bounds.width;
    const sourceScaleY = canvas.height / bounds.height;
    const filter = window.getComputedStyle(canvas).filter;
    context.filter = filter === "none" ? "none" : filter;
    context.drawImage(
      canvas,
      (left - bounds.left) * sourceScaleX,
      (top - bounds.top) * sourceScaleY,
      (right - left) * sourceScaleX,
      (bottom - top) * sourceScaleY,
      target.x + ((left - frameRect.x) / frameRect.width) * target.width,
      target.y + ((top - frameRect.y) / frameRect.height) * target.height,
      ((right - left) / frameRect.width) * target.width,
      ((bottom - top) / frameRect.height) * target.height,
    );
  });
  context.restore();
};

const drawVideoCover = (
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  target: ViewportRect,
) => {
  const sourceAspect = video.videoWidth / video.videoHeight;
  const targetAspect = target.width / target.height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;
  if (sourceAspect > targetAspect) {
    sourceWidth = sourceHeight * targetAspect;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = sourceWidth / targetAspect;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }
  context.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    target.x,
    target.y,
    target.width,
    target.height,
  );
};

export const FrameRecorder = ({
  excalidrawAPI,
  sceneLifecycle,
  theme,
  isOpen,
  onOpen,
  onClose,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  sceneLifecycle: FrankSceneLifecycle;
  theme: AppState["theme"];
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) => {
  const [frames, setFrames] = useState<NonDeleted<ExcalidrawFrameElement>[]>(
    [],
  );
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [showSettings, setShowSettings] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recorderSettings, setRecorderSettings] =
    useState(readRecorderSettings);

  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasCaptureTrackRef = useRef<CanvasCaptureMediaStreamTrack | null>(
    null,
  );
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const videoFrameCallbackRef = useRef<number | null>(null);
  const recordingAudioPipelineRef = useRef<RecordingAudioPipeline | null>(null);
  const cameraFrameDelayRef = useRef<number | null>(null);
  const frameExportTimerRef = useRef<number | null>(null);
  const frameExportIdRef = useRef(0);
  const frameSceneSignatureRef = useRef("");
  const frameAppearanceRef = useRef("");
  const cameraPositionRef = useRef<CameraPosition>(
    recorderSettings.cameraPosition,
  );
  const cameraSizeRef = useRef(recorderSettings.cameraSize);
  const scopeRef = useRef<RecorderScope>(recorderSettings.scope);
  const layoutRef = useRef<RecorderLayout>(recorderSettings.layout);
  const splitPositionRef = useRef<SplitPosition>(
    recorderSettings.splitPosition,
  );
  const splitRatioRef = useRef(recorderSettings.splitRatio);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordedSecondsRef = useRef(0);
  const recordingDimensionsRef = useRef<{
    width: number;
    height: number;
  } | null>(null);
  const currentFrameIdRef = useRef<string | null>(null);
  const isOpenRef = useRef(isOpen);
  const statusRef = useRef(status);
  const previewRequestIdRef = useRef(0);
  const previewPromiseRef = useRef<Promise<MediaStream | null> | null>(null);
  const recordingStartPendingRef = useRef(false);
  const stopPreviewRef = useRef<() => void>(() => {});
  const scheduleFrameCanvasRefreshRef = useRef<() => void>(() => {});
  const drawRecordingFrameRef = useRef<() => void>(() => {});
  const onCloseRef = useRef(onClose);
  isOpenRef.current = isOpen;
  statusRef.current = status;
  onCloseRef.current = onClose;

  const getCurrentFrame = () => {
    const id = currentFrameIdRef.current || frames[0]?.id;
    if (!id) {
      return null;
    }
    const element = excalidrawAPI
      .getSceneElements()
      .find((element) => element.id === id);
    return element && isFrameElement(element) ? element : null;
  };

  const getRecordingSourceDimensions = () => {
    if (scopeRef.current === "canvas") {
      const appState = excalidrawAPI.getAppState();
      return { width: appState.width, height: appState.height };
    }
    const frame = getCurrentFrame();
    return frame ? { width: frame.width, height: frame.height } : null;
  };

  const getRecordingViewportRect = (appState: AppState) => {
    if (scopeRef.current === "canvas") {
      return getCanvasViewportRect(appState);
    }
    const frame = getCurrentFrame();
    return frame ? getFrameViewportRect(frame, appState) : null;
  };

  const resizeCaptureCanvas = (source: { width: number; height: number }) => {
    const captureCanvas = captureCanvasRef.current;
    if (!captureCanvas) {
      return null;
    }
    const dimensions =
      recordingDimensionsRef.current || getRecordingDimensions(source);
    if (
      captureCanvas.width !== dimensions.width ||
      captureCanvas.height !== dimensions.height
    ) {
      captureCanvas.width = dimensions.width;
      captureCanvas.height = dimensions.height;
    }
    return captureCanvas;
  };

  const stopRecordingAudioPipeline = () => {
    const pipeline = recordingAudioPipelineRef.current;
    if (!pipeline) {
      return;
    }
    recordingAudioPipelineRef.current = null;
    pipeline.source.disconnect();
    pipeline.delay.disconnect();
    pipeline.destination.stream.getTracks().forEach((track) => track.stop());
    void pipeline.context.close();
  };

  const createSynchronizedAudioTrack = async (
    mediaStream: MediaStream,
    context: AudioContext,
    contextReady: Promise<void>,
  ) => {
    stopRecordingAudioPipeline();
    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      void context.close();
      return null;
    }

    try {
      await contextReady;
      const source = context.createMediaStreamSource(
        new MediaStream([audioTrack]),
      );
      const delay = context.createDelay(MAX_AUDIO_SYNC_DELAY_SECONDS);
      const { latency: inputLatency = 0 } =
        audioTrack.getSettings() as MediaTrackSettings & { latency?: number };
      delay.delayTime.value = getAudioSyncDelay(
        cameraFrameDelayRef.current,
        inputLatency,
      );
      const destination = context.createMediaStreamDestination();
      source.connect(delay);
      delay.connect(destination);
      recordingAudioPipelineRef.current = {
        context,
        source,
        delay,
        destination,
        inputLatency,
      };
      return destination.stream.getAudioTracks()[0] || null;
    } catch (error) {
      void context.close();
      throw error;
    }
  };

  const updateRecordingAudioDelay = (
    now: DOMHighResTimeStamp,
    metadata: VideoFrameCallbackMetadata,
  ) => {
    const nextDelay = getCameraFrameDelay(now, metadata);
    if (nextDelay === null) {
      return;
    }
    const smoothedDelay = smoothCameraFrameDelay(
      cameraFrameDelayRef.current,
      nextDelay,
    );
    cameraFrameDelayRef.current = smoothedDelay;
    const pipeline = recordingAudioPipelineRef.current;
    if (pipeline && pipeline.context.state !== "closed") {
      pipeline.delay.delayTime.setTargetAtTime(
        getAudioSyncDelay(smoothedDelay, pipeline.inputLatency),
        pipeline.context.currentTime,
        0.04,
      );
    }
  };

  const waitForCameraSyncSample = async () => {
    if (cameraFrameDelayRef.current !== null) {
      return;
    }
    const video = videoRef.current;
    if (!video || typeof video.requestVideoFrameCallback !== "function") {
      return;
    }
    await new Promise<void>((resolve) => {
      let isSettled = false;
      const finish = () => {
        if (!isSettled) {
          isSettled = true;
          window.clearTimeout(timeout);
          resolve();
        }
      };
      const callbackId = video.requestVideoFrameCallback((now, metadata) => {
        updateRecordingAudioDelay(now, metadata);
        finish();
      });
      const timeout = window.setTimeout(() => {
        video.cancelVideoFrameCallback(callbackId);
        finish();
      }, 180);
    });
  };

  const refreshFrames = () => {
    const nextFrames = sortFramesForPlayback(
      excalidrawAPI.getSceneElements().filter(isFrameElement),
    );
    setFrames(nextFrames);
    const selectedFrameId = resolveSelectedFrameId(
      excalidrawAPI.getSceneElements(),
      excalidrawAPI.getAppState().selectedElementIds,
    );
    currentFrameIdRef.current =
      nextFrames.find((frame) => frame.id === selectedFrameId)?.id ||
      nextFrames[0]?.id ||
      null;
    return nextFrames;
  };

  const setCameraPosition = (position: CameraPosition) => {
    cameraPositionRef.current = position;
    setRecorderSettings((settings) => ({
      ...settings,
      cameraPosition: position,
    }));
    updateRecordingOverlay(excalidrawAPI.getAppState());
  };

  const setCameraSize = (cameraSize: number) => {
    cameraSizeRef.current = cameraSize;
    setRecorderSettings((settings) => ({ ...settings, cameraSize }));
    updateRecordingOverlay(excalidrawAPI.getAppState());
  };

  const setRecorderMode = (scope: RecorderScope, layout: RecorderLayout) => {
    if (statusRef.current === "recording" || statusRef.current === "paused") {
      return;
    }
    scopeRef.current = scope;
    layoutRef.current = layout;
    frameExportIdRef.current += 1;
    frameSceneSignatureRef.current = "";
    frameAppearanceRef.current = "";
    setRecorderSettings((settings) => ({ ...settings, scope, layout }));
    const source = getRecordingSourceDimensions();
    if (source) {
      resizeCaptureCanvas(source);
    }
    updateRecordingOverlay(excalidrawAPI.getAppState());
    if (shouldRefreshRecordingExport(scope, layout, false)) {
      scheduleFrameCanvasRefreshRef.current();
    }
    if (isOpenRef.current && !mediaStreamRef.current) {
      void startPreview();
    }
  };

  const setSplitPosition = (splitPosition: SplitPosition) => {
    splitPositionRef.current = splitPosition;
    setRecorderSettings((settings) => ({ ...settings, splitPosition }));
    updateRecordingOverlay(excalidrawAPI.getAppState());
  };

  const setSplitRatio = (splitRatio: number) => {
    splitRatioRef.current = splitRatio;
    setRecorderSettings((settings) => ({ ...settings, splitRatio }));
    updateRecordingOverlay(excalidrawAPI.getAppState());
  };

  const updateRecordingOverlay = (appState: AppState) => {
    const rect = getRecordingViewportRect(appState);
    if (!rect) {
      return;
    }
    const camera = cameraRef.current;
    const currentLayout = layoutRef.current;
    if (!camera) {
      return;
    }
    const previewLayout = getCameraPreviewLayoutRects(
      currentLayout,
      rect,
      cameraPositionRef.current,
      cameraSizeRef.current,
      splitPositionRef.current,
      splitRatioRef.current,
    );
    const cameraRect = {
      x: rect.x + previewLayout.camera.x,
      y: rect.y + previewLayout.camera.y,
      width: previewLayout.camera.width,
      height: previewLayout.camera.height,
    };
    const clip = getClipInsets(cameraRect, rect);
    camera.style.width = `${cameraRect.width}px`;
    camera.style.height = `${cameraRect.height}px`;
    camera.style.transform = `translate3d(${cameraRect.x}px, ${cameraRect.y}px, 0)`;
    camera.style.clipPath = `inset(${clip.top}px ${clip.right}px ${
      clip.bottom
    }px ${clip.left}px${
      previewLayout.cameraShape === "circle" ? " round 50%" : ""
    })`;
  };

  const refreshFrameCanvas = async () => {
    if (excalidrawAPI.isDestroyed) {
      return false;
    }
    const exportId = ++frameExportIdRef.current;
    const appState = excalidrawAPI.getAppState();
    if (scopeRef.current === "canvas") {
      const viewportCanvas = document.querySelector<HTMLCanvasElement>(
        ".excalidraw-app .excalidraw__canvas.static",
      );
      if (!viewportCanvas) {
        excalidrawAPI.setToast({
          message: "The visible canvas could not be prepared for recording.",
        });
        return false;
      }
      frameCanvasRef.current = viewportCanvas;
      frameSceneSignatureRef.current = "canvas-viewport";
      frameAppearanceRef.current = `${appState.theme}:${appState.viewBackgroundColor}`;
      drawRecordingFrameRef.current();
      return true;
    }

    const frame = getCurrentFrame();
    if (!frame) {
      return false;
    }
    try {
      const frameCanvas = await exportToCanvas({
        elements: excalidrawAPI.getSceneElements(),
        appState: {
          ...appState,
          exportBackground: layoutRef.current !== "full-camera",
          exportScale: 1,
          exportWithDarkMode: appState.theme === "dark",
        },
        files: excalidrawAPI.getFiles(),
        exportingFrame: frame,
        getDimensions: () => getRecordingDimensions(frame),
      });
      if (
        exportId !== frameExportIdRef.current ||
        frame.id !== currentFrameIdRef.current
      ) {
        return false;
      }
      frameCanvasRef.current = frameCanvas;
      frameSceneSignatureRef.current = getFrameSceneSignature(
        excalidrawAPI.getSceneElementsIncludingDeleted(),
        frame.id,
      );
      frameAppearanceRef.current = `${appState.theme}:${appState.viewBackgroundColor}`;
      drawRecordingFrameRef.current();
      return true;
    } catch {
      if (exportId === frameExportIdRef.current) {
        excalidrawAPI.setToast({
          message: "The current frame could not be prepared for recording.",
        });
      }
      return false;
    }
  };

  const scheduleFrameCanvasRefresh = () => {
    if (frameExportTimerRef.current !== null) {
      window.clearTimeout(frameExportTimerRef.current);
    }
    frameExportTimerRef.current = window.setTimeout(() => {
      frameExportTimerRef.current = null;
      void refreshFrameCanvas();
    }, 80);
  };
  scheduleFrameCanvasRefreshRef.current = scheduleFrameCanvasRefresh;

  const drawRecordingFrame = () => {
    const appState = excalidrawAPI.getAppState();
    const captureCanvas = captureCanvasRef.current;
    const sourceCanvas = frameCanvasRef.current;
    const nativeFullCamera = usesNativeFullCamera(
      scopeRef.current,
      layoutRef.current,
    );
    if (!captureCanvas || (!nativeFullCamera && !sourceCanvas)) {
      return;
    }

    const context = captureCanvas.getContext("2d");
    if (
      !context ||
      (!nativeFullCamera &&
        (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0))
    ) {
      return;
    }
    context.fillStyle =
      appState.theme === "dark" ? "#000000" : appState.viewBackgroundColor;
    context.fillRect(0, 0, captureCanvas.width, captureCanvas.height);

    const layout = getRecordingLayoutRects(
      layoutRef.current,
      captureCanvas.width,
      captureCanvas.height,
      cameraPositionRef.current,
      cameraSizeRef.current,
      splitPositionRef.current,
      splitRatioRef.current,
    );

    const drawCanvas = () => {
      if (nativeFullCamera) {
        const frameRect = getRecordingViewportRect(appState);
        if (frameRect) {
          drawNativeFrameCanvases(
            context,
            layout.canvas,
            frameRect,
            appState.theme,
          );
          drawNativeTextEditor(context, layout.canvas, frameRect);
        }
        return;
      }
      if (!sourceCanvas) {
        return;
      }
      const canvasDestination = fitInside(
        sourceCanvas.width,
        sourceCanvas.height,
        layout.canvas.width,
        layout.canvas.height,
      );
      context.drawImage(
        sourceCanvas,
        0,
        0,
        sourceCanvas.width,
        sourceCanvas.height,
        layout.canvas.x + canvasDestination.x,
        layout.canvas.y + canvasDestination.y,
        canvasDestination.width,
        canvasDestination.height,
      );
    };

    const video = videoRef.current;
    const drawCamera = () => {
      if (!video?.videoWidth) {
        return;
      }
      context.save();
      if (layout.cameraShape === "circle") {
        context.beginPath();
        context.arc(
          layout.camera.x + layout.camera.width / 2,
          layout.camera.y + layout.camera.height / 2,
          layout.camera.width / 2,
          0,
          Math.PI * 2,
        );
        context.clip();
      }
      drawVideoCover(context, video, layout.camera);
      context.restore();
    };

    if (layout.canvasLayer === "above") {
      drawCamera();
      drawCanvas();
    } else {
      drawCanvas();
      drawCamera();
    }
    canvasCaptureTrackRef.current?.requestFrame();
  };
  drawRecordingFrameRef.current = drawRecordingFrame;

  const startRenderLoop = () => {
    const video = videoRef.current;
    const supportsVideoFrameCallbacks =
      typeof video?.requestVideoFrameCallback === "function";

    if (animationFrameRef.current === null) {
      const renderOverlay = () => {
        updateRecordingOverlay(excalidrawAPI.getAppState());
        if (
          !supportsVideoFrameCallbacks &&
          shouldRenderRecordingComposite(
            scopeRef.current,
            layoutRef.current,
            recorderRef.current?.state === "recording",
          )
        ) {
          drawRecordingFrame();
        }
        animationFrameRef.current = window.requestAnimationFrame(renderOverlay);
      };
      animationFrameRef.current = window.requestAnimationFrame(renderOverlay);
    }

    if (
      video &&
      supportsVideoFrameCallbacks &&
      videoFrameCallbackRef.current === null
    ) {
      const renderVideoFrame: VideoFrameRequestCallback = (now, metadata) => {
        updateRecordingAudioDelay(now, metadata);
        if (
          shouldRenderRecordingComposite(
            scopeRef.current,
            layoutRef.current,
            recorderRef.current?.state === "recording",
          )
        ) {
          drawRecordingFrame();
        }
        videoFrameCallbackRef.current =
          video.requestVideoFrameCallback(renderVideoFrame);
      };
      videoFrameCallbackRef.current =
        video.requestVideoFrameCallback(renderVideoFrame);
    }
  };

  const stopRenderLoop = () => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    const video = videoRef.current;
    if (video && videoFrameCallbackRef.current !== null) {
      video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      videoFrameCallbackRef.current = null;
    }
  };

  const startPreview = async () => {
    const source = getRecordingSourceDimensions();
    if (!source) {
      excalidrawAPI.setToast({ message: "Create or select a Frame first." });
      return null;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      excalidrawAPI.setToast({
        message: "Camera recording requires HTTPS or localhost.",
      });
      return null;
    }
    if (mediaStreamRef.current) {
      return mediaStreamRef.current;
    }
    if (previewPromiseRef.current) {
      return previewPromiseRef.current;
    }
    if (
      shouldRenderRecordingComposite(
        scopeRef.current,
        layoutRef.current,
        false,
      ) &&
      !(await refreshFrameCanvas())
    ) {
      return null;
    }
    if (!resizeCaptureCanvas(source)) {
      return null;
    }
    drawRecordingFrame();

    const requestId = ++previewRequestIdRef.current;
    const request = navigator.mediaDevices
      .getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      .then(async (stream) => {
        if (
          requestId !== previewRequestIdRef.current ||
          !isOpenRef.current ||
          !getRecordingSourceDimensions()
        ) {
          stream.getTracks().forEach((track) => track.stop());
          return null;
        }
        mediaStreamRef.current = stream;
        cameraFrameDelayRef.current = null;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setStatus("preview");
        startRenderLoop();
        return stream;
      })
      .catch((error) => {
        if (requestId === previewRequestIdRef.current && isOpenRef.current) {
          excalidrawAPI.setToast({
            message:
              error instanceof Error
                ? `Camera or microphone unavailable: ${error.message}`
                : "Camera or microphone unavailable.",
          });
        }
        return null;
      });
    previewPromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (previewPromiseRef.current === request) {
        previewPromiseRef.current = null;
      }
    }
  };

  const startRecording = async () => {
    if (recordingStartPendingRef.current || recorderRef.current) {
      return;
    }
    const source = getRecordingSourceDimensions();
    if (!source || typeof MediaRecorder === "undefined") {
      excalidrawAPI.setToast({ message: "Recording is unavailable here." });
      return;
    }
    let recordingAudioContext: AudioContext;
    let recordingAudioContextReady: Promise<void>;
    try {
      recordingAudioContext = new AudioContext();
      recordingAudioContextReady =
        recordingAudioContext.state === "suspended"
          ? recordingAudioContext.resume()
          : Promise.resolve();
    } catch {
      excalidrawAPI.setToast({
        message: "Microphone synchronization is unavailable here.",
      });
      return;
    }
    recordingStartPendingRef.current = true;
    try {
      const mediaStream = await startPreview();
      const recordingSource = getRecordingSourceDimensions();
      if (!mediaStream || !recordingSource) {
        return;
      }
      if (
        !usesNativeFullCamera(scopeRef.current, layoutRef.current) &&
        !(await refreshFrameCanvas())
      ) {
        return;
      }
      await waitForCameraSyncSample();
      const synchronizedSource = getRecordingSourceDimensions();
      if (
        !isOpenRef.current ||
        mediaStreamRef.current !== mediaStream ||
        !synchronizedSource
      ) {
        return;
      }

      recordingDimensionsRef.current =
        getRecordingDimensions(synchronizedSource);
      const captureCanvas = resizeCaptureCanvas(synchronizedSource);
      if (!captureCanvas) {
        recordingDimensionsRef.current = null;
        return;
      }
      drawRecordingFrame();

      if (typeof captureCanvas.captureStream !== "function") {
        recordingDimensionsRef.current = null;
        excalidrawAPI.setToast({
          message: "Frame recording is not supported by this browser.",
        });
        return;
      }
      const supportsManualFrameCapture =
        typeof CanvasCaptureMediaStreamTrack !== "undefined" &&
        typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame ===
          "function";
      const canvasStream = captureCanvas.captureStream(
        supportsManualFrameCapture ? 0 : 30,
      );
      const canvasCaptureTrack =
        canvasStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      canvasCaptureTrackRef.current = supportsManualFrameCapture
        ? canvasCaptureTrack
        : null;
      canvasCaptureTrackRef.current?.requestFrame();
      let synchronizedAudioTrack: MediaStreamTrack | null;
      try {
        synchronizedAudioTrack = await createSynchronizedAudioTrack(
          mediaStream,
          recordingAudioContext,
          recordingAudioContextReady,
        );
      } catch {
        canvasStream.getTracks().forEach((track) => track.stop());
        canvasCaptureTrackRef.current = null;
        excalidrawAPI.setToast({
          message: "Microphone synchronization could not be started.",
        });
        return;
      }
      const recordingStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...(synchronizedAudioTrack ? [synchronizedAudioTrack] : []),
      ]);
      recordingStreamRef.current = recordingStream;
      chunksRef.current = [];
      const mimeType = getRecorderMimeType();
      if (!mimeType.includes("mp4")) {
        excalidrawAPI.setToast({
          message: "Native MP4 is unavailable in this browser. Using WebM.",
        });
      }
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(
          recordingStream,
          mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined,
        );
      } catch {
        recordingStream.getTracks().forEach((track) => track.stop());
        canvasCaptureTrackRef.current = null;
        recordingStreamRef.current = null;
        stopRecordingAudioPipeline();
        excalidrawAPI.setToast({ message: "Recording could not be prepared." });
        return;
      }
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        excalidrawAPI.setToast({ message: "Recording failed." });
      };
      recorder.onstop = () => {
        if (recordingStartedAtRef.current !== null) {
          recordedSecondsRef.current +=
            (Date.now() - recordingStartedAtRef.current) / 1000;
          recordingStartedAtRef.current = null;
          setElapsedSeconds(recordedSecondsRef.current);
        }
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "video/webm",
        });
        try {
          const { filename } = getRecordingDownloadMetadata(recorder.mimeType);
          const recordingUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = recordingUrl;
          link.download = filename;
          link.hidden = true;
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(recordingUrl), 1000);
        } catch {
          excalidrawAPI.setToast({
            message: "The recording finished, but the download was blocked.",
          });
        }
        recordingStream.getTracks().forEach((track) => track.stop());
        canvasCaptureTrackRef.current = null;
        stopRecordingAudioPipeline();
        recordingStreamRef.current = null;
        recorderRef.current = null;
        recordingDimensionsRef.current = null;
        chunksRef.current = [];
        recordedSecondsRef.current = 0;
        setElapsedSeconds(0);
        setStatus(mediaStreamRef.current ? "preview" : "idle");
        const currentSource = getRecordingSourceDimensions();
        if (currentSource) {
          resizeCaptureCanvas(currentSource);
        }
      };
      recordedSecondsRef.current = 0;
      recordingStartedAtRef.current = Date.now();
      setElapsedSeconds(0);
      try {
        recorder.start(1000);
      } catch {
        recorderRef.current = null;
        recordingStream.getTracks().forEach((track) => track.stop());
        canvasCaptureTrackRef.current = null;
        recordingStreamRef.current = null;
        stopRecordingAudioPipeline();
        recordingStartedAtRef.current = null;
        excalidrawAPI.setToast({ message: "Recording could not be started." });
        return;
      }
      setStatus("recording");
    } finally {
      if (!recorderRef.current) {
        stopRecordingAudioPipeline();
        if (recordingAudioContext.state !== "closed") {
          void recordingAudioContext.close();
        }
        recordingDimensionsRef.current = null;
      }
      recordingStartPendingRef.current = false;
    }
  };

  const pauseOrResume = () => {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.pause();
      if (recordingStartedAtRef.current !== null) {
        recordedSecondsRef.current +=
          (Date.now() - recordingStartedAtRef.current) / 1000;
        recordingStartedAtRef.current = null;
        setElapsedSeconds(recordedSecondsRef.current);
      }
      setStatus("paused");
    } else if (recorder?.state === "paused") {
      recorder.resume();
      recordingStartedAtRef.current = Date.now();
      setStatus("recording");
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return true;
    }
    return false;
  };

  const stopPreview = () => {
    previewRequestIdRef.current += 1;
    previewPromiseRef.current = null;
    recordingStartPendingRef.current = false;
    frameExportIdRef.current += 1;
    if (frameExportTimerRef.current !== null) {
      window.clearTimeout(frameExportTimerRef.current);
      frameExportTimerRef.current = null;
    }
    const isFinalizingRecording = stopRecording();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    stopRenderLoop();
    if (!isFinalizingRecording) {
      canvasCaptureTrackRef.current = null;
      stopRecordingAudioPipeline();
      recordingDimensionsRef.current = null;
      recordingStartedAtRef.current = null;
      recordedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    setStatus("idle");
  };
  stopPreviewRef.current = stopPreview;

  const closeRecorder = () => {
    stopPreview();
    setShowSettings(false);
    onClose();
  };

  const openRecorder = () => {
    const nextFrames = refreshFrames();
    isOpenRef.current = true;
    onOpen();
    if (scopeRef.current === "frame" && !nextFrames.length) {
      setShowSettings(true);
      excalidrawAPI.setToast({
        message: "Create a Frame or choose Canvas View.",
      });
      return;
    }
    const targetFrame =
      nextFrames.find((frame) => frame.id === currentFrameIdRef.current) ||
      nextFrames[0];
    frameExportIdRef.current += 1;
    frameSceneSignatureRef.current = "";
    frameAppearanceRef.current = "";
    const source = getRecordingSourceDimensions();
    if (source) {
      resizeCaptureCanvas(source);
    }
    if (scopeRef.current === "frame" && targetFrame) {
      excalidrawAPI.setViewport({
        target: [targetFrame],
        fit: "scale-down",
        animation: true,
        offsets: { ui: true },
      });
    }
    startRenderLoop();
    void startPreview();
  };

  const dragCamera = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      layoutRef.current !== "canvas-pip" ||
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      return;
    }
    const rect = getRecordingViewportRect(excalidrawAPI.getAppState());
    if (!rect) {
      return;
    }
    const diameter = cameraRef.current?.getBoundingClientRect().width || 72;
    cameraPositionRef.current = clampCameraPosition(
      {
        x: (event.clientX - rect.x) / rect.width,
        y: (event.clientY - rect.y) / rect.height,
      },
      rect,
      diameter,
    );
    updateRecordingOverlay(excalidrawAPI.getAppState());
  };

  const saveDraggedCameraPosition = () => {
    setRecorderSettings((settings) => ({
      ...settings,
      cameraPosition: cameraPositionRef.current,
    }));
  };

  useEffect(() => {
    return sceneLifecycle.subscribe((snapshot) => {
      if (!isOpenRef.current) {
        return;
      }

      const nextFrames = sortFramesForPlayback(
        snapshot.elements.filter(
          (element): element is NonDeleted<ExcalidrawFrameElement> =>
            !element.isDeleted && isFrameElement(element),
        ),
      );
      let currentFrameId = currentFrameIdRef.current;
      if (currentFrameId && !snapshot.activeElementIds.has(currentFrameId)) {
        if (scopeRef.current === "frame") {
          const hadActiveMedia =
            statusRef.current !== "idle" || previewPromiseRef.current !== null;
          stopPreviewRef.current();
          if (hadActiveMedia) {
            excalidrawAPI.setToast({
              message:
                "Recording stopped because the current Frame was removed.",
            });
          }
        }
        currentFrameIdRef.current = nextFrames[0]?.id || null;
        currentFrameId = currentFrameIdRef.current;
        if (scopeRef.current === "frame" && !nextFrames.length) {
          onCloseRef.current();
        }
      }

      const selectedFrameId = resolveSelectedFrameId(
        snapshot.elements,
        snapshot.selectedElementIds,
      );
      const selectedFrame = nextFrames.find(
        (frame) => frame.id === selectedFrameId,
      );
      if (selectedFrame && selectedFrame.id !== currentFrameId) {
        currentFrameIdRef.current = selectedFrame.id;
        currentFrameId = selectedFrame.id;
        if (scopeRef.current === "frame") {
          frameExportIdRef.current += 1;
          frameSceneSignatureRef.current = "";
          frameAppearanceRef.current = "";
          resizeCaptureCanvas(selectedFrame);
          if (
            shouldRefreshRecordingExport(
              scopeRef.current,
              layoutRef.current,
              recorderRef.current?.state === "recording",
            )
          ) {
            scheduleFrameCanvasRefreshRef.current();
          }
        }
      }

      if (
        scopeRef.current === "frame" &&
        currentFrameId &&
        snapshot.activeElementIds.has(currentFrameId)
      ) {
        const shouldRefreshComposite = shouldRefreshRecordingExport(
          scopeRef.current,
          layoutRef.current,
          recorderRef.current?.state === "recording",
        );
        if (shouldRefreshComposite) {
          const nextSignature = getFrameSceneSignature(
            snapshot.elements,
            currentFrameId,
          );
          const appState = excalidrawAPI.getAppState();
          const nextAppearance = `${appState.theme}:${appState.viewBackgroundColor}`;
          if (
            nextSignature !== frameSceneSignatureRef.current ||
            nextAppearance !== frameAppearanceRef.current
          ) {
            scheduleFrameCanvasRefreshRef.current();
          }
        }
      }

      setFrames((previousFrames) => {
        const didFrameListChange =
          previousFrames.length !== nextFrames.length ||
          previousFrames.some(
            (frame, index) => frame.id !== nextFrames[index]?.id,
          );
        return didFrameListChange ? nextFrames : previousFrames;
      });
    });
  }, [excalidrawAPI, sceneLifecycle]);

  useEffect(() => {
    if (status !== "recording") {
      return;
    }
    const updateElapsedTime = () => {
      setElapsedSeconds(
        recordedSecondsRef.current +
          (recordingStartedAtRef.current === null
            ? 0
            : (Date.now() - recordingStartedAtRef.current) / 1000),
      );
    };
    updateElapsedTime();
    const timer = window.setInterval(updateElapsedTime, 250);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        RECORDER_SETTINGS_KEY,
        JSON.stringify(recorderSettings),
      );
    } catch {
      // Recording still works when storage is unavailable.
    }
  }, [recorderSettings]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      canvasCaptureTrackRef.current = null;
      stopRecordingAudioPipeline();
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (video && videoFrameCallbackRef.current !== null) {
        video.cancelVideoFrameCallback(videoFrameCallbackRef.current);
      }
      if (frameExportTimerRef.current !== null) {
        window.clearTimeout(frameExportTimerRef.current);
      }
      frameExportIdRef.current += 1;
    };
  }, []);

  const settingsLocked = status === "recording" || status === "paused";
  const hasRecordingTarget =
    recorderSettings.scope === "canvas" || frames.length > 0;

  return (
    <>
      <div className={`frank-recorder frank-recorder--${theme}`}>
        {isOpen && showSettings ? (
          <div
            className="frank-recorder__settings"
            aria-label="Recording settings"
          >
            <div className="frank-recorder__settings-heading">
              <strong>Recording</strong>
              <button
                type="button"
                aria-label="Close recording settings"
                onClick={() => setShowSettings(false)}
              >
                {CloseIcon}
              </button>
            </div>
            <div
              className="frank-recorder__layouts"
              role="group"
              aria-label="Choose a recording mode"
            >
              {RECORDER_MODES.map(({ scope, value, label }) => (
                <button
                  key={`${scope}-${value}`}
                  type="button"
                  data-layout={value}
                  data-scope={scope}
                  data-split-position={
                    value === "split"
                      ? recorderSettings.splitPosition
                      : undefined
                  }
                  disabled={settingsLocked}
                  aria-label={label}
                  aria-pressed={
                    recorderSettings.scope === scope &&
                    recorderSettings.layout === value
                  }
                  onClick={() => setRecorderMode(scope, value)}
                >
                  <span
                    className="frank-recorder__layout-icon"
                    aria-hidden="true"
                  >
                    <i />
                    <i />
                  </span>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            {recorderSettings.scope === "frame" &&
            recorderSettings.layout === "split" ? (
              <>
                <div className="frank-recorder__setting-row">
                  <span>Camera</span>
                  <div
                    className="frank-recorder__segments"
                    role="group"
                    aria-label="Camera split position"
                  >
                    <button
                      type="button"
                      disabled={settingsLocked}
                      aria-pressed={recorderSettings.splitPosition === "top"}
                      onClick={() => setSplitPosition("top")}
                    >
                      Top
                    </button>
                    <button
                      type="button"
                      disabled={settingsLocked}
                      aria-pressed={recorderSettings.splitPosition === "bottom"}
                      onClick={() => setSplitPosition("bottom")}
                    >
                      Bottom
                    </button>
                  </div>
                </div>
                <label className="frank-recorder__size">
                  <span>Camera area</span>
                  <input
                    type="range"
                    min="30"
                    max="70"
                    step="5"
                    disabled={settingsLocked}
                    value={Math.round(recorderSettings.splitRatio * 100)}
                    onChange={(event) =>
                      setSplitRatio(Number(event.target.value) / 100)
                    }
                  />
                  <output>
                    {Math.round(recorderSettings.splitRatio * 100)}%
                  </output>
                </label>
              </>
            ) : null}
            {recorderSettings.layout === "canvas-pip" ? (
              <>
                <label className="frank-recorder__size">
                  <span>Camera size</span>
                  <input
                    type="range"
                    min="12"
                    max="32"
                    step="1"
                    disabled={settingsLocked}
                    value={Math.round(recorderSettings.cameraSize * 100)}
                    onChange={(event) =>
                      setCameraSize(Number(event.target.value) / 100)
                    }
                  />
                  <output>
                    {Math.round(recorderSettings.cameraSize * 100)}%
                  </output>
                </label>
                <div className="frank-recorder__position">
                  <span>Camera position</span>
                  <div>
                    {(
                      Object.keys(CAMERA_POSITIONS) as CameraPositionName[]
                    ).map((name) => {
                      const position = CAMERA_POSITIONS[name];
                      const isSelected =
                        Math.abs(
                          recorderSettings.cameraPosition.x - position.x,
                        ) < 0.001 &&
                        Math.abs(
                          recorderSettings.cameraPosition.y - position.y,
                        ) < 0.001;
                      return (
                        <button
                          key={name}
                          type="button"
                          disabled={settingsLocked}
                          data-position={name}
                          aria-label={name.replace("-", " ")}
                          aria-pressed={isSelected}
                          onClick={() => setCameraPosition(position)}
                        >
                          <span aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}
            <small>
              {recorderSettings.layout === "canvas-pip"
                ? "Drag the camera directly for a custom position."
                : recorderSettings.layout === "full-camera"
                ? "Frame content stays above the camera video."
                : "Camera overlays the Frame without reflowing it."}
            </small>
          </div>
        ) : null}
        {isOpen ? (
          <div
            className="frank-recorder__toolbar"
            role="toolbar"
            aria-label="Recorder"
          >
            {status === "recording" || status === "paused" ? (
              <span
                className={`frank-recorder__status frank-recorder__status--${status}`}
                role="status"
              >
                <i aria-hidden="true" />
                {status === "recording" ? "REC" : "PAUSED"}
                <time>{formatRecordingTime(elapsedSeconds)}</time>
              </span>
            ) : null}
            {hasRecordingTarget &&
            (status === "idle" || status === "preview") ? (
              <button
                className="frank-recorder__record"
                type="button"
                onClick={startRecording}
              >
                <span aria-hidden="true" /> Start recording
              </button>
            ) : null}
            {status === "recording" || status === "paused" ? (
              <>
                <button type="button" onClick={pauseOrResume}>
                  {status === "paused" ? "Resume" : "Pause"}
                </button>
                <button type="button" onClick={stopRecording}>
                  Stop
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label="Recording settings"
              aria-expanded={showSettings}
              aria-pressed={showSettings}
              onClick={() => setShowSettings((isVisible) => !isVisible)}
            >
              {settingsIcon}
            </button>
            <button
              type="button"
              aria-label="Close recorder"
              onClick={closeRecorder}
            >
              {CloseIcon}
            </button>
          </div>
        ) : null}
        <button
          className="frank-recorder__trigger frank-dock__trigger"
          type="button"
          aria-label="Recording"
          aria-expanded={isOpen}
          aria-pressed={isOpen}
          onClick={isOpen ? closeRecorder : openRecorder}
        >
          <span className="frank-dock__index" aria-hidden="true">
            02
          </span>
          <span>Recording</span>
        </button>
      </div>
      {typeof document !== "undefined"
        ? createPortal(
            <>
              <canvas
                ref={captureCanvasRef}
                className="frank-recorder__preview"
                aria-hidden="true"
              />
              <div
                ref={cameraRef}
                className={`frank-recorder__camera ${
                  isOpen && hasRecordingTarget && status !== "idle"
                    ? "frank-recorder__camera--visible"
                    : ""
                } ${
                  recorderSettings.layout === "full-camera"
                    ? "frank-recorder__camera--full"
                    : recorderSettings.layout === "canvas-pip"
                    ? "frank-recorder__camera--pip"
                    : recorderSettings.layout === "split"
                    ? "frank-recorder__camera--split"
                    : ""
                }`}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={dragCamera}
                onPointerUp={saveDraggedCameraPosition}
                onPointerCancel={saveDraggedCameraPosition}
              >
                <video ref={videoRef} autoPlay muted playsInline />
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
};
