import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(120);
// Structured-output models frequently emit an empty string for an omitted
// optional identifier. Accept that representation at the schema boundary and
// let the planner normalize it to `undefined` before structural validation.
const optionalIdentifierSchema = z.string().trim().max(120).optional();
const conciseTextSchema = z.string().trim().min(1).max(500);

export const targetCriterionSchema = z.object({
  id: identifierSchema,
  description: z.string().trim().min(1).max(1_200),
  evidenceRequirement: z.string().trim().min(1).max(1_200),
});

export const targetPermissionExpectationSchema = z.object({
  id: identifierSchema,
  resource: conciseTextSchema,
  action: conciseTextSchema,
  expected: z.enum(['allow', 'deny', 'limited', 'unknown']),
  detail: z.string().trim().max(1_200).optional(),
  source: z.enum(['user', 'requirement', 'environment', 'ai_inference', 'unconfirmed']),
});

export const targetActorAuthSchema = z.object({
  required: z.boolean(),
  mode: z.enum(['none', 'manual', 'credentials', 'existing_session']),
  status: z.enum(['not_required', 'missing', 'awaiting_user', 'verifying', 'ready', 'failed']),
  loginUrl: z.string().trim().max(4_000).optional(),
  browserSessionId: z.string().trim().max(200).optional(),
  credentialsAvailable: z.boolean().optional(),
  message: z.string().trim().max(1_000).optional(),
});

export const targetActorSchema = z.object({
  id: identifierSchema,
  name: conciseTextSchema,
  role: conciseTextSchema,
  purpose: z.string().trim().min(1).max(1_200),
  auth: targetActorAuthSchema,
  permissions: z.array(targetPermissionExpectationSchema).max(40),
});

export const targetPlanningRequirementSchema = z.object({
  id: identifierSchema,
  category: z.enum(['environment', 'account', 'permission', 'test_data', 'file', 'constraint', 'confirmation', 'other']),
  title: conciseTextSchema,
  question: z.string().trim().min(1).max(1_200),
  required: z.boolean(),
  actorId: optionalIdentifierSchema,
  status: z.enum(['missing', 'resolved']),
  resolution: z.string().trim().max(2_000).optional(),
});

export const targetResourceSchema = z.object({
  key: z.string().trim().min(1).max(300),
  access: z.enum(['read', 'write']),
  description: z.string().trim().max(800).optional(),
});

export const targetSequenceNodeSchema = z.object({
  id: identifierSchema,
  type: z.literal('sequence'),
  title: conciseTextSchema,
  description: z.string().trim().max(1_200).optional(),
  relationReason: z.string().trim().min(1).max(1_200),
  children: z.array(identifierSchema).min(1).max(30),
  alwaysRun: z.boolean().optional(),
});

export const targetParallelNodeSchema = z.object({
  id: identifierSchema,
  type: z.literal('parallel'),
  title: conciseTextSchema,
  description: z.string().trim().max(1_200).optional(),
  relationReason: z.string().trim().min(1).max(1_200),
  children: z.array(identifierSchema).min(2).max(12),
  maxConcurrency: z.number().int().min(2).max(8).optional(),
});

export const targetLeafNodeSchema = z.object({
  id: identifierSchema,
  type: z.literal('target'),
  title: conciseTextSchema,
  objective: z.string().trim().min(1).max(2_000),
  actorId: optionalIdentifierSchema,
  preconditions: z.array(z.string().trim().min(1).max(800)).max(20),
  successCriteria: z.array(targetCriterionSchema).min(1).max(20),
  inputs: z.array(z.string().trim().min(1).max(800)).max(20),
  outputs: z.array(z.string().trim().min(1).max(800)).max(20),
  resources: z.array(targetResourceSchema).max(20),
});

export const targetFlowNodeSchema = z.discriminatedUnion('type', [
  targetSequenceNodeSchema,
  targetParallelNodeSchema,
  targetLeafNodeSchema,
]);

