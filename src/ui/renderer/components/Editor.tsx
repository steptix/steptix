import React, { useEffect, useRef, useMemo } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  gutter,
  GutterMarker,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { StateField, StateEffect } from '@codemirror/state';
import { RangeSet } from '@codemirror/state';
import type { TabInfo } from '../App';
import { useAppState, useAppDispatch } from '../App';
import { useIpcInvoke } from '../hooks/useIpc';

// ---------------------------------------------------------------------------
// Step line detection
// ---------------------------------------------------------------------------
const STEP_LINE_REGEX = /^\d+\.\s/;

function isStepLine(lineText: string): boolean {
  return STEP_LINE_REGEX.test(lineText.trim());
}

/**
 * Find all step line numbers in the document text.
 * Step lines are lines inside a ## Steps section matching /^\d+\./
 */
function findStepLines(doc: string): Map<number, number> {
  const lines = doc.split('\n');
  let inSteps = false;
  const stepMap = new Map<number, number>(); // lineNumber (1-based) → stepIndex (0-based)
  let stepIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+Steps/.test(line)) {
      inSteps = true;
      continue;
    }
    if (inSteps && /^##\s/.test(line) && !/^##\s+Steps/.test(line)) {
      inSteps = false;
      continue;
    }
    if (inSteps && isStepLine(line)) {
      stepMap.set(i + 1, stepIndex); // 1-based line → 0-based step index
      stepIndex++;
    }
  }
  return stepMap;
}

// ---------------------------------------------------------------------------
// Gutter markers
// ---------------------------------------------------------------------------
class BreakpointMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'gutter-marker-breakpoint';
    el.textContent = '\u25CF'; // ●
    return el;
  }
}

class PointerMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'gutter-marker-pointer';
    el.textContent = '\u2192'; // →
    return el;
  }
}

class PassedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'gutter-marker-passed';
    el.textContent = '\u2713'; // ✓
    return el;
  }
}

class FailedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'gutter-marker-failed';
    el.textContent = '\u2717'; // ✗
    return el;
  }
}

/** A step the run decided against: the untaken half of a chain, a loop body
 *  that never ran, an `[input:]` in an unattended run. Reading which way a
 *  decision went off the editor is the point of painting it at all. */
class SkippedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('span');
    el.className = 'gutter-marker-skipped';
    el.textContent = '−'; // −
    return el;
  }
}

const breakpointMarker = new BreakpointMarker();
const pointerMarker = new PointerMarker();
const passedMarker = new PassedMarker();
const failedMarker = new FailedMarker();
const skippedMarker = new SkippedMarker();

// ---------------------------------------------------------------------------
// State effects for updating markers
// ---------------------------------------------------------------------------
interface MarkerState {
  breakpoints: Set<number>; // step indices
  pointer: number | null; // step index
  results: Map<number, 'passed' | 'failed' | 'skipped'>; // step index → status
  stepLines: Map<number, number>; // lineNumber → stepIndex
}

const setMarkersEffect = StateEffect.define<MarkerState>();

const markerField = StateField.define<MarkerState>({
  create() {
    return {
      breakpoints: new Set(),
      pointer: null,
      results: new Map(),
      stepLines: new Map(),
    };
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMarkersEffect)) {
        return effect.value;
      }
    }
    return value;
  },
});

