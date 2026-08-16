import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type FrankSceneTransition = "incremental" | "clear" | "replace";

export type FrankSceneSnapshot = {
  elements: readonly ExcalidrawElement[];
  activeElementIds: ReadonlySet<string>;
  transition: FrankSceneTransition;
};

export const areElementsUnchanged = (
  elements: readonly ExcalidrawElement[],
  expectedVersions: ReadonlyMap<string, number>,
) => {
  if (expectedVersions.size === 0) {
    return true;
  }
  const elementsById = new Map(
    elements.map((element) => [element.id, element]),
  );
  for (const [id, version] of expectedVersions) {
    const element = elementsById.get(id);
    if (!element || element.isDeleted || element.version !== version) {
      return false;
    }
  }
  return true;
};

type SceneListener = (snapshot: FrankSceneSnapshot) => void;

const getActiveElementIds = (elements: readonly ExcalidrawElement[]) =>
  new Set(
    elements
      .filter((element) => !element.isDeleted)
      .map((element) => element.id),
  );

export const classifySceneTransition = (
  previousIds: ReadonlySet<string>,
  nextIds: ReadonlySet<string>,
): FrankSceneTransition => {
  if (previousIds.size > 0 && nextIds.size === 0) {
    return "clear";
  }

  if (previousIds.size > 0 && nextIds.size > 0) {
    for (const id of previousIds) {
      if (nextIds.has(id)) {
        return "incremental";
      }
    }
    return "replace";
  }

  return "incremental";
};

/**
 * App-layer bridge for Frank features. It deliberately uses only Excalidraw's
 * public imperative API so the fork does not need lifecycle hooks in core.
 */
export class FrankSceneLifecycle {
  private activeElementIds: ReadonlySet<string>;
  private readonly listeners = new Set<SceneListener>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly excalidrawAPI: ExcalidrawImperativeAPI) {
    this.activeElementIds = getActiveElementIds(
      excalidrawAPI.getSceneElementsIncludingDeleted(),
    );
  }

  start() {
    if (this.unsubscribe) {
      return;
    }
    this.activeElementIds = getActiveElementIds(
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    );
    this.unsubscribe = this.excalidrawAPI.onChange((elements) => {
      const activeElementIds = getActiveElementIds(elements);
      const snapshot: FrankSceneSnapshot = {
        elements,
        activeElementIds,
        transition: classifySceneTransition(
          this.activeElementIds,
          activeElementIds,
        ),
      };
      this.activeElementIds = activeElementIds;
      this.listeners.forEach((listener) => listener(snapshot));
    });
  }

  getActiveElementIds() {
    return this.activeElementIds;
  }

  subscribe(listener: SceneListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  dispose() {
    this.stop();
    this.listeners.clear();
  }
}
