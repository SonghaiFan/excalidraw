import {
  Excalidraw,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
  reconcileElements,
  ExcalidrawAPIProvider,
  useExcalidrawAPI,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import {
  CommandPalette,
  DEFAULT_CATEGORIES,
} from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { OverwriteConfirmDialog } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm";
import { openConfirmModal } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirmState";
import Trans from "@excalidraw/excalidraw/components/Trans";
import {
  ArrowRightIcon,
  CloseIcon,
  microphoneIcon,
} from "@excalidraw/excalidraw/components/icons";
import {
  APP_NAME,
  EVENT,
  VERSION_TIMEOUT,
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  resolvablePromise,
} from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { t } from "@excalidraw/excalidraw/i18n";

import { isElementLink } from "@excalidraw/element";
import {
  bumpElementVersions,
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { newElementWith } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "@excalidraw/excalidraw/data/library";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { RestoredDataState } from "@excalidraw/excalidraw/data/restore";
import type {
  ExcalidrawFrameElement,
  FileId,
  NonDeleted,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { ResolutionType } from "@excalidraw/common/utility-types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import CustomStats from "./CustomStats";
import { FramePages } from "./frame-pages";
import { FrameRecorder } from "./frame-recorder";
import {
  clampFrameDimension,
  FRAME_PRESETS,
  type FramePreset,
} from "./frank/frame-utils";
import {
  areElementsAtKnownRevisions,
  FrankSceneLifecycle,
  getElementRevisionKey,
  type FrankSceneSnapshot,
} from "./frank/scene-lifecycle";
import { Provider, useAtom, useAtomValue, appJotaiStore } from "./app-jotai";
import {
  FIREBASE_STORAGE_PREFIXES,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT,
} from "./app_constants";
import { collabAPIAtom } from "./collab/Collab";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { TopErrorBoundary } from "./components/TopErrorBoundary";

import {
  getCollaborationLinkData,
  importFromBackend,
  isCollaborationLink,
} from "./data";

import { updateStaleImageStatuses } from "./data/FileManager";
import { FileStatusStore } from "./data/fileStatusStore";
import {
  importFromLocalStorage,
  importUsernameFromLocalStorage,
} from "./data/localStorage";

import { loadFilesFromFirebase } from "./data/firebase";
import {
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  LocalData,
  localStorageQuotaExceededAtom,
} from "./data/LocalData";
import { isBrowserStorageStateNewer } from "./data/tabSync";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { getPreferredLanguage } from "./app-language/language-detector";
import { useAppLangCode } from "./app-language/language-state";
import {
  createIncrementalCanvasMarkdown,
  createFormattedCanvasElements,
  createStreamingCanvasBlockElements,
  frameCanvasElements,
  measureCanvasBlockHeight,
  paginateCanvasBlockHeights,
  parseCanvasMarkdown,
  readAIStream,
  type StreamingCanvasBlock,
} from "./ai-format";

import "./index.scss";

import type { CollabAPI } from "./collab/Collab";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

declare global {
  interface BeforeInstallPromptEventChoiceResult {
    outcome: "accepted" | "dismissed";
  }

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<BeforeInstallPromptEventChoiceResult>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

let pwaEvent: BeforeInstallPromptEvent | null = null;

// Adding a listener outside of the component as it may (?) need to be
// subscribed early to catch the event.
//
// Also note that it will fire only if certain heuristics are met (user has
// used the app for some time, etc.)
window.addEventListener(
  "beforeinstallprompt",
  (event: BeforeInstallPromptEvent) => {
    // prevent Chrome <= 67 from automatically showing the prompt
    event.preventDefault();
    // cache for later use
    pwaEvent = event;
  },
);

let isSelfEmbedding = false;

if (window.self !== window.top) {
  try {
    const parentUrl = new URL(document.referrer);
    const currentUrl = new URL(window.location.href);
    if (parentUrl.origin === currentUrl.origin) {
      isSelfEmbedding = true;
    }
  } catch (error) {
    // ignore
  }
}

const shareableLinkConfirmDialog = {
  title: t("overwriteConfirm.modal.shareableLink.title"),
  description: (
    <Trans
      i18nKey="overwriteConfirm.modal.shareableLink.description"
      bold={(text) => <strong>{text}</strong>}
      br={() => <br />}
    />
  ),
  actionLabel: t("overwriteConfirm.modal.shareableLink.button"),
  color: "danger",
} as const;

type AIMessage = {
  role: "user" | "assistant";
  content: string;
};

type AIProvider = "deepseek" | "openai";

const AICanvasPrompt = ({
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
  const [provider, setProvider] = useState<AIProvider>("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [isEditingApiKey, setIsEditingApiKey] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [framePreset, setFramePreset] = useState<FramePreset>("portrait");
  const [customFrameSize, setCustomFrameSize] = useState({
    width: "1080",
    height: "1350",
  });
  const messagesRef = useRef<AIMessage[]>([]);
  const nextCardPositionRef = useRef<{ x: number; y: number } | null>(null);
  const activeRequestRef = useRef<{
    controller: AbortController;
    initialElementIds: ReadonlySet<string>;
    renderer: {
      cancel: () => void;
      hasRendered: () => boolean;
      isSceneIntact: (elements: FrankSceneSnapshot["elements"]) => boolean;
    };
  } | null>(null);

  const cancelActiveRequest = () => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) {
      return;
    }
    activeRequest.renderer.cancel();
    activeRequest.controller.abort();
    activeRequestRef.current = null;
  };

  const closePrompt = () => {
    cancelActiveRequest();
    setIsEditingApiKey(false);
    onClose();
  };

  useEffect(() => {
    return sceneLifecycle.subscribe((snapshot) => {
      if (
        snapshot.transition === "clear" ||
        snapshot.transition === "replace"
      ) {
        messagesRef.current = [];
        nextCardPositionRef.current = null;
      }

      const activeRequest = activeRequestRef.current;
      if (!activeRequest) {
        return;
      }

      const sceneChangedBeforeFirstRender =
        !activeRequest.renderer.hasRendered() &&
        (snapshot.activeElementIds.size !==
          activeRequest.initialElementIds.size ||
          [...snapshot.activeElementIds].some(
            (id) => !activeRequest.initialElementIds.has(id),
          ));
      if (
        sceneChangedBeforeFirstRender ||
        !activeRequest.renderer.isSceneIntact(snapshot.elements)
      ) {
        cancelActiveRequest();
        setIsLoading(false);
      }
    });
  }, [sceneLifecycle]);

  useEffect(() => () => cancelActiveRequest(), []);

  const frameSize =
    framePreset === "custom"
      ? {
          width: clampFrameDimension(customFrameSize.width, 1080),
          height: clampFrameDimension(customFrameSize.height, 1350),
        }
      : FRAME_PRESETS[framePreset];

  const createResponseRenderer = (
    question: string,
    responseProvider: AIProvider,
  ) => {
    const appState = excalidrawAPI.getAppState();
    const isDark = appState.theme === "dark";
    const pageWidth = frameSize.width;
    const pageHeight = frameSize.height;
    const pagePadding = Math.round(
      Math.max(36, Math.min(64, pageWidth * 0.05)),
    );
    const pageGap = Math.round(pagePadding * 1.5);
    const rowGap = Math.round(pagePadding * 2);
    const contentWidth = pageWidth - pagePadding * 2;
    const zoom = appState.zoom.value;
    const position =
      nextCardPositionRef.current ||
      viewportCoordsToSceneCoords(
        {
          clientX:
            appState.offsetLeft + appState.width / 2 - (pageWidth * zoom) / 2,
          clientY:
            appState.offsetTop +
            appState.height / 2 -
            Math.min((pageHeight * zoom) / 2, 320),
        },
        appState,
      );
    const header = createFormattedCanvasElements({
      markdown: "",
      question,
      provider: responseProvider,
      x: position.x + pagePadding,
      y: position.y + pagePadding,
      isDark,
      width: contentWidth,
    });
    let headerElements: NonDeletedExcalidrawElement[] = [...header.elements];
    let frames: NonDeleted<ExcalidrawFrameElement>[] = [];
    let ownedIds = new Set<string>();
    const ownedRevisions = new Map<string, Set<string>>();
    let didFocus = false;
    let cancelled = false;
    const responseId = crypto.randomUUID();
    const streamMarkdown = createIncrementalCanvasMarkdown();
    type RenderedCanvasBlock = {
      signature: string;
      x: number;
      y: number;
      height: number;
      elements: NonDeletedExcalidrawElement[];
    };
    let renderedBlocks = new Map<number, RenderedCanvasBlock>();

    const replaceResponseElements = (
      elements: readonly NonDeletedExcalidrawElement[],
      captureUpdate:
        | typeof CaptureUpdateAction.EVENTUALLY
        | typeof CaptureUpdateAction.IMMEDIATELY,
    ) => {
      if (cancelled || excalidrawAPI.isDestroyed) {
        return false;
      }

      const sceneElements = excalidrawAPI.getSceneElementsIncludingDeleted();
      if (
        ownedIds.size > 0 &&
        [...ownedIds].some((id) => {
          const element = sceneElements.find((element) => element.id === id);
          return !element || element.isDeleted;
        })
      ) {
        cancelled = true;
        return false;
      }

      const nextOwnedIds = new Set(elements.map((element) => element.id));
      const retainedElements = sceneElements.filter(
        (element) => !ownedIds.has(element.id),
      );
      const removedElements = sceneElements
        .filter(
          (element) =>
            ownedIds.has(element.id) && !nextOwnedIds.has(element.id),
        )
        .map((element) =>
          element.isDeleted
            ? element
            : newElementWith(element, { isDeleted: true }),
        );
      ownedIds = nextOwnedIds;
      for (const id of ownedRevisions.keys()) {
        if (!nextOwnedIds.has(id)) {
          ownedRevisions.delete(id);
        }
      }
      for (const element of elements) {
        const revisions = ownedRevisions.get(element.id) || new Set<string>();
        revisions.add(getElementRevisionKey(element));
        ownedRevisions.set(element.id, revisions);
      }
      excalidrawAPI.updateScene({
        elements: [
          ...retainedElements,
          ...removedElements,
          ...elements,
        ] as OrderedExcalidrawElement[],
        captureUpdate,
      });
      return true;
    };

    const layoutBlocks = (
      blocks: readonly StreamingCanvasBlock[],
      captureUpdate:
        | typeof CaptureUpdateAction.EVENTUALLY
        | typeof CaptureUpdateAction.IMMEDIATELY,
    ) => {
      const contentHeight = pageHeight - pagePadding * 2;
      const heights = blocks.map(({ block }) =>
        measureCanvasBlockHeight({ block, width: contentWidth, isDark }),
      );
      const pages = paginateCanvasBlockHeights({
        heights,
        firstPageHeight: contentHeight - header.height,
        pageHeight: contentHeight,
      });
      const nextBlocks = new Map(renderedBlocks);
      nextBlocks.clear();
      const nextFrames: NonDeleted<ExcalidrawFrameElement>[] = [];
      const allElements: NonDeletedExcalidrawElement[] = [];

      for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const pageX = position.x + pageIndex * (pageWidth + pageGap);
        const pageY = position.y;
        let cursorY =
          pageY + pagePadding + (pageIndex === 0 ? header.height : 0);
        const blockEntries: {
          id: number;
          section: RenderedCanvasBlock;
        }[] = [];
        for (const blockIndex of pages[pageIndex]) {
          const { id, block } = blocks[blockIndex];
          const signature = JSON.stringify(block);
          const blockX = pageX + pagePadding;
          const cached = renderedBlocks.get(id);
          const section =
            cached &&
            cached.signature === signature &&
            cached.x === blockX &&
            cached.y === cursorY
              ? cached
              : {
                  signature,
                  x: blockX,
                  y: cursorY,
                  ...createStreamingCanvasBlockElements({
                    block,
                    idPrefix: `${responseId}-block-${id}`,
                    x: blockX,
                    y: cursorY,
                    width: contentWidth,
                    isDark,
                    previous: cached?.elements,
                  }),
                };
          cursorY += section.height;
          blockEntries.push({ id, section });
        }
        const pageElements = [
          ...(pageIndex === 0 ? headerElements : []),
          ...blockEntries.flatMap(({ section }) => section.elements),
        ];
        const framed = frameCanvasElements({
          elements: pageElements,
          name: `AI / ${question.slice(0, 42)} / FRAME ${pageIndex + 1} OF ${
            pages.length
          }`,
          isDark,
          frame: frames[pageIndex],
          bounds: {
            x: pageX,
            y: pageY,
            width: pageWidth,
            height: pageHeight,
          },
        });
        nextFrames.push(framed.frame);
        allElements.push(...framed.elements);

        const content = framed.elements.slice(0, -1);
        let offset = 0;
        if (pageIndex === 0) {
          headerElements = content.slice(0, headerElements.length);
          offset = headerElements.length;
        }
        for (const { id, section } of blockEntries) {
          const elements = content.slice(
            offset,
            offset + section.elements.length,
          );
          nextBlocks.set(id, { ...section, elements });
          offset += section.elements.length;
        }
      }

      renderedBlocks = nextBlocks;
      frames = nextFrames;
      if (!replaceResponseElements(allElements, captureUpdate)) {
        return null;
      }

      if (!didFocus && frames[0]) {
        didFocus = true;
        excalidrawAPI.setViewport({
          target: [frames[0]],
          fit: "scale-down",
          animation: true,
          offsets: { ui: true },
        });
      }

      return { elements: allElements, pageCount: pages.length };
    };

    const renderStreaming = () => {
      return layoutBlocks(
        streamMarkdown.snapshot(),
        CaptureUpdateAction.EVENTUALLY,
      );
    };

    const pushStreamingDelta = (delta: string) => {
      if (cancelled) {
        return;
      }
      streamMarkdown.push(delta);
    };

    const finalize = async (answer: string) => {
      if (cancelled) {
        return;
      }
      const document = parseCanvasMarkdown(answer);
      const finalBlocks = document.blocks.map((block, id) => ({
        id,
        block,
        complete: true,
      }));
      const layout = layoutBlocks(finalBlocks, CaptureUpdateAction.IMMEDIATELY);
      if (!layout) {
        return;
      }

      if (document.mermaid) {
        try {
          const { parseMermaidToExcalidraw } = await import(
            "@excalidraw/mermaid-to-excalidraw"
          );
          const result = await parseMermaidToExcalidraw(document.mermaid);
          if (cancelled || excalidrawAPI.isDestroyed) {
            return;
          }
          const diagram = convertToExcalidrawElements(result.elements);
          const [diagramX, diagramY] = getCommonBounds(diagram);
          const pageIndex = layout.pageCount;
          const pageX = position.x + pageIndex * (pageWidth + pageGap);
          const placedDiagram = diagram.map((element) =>
            newElementWith(element, {
              x: element.x + pageX + pagePadding - diagramX,
              y: element.y + position.y + pagePadding - diagramY,
            }),
          );
          const diagramPage = frameCanvasElements({
            elements: placedDiagram,
            name: `AI / ${question.slice(0, 42)} / DIAGRAM`,
            isDark,
            frame: frames[pageIndex],
            bounds: {
              x: pageX,
              y: position.y,
              width: pageWidth,
              height: pageHeight,
            },
          });
          frames = [...frames, diagramPage.frame];
          if (
            !replaceResponseElements(
              [...layout.elements, ...diagramPage.elements],
              CaptureUpdateAction.IMMEDIATELY,
            )
          ) {
            return;
          }
          if (result.files) {
            excalidrawAPI.addFiles(Object.values(result.files));
          }
        } catch {
          excalidrawAPI.setToast({
            message: "Text added. The optional diagram could not be drawn.",
          });
        }
      }
      nextCardPositionRef.current = {
        x: position.x,
        y: position.y + pageHeight + rowGap,
      };
    };

    return {
      pushStreamingDelta,
      renderStreaming,
      finalize,
      cancel: () => {
        cancelled = true;
      },
      hasRendered: () => ownedIds.size > 0,
      isSceneIntact: (elements: FrankSceneSnapshot["elements"]) =>
        !cancelled && areElementsAtKnownRevisions(elements, ownedRevisions),
    };
  };

  const submitPrompt = async () => {
    const question = prompt.trim();
    if (!question || isLoading || (provider === "deepseek" && !apiKey.trim())) {
      return;
    }

    const messages: AIMessage[] = [
      ...messagesRef.current,
      { role: "user" as const, content: question },
    ].slice(-12);

    setIsLoading(true);
    const renderer = createResponseRenderer(question, provider);
    const controller = new AbortController();
    const activeRequest = {
      controller,
      initialElementIds: new Set(sceneLifecycle.getActiveElementIds()),
      renderer,
    };
    activeRequestRef.current = activeRequest;
    let latestAnswer = "";
    let renderTimer: number | null = null;
    let finalized = false;

    const flushStreamingRender = () => {
      if (renderTimer !== null) {
        window.clearTimeout(renderTimer);
        renderTimer = null;
      }
      if (latestAnswer) {
        renderer.renderStreaming();
      }
    };
    const scheduleStreamingRender = (answer: string, delta: string) => {
      latestAnswer = answer;
      renderer.pushStreamingDelta(delta);
      if (renderTimer === null) {
        renderTimer = window.setTimeout(flushStreamingRender, 40);
      }
    };

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: apiKey.trim() || undefined,
          messages,
        }),
      });
      const answer = await readAIStream(response, scheduleStreamingRender);
      latestAnswer = answer;
      flushStreamingRender();
      await renderer.finalize(answer);
      if (controller.signal.aborted) {
        return;
      }
      finalized = true;

      messagesRef.current = [
        ...messages,
        { role: "assistant" as const, content: answer },
      ].slice(-12);
      setPrompt("");
      setIsLoading(false);
      activeRequestRef.current = null;
      closePrompt();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      if (!finalized && latestAnswer.trim()) {
        flushStreamingRender();
        await renderer.finalize(latestAnswer);
      }
      excalidrawAPI.setToast({
        message: error instanceof Error ? error.message : "AI request failed",
      });
    } finally {
      if (renderTimer !== null) {
        window.clearTimeout(renderTimer);
      }
      if (activeRequestRef.current === activeRequest) {
        activeRequestRef.current = null;
        setIsLoading(false);
      }
    }
  };

  return (
    <div className={`frank-ai frank-ai--${theme}`}>
      {isOpen ? (
        <div
          className="frank-ai__panel"
          role="dialog"
          aria-label="Ask Frank AI"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              closePrompt();
            }
          }}
        >
          <div className="frank-ai__composer">
            <label className="visually-hidden" htmlFor="frank-ai-prompt">
              Ask Frank on canvas
            </label>
            <textarea
              id="frank-ai-prompt"
              autoFocus
              autoComplete="off"
              data-form-type="other"
              data-1p-ignore="true"
              value={prompt}
              maxLength={8000}
              rows={2}
              placeholder="Ask Frank anything…"
              onChange={(event) => setPrompt(event.target.value)}
            />
            <button
              className="frank-ai__voice"
              type="button"
              aria-label="Voice input coming soon"
              title="Voice input coming soon"
              disabled
            >
              {microphoneIcon}
            </button>
            <button
              className="frank-ai__send"
              type="button"
              aria-label={isLoading ? "Frank is answering" : "Ask Frank"}
              title="Ask Frank"
              disabled={
                !prompt.trim() ||
                isLoading ||
                (provider === "deepseek" && !apiKey.trim())
              }
              onClick={submitPrompt}
            >
              {isLoading ? <span aria-hidden="true">···</span> : ArrowRightIcon}
            </button>
          </div>
          <div className="frank-ai__controls">
            <select
              aria-label="Model provider"
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value as AIProvider)
              }
            >
              <option value="deepseek">DeepSeek</option>
              <option value="openai">OpenAI</option>
            </select>
            <div className="frank-ai__format">
              <select
                aria-label="Frame format"
                value={framePreset}
                onChange={(event) =>
                  setFramePreset(event.target.value as FramePreset)
                }
              >
                {Object.entries(FRAME_PRESETS).map(([value, preset]) => (
                  <option key={value} value={value}>
                    {preset.label} · {preset.width}×{preset.height}
                  </option>
                ))}
                <option value="custom">Custom size</option>
              </select>
              {framePreset === "custom" ? (
                <div className="frank-ai__dimensions">
                  <input
                    type="number"
                    min="480"
                    max="3000"
                    step="10"
                    aria-label="Frame width"
                    value={customFrameSize.width}
                    onChange={(event) =>
                      setCustomFrameSize((current) => ({
                        ...current,
                        width: event.target.value,
                      }))
                    }
                  />
                  <span aria-hidden="true">×</span>
                  <input
                    type="number"
                    min="480"
                    max="3000"
                    step="10"
                    aria-label="Frame height"
                    value={customFrameSize.height}
                    onChange={(event) =>
                      setCustomFrameSize((current) => ({
                        ...current,
                        height: event.target.value,
                      }))
                    }
                  />
                </div>
              ) : null}
            </div>
            {isEditingApiKey ? (
              <div className="frank-ai__api-key-editor">
                <input
                  type="search"
                  aria-label="Provider access token"
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="none"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  data-lpignore="true"
                  data-protonpass-ignore="true"
                  spellCheck={false}
                  value={apiKey}
                  placeholder="Paste provider token"
                  onChange={(event) => setApiKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      setIsEditingApiKey(false);
                    }
                  }}
                />
                <button type="button" onClick={() => setIsEditingApiKey(false)}>
                  Done
                </button>
              </div>
            ) : (
              <button
                className="frank-ai__api-key-trigger"
                type="button"
                onClick={() => setIsEditingApiKey(true)}
              >
                {apiKey ? `API key · ${apiKey.slice(-4)}` : "Add API key"}
              </button>
            )}
            <span>
              {isLoading ? "Writing on canvas…" : "Key stays in this session"}
            </span>
            <button
              className="frank-ai__close"
              type="button"
              aria-label="Close AI input"
              onClick={closePrompt}
            >
              {CloseIcon}
            </button>
          </div>
        </div>
      ) : null}
      <button
        className="frank-ai__trigger frank-dock__trigger"
        type="button"
        aria-label="AI"
        aria-expanded={isOpen}
        aria-pressed={isOpen}
        onClick={isOpen ? closePrompt : onOpen}
      >
        <span className="frank-dock__index" aria-hidden="true">
          01
        </span>
        <span>AI</span>
      </button>
    </div>
  );
};

