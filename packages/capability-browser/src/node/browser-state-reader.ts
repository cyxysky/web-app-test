import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { raceWithAbort } from '@webpilot/capability-sdk';
import type { BrowserActionResult, BrowserStateSnapshot } from './browser-session.js';
import type { BrowserPageObservation } from './browser-page-observation.js';

export type BrowserStateReadOptions = {
  abortSignal?: AbortSignal;
  maxOutputChars?: number;
  scope?: 'active' | 'all';
  frame?: string;
  selector?: string;
  query?: string;
  cursor?: string;
};
type Capture = { id: string; page: Page; revision: number; capturedAt: number; payload: BrowserStateSnapshot; criteria: Omit<BrowserStateReadOptions, 'abortSignal' | 'cursor'> };

/** Continuation pages belong to one immutable capture, never to a fresh, differently ordered tree. */
export class BrowserStateReader {
  private capture?: Capture;
  constructor(private readonly host: {
    page(): Page;
    revision(page: Page): number;
    framePath(frame: import('playwright').Frame): string;
    observation(): Promise<BrowserPageObservation>;
    tabs(): BrowserStateSnapshot['tabs'];
  }) {}

  clear() { this.capture = undefined; }

  async read(options: BrowserStateReadOptions = {}): Promise<BrowserActionResult> {
    try {
      options.abortSignal?.throwIfAborted();
      let offset = 0;
      let capture = this.capture;
      if (options.cursor) {
        let token: { id?: string; offset?: number };
        try { token = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')); }
        catch { throw new Error('Invalid state cursor. Read state without cursor to start a new capture.'); }
        if (!capture || token.id !== capture.id || !Number.isSafeInteger(token.offset) || token.offset! < 0
          || token.offset! > capture.payload.pageState.length || Date.now() - capture.capturedAt > 120_000
          || capture.page !== this.host.page() || capture.page.isClosed() || capture.payload.activePage.url !== capture.page.url()
          || capture.revision !== this.host.revision(capture.page)) {
          throw new Error('State cursor expired or its page navigated. Read state without cursor.');
        }
        for (const key of ['scope', 'frame', 'selector', 'query'] as const) {
          if (options[key] !== undefined && options[key] !== capture.criteria[key]) throw new Error('State continuation must keep the original scope/frame/selector/query.');
        }
        offset = token.offset!;
      } else {
        const page = this.host.page();
        const revision = this.host.revision(page);
        const [observation, title] = await raceWithAbort(Promise.all([this.host.observation(), page.title().catch(() => '')]), options.abortSignal);
        const allFrames = page.frames();
        const explicit = options.frame ? allFrames.find((frame) => this.host.framePath(frame) === options.frame) : undefined;
        if (options.frame && !explicit) throw new Error('Frame not found. Use an exact frame path from the page observation.');
        const active = allFrames.find((frame) => this.host.framePath(frame) === observation.activeSurface?.framePath) || page.mainFrame();
        const frames = explicit ? [explicit] : options.scope === 'all' ? allFrames : [active];
        const parts = [`[page-state] ${JSON.stringify(observation)}`];
        for (const frame of frames) {
          options.abortSignal?.throwIfAborted();
          let target = frame.locator(options.selector || 'body');
          if (!options.selector && options.scope !== 'all' && observation.activeSurface?.selector) {
            const surface = frame.locator(observation.activeSurface.selector).filter({ visible: true }).first();
            if (await surface.count().catch(() => 0)) target = surface;
          }
          const tree = await raceWithAbort(target.ariaSnapshot({ timeout: 5_000 }).catch(async (error) => {
            const text = await target.innerText({ timeout: 1_500 }).catch(() => '');
            if (!text && options.selector) throw error;
            return text ? `[text-fallback]\n${text}` : '[snapshot unavailable]';
          }), options.abortSignal);
          let lines = tree.split('\n');
          if (options.query) {
            const query = options.query.toLocaleLowerCase();
            const retained = new Set<number>();
            lines.forEach((line, index) => {
              if (line.toLocaleLowerCase().includes(query)) for (let i = Math.max(0, index - 2); i <= Math.min(lines.length - 1, index + 2); i++) retained.add(i);
            });
            lines = [...retained].sort((a, b) => a - b).map((index) => lines[index]);
          }
          parts.push(`[ax-tree frame=${this.host.framePath(frame)} scope=${options.selector || options.scope || 'active'}]`, lines.join('\n'));
          if (parts.reduce((sum, part) => sum + part.length, 0) > 2_000_000) throw new Error('State capture exceeds 2 million characters. Narrow frame, selector or query.');
        }
        if (page !== this.host.page() || revision !== this.host.revision(page)) throw new Error('Page navigated during capture. Read state again.');
        capture = { id: randomUUID(), page, revision, capturedAt: Date.now(), criteria: {
          scope: options.scope, frame: options.frame, selector: options.selector, query: options.query,
        }, payload: { tabs: this.host.tabs(), activePage: { url: page.url(), title }, pageState: parts.join('\n') } };
        this.capture = capture;
      }
      if (!capture) throw new Error('No state capture is available.');
      const budget = Math.min(200_000, Math.max(1_000, Math.floor(options.maxOutputChars ?? 40_000)));
      const source = capture.payload;
      let length = Math.min(source.pageState.length - offset, Math.max(1, budget - 800));
      const payload = { ...source,
        tabs: source.tabs.slice(0, 100).map((tab) => ({ ...tab, url: tab.url.slice(0, 500) })),
        activePage: { url: source.activePage.url.slice(0, 500), title: source.activePage.title.slice(0, 200) },
        pageState: '', truncated: false, nextCursor: undefined as string | undefined,
        snapshotId: capture.id, capturedAt: new Date(capture.capturedAt).toISOString(), offset,
        totalCharacters: source.pageState.length, tabsTruncated: source.tabs.length > 100,
      };
      const serialize = () => {
        payload.pageState = source.pageState.slice(offset, offset + length);
        payload.truncated = offset + length < source.pageState.length;
        payload.nextCursor = payload.truncated ? Buffer.from(JSON.stringify({ id: capture.id, offset: offset + length })).toString('base64url') : undefined;
        return JSON.stringify(payload);
      };
      let actual = serialize();
      while (actual.length > budget && payload.tabs.length) {
        payload.tabs = payload.tabs.slice(0, Math.floor(payload.tabs.length / 2)); payload.tabsTruncated = true; actual = serialize();
      }
      while (actual.length > budget && length > 1) { length = Math.max(1, Math.floor(length * 0.7)); actual = serialize(); }
      if (actual.length > budget) {
        payload.activePage = { url: source.activePage.url.slice(0, 100), title: source.activePage.title.slice(0, 60) };
        actual = serialize();
      }
      return { ok: true, actual, data: payload, summary: `Read browser state characters ${offset}-${offset + length} of ${source.pageState.length}.` };
    } catch (error) {
      return { ok: false, actual: error instanceof Error ? error.message : String(error), failureCategory: options.abortSignal?.aborted ? 'aborted' : 'browser-state-failed' };
    }
  }
}
