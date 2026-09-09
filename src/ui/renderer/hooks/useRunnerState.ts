import { useState, useCallback } from 'react';
import { useIpcEvent } from './useIpc';
import type { RunState, StepOutput, PauseReason } from '../../ipc-types';

interface UseRunnerStateReturn {
  runState: RunState;
  stepOutputs: Map<number, StepOutput>;
  selectedStep: number | null;
  setSelectedStep: (step: number | null) => void;
  currentStep: number | null;
}

/**
 * Hook that manages the runner execution state by subscribing to IPC events.
 * This is a standalone hook that can be used independently of the App-level context.
 */
export function useRunnerState(): UseRunnerStateReturn {
  const [runState, setRunState] = useState<RunState>({ status: 'idle' });
  const [stepOutputs, setStepOutputs] = useState<Map<number, StepOutput>>(new Map());
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [currentStep, setCurrentStep] = useState<number | null>(null);

  useIpcEvent('runner:step-start', (data) => {
    setCurrentStep(data.stepIndex);
    setRunState({ status: 'running', currentStep: data.stepIndex });
    setStepOutputs((prev) => {
      const next = new Map(prev);
      next.set(data.stepIndex, {
        stepIndex: data.stepIndex,
        instruction: data.instruction,
        status: 'running',
        aiReasoning: '',
        aiInteractions: [],
        subActions: [],
        screenshots: [],
      });
      return next;
    });
  });

  useIpcEvent('runner:step-complete', (data) => {
    setStepOutputs((prev) => {
      const next = new Map(prev);
      const existing = next.get(data.stepIndex);
      if (existing) {
        next.set(data.stepIndex, {
          ...existing,
          status: data.status,
          durationMs: data.durationMs,
        });
      }
      return next;
    });
  });

  useIpcEvent('runner:subaction', (data) => {
    setStepOutputs((prev) => {
      const next = new Map(prev);
      const existing = next.get(data.stepIndex);
      if (existing) {
        next.set(data.stepIndex, {
          ...existing,
          subActions: [...existing.subActions, data.subAction],
        });
      }
      return next;
    });
  });

  useIpcEvent('runner:screenshot', (data) => {
    setStepOutputs((prev) => {
      const next = new Map(prev);
      const existing = next.get(data.stepIndex);
      if (existing) {
        next.set(data.stepIndex, {
          ...existing,
          screenshots: [...existing.screenshots, data.dataUrl],
        });
      }
      return next;
    });
  });

  useIpcEvent('runner:ai-reasoning', (data) => {
    setStepOutputs((prev) => {
      const next = new Map(prev);
      const existing = next.get(data.stepIndex);
      if (existing) {
        next.set(data.stepIndex, {
          ...existing,
          aiReasoning: existing.aiReasoning + data.text,
        });
      }
      return next;
    });
  });

  useIpcEvent('runner:paused', (data) => {
    setRunState({ status: 'paused', currentStep: data.stepIndex, reason: data.reason });
    setCurrentStep(data.stepIndex);
  });

  useIpcEvent('runner:resumed', () => {
    // Keep the current step; just update status
    setRunState((prev) => {
      const step = prev.status === 'paused' || prev.status === 'running' ? prev.currentStep : 0;
      return { status: 'running', currentStep: step };
    });
  });

  useIpcEvent('runner:complete', (data) => {
    setRunState({ status: 'complete', result: data.status });
    setCurrentStep(null);
  });

  useIpcEvent('runner:error', () => {
    setRunState({ status: 'complete', result: 'failed' });
  });

  return { runState, stepOutputs, selectedStep, setSelectedStep, currentStep };
}
