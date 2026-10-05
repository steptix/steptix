/**
 * Tests for the state-aware retry context builder and page state diagnosis types.
 */
import { describe, it, expect } from 'vitest';
import { buildRetryContext } from '../src/ai/prompts.js';
import type { PriorFailureContext, RetryDiagnostics } from '../src/ai/prompts.js';
import type { PageStateDiagnosis } from '../src/browser/page-state.js';

// ─── buildRetryContext — backward compatibility ─────────────────────────────

describe('buildRetryContext — backward compatibility (PriorFailureContext[])', () => {
  it('returns empty string for empty failures array', () => {
    expect(buildRetryContext([])).toBe('');
  });

  it('includes the failed action type and selector', () => {
    const failures: PriorFailureContext[] = [
      { selector: '#submit-btn', error: 'Timeout 10000ms exceeded', actionType: 'click' },
    ];
    const result = buildRetryContext(failures);
    expect(result).toContain('click');
    expect(result).toContain('#submit-btn');
    expect(result).toContain('Timeout 10000ms exceeded');
  });

  it('shows match count hint when no elements found', () => {
    const failures: PriorFailureContext[] = [
      { selector: '.missing', error: 'Element not found', matchCount: 0, actionType: 'click' },
    ];
    const result = buildRetryContext(failures);
    expect(result).toContain('No elements matched');
  });

  it('shows match count hint when multiple elements found', () => {
    const failures: PriorFailureContext[] = [
      { selector: '.btn', error: 'Wrong target', matchCount: 5, actionType: 'click' },
    ];
    const result = buildRetryContext(failures);
    expect(result).toContain('5 elements matched');
    expect(result).toContain('more specific selector');
  });

  it('defaults to attempt 2 when using array input', () => {
    const failures: PriorFailureContext[] = [
      { selector: '#x', error: 'fail', actionType: 'click' },
    ];
    const result = buildRetryContext(failures);
    expect(result).toContain('Retry Attempt 2');
  });

  it('lists failed selectors in instructions section', () => {
    const failures: PriorFailureContext[] = [
      { selector: '#btn-a', error: 'fail', actionType: 'click' },
      { selector: '#btn-b', error: 'fail', actionType: 'click' },
    ];
    const result = buildRetryContext(failures);
    expect(result).toContain('`#btn-a`');
    expect(result).toContain('`#btn-b`');
    expect(result).toContain('choose a different selector');
  });
});

// ─── buildRetryContext — RetryDiagnostics ────────────────────────────────────

describe('buildRetryContext — RetryDiagnostics', () => {
  const baseFailure: PriorFailureContext = {
    selector: '#submit',
    error: 'Element not found',
    matchCount: 0,
    actionType: 'click',
  };

  it('returns empty string when diagnostics has no failures', () => {
    const diagnostics: RetryDiagnostics = { failures: [], attemptNumber: 2 };
    expect(buildRetryContext(diagnostics)).toBe('');
  });

  it('uses the provided attempt number', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      attemptNumber: 3,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).toContain('Retry Attempt 3');
  });

  it('includes completed actions when present', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [{
        ...baseFailure,
        completedActions: [
          { action: 'click', description: 'Clicked the Login button' },
          { action: 'type', description: 'Typed email address' },
        ],
      }],
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).toContain('SUCCEEDED');
    expect(result).toContain('Clicked the Login button');
    expect(result).toContain('Typed email address');
    expect(result).toContain('FAILED');
  });

  it('includes navigation context when page navigated', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [{
        ...baseFailure,
        startUrl: 'https://app.com/login',
        failureUrl: 'https://app.com/dashboard',
        navigated: true,
      }],
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).toContain('Page state changed');
    expect(result).toContain('https://app.com/login');
    expect(result).toContain('https://app.com/dashboard');
    expect(result).toContain('partially succeeded');
  });

  it('omits navigation section when page did not navigate', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [{
        ...baseFailure,
        startUrl: 'https://app.com/login',
        failureUrl: 'https://app.com/login',
        navigated: false,
      }],
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).not.toContain('Page state changed');
  });

  it('handles failure without selector gracefully', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [{
        selector: '',
        error: 'Navigation timeout',
        actionType: 'navigate',
      }],
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).toContain('navigate');
    expect(result).toContain('Navigation timeout');
    // Should not list empty selector in failed selectors
    expect(result).not.toContain('Failed selectors');
  });
});