export const targetPlanSchema = z.object({
  id: identifierSchema,
  version: z.number().int().min(1),
  title: conciseTextSchema,
  requirementSummary: z.string().trim().min(1).max(4_000),
  targetUrl: z.string().trim().max(4_000).optional(),
  actors: z.array(targetActorSchema).max(20),
  requirements: z.array(targetPlanningRequirementSchema).max(40),
  // The collection phase intentionally has no executable flow. Defaults keep
  // the persisted shape stable while allowing structured-output models to omit
  // both fields until every required input and actor session is ready.
  rootNodeId: optionalIdentifierSchema.default(''),
  nodes: z.array(targetFlowNodeSchema).max(120).default([]),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(30),
  risks: z.array(z.string().trim().min(1).max(1_000)).max(30),
  analysisComplete: z.boolean(),
});

function omitNullObjectProperties(value: unknown): { changed: boolean; value: unknown } {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const normalized = omitNullObjectProperties(item);
      changed ||= normalized.changed;
      return normalized.value;
    });
    return { changed, value: items };
  }
  if (!value || typeof value !== 'object') return { changed: false, value };
  let changed = false;
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === null) {
      changed = true;
      continue;
    }
    const normalized = omitNullObjectProperties(item);
    changed ||= normalized.changed;
    entries.push([key, normalized.value]);
  }
  return { changed, value: Object.fromEntries(entries) };
}

/**
 * Repair the common structured-output representation `optionalField: null`.
 * Required null values remain invalid after omission because the strict runtime
 * schema will still require those fields on the SDK's second validation pass.
 */
export function repairNullableTargetPlanText(text: string) {
  try {
    const normalized = omitNullObjectProperties(JSON.parse(text));
    return normalized.changed ? JSON.stringify(normalized.value) : null;
  } catch {
    return null;
  }
}

export const targetCriterionResultSchema = z.object({
  criterionId: identifierSchema,
  status: z.enum(['passed', 'failed', 'inconclusive']),
  observation: z.string().trim().min(1).max(4_000),
  evidence: z.array(z.string().trim().min(1).max(4_000)).max(30),
});

export const targetResultSchema = z.object({
  targetId: identifierSchema,
  actorId: optionalIdentifierSchema,
  status: z.enum(['pending', 'running', 'passed', 'failed', 'inconclusive', 'blocked', 'cancelled']),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  summary: z.string().trim().max(4_000).optional(),
  failureReason: z.string().trim().max(4_000).optional(),
  blockedBy: z.array(identifierSchema).max(30).optional(),
  criteria: z.array(targetCriterionResultSchema).max(30),
  evidence: z.array(z.string().trim().min(1).max(4_000)).max(60),
  outputs: z.record(z.string(), z.unknown()),
  stepIndexes: z.array(z.number().int().nonnegative()).max(500).optional(),
});