type CanvasTool = "ai" | "recording" | null;

const CanvasToolDock = ({
  excalidrawAPI,
  theme,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  theme: AppState["theme"];
}) => {
  const [activeTool, setActiveTool] = useState<CanvasTool>(null);
  const [sceneLifecycle] = useState(
    () => new FrankSceneLifecycle(excalidrawAPI),
  );

  useEffect(() => {
    sceneLifecycle.start();
    return () => sceneLifecycle.stop();
  }, [sceneLifecycle]);

  return (
    <>
      <FramePages
        excalidrawAPI={excalidrawAPI}
        sceneLifecycle={sceneLifecycle}
        theme={theme}
      />
      <div
        className={`frank-dock frank-dock--${theme}`}
        aria-label="Canvas tools"
      >
        <AICanvasPrompt
          excalidrawAPI={excalidrawAPI}
          sceneLifecycle={sceneLifecycle}
          theme={theme}
          isOpen={activeTool === "ai"}
          onOpen={() => setActiveTool("ai")}
          onClose={() => setActiveTool(null)}
        />
        <FrameRecorder
          excalidrawAPI={excalidrawAPI}
          sceneLifecycle={sceneLifecycle}
          theme={theme}
          isOpen={activeTool === "recording"}
          onOpen={() => setActiveTool("recording")}
          onClose={() => setActiveTool(null)}
        />
      </div>
    </>
  );
};