// ─── buildRetryContext — page state diagnosis ────────────────────────────────

describe('buildRetryContext — page state assessment', () => {
  const baseFailure: PriorFailureContext = {
    selector: '#btn',
    error: 'Timeout',
    actionType: 'click',
  };

  const cleanPageState: PageStateDiagnosis = {
    url: 'https://app.com/',
    title: 'App',
    isLoading: false,
    loadingIndicators: [],
    hasErrorOverlay: false,
    errorMessages: [],
    hasModal: false,
    documentLoading: false,
  };

  it('omits page state section when page is clean', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      pageState: cleanPageState,
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).not.toContain('Current page state assessment');
  });

  it('a loading page gets both the assessment and the wait instruction', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      pageState: {
        ...cleanPageState,
        isLoading: true,
        loadingIndicators: ['<div.spinner>', '<div.loading-overlay>'],
      },
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    // The assessment: what is on the page.
    expect(result).toContain('Current page state assessment');
    expect(result).toContain('Loading indicators are visible');
    expect(result).toContain('<div.spinner>');
    // The instruction: what to do about it.
    expect(result).toContain('Loading indicators are present');
    expect(result).toContain('"wait" action first');
  });

  it('includes error overlay info when detected', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      pageState: {
        ...cleanPageState,
        hasErrorOverlay: true,
        errorMessages: ['Session expired. Please log in again.'],
      },
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).toContain('Error overlay detected');
    expect(result).toContain('Session expired');
  });

  it('includes modal info when detected and dismissalGuidance is enabled', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      pageState: { ...cleanPageState, hasModal: true },
      attemptNumber: 2,
      dismissalGuidance: true,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).toContain('modal/dialog is currently visible');
    expect(result).toContain('dismiss');
  });

  it('omits modal dismissal hint when dismissalGuidance is disabled', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      pageState: { ...cleanPageState, hasModal: true },
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).not.toContain('modal/dialog is currently visible');
  });

  it('includes document loading state', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      pageState: { ...cleanPageState, documentLoading: true, isLoading: true },
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).toContain('document is still loading');
  });

  it('omits page state section when no pageState provided', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      attemptNumber: 2,
    };
    const result = buildRetryContext(diagnostics);
    expect(result).not.toContain('Current page state assessment');
  });
});

// ─── buildRetryContext — instruction numbering ───────────────────────────────

describe('buildRetryContext — instruction numbering', () => {
  const baseFailure: PriorFailureContext = {
    selector: '#btn',
    error: 'fail',
    actionType: 'click',
  };

  it('numbers instructions sequentially with no page state', () => {
    const result = buildRetryContext([baseFailure]);
    const instructionSection = result.split('Instructions for this retry')[1] ?? '';
    // Should have 1. LOOK, 2. If navigated, 3. Do NOT, 4. Failed selectors
    expect(instructionSection).toContain('1.');
    expect(instructionSection).toContain('2.');
    expect(instructionSection).toContain('3.');
    expect(instructionSection).toContain('4.');
  });

  it('numbers instructions sequentially with loading + modal state', () => {
    const diagnostics: RetryDiagnostics = {
      failures: [baseFailure],
      pageState: {
        url: 'https://app.com/',
        title: 'App',
        isLoading: true,
        loadingIndicators: ['<div.spinner>'],
        hasErrorOverlay: false,
        errorMessages: [],
        hasModal: true,
        documentLoading: false,
      },
      attemptNumber: 2,
      dismissalGuidance: true,
    };
    const result = buildRetryContext(diagnostics);
    const instructionSection = result.split('Instructions for this retry')[1] ?? '';
    // Should have 1. LOOK, 2. Loading, 3. Modal, 4. If navigated, 5. Do NOT, 6. Failed
    expect(instructionSection).toContain('1.');
    expect(instructionSection).toContain('2.');
    expect(instructionSection).toContain('3.');
    expect(instructionSection).toContain('4.');
    expect(instructionSection).toContain('5.');
    expect(instructionSection).toContain('6.');
  });
});
