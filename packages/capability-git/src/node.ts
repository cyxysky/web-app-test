import path from 'node:path';
import { runCapabilityProcess } from '@webpilot/capability-sdk/node';
import { createGitCapability, type GitOperations } from './index.js';
import type { CapabilityExecutionContext, CapabilityRunContext } from '@webpilot/capability-sdk';

function gitCommand(repository: string, args: string[], context: CapabilityExecutionContext, maximum: number, timeoutMs: number, stdin?: string) {
  return runCapabilityProcess({ executable: 'git',
    args: ['-c', `safe.directory=${repository.replace(/\\/g, '/')}`, '-C', repository, ...args],
    signal: context.abortSignal, maxOutputChars: maximum, timeoutMs, stdin });
}
function safePaths(paths: string[] | undefined) {
  return (paths || []).map((value) => {
    if (path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`Git path must stay inside the repository: ${value}.`);
    return value;
  });
}
function safeRef(ref?: string) {
  if (ref && (ref.startsWith('-') || /[\x00-\x1f\x7f]/.test(ref))) throw new Error('Git ref must be a revision, not an option.');
  return ref;
}
export function createNodeGitOperations(input: { repository: string }): GitOperations {
  const repository = path.resolve(input.repository);
  return {
    async run(request, context) {
      context.abortSignal?.throwIfAborted();
      const paths = safePaths(request.paths);
      const ref = safeRef(request.ref);
      let args: string[];
      let stdin: string | undefined;
      if (request.action === 'status') args = ['status', '--short', '--branch'];
      else if (request.action === 'branches') args = ['branch', '--all', '--no-color'];
      else if (request.action === 'log') args = ['log', '--oneline', '--decorate', '-n', '50', '--end-of-options', ...(ref ? [ref] : []), '--', ...paths];
      else if (request.action === 'show') args = ['show', '--no-ext-diff', '--no-textconv', '--stat', '--format=fuller', '--end-of-options', ref || 'HEAD', '--', ...paths];
      else if (request.action === 'diff') args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--end-of-options', ...(ref ? [ref] : []), '--', ...paths];
      else if (request.action === 'applyPatch') { args = ['apply', '--whitespace=nowarn', '-']; stdin = request.patch; }
      else {
        if (!paths.length || !request.message) throw new Error('Commit requires a message and explicit paths.');
        await gitCommand(repository, ['add', '--', ...paths], context, request.maxOutputChars, request.timeoutMs);
        args = ['commit', '-m', request.message, '--', ...paths];
      }
      return { repository, ...await gitCommand(repository, args, context, request.maxOutputChars, request.timeoutMs, stdin) };
    },
    async health() {
      try { await gitCommand(repository, ['rev-parse', '--is-inside-work-tree'], { invocationId: 'health' }, 1000, 10_000); return { status: 'healthy' }; }
      catch (error) { return { status: 'unhealthy', message: error instanceof Error ? error.message : String(error) }; }
    },
  };
}
export function createNodeGitCapability(input: { repository: string | ((context: CapabilityRunContext) => string) }) {
  return createGitCapability({ createOperations(context) {
    return createNodeGitOperations({ repository: typeof input.repository === 'function' ? input.repository(context) : input.repository });
  } });
}
