import { describe, expect, it } from "vitest";

import type {
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  clampCameraPosition,
  formatRecordingTime,
  getRecorderMimeType,
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

  it("keeps the camera circle inside the current frame", () => {
    const frame = { x: 100, y: 50, width: 240, height: 160 };
    const diameter = 72;
    const position = clampCameraPosition({ x: 1, y: 1 }, frame, diameter);
    const right = frame.x + frame.width * position.x + diameter / 2;
    const bottom = frame.y + frame.height * position.y + diameter / 2;

    expect(right).toBe(frame.x + frame.width);
    expect(bottom).toBe(frame.y + frame.height);
  });
});
