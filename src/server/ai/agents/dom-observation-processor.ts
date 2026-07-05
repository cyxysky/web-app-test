import { Worker } from 'node:worker_threads';

export type ProcessedDomObservation = {
  text: string;
  interactive: string;
  textCharLength: number;
  interactiveCharLength: number;
  domNodeCount: number;
  interactiveNodeCount: number;
  usedWorkers: boolean;
  errors: string[];
  timings: {
    totalMs: number;
    textWorkerMs?: number;
    interactiveWorkerMs?: number;
    textFallbackMs?: number;
    interactiveFallbackMs?: number;
  };
};

type WorkerTask = {
  kind: 'text' | 'interactive';
  domTree: string;
};

type WorkerResult = {
  kind: WorkerTask['kind'];
  text: string;
  domNodeCount: number;
  interactiveNodeCount: number;
  elapsedMs?: number;
};

const workerTimeoutMs = 8000;

function processDomSnapshot(task: WorkerTask): WorkerResult {
  const htmlEntityMap: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  const interactiveTags = new Set(['a', 'button', 'details', 'input', 'label', 'option', 'select', 'summary', 'textarea']);
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
  ]);
  const textAttributeNames = ['aria-label', 'alt', 'placeholder', 'title', 'value'];
  const interactiveAttributeNames = [
    'aria-label',
    'placeholder',
    'title',
    'role',
    'type',
    'name',
    'value',
    'href',
    'aria-expanded',
    'aria-pressed',
    'checked',
    'disabled',
    'readonly',
    'required',
    'selected',
    'contenteditable',
    'data-testid',
    'data-test',
    'data-qa',
    'data-cy',
  ];

  const decode = (value: string) => value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => htmlEntityMap[String(name).toLowerCase()] ?? match);
  const normalize = (value: string) => decode(String(value || '').replace(/\s+/g, ' ').trim());
  const unique = (values: string[]) => {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
      const text = normalize(value);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      output.push(text);
    }
    return output;
  };
  const parseAttributes = (raw: string) => {
    const attrs: Record<string, string> = {};
    const attrPattern = /([^\s=/>]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g;
    let match: RegExpExecArray | null;
    while ((match = attrPattern.exec(raw))) {
      const name = String(match[1] || '').toLowerCase();
      if (!name) continue;
      attrs[name] = normalize(match[2] ?? match[3] ?? match[4] ?? 'true');
    }
    return attrs;
  };
  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<!--')) return undefined;
    const match = trimmed.match(/^<([a-zA-Z0-9:-]+)\b([\s\S]*?)(?:\/>|>([\s\S]*)<\/\1>)$/);
    if (!match) return undefined;
    const tag = String(match[1] || '').toLowerCase();
    const attrs = parseAttributes(match[2] || '');
    const text = normalize(String(match[3] || '').replace(/<[^>]*>/g, ' '));
    const nodeId = attrs.node_id || attrs['data-node-id'] || '';
    return { attrs, nodeId, tag, text };
  };
  const isInteractive = (node: NonNullable<ReturnType<typeof parseLine>>) => {
    const role = String(node.attrs.role || '').toLowerCase();
    if (interactiveTags.has(node.tag) || interactiveRoles.has(role)) return true;
    if (node.attrs.href || node.attrs.contenteditable === 'true') return true;
    return Boolean(node.attrs['aria-expanded'] || node.attrs['aria-pressed'] || node.attrs.onclick);
  };
  const labelFor = (node: NonNullable<ReturnType<typeof parseLine>>) => unique([
    node.text,
    ...textAttributeNames.map((name) => node.attrs[name] || ''),
    node.attrs.name || '',
  ]).join(' | ');
  const stateFor = (node: NonNullable<ReturnType<typeof parseLine>>) => interactiveAttributeNames
    .map((name) => {
      const value = node.attrs[name];
      return value ? `${name}=${JSON.stringify(value)}` : '';
    })
    .filter(Boolean)
    .join(' ');

  const textLines: string[] = [];
  const interactiveLines: string[] = [];
  let domNodeCount = 0;
  let interactiveNodeCount = 0;

  for (const line of String(task.domTree || '').split(/\r?\n/)) {
    const node = parseLine(line);
    if (!node) continue;
    domNodeCount += 1;

    if (task.kind === 'text') {
      const text = labelFor(node);
      if (text) textLines.push(text);
      continue;
    }

    if (!isInteractive(node)) continue;
    interactiveNodeCount += 1;
    const label = labelFor(node) || '[unlabeled]';
    const state = stateFor(node);
    interactiveLines.push(`- node_id=${node.nodeId || '?'} <${node.tag}> "${label.slice(0, 180)}"${state ? ` (${state})` : ''}`);
  }

  if (task.kind === 'text') {
    return {
      kind: task.kind,
      text: unique(textLines).join('\n') || '[empty page text]',
      domNodeCount,
      interactiveNodeCount,
    };
  }

  return {
    kind: task.kind,
    text: interactiveLines.join('\n') || '[no interactive DOM nodes detected]',
    domNodeCount,
    interactiveNodeCount,
  };
}

function runDomWorker(task: WorkerTask) {
  return new Promise<WorkerResult>((resolve, reject) => {
    const startedAt = Date.now();
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const processDomSnapshot = ${processDomSnapshot.toString()};
      parentPort.postMessage(processDomSnapshot(workerData));
    `, { eval: true, workerData: task });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`DOM ${task.kind} worker timed out after ${workerTimeoutMs}ms`));
    }, workerTimeoutMs);
    worker.once('message', (result) => {
      clearTimeout(timeout);
      resolve({ ...(result as WorkerResult), elapsedMs: Date.now() - startedAt });
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    worker.once('exit', (code) => {
      if (code === 0) return;
      clearTimeout(timeout);
      reject(new Error(`DOM ${task.kind} worker exited with code ${code}`));
    });
  });
}

export async function processDomObservationInNode(domTree: string): Promise<ProcessedDomObservation> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const textTask: WorkerTask = { kind: 'text', domTree };
  const interactiveTask: WorkerTask = { kind: 'interactive', domTree };

  let textResult: WorkerResult;
  let interactiveResult: WorkerResult;
  let usedWorkers = true;
  let textFallbackMs: number | undefined;
  let interactiveFallbackMs: number | undefined;

  try {
    [textResult, interactiveResult] = await Promise.all([
      runDomWorker(textTask),
      runDomWorker(interactiveTask),
    ]);
  } catch (error) {
    usedWorkers = false;
    errors.push(error instanceof Error ? error.message : String(error));
    const textFallbackStartedAt = Date.now();
    textResult = processDomSnapshot(textTask);
    textFallbackMs = Date.now() - textFallbackStartedAt;
    const interactiveFallbackStartedAt = Date.now();
    interactiveResult = processDomSnapshot(interactiveTask);
    interactiveFallbackMs = Date.now() - interactiveFallbackStartedAt;
  }

  return {
    text: textResult.text,
    interactive: interactiveResult.text,
    textCharLength: textResult.text.length,
    interactiveCharLength: interactiveResult.text.length,
    domNodeCount: Math.max(textResult.domNodeCount, interactiveResult.domNodeCount),
    interactiveNodeCount: interactiveResult.interactiveNodeCount,
    usedWorkers,
    errors,
    timings: {
      totalMs: Date.now() - startedAt,
      textWorkerMs: textResult.elapsedMs,
      interactiveWorkerMs: interactiveResult.elapsedMs,
      textFallbackMs,
      interactiveFallbackMs,
    },
  };
}
