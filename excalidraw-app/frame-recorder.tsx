import { sceneCoordsToViewportCoords } from "@excalidraw/excalidraw";
import {
  chevronLeftIcon,
  chevronRight,
  CloseIcon,
  settingsIcon,
} from "@excalidraw/excalidraw/components/icons";
import { isFrameElement } from "@excalidraw/element";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

type RecorderStatus = "idle" | "preview" | "recording" | "paused";
type CameraPosition = { x: number; y: number };
type ViewportRect = { x: number; y: number; width: number; height: number };

const MAX_RECORDING_SIDE = 1920;
const DEFAULT_CAMERA_SIZE = 0.18;
const RECORDER_SETTINGS_KEY = "frank-canvas-recorder-settings";

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

const readRecorderSettings = () => {
  const fallback = {
    cameraSize: DEFAULT_CAMERA_SIZE,
    cameraPosition: CAMERA_POSITIONS["bottom-right"],
  };
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(RECORDER_SETTINGS_KEY) || "null",
    );
    return {
      cameraSize:
        typeof saved?.cameraSize === "number"
          ? Math.min(0.32, Math.max(0.12, saved.cameraSize))
          : fallback.cameraSize,
      cameraPosition:
        typeof saved?.cameraPosition?.x === "number" &&
        typeof saved?.cameraPosition?.y === "number"
          ? saved.cameraPosition
          : fallback.cameraPosition,
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

export const sortFramesForPlayback = (
  frames: readonly NonDeleted<ExcalidrawFrameElement>[],
) =>
  [...frames].sort((a, b) => {
    const sameRow = Math.abs(a.y - b.y) < Math.min(a.height, b.height) * 0.25;
    return sameRow ? a.x - b.x : a.y - b.y;
  });

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

export const FrameRecorder = ({
  excalidrawAPI,
  theme,
  isOpen,
  onOpen,
  onClose,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  theme: AppState["theme"];
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) => {
  const [frames, setFrames] = useState<NonDeleted<ExcalidrawFrameElement>[]>(
    [],
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [showSettings, setShowSettings] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [recorderSettings, setRecorderSettings] =
    useState(readRecorderSettings);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingExtension, setRecordingExtension] = useState<"mp4" | "webm">(
    "mp4",
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const cameraPositionRef = useRef<CameraPosition>(
    recorderSettings.cameraPosition,
  );
  const cameraSizeRef = useRef(recorderSettings.cameraSize);
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordedSecondsRef = useRef(0);
  const currentFrameIdRef = useRef<string | null>(null);

  const getCurrentFrame = () => {
    const id = currentFrameIdRef.current;
    return id
      ? frames.find((frame) => frame.id === id) || null
      : frames[currentIndex] || null;
  };

  const refreshFrames = () => {
    const nextFrames = sortFramesForPlayback(
      excalidrawAPI.getSceneElements().filter(isFrameElement),
    );
    setFrames(nextFrames);
    const selectedIds = excalidrawAPI.getAppState().selectedElementIds;
    const selectedIndex = nextFrames.findIndex(
      (frame) => selectedIds[frame.id],
    );
    const index = selectedIndex >= 0 ? selectedIndex : 0;
    setCurrentIndex(index);
    currentFrameIdRef.current = nextFrames[index]?.id || null;
    return nextFrames;
  };

  const selectFrame = (index: number) => {
    if (!frames.length) {
      return;
    }
    const nextIndex = (index + frames.length) % frames.length;
    const frame = frames[nextIndex];
    setCurrentIndex(nextIndex);
    currentFrameIdRef.current = frame.id;
    excalidrawAPI.setViewport({
      target: [frame],
      fit: "scale-down",
      animation: status === "idle" || status === "preview",
      offsets: { ui: true },
    });
  };

  const setCameraPosition = (position: CameraPosition) => {
    cameraPositionRef.current = position;
    setRecorderSettings((settings) => ({
      ...settings,
      cameraPosition: position,
    }));
    const frame = getCurrentFrame();
    if (frame) {
      updateCameraOverlay(frame, excalidrawAPI.getAppState());
    }
  };

  const setCameraSize = (cameraSize: number) => {
    cameraSizeRef.current = cameraSize;
    setRecorderSettings((settings) => ({ ...settings, cameraSize }));
    const frame = getCurrentFrame();
    if (frame) {
      updateCameraOverlay(frame, excalidrawAPI.getAppState());
    }
  };

  const updateCameraOverlay = (
    frame: NonDeleted<ExcalidrawFrameElement>,
    appState: AppState,
  ) => {
    const camera = cameraRef.current;
    if (!camera) {
      return;
    }
    const rect = getFrameViewportRect(frame, appState);
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
    camera.style.width = `${size}px`;
    camera.style.height = `${size}px`;
    camera.style.left = `${
      rect.x + rect.width * cameraPositionRef.current.x - size / 2
    }px`;
    camera.style.top = `${
      rect.y + rect.height * cameraPositionRef.current.y - size / 2
    }px`;
  };

  const drawRecordingFrame = () => {
    const frame = getCurrentFrame();
    const captureCanvas = captureCanvasRef.current;
    const sourceCanvas = document.querySelector<HTMLCanvasElement>(
      ".excalidraw-app canvas.excalidraw__canvas.static",
    );
    if (!frame || !captureCanvas || !sourceCanvas) {
      return;
    }

    const appState = excalidrawAPI.getAppState();
    const frameRect = getFrameViewportRect(frame, appState);
    updateCameraOverlay(frame, appState);

    const context = captureCanvas.getContext("2d");
    if (!context || frameRect.width <= 0 || frameRect.height <= 0) {
      return;
    }
    context.fillStyle =
      appState.theme === "dark" ? "#000000" : appState.viewBackgroundColor;
    context.fillRect(0, 0, captureCanvas.width, captureCanvas.height);

    const sourceRect = sourceCanvas.getBoundingClientRect();
    const sourceScaleX = sourceCanvas.width / sourceRect.width;
    const sourceScaleY = sourceCanvas.height / sourceRect.height;
    const destination = fitInside(
      frameRect.width,
      frameRect.height,
      captureCanvas.width,
      captureCanvas.height,
    );
    context.drawImage(
      sourceCanvas,
      (frameRect.x - sourceRect.left) * sourceScaleX,
      (frameRect.y - sourceRect.top) * sourceScaleY,
      frameRect.width * sourceScaleX,
      frameRect.height * sourceScaleY,
      destination.x,
      destination.y,
      destination.width,
      destination.height,
    );

    const video = videoRef.current;
    if (video?.videoWidth) {
      const diameter =
        Math.min(destination.width, destination.height) * cameraSizeRef.current;
      const centerX =
        destination.x + destination.width * cameraPositionRef.current.x;
      const centerY =
        destination.y + destination.height * cameraPositionRef.current.y;
      context.save();
      context.beginPath();
      context.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2);
      context.clip();
      const cameraCrop = Math.min(video.videoWidth, video.videoHeight);
      context.drawImage(
        video,
        (video.videoWidth - cameraCrop) / 2,
        (video.videoHeight - cameraCrop) / 2,
        cameraCrop,
        cameraCrop,
        centerX - diameter / 2,
        centerY - diameter / 2,
        diameter,
        diameter,
      );
      context.restore();
      context.strokeStyle = "#ffffff";
      context.lineWidth = Math.max(2, diameter * 0.018);
      context.beginPath();
      context.arc(centerX, centerY, diameter / 2, 0, Math.PI * 2);
      context.stroke();
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
    const frame = getCurrentFrame();
    if (!frame) {
      excalidrawAPI.setToast({ message: "Create or select a frame first." });
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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user",
        },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      mediaStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setStatus("preview");
      startRenderLoop();
      return stream;
    } catch (error) {
      excalidrawAPI.setToast({
        message:
          error instanceof Error
            ? `Camera or microphone unavailable: ${error.message}`
            : "Camera or microphone unavailable.",
      });
      return null;
    }
  };

  const startRecording = async () => {
    const frame = getCurrentFrame();
    if (!frame || typeof MediaRecorder === "undefined") {
      excalidrawAPI.setToast({ message: "Recording is unavailable here." });
      return;
    }
    const mediaStream = await startPreview();
    if (!mediaStream) {
      return;
    }

    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      setRecordingUrl(null);
    }
    const dimensions = getRecordingDimensions(frame);
    const captureCanvas =
      captureCanvasRef.current || document.createElement("canvas");
    captureCanvas.width = dimensions.width;
    captureCanvas.height = dimensions.height;
    captureCanvasRef.current = captureCanvas;
    drawRecordingFrame();

    if (typeof captureCanvas.captureStream !== "function") {
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
      setRecordingExtension(recorder.mimeType.includes("mp4") ? "mp4" : "webm");
      setRecordingUrl(URL.createObjectURL(blob));
      recordingStream.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
      recorderRef.current = null;
      setStatus(mediaStreamRef.current ? "preview" : "idle");
    };
    recordedSecondsRef.current = 0;
    recordingStartedAtRef.current = Date.now();
    setElapsedSeconds(0);
    recorder.start(1000);
    setStatus("recording");
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
    }
  };

  const stopPreview = () => {
    stopRecording();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    stopRenderLoop();
    recordingStartedAtRef.current = null;
    recordedSecondsRef.current = 0;
    setElapsedSeconds(0);
    setStatus("idle");
  };

  const closeRecorder = () => {
    stopPreview();
    setShowSettings(false);
    onClose();
  };

  const openRecorder = () => {
    const nextFrames = refreshFrames();
    if (!nextFrames.length) {
      excalidrawAPI.setToast({ message: "Create a frame before recording." });
      return;
    }
    onOpen();
    const targetFrame =
      nextFrames.find((frame) => frame.id === currentFrameIdRef.current) ||
      nextFrames[0];
    excalidrawAPI.setViewport({
      target: [targetFrame],
      fit: "scale-down",
      animation: true,
      offsets: { ui: true },
    });
  };

  const downloadRecording = () => {
    if (!recordingUrl) {
      return;
    }
    const link = document.createElement("a");
    link.href = recordingUrl;
    link.download = `frank-canvas-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.${recordingExtension}`;
    link.click();
  };

  const dragCamera = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    const frame = getCurrentFrame();
    if (!frame) {
      return;
    }
    const rect = getFrameViewportRect(frame, excalidrawAPI.getAppState());
    const diameter = cameraRef.current?.getBoundingClientRect().width || 72;
    cameraPositionRef.current = clampCameraPosition(
      {
        x: (event.clientX - rect.x) / rect.width,
        y: (event.clientY - rect.y) / rect.height,
      },
      rect,
      diameter,
    );
    updateCameraOverlay(frame, excalidrawAPI.getAppState());
  };

  const saveDraggedCameraPosition = () => {
    setRecorderSettings((settings) => ({
      ...settings,
      cameraPosition: cameraPositionRef.current,
    }));
  };

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
    };
  }, []);

  useEffect(
    () => () => {
      if (recordingUrl) {
        URL.revokeObjectURL(recordingUrl);
      }
    },
    [recordingUrl],
  );

  return (
    <>
      <div className={`frank-recorder frank-recorder--${theme}`}>
        {isOpen && showSettings ? (
          <div
            className="frank-recorder__settings"
            aria-label="Recording layout"
          >
            <div className="frank-recorder__settings-heading">
              <strong>Recording layout</strong>
              <button
                type="button"
                aria-label="Close recording settings"
                onClick={() => setShowSettings(false)}
              >
                {CloseIcon}
              </button>
            </div>
            <label className="frank-recorder__size">
              <span>Camera size</span>
              <input
                type="range"
                min="12"
                max="32"
                step="1"
                value={Math.round(recorderSettings.cameraSize * 100)}
                onChange={(event) =>
                  setCameraSize(Number(event.target.value) / 100)
                }
              />
              <output>{Math.round(recorderSettings.cameraSize * 100)}%</output>
            </label>
            <div className="frank-recorder__position">
              <span>Camera position</span>
              <div>
                {(Object.keys(CAMERA_POSITIONS) as CameraPositionName[]).map(
                  (name) => {
                    const position = CAMERA_POSITIONS[name];
                    const isSelected =
                      Math.abs(recorderSettings.cameraPosition.x - position.x) <
                        0.001 &&
                      Math.abs(recorderSettings.cameraPosition.y - position.y) <
                        0.001;
                    return (
                      <button
                        key={name}
                        type="button"
                        data-position={name}
                        aria-label={name.replace("-", " ")}
                        aria-pressed={isSelected}
                        onClick={() => setCameraPosition(position)}
                      >
                        <span aria-hidden="true" />
                      </button>
                    );
                  },
                )}
              </div>
            </div>
            <small>Drag the camera directly for a custom position.</small>
          </div>
        ) : null}
        {isOpen ? (
          <div
            className="frank-recorder__toolbar"
            role="toolbar"
            aria-label="Frame recorder"
          >
            <span
              className={`frank-recorder__status frank-recorder__status--${status}`}
              role="status"
            >
              <i aria-hidden="true" />
              {status === "recording"
                ? "REC"
                : status === "paused"
                ? "PAUSED"
                : status === "preview"
                ? recordingUrl
                  ? "DONE"
                  : "PREVIEW"
                : recordingUrl
                ? "DONE"
                : "READY"}
              {(status === "recording" ||
                status === "paused" ||
                recordingUrl) && (
                <time>{formatRecordingTime(elapsedSeconds)}</time>
              )}
            </span>
            <button
              type="button"
              aria-label="Previous frame"
              disabled={frames.length < 2}
              onClick={() => selectFrame(currentIndex - 1)}
            >
              {chevronLeftIcon}
            </button>
            <span className="frank-recorder__count" aria-live="polite">
              Frame {currentIndex + 1} of {frames.length}
            </span>
            <button
              type="button"
              aria-label="Next frame"
              disabled={frames.length < 2}
              onClick={() => selectFrame(currentIndex + 1)}
            >
              {chevronRight}
            </button>
            {status === "idle" || status === "preview" ? (
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
            {recordingUrl ? (
              <button
                type="button"
                aria-label={`Download ${recordingExtension.toUpperCase()}`}
                title={`Download ${recordingExtension.toUpperCase()}`}
                onClick={downloadRecording}
              >
                Download {recordingExtension.toUpperCase()}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Recording layout settings"
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
            <div
              ref={cameraRef}
              className={`frank-recorder__camera ${
                status === "idle" ? "" : "frank-recorder__camera--visible"
              } ${
                status === "recording"
                  ? "frank-recorder__camera--recording"
                  : ""
              } ${status === "paused" ? "frank-recorder__camera--paused" : ""}`}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={dragCamera}
              onPointerUp={saveDraggedCameraPosition}
              onPointerCancel={saveDraggedCameraPosition}
            >
              <video ref={videoRef} autoPlay muted playsInline />
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