const initializeScene = async (opts: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI;
}): Promise<
  { scene: ExcalidrawInitialDataState | null } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  const jsonBackendMatch = window.location.hash.match(
    /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
  );
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/);

  const localDataState = importFromLocalStorage();

  let scene: Omit<
    RestoredDataState,
    // we're not storing files in the scene database/localStorage, and instead
    // fetch them async from a different store
    "files"
  > & {
    scrollToContent?: boolean;
  } = {
    elements: restoreElements(localDataState?.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    }),
    appState: restoreAppState(localDataState?.appState, null),
  };

  let roomLinkData = getCollaborationLinkData(window.location.href);
  const isExternalScene = !!(id || jsonBackendMatch || roomLinkData);
  if (isExternalScene) {
    if (
      // don't prompt if scene is empty
      !scene.elements.length ||
      // don't prompt for collab scenes because we don't override local storage
      roomLinkData ||
      // otherwise, prompt whether user wants to override current scene
      (await openConfirmModal(shareableLinkConfirmDialog))
    ) {
      if (jsonBackendMatch) {
        const imported = await importFromBackend(
          jsonBackendMatch[1],
          jsonBackendMatch[2],
        );

        scene = {
          elements: bumpElementVersions(
            restoreElements(imported.elements, null, {
              repairBindings: true,
              deleteInvisibleElements: true,
            }),
            localDataState?.elements,
          ),
          appState: restoreAppState(
            imported.appState,
            // local appState when importing from backend to ensure we restore
            // localStorage user settings which we do not persist on server.
            localDataState?.appState,
          ),
        };
      }
      scene.scrollToContent = true;
      if (!roomLinkData) {
        window.history.replaceState({}, APP_NAME, window.location.origin);
      }
    } else {
      // https://github.com/excalidraw/excalidraw/issues/1919
      if (document.hidden) {
        return new Promise((resolve, reject) => {
          window.addEventListener(
            "focus",
            () => initializeScene(opts).then(resolve).catch(reject),
            {
              once: true,
            },
          );
        });
      }

      roomLinkData = null;
      window.history.replaceState({}, APP_NAME, window.location.origin);
    }
  } else if (externalUrlMatch) {
    window.history.replaceState({}, APP_NAME, window.location.origin);

    const url = externalUrlMatch[1];
    try {
      const request = await fetch(window.decodeURIComponent(url));
      const data = await loadFromBlob(await request.blob(), null, null);
      if (
        !scene.elements.length ||
        (await openConfirmModal(shareableLinkConfirmDialog))
      ) {
        return { scene: data, isExternalScene };
      }
    } catch (error: any) {
      return {
        scene: {
          appState: {
            errorMessage: t("alerts.invalidSceneUrl"),
          },
        },
        isExternalScene,
      };
    }
  }

  if (roomLinkData && opts.collabAPI) {
    const { excalidrawAPI } = opts;

    const scene = await opts.collabAPI.startCollaboration(roomLinkData);

    return {
      // when collaborating, the state may have already been updated at this
      // point (we may have received updates from other clients), so reconcile
      // elements and appState with existing state
      scene: {
        ...scene,
        appState: {
          ...restoreAppState(
            {
              ...scene?.appState,
              theme: localDataState?.appState?.theme || scene?.appState?.theme,
            },
            excalidrawAPI.getAppState(),
          ),
          // necessary if we're invoking from a hashchange handler which doesn't
          // go through App.initializeScene() that resets this flag
          isLoading: false,
        },
        elements: reconcileElements(
          scene?.elements || [],
          excalidrawAPI.getSceneElementsIncludingDeleted() as RemoteExcalidrawElement[],
          excalidrawAPI.getAppState(),
        ),
      },
      isExternalScene: true,
      id: roomLinkData.roomId,
      key: roomLinkData.roomKey,
    };
  } else if (scene) {
    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2],
        }
      : { scene, isExternalScene: false };
  }
  return { scene: null, isExternalScene: false };
};

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();

  const isCollabDisabled = true;

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [langCode, setLangCode] = useAppLangCode();

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  const [collabAPI] = useAtom(collabAPIAtom);

  useHandleLibrary({
    excalidrawAPI,
    adapter: LibraryIndexedDBAdapter,
    // TODO maybe remove this in several months (shipped: 24-03-11)
    migrationAdapter: LibraryLocalStorageMigrationAdapter,
  });

  // ---------------------------------------------------------------------------
  // Hoisted loadImages
  // ---------------------------------------------------------------------------
  const loadImages = useCallback(
    (data: ResolutionType<typeof initializeScene>, isInitialLoad = false) => {
      if (!data.scene || !excalidrawAPI) {
        return;
      }

      if (collabAPI?.isCollaborating()) {
        if (data.scene.elements) {
          collabAPI
            .fetchImageFilesFromFirebase({
              elements: data.scene.elements,
              forceFetchFiles: true,
            })
            .then(({ loadedFiles, erroredFiles }) => {
              excalidrawAPI.addFiles(loadedFiles);
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
        }
      } else {
        const fileIds =
          data.scene.elements?.reduce((acc, element) => {
            if (isInitializedImageElement(element)) {
              return acc.concat(element.fileId);
            }
            return acc;
          }, [] as FileId[]) || [];

        if (data.isExternalScene) {
          if (fileIds.length) {
            // Direct Firebase call (not through FileManager), so track manually
            FileStatusStore.updateStatuses(
              fileIds.map((id) => [id, "loading"]),
            );
          }
          loadFilesFromFirebase(
            `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
            data.key,
            fileIds,
          ).then(({ loadedFiles, erroredFiles }) => {
            excalidrawAPI.addFiles(loadedFiles);
            updateStaleImageStatuses({
              excalidrawAPI,
              erroredFiles,
              elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
            });
            FileStatusStore.updateStatuses([
              ...loadedFiles.map((f) => [f.id, "loaded"] as [FileId, "loaded"]),
              ...[...erroredFiles.keys()].map(
                (id) => [id, "error"] as [FileId, "error"],
              ),
            ]);
          });
        } else if (isInitialLoad) {
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(async ({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
          // on fresh load, clear unused files from IDB (from previous
          // session)
          LocalData.fileStorage.clearObsoleteFiles({
            currentFileIds: fileIds,
          });
        }
      }
    },
    [collabAPI, excalidrawAPI],
  );

  useEffect(() => {
    if (!excalidrawAPI || (!isCollabDisabled && !collabAPI)) {
      return;
    }

    initializeScene({ collabAPI, excalidrawAPI }).then(async (data) => {
      loadImages(data, /* isInitialLoad */ true);
      initialStatePromiseRef.current.promise.resolve(data.scene);
    });

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault();
      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (!libraryUrlTokens) {
        if (
          collabAPI?.isCollaborating() &&
          !isCollaborationLink(window.location.href)
        ) {
          collabAPI.stopCollaboration(false);
        }
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        initializeScene({ collabAPI, excalidrawAPI }).then((data) => {
          loadImages(data);
          if (data.scene) {
            excalidrawAPI.updateScene({
              elements: restoreElements(data.scene.elements, null, {
                repairBindings: true,
              }),
              appState: restoreAppState(data.scene.appState, null),
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
          }
        });
      }
    };

    const syncData = debounce(() => {
      if (isTestEnv()) {
        return;
      }
      if (
        !document.hidden &&
        ((collabAPI && !collabAPI.isCollaborating()) || isCollabDisabled)
      ) {
        // don't sync if local state is newer or identical to browser state
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const localDataState = importFromLocalStorage();
          const username = importUsernameFromLocalStorage();
          setLangCode(getPreferredLanguage());
          excalidrawAPI.updateScene({
            ...localDataState,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          LibraryIndexedDBAdapter.load().then((data) => {
            if (data) {
              excalidrawAPI.updateLibrary({
                libraryItems: data.libraryItems,
              });
            }
          });
          collabAPI?.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles = excalidrawAPI.getFiles();
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId);
              }
              return acc;
            }, [] as FileId[]) || [];
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    const onUnload = () => {
      LocalData.flushSave();
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
        LocalData.flushSave();
      }
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false);
    window.addEventListener(EVENT.PAGE_HIDE, onUnload, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
      window.removeEventListener(EVENT.PAGE_HIDE, onUnload, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
    };
  }, [isCollabDisabled, collabAPI, excalidrawAPI, setLangCode, loadImages]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      LocalData.flushSave();

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
          preventUnload(event);
        } else {
          console.warn(
            "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
          );
        }
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements);
    }

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (excalidrawAPI) {
          let didChange = false;

          const elements = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const newElement = newElementWith(element, { status: "saved" });
                if (newElement !== element) {
                  didChange = true;
                }
                return newElement;
              }
              return element;
            });

          if (didChange) {
            excalidrawAPI.updateScene({
              elements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        }
      });
    }
  };

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    );
  };

  const localStorageQuotaExceeded = useAtomValue(localStorageQuotaExceededAtom);

  // ---------------------------------------------------------------------------
  // onExport — intercepts file save to wait for pending image loads
  // ---------------------------------------------------------------------------
  const onExport: Required<ExcalidrawProps>["onExport"] = useCallback(
    async function* () {
      let snapshot = FileStatusStore.getSnapshot();
      const { pending, total } = FileStatusStore.getPendingCount(
        snapshot.value,
      );
      if (pending === 0) {
        return;
      }

      // Yield initial progress
      yield {
        type: "progress",
        progress: (total - pending) / total,
        message: `Loading images (${total - pending}/${total})...`,
      };

      // Wait for all pending images to finish
      while (true) {
        snapshot = await FileStatusStore.pull(snapshot.version);
        const { pending: nowPending, total: nowTotal } =
          FileStatusStore.getPendingCount(snapshot.value);

        yield {
          type: "progress",
          progress: (nowTotal - nowPending) / nowTotal,
          message: `Loading images (${nowTotal - nowPending}/${nowTotal})...`,
        };

        if (nowPending === 0) {
          await new Promise((r) => setTimeout(r, 500));
          yield {
            type: "progress",
            message: `Preparing export...`,
          };
          return;
        }
      }
    },
    [],
  );

  // const onExport = () => {
  //   return new Promise((r) => setTimeout(r, 2500));
  //   // console.log("onExport");
  // };

  // browsers generally prevent infinite self-embedding, there are
  // cases where it still happens, and while we disallow self-embedding
  // by not whitelisting our own origin, this serves as an additional guard
  if (isSelfEmbedding) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          height: "100%",
        }}
      >
        <h1>I'm not a pretzel!</h1>
      </div>
    );
  }

  return (
    <div style={{ height: "100%" }} className="excalidraw-app">
      <Excalidraw
        onChange={onChange}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {},
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        theme={editorTheme}
        onThemeChange={setAppTheme}
        onLinkOpen={(element, event) => {
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            excalidrawAPI?.setViewport({
              target: element.link,
              fit: "scale-down",
              animation: true,
            });
          }
        }}
      >
        <AppMainMenu theme={appTheme} />
        <AppWelcomeScreen />
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
        </OverwriteConfirmDialog>
        {localStorageQuotaExceeded && (
          <div className="alert alert--danger">
            {t("alerts.localStorageQuotaExceeded")}
          </div>
        )}
        <CommandPalette
          customCommandPaletteItems={[
            {
              label: t("labels.installPWA"),
              category: DEFAULT_CATEGORIES.app,
              predicate: () => !!pwaEvent,
              perform: () => {
                if (pwaEvent) {
                  pwaEvent.prompt();
                  pwaEvent.userChoice.then(() => {
                    // event cannot be reused, but we'll hopefully
                    // grab new one as the event should be fired again
                    pwaEvent = null;
                  });
                }
              },
            },
          ]}
        />
      </Excalidraw>
      {excalidrawAPI ? (
        <CanvasToolDock excalidrawAPI={excalidrawAPI} theme={editorTheme} />
      ) : null}
    </div>
  );
};

const ExcalidrawApp = () => {
  return (
    <TopErrorBoundary>
      <Provider store={appJotaiStore}>
        <ExcalidrawAPIProvider>
          <ExcalidrawWrapper />
        </ExcalidrawAPIProvider>
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