// ---------------------------------------------------------------------------
// Breakpoint gutter
// ---------------------------------------------------------------------------
function createBreakpointGutter(
  onToggle: (stepIndex: number) => void,
): Extension {
  return gutter({
    class: 'cm-breakpoint-gutter',
    markers(view) {
      const markers: Array<{ from: number; marker: GutterMarker }> = [];
      const state = view.state.field(markerField);

      for (const [lineNum, stepIdx] of state.stepLines) {
        if (lineNum > view.state.doc.lines) continue;
        const lineInfo = view.state.doc.line(lineNum);

        // Pointer takes priority over breakpoint
        if (state.pointer === stepIdx) {
          markers.push({ from: lineInfo.from, marker: pointerMarker });
        } else if (state.breakpoints.has(stepIdx)) {
          markers.push({ from: lineInfo.from, marker: breakpointMarker });
        }

        // Show result markers
        const result = state.results.get(stepIdx);
        if (result === 'passed') {
          markers.push({ from: lineInfo.from, marker: passedMarker });
        } else if (result === 'failed') {
          markers.push({ from: lineInfo.from, marker: failedMarker });
        } else if (result === 'skipped') {
          markers.push({ from: lineInfo.from, marker: skippedMarker });
        }
      }

      return RangeSet.of(
        markers.sort((a, b) => a.from - b.from).map((m) => m.marker.range(m.from)),
      );
    },
    domEventHandlers: {
      mousedown(view, line) {
        const state = view.state.field(markerField);
        const lineNum = view.state.doc.lineAt(line.from).number;
        const stepIdx = state.stepLines.get(lineNum);
        if (stepIdx !== undefined) {
          onToggle(stepIdx);
          return true;
        }
        return false;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Editor component
// ---------------------------------------------------------------------------
interface EditorProps {
  tab: TabInfo;
  tabIndex: number;
}

export function Editor({ tab, tabIndex }: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const state = useAppState();
  const dispatch = useAppDispatch();
  const invoke = useIpcInvoke();

  // Compute step lines from document content
  const stepLines = useMemo(() => findStepLines(tab.content), [tab.content]);

  // Compute results map from step outputs
  const resultMap = useMemo(() => {
    const map = new Map<number, 'passed' | 'failed' | 'skipped'>();
    for (const [idx, output] of state.stepOutputs) {
      if (output.status === 'passed' || output.status === 'failed' || output.status === 'skipped') {
        map.set(idx, output.status);
      }
    }
    return map;
  }, [state.stepOutputs]);

  const handleToggleBreakpoint = (stepIndex: number) => {
    dispatch({ type: 'TOGGLE_BREAKPOINT', stepIndex });
    // Also update breakpoints on the main process if running
    if (state.runState.status === 'running' || state.runState.status === 'paused') {
      const newBreakpoints = new Set(state.breakpoints);
      if (newBreakpoints.has(stepIndex)) {
        newBreakpoints.delete(stepIndex);
      } else {
        newBreakpoints.add(stepIndex);
      }
      invoke('runner:update-breakpoints', { breakpoints: Array.from(newBreakpoints) });
    }
  };

  // Initialize CodeMirror
  useEffect(() => {
    if (!containerRef.current) return;

    const onContentChange = EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) {
        const content = update.state.doc.toString();
        dispatch({ type: 'UPDATE_TAB_CONTENT', index: tabIndex, content });
      }
    });

    const editorState = EditorState.create({
      doc: tab.content,
      extensions: [
        lineNumbers(),
        history(),
        highlightSelectionMatches(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        markerField,
        createBreakpointGutter(handleToggleBreakpoint),
        onContentChange,
        EditorView.theme({
          '&': {
            height: '100%',
          },
          '.cm-scroller': {
            overflow: 'auto',
          },
        }),
      ],
    });

    const view = new EditorView({
      state: editorState,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only re-create when the tab file path changes (key handles this)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update markers when breakpoints, pointer, or results change
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: setMarkersEffect.of({
        breakpoints: state.breakpoints,
        pointer: state.currentStep,
        results: resultMap,
        stepLines,
      }),
    });
  }, [state.breakpoints, state.currentStep, resultMap, stepLines]);

  // Handle clicks on step lines to select them for the output panel
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const handler = EditorView.domEventHandlers({
      click(event, editorView) {
        const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const line = editorView.state.doc.lineAt(pos);
        const stepIdx = stepLines.get(line.number);
        if (stepIdx !== undefined) {
          dispatch({ type: 'SET_SELECTED_STEP', stepIndex: stepIdx });
        }
        return false;
      },
    });

    // We can't dynamically add extensions easily, so use a click listener on the container
    const containerHandler = (e: MouseEvent) => {
      const view = viewRef.current;
      if (!view) return;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos === null) return;
      const line = view.state.doc.lineAt(pos);
      const stepIdx = stepLines.get(line.number);
      if (stepIdx !== undefined) {
        dispatch({ type: 'SET_SELECTED_STEP', stepIndex: stepIdx });
      }
    };

    containerRef.current?.addEventListener('click', containerHandler);
    return () => {
      containerRef.current?.removeEventListener('click', containerHandler);
    };
  }, [stepLines, dispatch]);

  return <div ref={containerRef} className="editor-wrapper" />;
}
