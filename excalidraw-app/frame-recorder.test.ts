import { describe, expect, it } from "vitest";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  clampCameraPosition,
  formatRecordingTime,
  getFrameSceneSignature,
  getRecorderMimeType,
  getRecordingDownloadMetadata,
  getRecordingDimensions,
  getRecordingLayoutRects,
} from "./frame-recorder";
import {
  getNextFramePosition,
  resolveSelectedFrameId,
  sortFramesForPlayback,
} from "./frank/frame-utils";

describe("frame recorder", () => {
  it("formats a stable recording timer", () => {
    expect(formatRecordingTime(0)).toBe("00:00");
    expect(formatRecordingTime(65.9)).toBe("01:05");
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

  it("maps all four recording layouts into stable canvas regions", () => {
    const position = { x: 0.8, y: 0.8 };

    expect(
      getRecordingLayoutRects("full-camera", 100, 200, position, 0.2),
    ).toEqual({
      canvas: null,
      camera: { x: 0, y: 0, width: 100, height: 200 },
      cameraShape: "rectangle",
    });
    expect(
      getRecordingLayoutRects("camera-canvas", 100, 200, position, 0.2),
    ).toEqual({
      canvas: { x: 0, y: 110, width: 100, height: 90 },
      camera: { x: 0, y: 0, width: 100, height: 110 },
      cameraShape: "rectangle",
    });
    expect(
      getRecordingLayoutRects("canvas-camera", 100, 200, position, 0.2),
    ).toEqual({
      canvas: { x: 0, y: 0, width: 100, height: 120 },
      camera: { x: 0, y: 120, width: 100, height: 80 },
      cameraShape: "rectangle",
    });
    expect(
      getRecordingLayoutRects("canvas-pip", 100, 200, position, 0.2),
    ).toEqual({
      canvas: { x: 0, y: 0, width: 100, height: 200 },
      camera: { x: 70, y: 150, width: 20, height: 20 },
      cameraShape: "circle",
    });
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
