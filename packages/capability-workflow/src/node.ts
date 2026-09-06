import { randomUUID } from 'node:crypto';
import { createCapabilityDocumentDatabase } from '@webpilot/capability-sdk/node';
import { createWorkflowCapability, validateDag, type AgentWorkflow, type WorkflowStepStatus, type WorkflowStore } from './index.js';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';

const transitions: Record<WorkflowStepStatus, readonly WorkflowStepStatus[]> = {
  pending: ['in_progress', 'completed', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: [],
};

export function createFileWorkflowStore(input: { directory: string }): WorkflowStore {
  const store = createCapabilityDocumentDatabase<AgentWorkflow>({
    directory: input.directory, filename: 'workflows.db', legacyFilename: 'workflows.json',
    readLegacy(value) {
      const file = value as { version?: number; workflows?: AgentWorkflow[] };
      if (file.version !== 1 || !Array.isArray(file.workflows)) throw new Error('Invalid legacy workflow store.');
      return file.workflows;
    },
  });
  function getRequired(id: string) {
    const workflow = store.get(id);
    if (!workflow) throw new Error(`Unknown workflow: ${id}.`);
    return workflow;
  }
  return {
    async create(candidate) {
      validateDag(candidate.steps);
      if (!candidate.steps.length) throw new Error('A workflow requires at least one step.');
      const now = new Date().toISOString();
      const workflow: AgentWorkflow = { ...candidate, id: randomUUID(), status: 'active', createdAt: now, updatedAt: now,
        steps: candidate.steps.map((step) => ({ ...step, status: 'pending', updatedAt: now })) };
      store.transaction(() => store.save(workflow));
      return workflow;
    },
    async get(id) { return store.get(id); },
    async list(limit, status) {
      const db = store.database();
      const rows = status
        ? db.prepare("SELECT record_json FROM records WHERE json_extract(record_json, '$.status')=? ORDER BY updated_at DESC, id DESC LIMIT ?").all(status, limit)
        : db.prepare('SELECT record_json FROM records ORDER BY updated_at DESC, id DESC LIMIT ?').all(limit);
      return rows.map((row) => JSON.parse(String(row.record_json)) as AgentWorkflow);
    },
    async updateStep(workflowId, stepId, patch) {
      return store.transaction(() => {
        const workflow = getRequired(workflowId);
        const step = workflow.steps.find((item) => item.id === stepId);
        if (!step) throw new Error(`Unknown workflow step: ${stepId}.`);
        if (step.status === patch.status && (patch.output === undefined || patch.output === step.output)) return workflow;
        if (workflow.status !== 'active') throw new Error(`Workflow ${workflowId} is terminal (${workflow.status}). Create a new workflow to retry.`);
        if (!transitions[step.status].includes(patch.status)) throw new Error(`Invalid step transition: ${step.status} -> ${patch.status}.`);
        if (patch.status === 'in_progress' || patch.status === 'completed') {
          const incomplete = step.dependsOn.filter((id) => workflow.steps.find((item) => item.id === id)?.status !== 'completed');
          if (incomplete.length) throw new Error(`Step ${stepId} has incomplete dependencies: ${incomplete.join(', ')}.`);
        }
        step.status = patch.status;
        if (patch.output !== undefined) step.output = patch.output;
        workflow.updatedAt = step.updatedAt = new Date().toISOString();
        workflow.status = workflow.steps.every((item) => item.status === 'completed') ? 'completed'
          : workflow.steps.some((item) => item.status === 'failed') ? 'failed'
          : workflow.steps.every((item) => item.status === 'completed' || item.status === 'cancelled') ? 'cancelled' : 'active';
        store.save(workflow);
        return workflow;
      });
    },
    async cancel(id) {
      return store.transaction(() => {
        const workflow = getRequired(id);
        if (workflow.status === 'cancelled') return workflow;
        if (workflow.status !== 'active') throw new Error(`Workflow ${id} is already ${workflow.status}.`);
        workflow.status = 'cancelled';
        workflow.updatedAt = new Date().toISOString();
        for (const step of workflow.steps) if (step.status === 'pending' || step.status === 'in_progress') {
          step.status = 'cancelled'; step.updatedAt = workflow.updatedAt;
        }
        store.save(workflow);
        return workflow;
      });
    },
    async health() {
      try { store.database(); return { status: 'healthy' }; }
      catch (error) { return { status: 'unhealthy', message: error instanceof Error ? error.message : String(error) }; }
    },
    dispose: store.dispose,
  };
}
export function createNodeWorkflowCapability(input: { directory: string | ((context: CapabilityRunContext) => string) }) {
  return createWorkflowCapability({ createStore(context) {
    return createFileWorkflowStore({ directory: typeof input.directory === 'function' ? input.directory(context) : input.directory });
  } });
}
