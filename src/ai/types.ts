/** All supported AI action types */
export type ActionType =
  | 'click'
  | 'type'
  | 'select'
  | 'navigate'
  | 'upload'
  | 'hover'
  | 'wait'
  | 'scroll'
  | 'switchFrame'
  | 'switchPage'
  | 'closePage'
  | 'dismiss'
  | 'assert'
  | 'keyboard'
  | 'keypress'
  | 'prompt'
  // API action types
  | 'api_call'
  | 'extract_csrf'
  | 'extract_value'
  // Capture a DOM value into a test variable
  | 'read'
  // Count elements matching a selector and store the result
  | 'count'
  // Search the full DOM for specific text, return matching elements with selectors
  | 'find'
  // Return the full DOM subtree for a given selector (expand collapsed content)
  | 'expand';

/** A single action returned by the AI */
export interface AIAction {
  action: ActionType;
  /** CSS selector for the target element */
  selector?: string;
  /** Text to type, option value to select, or condition to wait for */
  value?: string;
  /** URL to navigate to */
  url?: string;
  /** File path for upload actions */
  filePath?: string;
  /** Condition string for wait/assert actions */
  condition?: string;
  /** Expected value for assertion */
  expected?: string;
  /** Scroll direction */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** Scroll amount in pixels */
  amount?: number;
  /** Type of wait to perform */
  waitType?: 'selector' | 'hidden' | 'text' | 'url' | 'load' | 'duration' | 'count' | 'attribute' | 'navigation' | 'stable';
  /** Timeout in milliseconds for wait actions */
  timeout?: number;
  /** Keyboard key or shortcut (e.g. "Enter", "Control+a") */
  key?: string;
  /** Question to ask the user for prompt actions */
  question?: string;
  /** HTTP method for api_call actions (GET, POST, PUT, etc.) */
  method?: string;
  /**
   * Request body for api_call actions.
   * The AI provides this as a JSON-serialisable value.
   */
  body?: unknown;
  /**
   * Additional HTTP headers for api_call actions.
   * The AI includes auth headers as specified in the API context.
   */
  apiHeaders?: Record<string, string>;
  /**
   * Execution mode for api_call: 'browser' uses Playwright context.request (carries cookies),
   * 'standalone' uses native fetch. Defaults to 'standalone'.
   */
  apiMode?: 'browser' | 'standalone';
  /** CSS selector for extract_csrf actions (where to find the token) */
  source?: string;
  /** JSONPath-style path for extract_value actions (e.g. "data.0.id") */
  path?: string;
  /** Variable name to assign the extracted value to (for extract_value) */
  as?: string;
  /**
   * For "read" actions, the DOM attribute to capture (e.g. "href", "src", "value").
   * When omitted, falls back to the element's value (for form inputs) or textContent.
   * Use this when the displayed text differs from the underlying attribute — e.g.
   * search-result links where the visible URL is a stylised breadcrumb.
   */
  attribute?: string;
  /**
   * CSS selector identifying the <iframe> element in the main page that contains the target element.
   * When set, the action is executed inside that frame rather than the main page.
   * Omit for elements in the main page.
   */
  frame?: string;
  /**
   * Target page identifier for switchPage actions.
   * Can be a label ("main", "page:2"), a URL substring, or a title substring.
   */
  page?: string;
  /** Human-readable description of what this action does */
  description: string;
}

/** The structured response from the AI for a test step */
export interface AIResponse {
  actions: AIAction[];
  reasoning: string;
  /**
   * When true, the AI signals it needs a fresh snapshot before planning remaining actions.
   * The executor will re-evaluate after executing the returned actions.
   */
  needs_reeval?: boolean;
}

/** AI response for a branched (conditional) step evaluation */
export interface BranchedAIResponse {
  /** Which outcome label matched (e.g. "A", "B") or "waiting" */
  matched: string;
  /** Actions to execute for the matched outcome (empty if "waiting") */
  actions: AIAction[];
  reasoning: string;
  needs_reeval?: boolean;
}

/** Result of an AI assertion evaluation */
export interface AssertionEvaluation {
  pass: boolean;
  /** The actual value extracted from the page */
  actual: string;
  /** Explanation of why the assertion passed or failed */
  explanation: string;
}

/** A single content block in a multimodal message */
export type MessageContentBlock =
  | { type: 'text'; text: string; cache?: boolean }
  | { type: 'image_url'; image_url: { url: string }; cache?: boolean };

/** A message in the AI conversation */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MessageContentBlock[];
}

/** Request payload for /v2/vision */
export interface VisionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
}

/** Usage statistics from the API response */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

/** Provider-neutral content blocks returned by /v2 endpoints */
export type ResponseContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown }
  | { type: 'image'; source?: unknown };

/** Response from /v2/vision */
export interface VisionResponse {
  id: string;
  object: 'response';
  created: number;
  provider: string;
  model: string;
  role: string;
  stop_reason?: string | null;
  content: ResponseContentBlock[];
  usage?: TokenUsage;
}

/** Legacy v1 response, still parsed as a fallback during migration */
export interface LegacyVisionResponse {
  response?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: TokenUsage;
}

/** Legacy SSE chunk from /v1/stream, still parsed as a fallback during migration */
export interface LegacyStreamChunk {
  id?: string;
  choices: Array<{
    delta: {
      content?: string;
      role?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: TokenUsage;
}

export interface StreamResponseEnvelope {
  id: string;
  object: 'response';
  created: number;
  provider: string;
  model: string;
  role: string;
  stop_reason?: string | null;
  content: ResponseContentBlock[];
  usage?: TokenUsage;
}

export type StreamEvent =
  | {
      type: 'response.start';
      response: Pick<StreamResponseEnvelope, 'id' | 'object' | 'created' | 'provider' | 'model' | 'role'>;
    }
  | {
      type: 'response.content_block.delta';
      index: number;
      delta: {
        type: 'text_delta';
        text: string;
      };
    }
  | {
      type: 'response.completed';
      response: StreamResponseEnvelope;
    }
  | {
      type: 'response.error';
      error: {
        message: string;
        type?: string;
        provider?: string;
        code?: string;
      };
    };
