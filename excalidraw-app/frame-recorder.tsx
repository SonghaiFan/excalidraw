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

const MAX_RECORDING_SIDE = 1920;
const DEFAULT_CAMERA_SIZE = 0.18;
const RECORDER_SETTINGS_KEY = "frank-canvas-recorder-settings";
const DEFAULT_RECORDER_LAYOUT: RecorderLayout = "split";

const FRAME_RECORDER_LAYOUTS: readonly {
  value: RecorderLayout;
  label: string;
}[] = [
  { value: "full-camera", label: "Full camera" },
  { value: "split", label: "Camera + canvas" },
  { value: "canvas-pip", label: "Canvas + PIP" },
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
      canvas: {
        x: 0,
        y: cameraIsAbove ? cameraHeight : 0,
        width,
        height: height - cameraHeight,
      },
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
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
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

  const setRecorderScope = (scope: RecorderScope) => {
    if (statusRef.current === "recording" || statusRef.current === "paused") {
      return;
    }
    const layout: RecorderLayout =
      scope === "canvas" ? "canvas-pip" : layoutRef.current;
    scopeRef.current = scope;
    layoutRef.current = layout;
    frameCanvasRef.current = null;
    frameSceneSignatureRef.current = "";
    setRecorderSettings((settings) => ({ ...settings, scope, layout }));
    const source = getRecordingSourceDimensions();
    if (source) {
      resizeCaptureCanvas(source);
    }
    updateRecordingOverlay(excalidrawAPI.getAppState());
    scheduleFrameCanvasRefreshRef.current();
    if (isOpenRef.current && !mediaStreamRef.current) {
      void startPreview();
    }
  };

  const setRecorderLayout = (layout: RecorderLayout) => {
    if (statusRef.current === "recording" || statusRef.current === "paused") {
      return;
    }
    layoutRef.current = layout;
    frameCanvasRef.current = null;
    frameSceneSignatureRef.current = "";
    setRecorderSettings((settings) => ({ ...settings, layout }));
    scheduleFrameCanvasRefreshRef.current();
  };

  const setSplitPosition = (splitPosition: SplitPosition) => {
    splitPositionRef.current = splitPosition;
    setRecorderSettings((settings) => ({ ...settings, splitPosition }));
  };

  const setSplitRatio = (splitRatio: number) => {
    splitRatioRef.current = splitRatio;
    setRecorderSettings((settings) => ({ ...settings, splitRatio }));
  };

  const updateRecordingOverlay = (appState: AppState) => {
    const rect = getRecordingViewportRect(appState);
    if (!rect) {
      return;
    }
    const preview = captureCanvasRef.current;
    if (preview) {
      preview.style.left = `${rect.x}px`;
      preview.style.top = `${rect.y}px`;
      preview.style.width = `${rect.width}px`;
      preview.style.height = `${rect.height}px`;
      preview.style.clipPath = "inset(0)";
    }
    const camera = cameraRef.current;
    if (!camera || layoutRef.current !== "canvas-pip") {
      return;
    }
    const shortestSide = Math.min(rect.width, rect.height);
    const size = Math.min(
      shortestSide,
      Math.min(240, Math.max(48, shortestSide * cameraSizeRef.current)),
    );
    cameraPositionRef.current = clampCameraPosition(
      cameraPositionRef.current,
      rect,
      size,
    );
    const cameraRect = {
      x: rect.x + rect.width * cameraPositionRef.current.x - size / 2,
      y: rect.y + rect.height * cameraPositionRef.current.y - size / 2,
      width: size,
      height: size,
    };
    const clip = getClipInsets(cameraRect, rect);
    camera.style.width = `${cameraRect.width}px`;
    camera.style.height = `${cameraRect.height}px`;
    camera.style.left = `${cameraRect.x}px`;
    camera.style.top = `${cameraRect.y}px`;
    camera.style.clipPath = `inset(${clip.top}px ${clip.right}px ${clip.bottom}px ${clip.left}px round 50%)`;
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
    updateRecordingOverlay(appState);
    const captureCanvas = captureCanvasRef.current;
    const sourceCanvas = frameCanvasRef.current;
    if (!captureCanvas || !sourceCanvas) {
      return;
    }

    const context = captureCanvas.getContext("2d");
    if (!context || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) {
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
      if (layout.cameraShape === "circle") {
        context.strokeStyle =
          statusRef.current === "recording" ? "#d9342b" : "#ffffff";
        context.lineWidth = Math.max(2, layout.camera.width * 0.018);
        context.beginPath();
        context.arc(
          layout.camera.x + layout.camera.width / 2,
          layout.camera.y + layout.camera.height / 2,
          layout.camera.width / 2,
          0,
          Math.PI * 2,
        );
        context.stroke();
      }
    };

    if (layout.canvasLayer === "above") {
      drawCamera();
      drawCanvas();
    } else {
      drawCanvas();
      drawCamera();
    }
  };

  const startRenderLoop = () => {
    if (animationFrameRef.current !== null) {
      return;
    }
    const render = () => {
      drawRecordingFrame();
      animationFrameRef.current = window.requestAnimationFrame(render);
    };
    animationFrameRef.current = window.requestAnimationFrame(render);
  };

  const stopRenderLoop = () => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
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
    if (!(await refreshFrameCanvas())) {
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
    recordingStartPendingRef.current = true;
    try {
      const mediaStream = await startPreview();
      const recordingSource = getRecordingSourceDimensions();
      if (!mediaStream || !recordingSource) {
        return;
      }
      if (!(await refreshFrameCanvas())) {
        return;
      }

      recordingDimensionsRef.current = getRecordingDimensions(recordingSource);
      const captureCanvas = resizeCaptureCanvas(recordingSource);
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
      const canvasStream = captureCanvas.captureStream(30);
      const recordingStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...mediaStream.getAudioTracks(),
      ]);
      recordingStreamRef.current = recordingStream;
      chunksRef.current = [];
      const mimeType = getRecorderMimeType();
      if (!mimeType.includes("mp4")) {
        excalidrawAPI.setToast({
          message: "Native MP4 is unavailable in this browser. Using WebM.",
        });
      }
      const recorder = new MediaRecorder(
        recordingStream,
        mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined,
      );
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
      recorder.start(1000);
      setStatus("recording");
    } finally {
      if (!recorderRef.current) {
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
    frameCanvasRef.current = null;
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
          frameCanvasRef.current = null;
          frameSceneSignatureRef.current = "";
          frameAppearanceRef.current = "";
          resizeCaptureCanvas(selectedFrame);
          scheduleFrameCanvasRefreshRef.current();
        }
      }

      if (
        scopeRef.current === "frame" &&
        currentFrameId &&
        snapshot.activeElementIds.has(currentFrameId)
      ) {
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
    return () => {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
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
            <div className="frank-recorder__setting-row">
              <span>Record</span>
              <div
                className="frank-recorder__segments"
                role="group"
                aria-label="Choose what to record"
              >
                <button
                  type="button"
                  disabled={settingsLocked}
                  aria-pressed={recorderSettings.scope === "frame"}
                  onClick={() => setRecorderScope("frame")}
                >
                  Frame
                </button>
                <button
                  type="button"
                  disabled={settingsLocked}
                  aria-pressed={recorderSettings.scope === "canvas"}
                  onClick={() => setRecorderScope("canvas")}
                >
                  Canvas View
                </button>
              </div>
            </div>
            {recorderSettings.scope === "frame" ? (
              <div
                className="frank-recorder__layouts"
                role="group"
                aria-label="Choose a Frame recording layout"
              >
                {FRAME_RECORDER_LAYOUTS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    data-layout={value}
                    data-split-position={
                      value === "split"
                        ? recorderSettings.splitPosition
                        : undefined
                    }
                    disabled={settingsLocked}
                    aria-label={label}
                    aria-pressed={recorderSettings.layout === value}
                    onClick={() => setRecorderLayout(value)}
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
            ) : (
              <div className="frank-recorder__canvas-mode">
                <span>Canvas View</span>
                <small>PIP camera</small>
              </div>
            )}
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
                : "Frame content fits inside the canvas section."}
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
                className={`frank-recorder__preview ${
                  isOpen && hasRecordingTarget
                    ? "frank-recorder__preview--visible"
                    : ""
                }`}
                aria-hidden="true"
              />
              <div
                ref={cameraRef}
                className={`frank-recorder__camera ${
                  isOpen &&
                  hasRecordingTarget &&
                  recorderSettings.layout === "canvas-pip"
                    ? "frank-recorder__camera--visible"
                    : ""
                } ${
                  status === "recording"
                    ? "frank-recorder__camera--recording"
                    : ""
                } ${
                  status === "paused" ? "frank-recorder__camera--paused" : ""
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
