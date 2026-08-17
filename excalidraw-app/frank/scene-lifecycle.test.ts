import { describe, expect, it } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  areElementsAtKnownRevisions,
  classifySceneTransition,
  FrankSceneLifecycle,
  getElementRevisionKey,
} from "./scene-lifecycle";

const element = (id: string, isDeleted = false) =>
  ({ id, isDeleted } as ExcalidrawElement);

describe("classifySceneTransition", () => {
  it("recognizes clear without treating normal edits as document changes", () => {
    expect(classifySceneTransition(new Set(["a"]), new Set())).toBe("clear");
    expect(classifySceneTransition(new Set(["a"]), new Set(["a", "b"]))).toBe(
      "incremental",
    );
    expect(classifySceneTransition(new Set(["a", "b"]), new Set(["b"]))).toBe(
      "incremental",
    );
  });

  it("recognizes a scene replacement when no active elements survive", () => {
    expect(
      classifySceneTransition(new Set(["old-a", "old-b"]), new Set(["new-a"])),
    ).toBe("replace");
    expect(classifySceneTransition(new Set(), new Set(["first"]))).toBe(
      "incremental",
    );
  });

  it("can restart its Excalidraw subscription after React strict cleanup", () => {
    let scene = [element("a")];
    let onChange: ((elements: readonly ExcalidrawElement[]) => void) | null =
      null;
    const api = {
      getSceneElementsIncludingDeleted: () => scene,
      onChange: (listener: typeof onChange) => {
        onChange = listener;
        return () => {
          onChange = null;
        };
      },
    } as unknown as ExcalidrawImperativeAPI;
    const lifecycle = new FrankSceneLifecycle(api);
    const transitions: string[] = [];
    lifecycle.subscribe(({ transition }) => transitions.push(transition));

    lifecycle.start();
    lifecycle.stop();
    lifecycle.start();
    scene = [element("a", true)];
    (
      onChange as unknown as (
        elements: readonly ExcalidrawElement[],
        appState: AppState,
      ) => void
    )(scene, { selectedElementIds: {} } as AppState);

    expect(transitions).toEqual(["clear"]);
  });

  it("detects user edits or deletes to elements owned by a live operation", () => {
    const firstRevision = {
      ...element("answer"),
      version: 3,
      versionNonce: 30,
    };
    const latestRevision = {
      ...element("answer"),
      version: 4,
      versionNonce: 40,
    };
    const expected = new Map([
      [
        "answer",
        new Set([
          getElementRevisionKey(firstRevision),
          getElementRevisionKey(latestRevision),
        ]),
      ],
    ]);

    expect(areElementsAtKnownRevisions([firstRevision], expected)).toBe(true);
    expect(areElementsAtKnownRevisions([latestRevision], expected)).toBe(true);
    expect(
      areElementsAtKnownRevisions(
        [
          {
            ...latestRevision,
            versionNonce: 41,
          },
        ],
        expected,
      ),
    ).toBe(false);
    expect(areElementsAtKnownRevisions([element("other")], expected)).toBe(
      false,
    );
  });
});