export const targetWorkflowRunSchema = z.object({
  id: identifierSchema,
  ownerMessageId: optionalIdentifierSchema,
  status: z.enum([
    'analyzing',
    'collecting_requirements',
    'preparing_authentication',
    'awaiting_confirmation',
    'ready',
    'running',
    'summarizing',
    'completed',
    'failed',
    'cancelled',
  ]),
  plan: targetPlanSchema.optional(),
  results: z.record(z.string(), targetResultSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  confirmedAt: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  summary: z.string().trim().max(20_000).optional(),
  error: z.string().trim().max(4_000).optional(),
});

export type TargetActor = z.infer<typeof targetActorSchema>;
export type TargetFlowNode = z.infer<typeof targetFlowNodeSchema>;
export type TargetLeafNode = z.infer<typeof targetLeafNodeSchema>;
export type TargetParallelNode = z.infer<typeof targetParallelNodeSchema>;
export type TargetPlan = z.infer<typeof targetPlanSchema>;
export type TargetPlanningRequirement = z.infer<typeof targetPlanningRequirementSchema>;
export type TargetResult = z.infer<typeof targetResultSchema>;
export type TargetSequenceNode = z.infer<typeof targetSequenceNodeSchema>;
export type TargetWorkflowRun = z.infer<typeof targetWorkflowRunSchema>;

export function targetPlanNodeMap(plan: TargetPlan) {
  return new Map(plan.nodes.map((node) => [node.id, node]));
}

export function targetPlanLeafIds(plan: TargetPlan) {
  return plan.nodes.filter((node): node is TargetLeafNode => node.type === 'target').map((node) => node.id);
}

export function targetPlanIsReady(plan: TargetPlan) {
  return plan.analysisComplete
    && Boolean(plan.rootNodeId)
    && plan.nodes.length > 0
    && plan.requirements.every((item) => !item.required || item.status === 'resolved')
    && plan.actors.every((actor) => (
      (!actor.auth.required || actor.auth.status === 'ready')
      && actor.permissions.every((permission) => permission.expected !== 'unknown')
    ));
}

export function validateTargetPlanStructure(plan: TargetPlan) {
  const nodes = targetPlanNodeMap(plan);
  const errors: string[] = [];
  if (nodes.size !== plan.nodes.length) errors.push('Flow node ids must be unique.');
  const actorIds = new Set(plan.actors.map((actor) => actor.id));
  if (actorIds.size !== plan.actors.length) errors.push('Actor ids must be unique.');
  const requirementIds = new Set(plan.requirements.map((requirement) => requirement.id));
  if (requirementIds.size !== plan.requirements.length) errors.push('Planning requirement ids must be unique.');
  const missingRequiredRequirements = plan.requirements.filter((requirement) => requirement.required && requirement.status === 'missing');
  if (plan.analysisComplete && missingRequiredRequirements.length) {
    errors.push('analysisComplete cannot be true while required planning information is missing.');
  }
  if (!plan.analysisComplete && !missingRequiredRequirements.length) {
    errors.push('An incomplete analysis must expose at least one missing required planning requirement.');
  }
  const hasFlow = Boolean(plan.rootNodeId || plan.nodes.length);
  if (plan.analysisComplete) {
    if (!plan.rootNodeId) errors.push('A complete analysis must define rootNodeId.');
    if (!plan.nodes.length) errors.push('A complete analysis must define at least one flow node.');
  } else if (hasFlow) {
    errors.push('An incomplete analysis must only collect requirements and must not expose a flow tree.');
  }
  for (const requirement of plan.requirements) {
    if (requirement.actorId && !actorIds.has(requirement.actorId)) {
      errors.push(`Planning requirement ${requirement.id} references missing actor ${requirement.actorId}.`);
    }
    if (requirement.category === 'account' && !requirement.actorId) {
      errors.push(`Account requirement ${requirement.id} must reference an actor.`);
    }
  }
  for (const actor of plan.actors) {
    const permissionIds = new Set(actor.permissions.map((permission) => permission.id));
    if (permissionIds.size !== actor.permissions.length) errors.push(`Permission ids for actor ${actor.id} must be unique.`);
    if (actor.auth.required && actor.auth.mode === 'none') errors.push(`Actor ${actor.id} requires authentication but has auth mode none.`);
    if (actor.auth.required && actor.auth.status !== 'ready') {
      const hasMissingAccountRequirement = plan.requirements.some((requirement) => (
        requirement.required
        && requirement.status === 'missing'
        && requirement.category === 'account'
        && requirement.actorId === actor.id
      ));
      if (!hasMissingAccountRequirement) {
        errors.push(`Actor ${actor.id} must have an actor-bound missing account requirement until authentication is ready.`);
      }
    }
    for (const permission of actor.permissions) {
      if (permission.expected !== 'unknown') continue;
      const hasMissingConfirmation = plan.requirements.some((requirement) => (
        requirement.required
        && requirement.status === 'missing'
        && requirement.category === 'permission'
        && (!requirement.actorId || requirement.actorId === actor.id)
      ));
      if (!hasMissingConfirmation) {
        errors.push(`Unknown permission ${permission.id} for actor ${actor.id} must have a missing required permission requirement.`);
      }
    }
  }
  if (!hasFlow) return errors;
  if (!nodes.has(plan.rootNodeId)) errors.push(`Root node ${plan.rootNodeId} does not exist.`);
  const parents = new Map<string, string>();
  for (const node of plan.nodes) {
    if (node.type === 'target') {
      if (node.actorId && !actorIds.has(node.actorId)) errors.push(`Target ${node.id} references missing actor ${node.actorId}.`);
      const criterionIds = new Set(node.successCriteria.map((criterion) => criterion.id));
      if (criterionIds.size !== node.successCriteria.length) errors.push(`Success criterion ids for target ${node.id} must be unique.`);
      const resourceKeys = new Set(node.resources.map((resource) => resource.key));
      if (resourceKeys.size !== node.resources.length) errors.push(`Resource keys for target ${node.id} must be unique.`);
      continue;
    }
    if (new Set(node.children).size !== node.children.length) errors.push(`Node ${node.id} contains duplicate children.`);
    for (const childId of node.children) {
      if (!nodes.has(childId)) errors.push(`Node ${node.id} references missing child ${childId}.`);
      const previousParent = parents.get(childId);
      if (previousParent && previousParent !== node.id) errors.push(`Node ${childId} has more than one parent.`);
      parents.set(childId, node.id);
    }
  }
  if (parents.has(plan.rootNodeId)) errors.push('The root node cannot be a child of another node.');
  for (const node of plan.nodes) {
    if (node.id !== plan.rootNodeId && !parents.has(node.id)) errors.push(`Node ${node.id} is disconnected from the root.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string) => {
    if (visiting.has(nodeId)) {
      errors.push(`Flow contains a cycle at ${nodeId}.`);
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    const node = nodes.get(nodeId);
    if (node && node.type !== 'target') node.children.forEach(visit);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(plan.rootNodeId);
  for (const node of plan.nodes) {
    if (!visited.has(node.id)) errors.push(`Node ${node.id} is not reachable from the root.`);
  }

  const targetsBelow = (nodeId: string, seen = new Set<string>()): TargetLeafNode[] => {
    if (seen.has(nodeId)) return [];
    seen.add(nodeId);
    const node = nodes.get(nodeId);
    if (!node) return [];
    if (node.type === 'target') return [node];
    return node.children.flatMap((childId) => targetsBelow(childId, new Set(seen)));
  };
  for (const node of plan.nodes) {
    if (node.type !== 'parallel') continue;
    const branchTargets = node.children.map((childId) => targetsBelow(childId));
    for (let leftIndex = 0; leftIndex < branchTargets.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < branchTargets.length; rightIndex += 1) {
        const left = branchTargets[leftIndex];
        const right = branchTargets[rightIndex];
        const leftActors = new Set(left.map((target) => target.actorId).filter((actorId): actorId is string => Boolean(actorId)));
        const sharedActor = right.find((target) => target.actorId && leftActors.has(target.actorId));
        if (sharedActor?.actorId) {
          errors.push(`Parallel node ${node.id} reuses actor ${sharedActor.actorId} across branches; use sequence or separate actors.`);
        }
        const leftResources = new Map<string, 'read' | 'write'>();
        for (const target of left) {
          for (const resource of target.resources) {
            const key = resource.key.trim().toLowerCase();
            if (resource.access === 'write' || !leftResources.has(key)) leftResources.set(key, resource.access);
          }
        }
        for (const target of right) {
          for (const resource of target.resources) {
            const key = resource.key.trim().toLowerCase();
            const leftAccess = leftResources.get(key);
            if (leftAccess && (leftAccess === 'write' || resource.access === 'write')) {
              errors.push(`Parallel node ${node.id} has a conflicting ${key} resource across branches; use sequence or isolated test data.`);
            }
          }
        }
      }
    }
  }
  return errors;
}
