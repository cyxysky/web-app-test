import { randomUUID } from 'node:crypto';
import { generateObject, NoObjectGeneratedError } from 'ai';
import { getModel } from '@/server/ai/model';
import {
  repairNullableTargetPlanText,
  targetPlanSchema,
  validateTargetPlanStructure,
  type TargetActor,
  type TargetPlan,
  type TargetPlanningRequirement,
} from '@/server/ai/schemas/target-workflow.schema';

export type TargetPlanningMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type GenerateTargetPlanInput = {
  messages: TargetPlanningMessage[];
  currentPlan?: TargetPlan;
  targetUrl?: string;
  onValidation?: (event: {
    attempt: 'initial' | 'repair';
    errors: string[];
  }) => void;
};

const maxPlanningRequirements = 40;
const maxRequirementQuestionLength = 1_200;
const maxRequirementTitleLength = 500;

function boundedText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function planningPrompt(input: GenerateTargetPlanInput, validationErrors: string[] = []) {
  const previousPlan = input.currentPlan ? JSON.stringify(input.currentPlan, null, 2) : '[none]';
  const conversation = input.messages
    .filter((message) => message.content.trim())
    .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content.trim()}`)
    .join('\n\n');
  return [
    '你是 WebPilot 的目标测试规划 Agent。当前阶段只能分析和规划，绝对不能操作浏览器。',
    '请先阅读完整对话并判断执行资料是否齐全。资料收集阶段只输出参与者和待补充清单；全部齐全后，才生成一棵由 sequence、parallel 和 target 组成的串并联流程树。流程树 JSON 使用扁平 nodes 数组，父节点的 children 保存子节点 id。',
    '',
    '规划规则：',
    '- 串联或并联的业务语义由你判断。不要依靠固定业务规则，也不要为了提高并发而强行并联。',
    '- sequence 表示严格的先后关系；parallel 表示各分支在业务状态、账号会话和输入输出上可以独立推进。relationReason 必须解释判断依据。',
    '- 并联的每个 child 是一个完整分支；分支内部可以继续是 sequence、parallel 或 target。',
    '- 每个 target 都要用 resources 声明会读取或写入的账号外共享状态、业务数据、文件或配置；key 相同代表同一资源。纯浏览器页面状态不必声明。',
    '- parallel 的不同分支不得复用同一 actor，也不得对同一个 resource 形成读写或写写冲突。需要共享写入结果、同一账号或同一份测试数据时必须改为 sequence；确实独立时使用不同 actor 或唯一测试数据 key。',
    '- 先分析需要几个参与者、账号和权限角色。每个实际身份都建立独立 actor；同一角色需要两个账号时也要建立两个 actor。',
    '- currentPlan 已有参与者且身份、角色与登录入口没有变化时，必须保留原 actor id；只有真实身份发生变化时才能新增或替换 id，以便安全登录会话保持绑定。',
    '- 每个目标必须指定实际执行者 actorId（匿名目标可不指定），并给出可观察、可判定的 successCriteria 和 evidenceRequirement。',
    '- 仅打开、浏览或核对公开页面且不需要登录、账号角色或权限判断时，使用匿名目标：actors=[]、permissions=[]，target 不填写 actorId；绝对不要为这类需求虚构 actor、账号、角色或 permission。',
    '- 公开网页、公开直播间等可通过正常导航、站内搜索或搜索引擎发现时，网址未给出不构成阻塞信息，targetUrl 可以不填；应生成“搜索并打开官方或与描述匹配的页面”的匿名目标。例如“打开 yyf 直播间”不应仅因缺少精确 URL 而暂停。只有私有环境、指定系统、登录入口，或无法安全识别目标时，才要求用户提供 base/login URL。',
    '- 只有一个独立目标时可以直接让该 target 成为 rootNodeId，不要为了形式额外包装只有一个 child 的 sequence。',
    '- 权限预期必须来自用户、需求或环境。无法确定 allow/deny/limited 时写 unknown，并建立必填 permission requirement 要求用户确认，不能自行当成真相。',
    '- 缺少会阻止目标定位或判定的网址、账号角色、权限预期、测试数据、文件、约束或副作用授权时，建立 required=true、status=missing 的 requirement。',
    '- 用户在后续对话已经明确补充的内容，应写入 resolution 并设为 resolved。不要反复询问已经回答的问题。',
    '- 每个 account requirement 必须填写对应的 actorId；多个账号必须拆成多个 requirement，绝不能用一个未绑定参与者的“请提供所有账号”笼统代替。',
    '- 当前资料收集界面通过目标卡片为每个 actor 提供账号和密码，不要求用户选择登录方式，也不要引导用户打开手动登录；密码只经安全通道使用，绝不能进入计划内容。',
    '- 登录只是业务测试的前置条件时，通过 actor.auth 表达，不要创建“登录成功”测试目标；只有用户明确要测试登录功能时，登录才是 target。',
    '- 需要登录的 actor 应尽量给出明确的 http(s) loginUrl。登录地址未知且用户可能选择提供凭据时，建立必填 environment/account requirement 让用户补充；不能猜测登录域名。',
    '- actor.auth.status 只允许根据 currentPlan 中已有的运行时状态继承；不能因为用户说有账号就虚构 ready。新 actor 需要登录时使用 missing。',
    '- currentPlan 中 actor.auth.status=ready 表示该账号已通过安全通道登录验证。只能据此把相应 account requirement 标为 resolved，绝不能要求再次提供或输出账号密码明文。',
    '- 只要还有必填资料缺失，或任一需要登录的 actor 尚未 ready，就处于资料收集阶段：analysisComplete=false、nodes=[]，并省略 rootNodeId。此阶段只输出参与者、资料清单、假设和风险，绝对不要生成临时流程树。',
    '- 只有必填资料全部 resolved、所有需要登录的 actor 均 ready 后，才设置 analysisComplete=true 并生成完整 rootNodeId/nodes 流程树。',
    '- 管理员配置会改变后续验证依赖的系统状态时，必须把管理员配置放在 sequence 的前置步骤，后续使用者操作只能在配置成功后开始。',
    '- 三个使用者操作只有在确有三个独立 actor、三个独立登录会话，并且测试数据与写资源互不冲突时才能放入 parallel；账号或共享写数据不足时必须串行，或建立缺失的账号/测试数据 requirement。',
    '- 整个运行的最终结论由系统汇总 Agent 自动生成，不要创建只负责复述其他目标结果的“总结” target；只有确实需要再次操作浏览器核验业务状态时才创建最终核验 target。',
    '- 不生成重放步骤，也不把工具调用成功当作目标成功。',
    '- 仅在 analysisComplete=true 时 rootNodeId 才必须存在；完整树中除根节点外每个节点只能有一个父节点，不得有环或游离节点。资料收集阶段必须省略 rootNodeId。',
    '- 可选字段没有信息时直接省略；即使输出为 null，系统也会按“未提供”处理。',
    '',
    `当前目标地址：${input.targetUrl || '[未提供]'}`,
    '',
    `当前计划（如有）：\n${previousPlan}`,
    '',
    `完整需求对话：\n${conversation || '[空]'}`,
    validationErrors.length ? `\n上一次结构校验错误，请全部修复：\n- ${validationErrors.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
}

