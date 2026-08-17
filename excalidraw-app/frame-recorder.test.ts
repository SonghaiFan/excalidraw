import { describe, expect, it } from "vitest";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  clampCameraPosition,
  formatRecordingTime,
  getFrameSceneSignature,
  getFramePlaybackIndex,
  getRecorderMimeType,
  getRecordingDownloadMetadata,
  getRecordingDimensions,
  sortFramesForPlayback,
} from "./frame-recorder";

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

  it("keeps the playback index aligned when an earlier frame is removed", () => {
    const frames = [
      { id: "page-2" },
      { id: "page-3" },
    ] as NonDeleted<ExcalidrawFrameElement>[];

    expect(getFramePlaybackIndex(frames, "page-3")).toBe(1);
    expect(getFramePlaybackIndex(frames, "removed-page")).toBe(0);
  });
});
