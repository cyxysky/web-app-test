export type BrowserExecutionMode = 'default' | 'dom' | 'visual-markers';

export type ExecutionStrategy = {
  mode: BrowserExecutionMode;
  phase: string;
  initialState: string;
  nextStep: string;
  visualContextText: string;
  promptRules: string[];
};

export function strategyForBrowserMode(mode: string, browserChatMode = false): ExecutionStrategy {
  if (browserChatMode) {
    return {
      mode: normalizeMode(mode),
      phase: 'Browser chat turn; answer directly when current evidence is enough, otherwise use one browser tool.',
      initialState: 'No chat turn state summary yet; inspect the current live page before deciding.',
      nextStep: 'Satisfy the latest user message; do not use a tool when a Markdown answer is already supported by evidence.',
      visualContextText: '',
      promptRules: [
        'Answer directly when the current page evidence already satisfies the latest user message.',
        'If a tool is needed, use one concrete browser action or inspection and then stop when the user request is satisfied.',
      ],
    };
  }

  if (mode === 'dom') {
    return {
      mode: 'dom',
      phase: 'Entering DOM Agent Loop; prefer DOM/text evidence before visual scrolling.',
      initialState: 'No DOM state summary yet; use the current visible DOM snapshot, URL, focus, tabs, and scroll state.',
      nextStep: 'Use current visible DOM node_ids and getDomNodeText for the next missing goal; scroll and refresh getDomTree only when needed content is absent.',
      visualContextText: [
        'DOM Context Manager:',
        '- Current visible DOM snapshot, URL, focus, tabs, and scroll state in Runtime Context are authoritative.',
        '- No screenshot image is attached for DOM decisions.',
        '- Prefer getDomNodeText(id) for complete text under a returned DOM node before treating scrolling as the default read path.',
        '- If needed content/control is absent from the visible DOM snapshot, scroll the relevant area and call getDomTree again.',
      ].join('\n'),
      promptRules: [
        'DOM-first workflow: read the visible DOM tree, then getDomNodeText(id) for complete text under promising nodes.',
        'Use scrolling only when the DOM snapshot says the needed content/control is absent or virtualized.',
        'After any scroll or page-changing action, refresh getDomTree before using DOM node ids again.',
      ],
    };
  }

  if (mode === 'visual-markers') {
    return {
      mode: 'visual-markers',
      phase: 'Entering visual Agent Loop with marker ids; choose one tool from the current visual frame.',
      initialState: 'No visual marker state summary yet; inspect the current screenshot and marker map.',
      nextStep: 'Use the current screenshot marker ids to complete the next missing goal; never reuse historical marker ids.',
      visualContextText: '',
      promptRules: [
        'Current screenshot and marker map are the only actionable visual source.',
        'Use historical screenshots only for comparison or continuity; never use their marker ids.',
        'For long pages, use append visual retention only when comparing adjacent scroll positions matters.',
      ],
    };
  }

  return {
    mode: 'default',
    phase: 'Entering default Agent Loop; choose the most reliable browser tool for the next missing goal.',
    initialState: 'No page state summary yet; inspect the current page context and screenshot.',
    nextStep: 'Use the current page context and screenshot to complete the next missing goal.',
    visualContextText: '',
    promptRules: [
      'Choose the cheapest reliable tool for the next missing goal.',
      'Use DOM/text evidence when it is sufficient; use screenshots for visual-only state or layout evidence.',
    ],
  };
}

export function visualContextTextForStrategy(strategy: ExecutionStrategy, renderedVisualContext: string) {
  const strategyText = [
    'Execution strategy:',
    ...strategy.promptRules.map((rule) => `- ${rule}`),
  ].join('\n');
  const contextText = strategy.mode === 'dom' ? strategy.visualContextText : renderedVisualContext;
  return [strategyText, contextText].filter(Boolean).join('\n\n');
}

function normalizeMode(mode: string): BrowserExecutionMode {
  if (mode === 'dom' || mode === 'visual-markers') return mode;
  return 'default';
}
