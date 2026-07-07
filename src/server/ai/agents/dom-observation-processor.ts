import { Worker } from 'node:worker_threads';

export type ProcessedDomObservation = {
  elements: string;
  elementsCharLength: number;
  domNodeCount: number;
  interactiveNodeCount: number;
  usedWorkers: boolean;
  errors: string[];
  timings: {
    totalMs: number;
    elementsWorkerMs?: number;
    elementsFallbackMs?: number;
  };
};

type WorkerTask = {
  kind: 'elements';
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
  const decode = (value: string) => value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => htmlEntityMap[String(name).toLowerCase()] ?? match);
  const normalize = (value: string) => decode(String(value || '').replace(/\s+/g, ' ').trim());
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
    return node.attrs['data-ai-interactive'] === 'true';
  };
  const elementLines: string[] = [];
  let domNodeCount = 0;
  let interactiveNodeCount = 0;

  for (const line of String(task.domTree || '').split(/\r?\n/)) {
    const node = parseLine(line);
    if (!node) continue;
    domNodeCount += 1;
    if (isInteractive(node)) interactiveNodeCount += 1;
    elementLines.push(String(line || '').trimEnd());
  }

  return {
    kind: task.kind,
    text: elementLines.join('\n') || '[empty DOM elements]',
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
  const elementsTask: WorkerTask = { kind: 'elements', domTree };

  let elementsResult: WorkerResult;
  let usedWorkers = true;
  let elementsFallbackMs: number | undefined;

  try {
    elementsResult = await runDomWorker(elementsTask);
  } catch (error) {
    usedWorkers = false;
    errors.push(error instanceof Error ? error.message : String(error));
    const elementsFallbackStartedAt = Date.now();
    elementsResult = processDomSnapshot(elementsTask);
    elementsFallbackMs = Date.now() - elementsFallbackStartedAt;
  }

  return {
    elements: elementsResult.text,
    elementsCharLength: elementsResult.text.length,
    domNodeCount: elementsResult.domNodeCount,
    interactiveNodeCount: elementsResult.interactiveNodeCount,
    usedWorkers,
    errors,
    timings: {
      totalMs: Date.now() - startedAt,
      elementsWorkerMs: elementsResult.elapsedMs,
      elementsFallbackMs,
    },
  };
}
