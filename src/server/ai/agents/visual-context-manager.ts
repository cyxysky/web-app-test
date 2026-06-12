import type { VisualFrameRecord } from '@/server/ai/schemas/test-case.schema';

export type VisualAfterPolicy = {
  capture?: 'auto' | 'viewport' | 'fullPage';
  retention?: 'auto' | 'replace' | 'append';
  reason?: string;
};

function compact(value?: string, max = 120) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function basenameOfPath(value?: string) {
  return value ? value.split(/[\\/]/).filter(Boolean).at(-1) || value : '';
}

export class VisualContextManager {
  private frames: VisualFrameRecord[] = [];
  private currentId?: string;
  private sequence = 0;

  constructor(private readonly maxHistory = Number(process.env.AI_VISUAL_HISTORY_LIMIT || 6)) {}

  init(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>) {
    const record = this.createFrame(frame, 'current');
    this.frames = [record];
    this.currentId = record.id;
    return record;
  }

  apply(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>, policy: VisualAfterPolicy) {
    const retention = policy.retention === 'append' ? 'append' : 'replace';
    if (retention === 'append') {
      this.demoteCurrent();
      const record = this.createFrame(frame, 'current');
      this.frames.push(record);
      this.currentId = record.id;
      this.trim();
      return record;
    }

    this.demoteCurrent();
    const record = this.createFrame(frame, 'current');
    this.frames = [...this.frames.filter((item) => item.role === 'pinned'), record];
    this.currentId = record.id;
    this.trim();
    return record;
  }

  manage(action: 'clearHistory' | 'keepLatestOnly' | 'pinCurrent' | 'compressScrollSequence', reason: string) {
    if (action === 'clearHistory') {
      this.frames = this.frames.filter((frame) => frame.id === this.currentId || frame.role === 'pinned');
    } else if (action === 'keepLatestOnly') {
      this.frames = this.frames.filter((frame) => frame.id === this.currentId);
    } else if (action === 'pinCurrent') {
      this.frames = this.frames.map((frame) => frame.id === this.currentId ? { ...frame, role: 'pinned', reason } : frame);
    } else if (action === 'compressScrollSequence') {
      const scrollFrames = this.frames.filter((frame) => frame.group === 'scroll-sequence' && frame.id !== this.currentId);
      const keep = new Set(scrollFrames.slice(-2).map((frame) => frame.id));
      this.frames = this.frames.filter((frame) => frame.group !== 'scroll-sequence' || frame.id === this.currentId || keep.has(frame.id) || frame.role === 'pinned');
    }
    this.trim();
  }

  compressForBudget(reason: string) {
    const beforeCount = this.frames.length;
    const current = this.current();
    const historyLimit = Math.max(0, Number(process.env.AI_VISUAL_COMPRESSED_HISTORY_LIMIT || 2));
    const pinnedLimit = Math.max(0, Number(process.env.AI_VISUAL_COMPRESSED_PINNED_LIMIT || 2));
    const keep = new Map<string, VisualFrameRecord>();

    for (const frame of this.frames.filter((item) => item.role !== 'pinned' && item.id !== this.currentId).slice(-historyLimit)) {
      keep.set(frame.id, { ...frame, reason: frame.reason || reason });
    }
    for (const frame of this.frames.filter((item) => item.role === 'pinned').slice(-pinnedLimit)) {
      keep.set(frame.id, { ...frame, reason: frame.reason || reason });
    }
    if (current) keep.set(current.id, { ...current, reason: current.reason || reason });

    this.frames = Array.from(keep.values());
    this.trim();
    return Math.max(0, beforeCount - this.frames.length);
  }

  current() {
    return this.frames.find((frame) => frame.id === this.currentId);
  }

  snapshot() {
    return {
      current: this.current(),
      history: this.frames.filter((frame) => frame.id !== this.currentId),
    };
  }

  renderText() {
    const current = this.current();
    const history = this.frames.filter((frame) => frame.id !== this.currentId);
    const frameSummary = (frame: VisualFrameRecord) => (
      `${frame.id} ${compact(frame.reason, 80)} image=${basenameOfPath(frame.path)}${frame.originalPath ? ` original=${basenameOfPath(frame.originalPath)}` : ''}${frame.markerPath ? ` marker=${basenameOfPath(frame.markerPath)}` : ''}${frame.capture ? ` capture=${frame.capture}` : ''}`
    );

    return [
      'Visual Context Manager:',
      `current: ${current ? frameSummary(current) : '[none]'}`,
      '- current is the only screenshot whose marker ids may be used for click, fill, hover, drag, or scroll targeting.',
      history.length
        ? `history is reference-only; never use its marker ids for actions:\n${history.map((frame) => `- ${frameSummary(frame)} role=${frame.role} group=${frame.group || '-'}`).join('\n')}`
        : 'history: [none]',
    ].join('\n');
  }

  imagePaths(historyLimit = Number(process.env.AI_VISUAL_ATTACHED_HISTORY_LIMIT || 0)) {
    const paths: string[] = [];
    const current = this.current();
    if (current) paths.push(current.path);
    if (current?.markerPath) paths.push(current.markerPath);
    const history = this.frames.filter((item) => item.id !== this.currentId).slice(-Math.max(0, historyLimit));
    for (const frame of history) {
      paths.push(frame.path);
      if (frame.markerPath) paths.push(frame.markerPath);
    }
    return paths;
  }

  private createFrame(frame: Omit<VisualFrameRecord, 'id' | 'role' | 'createdAt'>, role: VisualFrameRecord['role']) {
    this.sequence += 1;
    return {
      ...frame,
      id: `vf-${this.sequence}`,
      role,
      createdAt: new Date().toISOString(),
    };
  }

  private demoteCurrent() {
    this.frames = this.frames.map((frame) => frame.id === this.currentId && frame.role === 'current'
      ? { ...frame, role: 'history' }
      : frame);
  }

  private trim() {
    const pinned = this.frames.filter((frame) => frame.role === 'pinned');
    const current = this.current();
    const history = this.frames
      .filter((frame) => frame.role !== 'pinned' && frame.id !== this.currentId)
      .slice(-this.maxHistory);
    this.frames = [...history, ...pinned, ...(current ? [current] : [])];
  }
}