type PlanningValidationIssue = {
  message?: unknown;
  path?: unknown;
};

function planningValidationIssues(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const issues = (current as { issues?: unknown }).issues;
    if (Array.isArray(issues)) {
      return issues.slice(0, 8).map((issue) => {
        const normalized = issue && typeof issue === 'object' ? issue as PlanningValidationIssue : {};
        const path = Array.isArray(normalized.path)
          ? normalized.path.map((segment) => String(segment)).join('.')
          : '';
        const message = typeof normalized.message === 'string' && normalized.message.trim()
          ? normalized.message.trim()
          : '字段值不符合约束';
        return path ? `${path}：${message}` : message;
      });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return [];
}

function readableGenerationError(error: unknown) {
  if (!NoObjectGeneratedError.isInstance(error)) return error;
  const issues = planningValidationIssues(error);
  const message = issues.length
    ? `AI 返回的目标计划字段格式不符合约束：${issues.join('；')}`
    : 'AI 没有返回可解析的目标计划，请重新生成。';
  const wrapped = new Error(message);
  wrapped.name = 'TargetPlanGenerationError';
  Object.assign(wrapped, {
    cause: error,
    data: {
      finishReason: error.finishReason,
      validationIssues: issues,
    },
  });
  return wrapped;
}

function preservedActorAuth(actor: TargetActor, currentPlan?: TargetPlan) {
  if (!actor.auth.required) {
    return {
      ...actor.auth,
      mode: 'none' as const,
      status: 'not_required' as const,
      browserSessionId: undefined,
      credentialsAvailable: undefined,
    };
  }
  const previous = currentPlan?.actors.find((item) => item.id === actor.id);
  const sameIdentity = previous
    && previous.name === actor.name
    && previous.role === actor.role
    && (previous.auth.loginUrl || '') === (actor.auth.loginUrl || '');
  if (sameIdentity && (previous?.auth.status === 'ready'
    || previous?.auth.status === 'awaiting_user'
    || previous?.auth.status === 'verifying'
    || previous?.auth.status === 'failed')) {
    return {
      ...actor.auth,
      mode: previous.auth.status !== 'ready' && previous.auth.mode === 'manual'
        ? 'credentials' as const
        : previous.auth.mode,
      status: previous.auth.status,
      browserSessionId: previous.auth.browserSessionId,
      credentialsAvailable: previous.auth.credentialsAvailable,
      message: previous.auth.message,
    };
  }
  return {
    ...actor.auth,
    mode: actor.auth.mode === 'none' || actor.auth.mode === 'manual'
      ? 'credentials' as const
      : actor.auth.mode,
    status: 'missing' as const,
    browserSessionId: undefined,
    credentialsAvailable: false,
  };
}

function uniqueRequirementId(requirements: TargetPlanningRequirement[], requestedBase = 'requirement_unknown_permissions') {
  const ids = new Set(requirements.map((requirement) => requirement.id));
  const base = requestedBase.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100) || 'requirement';
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function actorMentionedByRequirement(requirement: TargetPlanningRequirement, actors: TargetActor[]) {
  const text = `${requirement.title}\n${requirement.question}`.toLocaleLowerCase();
  const matches = actors.filter((actor) => [actor.id, actor.name, actor.role]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter((value) => value.length >= 2)
    .some((value) => text.includes(value)));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Account preparation is actor-scoped at runtime. Models occasionally return a
 * single unbound account question for several identities, so split/bind it here
 * before structural validation. Credential values are never placed in the plan.
 */
function normalizeAccountRequirements(plan: TargetPlan) {
  const authActors = plan.actors.filter((actor) => actor.auth.required);
  const nonAccount = plan.requirements.filter((requirement) => requirement.category !== 'account');
  const boundAccount: TargetPlanningRequirement[] = [];
  for (const requirement of plan.requirements.filter((item) => item.category === 'account')) {
    const existingActor = requirement.actorId
      ? authActors.find((actor) => actor.id === requirement.actorId)
      : undefined;
    const inferredActor = existingActor
      || actorMentionedByRequirement(requirement, authActors)
      || (authActors.length === 1 ? authActors[0] : undefined);
    if (inferredActor) {
      boundAccount.push({ ...requirement, actorId: inferredActor.id });
      continue;
    }
    // A combined account question is expanded into one question per actor. If
    // the model did not create any actor, leave it unbound so validation asks
    // the repair pass to create the missing identity instead of guessing one.
    if (!authActors.length) {
      boundAccount.push(requirement);
      continue;
    }
    for (const actor of authActors) {
      boundAccount.push({
        ...requirement,
        id: uniqueRequirementId([...nonAccount, ...boundAccount], `${requirement.id}_${actor.id}`),
        actorId: actor.id,
        title: boundedText(`${actor.name}：${requirement.title}`, maxRequirementTitleLength),
      });
    }
  }

  const requirements = [...nonAccount, ...boundAccount];
  for (const actor of authActors) {
    const indexes = requirements
      .map((requirement, index) => ({ requirement, index }))
      .filter(({ requirement }) => requirement.category === 'account' && requirement.actorId === actor.id)
      .map(({ index }) => index);
    if (indexes.length) {
      for (const index of indexes) {
        const requirement = requirements[index];
        requirements[index] = actor.auth.status === 'ready'
          ? {
              ...requirement,
              required: true,
              status: 'resolved',
              resolution: `${actor.name}（${actor.role}）的账号会话已通过安全登录验证。`,
            }
          : {
              ...requirement,
              required: true,
              question: `请在目标卡片中输入“${actor.name}（${actor.role}）”的账号和密码；密码仅用于安全登录，不会进入对话、日志或持久化存储。`,
              status: 'missing',
              resolution: undefined,
            };
      }
      continue;
    }
    const requirement: TargetPlanningRequirement = {
      id: uniqueRequirementId(requirements, `requirement_account_${actor.id}`),
      category: 'account',
      title: `${actor.name}的账号登录`,
      question: `请在目标卡片中输入“${actor.name}（${actor.role}）”的账号和密码；密码仅用于安全登录，不会进入对话、日志或持久化存储。`,
      required: true,
      actorId: actor.id,
      status: actor.auth.status === 'ready' ? 'resolved' : 'missing',
      resolution: actor.auth.status === 'ready'
        ? `${actor.name}（${actor.role}）的账号会话已通过安全登录验证。`
        : undefined,
    };
    if (requirements.length < maxPlanningRequirements) requirements.push(requirement);
    else {
      const replaceIndex = requirements.findIndex((item) => !item.required || item.status === 'resolved');
      if (replaceIndex >= 0) requirements[replaceIndex] = requirement;
    }
  }
  return { ...plan, requirements: requirements.slice(0, maxPlanningRequirements) };
}

function unknownPermissionRequirement(plan: TargetPlan) {
  const actorsNeedingConfirmation = plan.actors.filter((actor) => (
    actor.permissions.some((permission) => permission.expected === 'unknown')
    && !plan.requirements.some((requirement) => (
      requirement.required
      && requirement.status === 'missing'
      && requirement.category === 'permission'
      && (!requirement.actorId || requirement.actorId === actor.id)
    ))
  ));
  if (!actorsNeedingConfirmation.length) return plan;

  const permissionLines = actorsNeedingConfirmation.flatMap((actor) => (
    actor.permissions
      .filter((permission) => permission.expected === 'unknown')
      .map((permission) => `- ${actor.name}（${actor.role}）：${permission.resource} / ${permission.action}`)
  ));
  const requirement: TargetPlanningRequirement = {
    id: uniqueRequirementId(plan.requirements),
    category: 'permission',
    title: '确认待定的账号权限',
    question: boundedText(
      `以下权限预期尚不明确，请确认应当允许、禁止还是有限允许：\n${permissionLines.join('\n')}`,
      maxRequirementQuestionLength,
    ),
    required: true,
    status: 'missing',
  };
  const requirements = [...plan.requirements];
  if (requirements.length < maxPlanningRequirements) {
    requirements.push(requirement);
  } else {
    // The model schema already caps requirements at 40. Keep the plan valid by
    // merging the synthesized permission question into the least disruptive slot.
    const replaceIndex = requirements.findIndex((item) => !item.required || item.status === 'resolved');
    const fallbackIndex = requirements.findIndex((item) => item.status === 'missing' && !item.actorId);
    const index = replaceIndex >= 0 ? replaceIndex : fallbackIndex >= 0 ? fallbackIndex : requirements.length - 1;
    const previous = requirements[index];
    requirements[index] = previous.required && previous.status === 'missing'
      ? {
          ...requirement,
          id: previous.id,
          title: boundedText(`${previous.title}及待定权限确认`, maxRequirementTitleLength),
          question: boundedText(
            `${requirement.question}\n\n其他待补充信息：${previous.question}`,
            maxRequirementQuestionLength,
          ),
        }
      : { ...requirement, id: previous.id };
  }
  return {
    ...plan,
    requirements,
    analysisComplete: false,
  };
}

function normalizePlan(plan: TargetPlan, input: GenerateTargetPlanInput): TargetPlan {
  const normalizedAccounts = normalizeAccountRequirements({
    ...plan,
    id: input.currentPlan?.id || plan.id || `plan_${randomUUID()}`,
    version: (input.currentPlan?.version || 0) + 1,
    targetUrl: plan.targetUrl || input.targetUrl || undefined,
    actors: plan.actors.map((actor) => ({
      ...actor,
      auth: preservedActorAuth(actor, input.currentPlan),
    })),
    requirements: plan.requirements.map((requirement) => ({
      ...requirement,
      actorId: requirement.actorId || undefined,
    })),
    rootNodeId: plan.rootNodeId || '',
    nodes: plan.nodes.map((node) => (
      node.type === 'target'
        ? { ...node, actorId: node.actorId || undefined }
        : node
    )),
  });
  const normalizedRequirements = unknownPermissionRequirement(normalizedAccounts);
  const collecting = normalizedRequirements.requirements.some((requirement) => (
    requirement.required && requirement.status === 'missing'
  )) || normalizedRequirements.actors.some((actor) => actor.auth.required && actor.auth.status !== 'ready');
  return collecting
    ? {
        ...normalizedRequirements,
        analysisComplete: false,
        rootNodeId: '',
        nodes: [],
      }
    : normalizedRequirements;
}

async function generate(input: GenerateTargetPlanInput, validationErrors: string[] = []) {
  try {
    const result = await generateObject({
      model: getModel(),
      schema: targetPlanSchema,
      schemaName: 'target_workflow_plan',
      schemaDescription: '目标测试的参与者、前置需求与串并联流程树。可选字段允许省略或为 null。',
      experimental_repairText: async ({ text }) => repairNullableTargetPlanText(text),
      temperature: 0.15,
      prompt: planningPrompt(input, validationErrors),
    });
    return normalizePlan(result.object, input);
  } catch (error) {
    throw readableGenerationError(error);
  }
}

export async function generateTargetWorkflowPlan(input: GenerateTargetPlanInput): Promise<TargetPlan> {
  const first = await generate(input);
  const firstErrors = validateTargetPlanStructure(first);
  input.onValidation?.({ attempt: 'initial', errors: firstErrors });
  if (!firstErrors.length) return first;
  const repaired = await generate({ ...input, currentPlan: first }, firstErrors);
  const repairedErrors = validateTargetPlanStructure(repaired);
  input.onValidation?.({ attempt: 'repair', errors: repairedErrors });
  if (repairedErrors.length) throw new Error(`AI 生成的目标流程树结构无效：${repairedErrors.join('；')}`);
  return repaired;
}

export function targetWorkflowPlanningReply(plan: TargetPlan) {
  const targetCount = plan.nodes.filter((node) => node.type === 'target').length;
  const sequenceCount = plan.nodes.filter((node) => node.type === 'sequence').length;
  const parallelCount = plan.nodes.filter((node) => node.type === 'parallel').length;
  const unresolved = plan.requirements.filter((item) => item.required && item.status === 'missing');
  const pendingActors = plan.actors.filter((actor) => actor.auth.required && actor.auth.status !== 'ready');
  const lines = [plan.analysisComplete
    ? `已完成第 ${plan.version} 版目标分析：共 ${targetCount} 个测试目标，包含 ${sequenceCount} 个串联节点和 ${parallelCount} 个并联节点。`
    : `已完成第 ${plan.version} 版执行资料分析；流程树会在所需资料和账号会话全部齐全后生成。`,
  ];
  if (unresolved.length) lines.push(`开始执行前还需要补充 ${unresolved.length} 项需求信息，请在下方计划卡中查看并直接回复。`);
  if (pendingActors.length) lines.push(`还需要准备 ${pendingActors.length} 个账号会话；每个账号会使用独立浏览器身份。`);
  if (!unresolved.length && !pendingActors.length) lines.push('所需信息与账号会话已经齐全，请检查流程树并确认开始执行。');
  return lines.join('\n\n');
}
