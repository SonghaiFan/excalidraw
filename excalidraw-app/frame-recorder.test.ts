import { describe, expect, it } from "vitest";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  canSwitchRecorderMode,
  clampCameraPosition,
  formatRecordingTime,
  getAudioSyncDelay,
  getCameraPreviewLayoutRects,
  getCameraFrameDelay,
  getClipInsets,
  getFrameSceneSignature,
  getFrameLayoutShortcut,
  getRepeatedSplitPosition,
  getRecorderMimeType,
  getRecorderTextLines,
  getRecordingDownloadMetadata,
  getRecordingDimensions,
  getRecordingLayoutRects,
  shouldRefreshRecordingExport,
  shouldRenderRecordingComposite,
  smoothCameraFrameDelay,
  usesNativeFullCamera,
} from "./frame-recorder";
import {
  getNextFramePosition,
  getFrameNavigationDelta,
  resolveSelectedFrameId,
  sortFramesForPlayback,
} from "./frank/frame-utils";

describe("frame recorder", () => {
  it("maps only the intended unmodified keyboard shortcuts", () => {
    const keyboardEvent = {
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };

    expect(
      getFrameNavigationDelta({ ...keyboardEvent, key: "ArrowLeft" }),
    ).toBe(-1);
    expect(
      getFrameNavigationDelta({ ...keyboardEvent, key: "ArrowRight" }),
    ).toBe(1);
    expect(
      getFrameNavigationDelta({
        ...keyboardEvent,
        altKey: true,
        key: "ArrowRight",
      }),
    ).toBe(0);
    expect(
      ["Digit1", "Digit2", "Digit3"].map((code) =>
        getFrameLayoutShortcut({
          ...keyboardEvent,
          altKey: true,
          code,
        }),
      ),
    ).toEqual(["full-camera", "split", "canvas-pip"]);
    expect(
      getFrameLayoutShortcut({ ...keyboardEvent, code: "Digit1" }),
    ).toBeNull();
    expect(getRepeatedSplitPosition("split", "split", "top")).toBe("bottom");
    expect(getRepeatedSplitPosition("split", "split", "bottom")).toBe("top");
    expect(getRepeatedSplitPosition("full-camera", "split", "top")).toBeNull();
    expect(canSwitchRecorderMode("frame", "frame", true)).toBe(true);
    expect(canSwitchRecorderMode("frame", "canvas", true)).toBe(false);
    expect(canSwitchRecorderMode("frame", "canvas", false)).toBe(true);
  });

  it("formats a stable recording timer", () => {
    expect(formatRecordingTime(0)).toBe("00:00");
    expect(formatRecordingTime(65.9)).toBe("01:05");
  });

  it("keeps live text input offsets across wrapping and hard lines", () => {
    expect(
      getRecorderTextLines("abcd\nef", 3, true, (value) => value.length),
    ).toEqual([
      { start: 0, end: 3, text: "abc" },
      { start: 3, end: 4, text: "d" },
      { start: 5, end: 7, text: "ef" },
    ]);
    expect(
      getRecorderTextLines("abcd", 2, false, (value) => value.length),
    ).toEqual([{ start: 0, end: 4, text: "abcd" }]);
    expect(
      getRecorderTextLines("hello world", 6, true, (value) => value.length),
    ).toEqual([
      { start: 0, end: 6, text: "hello " },
      { start: 6, end: 11, text: "world" },
    ]);
  });

  it("measures and smooths camera latency for microphone sync", () => {
    expect(
      getCameraFrameDelay(1110, {
        captureTime: 1000,
        expectedDisplayTime: 1120,
      }),
    ).toBeCloseTo(0.12);
    expect(
      getCameraFrameDelay(1110, {
        expectedDisplayTime: 1120,
      }),
    ).toBeNull();
    expect(
      getCameraFrameDelay(1000, {
        captureTime: 1200,
        expectedDisplayTime: 1010,
      }),
    ).toBe(0);
    expect(
      getCameraFrameDelay(2000, {
        captureTime: 1000,
        expectedDisplayTime: 2010,
      }),
    ).toBe(0.35);
    expect(smoothCameraFrameDelay(null, 0.1)).toBe(0.1);
    expect(smoothCameraFrameDelay(0.1, 0.2)).toBeCloseTo(0.116);
    expect(getAudioSyncDelay(0.12, 0.03)).toBeCloseTo(0.09);
    expect(getAudioSyncDelay(0.02, 0.03)).toBe(0);
  });

  it("caps recording size and orders slide frames by row then column", () => {
    expect(getRecordingDimensions({ width: 1080, height: 1920 })).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(getRecordingDimensions({ width: 3000, height: 1500 })).toEqual({
      width: 1920,
      height: 960,
    });

    const frame = (
      id: string,
      x: number,
      y: number,
    ): NonDeleted<ExcalidrawFrameElement> =>
      ({
        id,
        x,
        y,
        width: 100,
        height: 100,
      } as NonDeleted<ExcalidrawFrameElement>);

    expect(
      sortFramesForPlayback([
        frame("bottom", 0, 200),
        frame("right", 200, 0),
        frame("left", 0, 0),
      ]).map(({ id }) => id),
    ).toEqual(["left", "right", "bottom"]);
  });

  it("prefers native MP4 and falls back to WebM", () => {
    expect(getRecorderMimeType((type) => type === "video/mp4")).toBe(
      "video/mp4",
    );
    expect(getRecorderMimeType((type) => type === "video/webm")).toBe(
      "video/webm",
    );
  });

  it("creates a timestamped filename for the automatic download", () => {
    expect(
      getRecordingDownloadMetadata(
        "video/mp4;codecs=avc1",
        new Date("2026-08-17T01:02:03.456Z"),
      ),
    ).toEqual({
      extension: "mp4",
      filename: "frank-canvas-2026-08-17T01-02-03-456Z.mp4",
    });
    expect(getRecordingDownloadMetadata("video/webm").extension).toBe("webm");
  });

  it("maps the recording layouts into stable canvas regions", () => {
    const position = { x: 0.8, y: 0.8 };

    expect(
      getRecordingLayoutRects("full-camera", 100, 200, position, 0.2),
    ).toEqual({
      canvas: { x: 0, y: 0, width: 100, height: 200 },
      camera: { x: 0, y: 0, width: 100, height: 200 },
      cameraShape: "rectangle",
      canvasLayer: "above",
    });
    expect(
      getRecordingLayoutRects("split", 100, 200, position, 0.2, "top", 0.55),
    ).toEqual({
      canvas: { x: 0, y: 0, width: 100, height: 200 },
      camera: { x: 0, y: 0, width: 100, height: 110 },
      cameraShape: "rectangle",
      canvasLayer: "below",
    });
    expect(
      getRecordingLayoutRects("split", 100, 200, position, 0.2, "bottom", 0.4),
    ).toEqual({
      canvas: { x: 0, y: 0, width: 100, height: 200 },
      camera: { x: 0, y: 120, width: 100, height: 80 },
      cameraShape: "rectangle",
      canvasLayer: "below",
    });
    expect(
      getRecordingLayoutRects("canvas-pip", 100, 200, position, 0.2),
    ).toEqual({
      canvas: { x: 0, y: 0, width: 100, height: 200 },
      camera: { x: 70, y: 150, width: 20, height: 20 },
      cameraShape: "circle",
      canvasLayer: "below",
    });
  });

  it("keeps every editor preview on the native Excalidraw canvas", () => {
    expect(shouldRenderRecordingComposite("frame", "split", false)).toBe(false);
    expect(shouldRenderRecordingComposite("frame", "canvas-pip", false)).toBe(
      false,
    );
    expect(shouldRenderRecordingComposite("canvas", "canvas-pip", false)).toBe(
      false,
    );
    expect(shouldRenderRecordingComposite("frame", "full-camera", false)).toBe(
      false,
    );
    expect(shouldRenderRecordingComposite("frame", "split", true)).toBe(true);
    expect(usesNativeFullCamera("frame", "full-camera")).toBe(true);
    expect(usesNativeFullCamera("frame", "split")).toBe(false);
    expect(shouldRefreshRecordingExport("frame", "full-camera", true)).toBe(
      false,
    );
    expect(shouldRefreshRecordingExport("frame", "split", true)).toBe(true);
  });

  it("clips an HTML camera preview at its recording boundary", () => {
    expect(
      getClipInsets(
        { x: 80, y: 90, width: 40, height: 40 },
        { x: 100, y: 100, width: 200, height: 200 },
      ),
    ).toEqual({ top: 10, right: 0, bottom: 0, left: 20 });
  });

  it("keeps the camera circle inside the current frame", () => {
    const frame = { x: 100, y: 50, width: 240, height: 160 };
    const diameter = 72;
    const position = clampCameraPosition({ x: 1, y: 1 }, frame, diameter);
    const right = frame.x + frame.width * position.x + diameter / 2;
    const bottom = frame.y + frame.height * position.y + diameter / 2;

    expect(right).toBe(frame.x + frame.width);
    expect(bottom).toBe(frame.y + frame.height);
  });

  it("keeps PIP geometry relative to the Frame while zooming", () => {
    const position = { x: 0.8, y: 0.75 };
    const atOneX = getCameraPreviewLayoutRects(
      "canvas-pip",
      { x: 100, y: 80, width: 400, height: 600 },
      position,
      0.2,
    );
    const atTwoX = getCameraPreviewLayoutRects(
      "canvas-pip",
      { x: 200, y: 160, width: 800, height: 1200 },
      position,
      0.2,
    );

    expect(atTwoX.camera).toEqual({
      x: atOneX.camera.x * 2,
      y: atOneX.camera.y * 2,
      width: atOneX.camera.width * 2,
      height: atOneX.camera.height * 2,
    });
    expect(position).toEqual({ x: 0.8, y: 0.75 });
  });

  it("refreshes a recording background only for changes in its frame", () => {
    const elements = [
      { id: "frame", frameId: null, version: 1, width: 400, height: 300 },
      { id: "inside", frameId: "frame", version: 2, width: 80, height: 40 },
      { id: "outside", frameId: null, version: 9, width: 20, height: 20 },
    ] as unknown as ExcalidrawFrameElement[];

    expect(getFrameSceneSignature(elements, "frame")).toBe(
      "frame:1:400:300|inside:2:80:40",
    );
  });

  it("resolves a selected child to its page frame", () => {
    const elements = [
      { id: "frame", type: "frame", frameId: null, isDeleted: false },
      { id: "child", type: "text", frameId: "frame", isDeleted: false },
    ] as unknown as ExcalidrawFrameElement[];

    expect(resolveSelectedFrameId(elements, { child: true })).toBe("frame");
  });

  it("places a new page after the rightmost frame in the current row", () => {
    const frames = [
      { id: "page-1", x: 0, y: 0, width: 100, height: 200 },
      { id: "page-2", x: 200, y: 0, width: 100, height: 200 },
      { id: "other-row", x: 900, y: 400, width: 100, height: 200 },
    ] as NonDeleted<ExcalidrawFrameElement>[];

    expect(getNextFramePosition(frames, frames[0], 50)).toEqual({
      x: 350,
      y: 0,
    });
  });
});
