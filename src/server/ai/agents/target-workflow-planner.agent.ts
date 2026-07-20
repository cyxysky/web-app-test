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
  type TargetResearchBundle,
} from '@/server/ai/schemas/target-workflow.schema';

export type TargetPlanningMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type TargetPlanningAccount = {
  id: string;
  domain: string;
  username: string;
  label?: string;
  loginUrl?: string;
};

type GenerateTargetPlanInput = {
  availableAccounts?: TargetPlanningAccount[];
  messages: TargetPlanningMessage[];
  currentPlan?: TargetPlan;
  research?: TargetResearchBundle;
  preferredLocale?: 'zh' | 'en';
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

function planningLocale(input: GenerateTargetPlanInput): 'zh' | 'en' {
  if (input.currentPlan?.locale) return input.currentPlan.locale;
  if (input.preferredLocale) return input.preferredLocale;
  const userText = input.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
  return /[\u3400-\u9fff]/u.test(userText) ? 'zh' : 'en';
}

function localeName(locale: 'zh' | 'en') {
  return locale === 'zh' ? '简体中文' : 'English';
}

function planningPrompt(input: GenerateTargetPlanInput, validationErrors: string[] = []) {
  const locale = planningLocale(input);
  const previousPlan = input.currentPlan ? JSON.stringify(input.currentPlan, null, 2) : '[none]';
  const conversation = input.messages
    .filter((message) => message.content.trim())
    .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content.trim()}`)
    .join('\n\n');
  const availableAccounts = (input.availableAccounts || []).map((account) => ({
    domain: account.domain,
    username: account.username,
    label: account.label || undefined,
    loginUrl: account.loginUrl || undefined,
  }));
  const research = input.research
    ? boundedText(JSON.stringify(input.research, null, 2), 80_000)
    : '[none]';
  return [
    '你是 WebPilot 的目标测试规划 Agent。当前阶段只能分析和规划，绝对不能操作浏览器。',
    '请先阅读完整对话并判断执行资料是否齐全。资料收集阶段只输出参与者和待补充清单；全部齐全后，才生成一棵由 sequence、parallel 和 target 组成的串并联流程树。流程树 JSON 使用扁平 nodes 数组，父节点的 children 保存子节点 id。',
    '',
    '规划规则：',
    `- 输出语言固定为 ${localeName(locale)}。所有用户可见的自然语言字段必须使用该语言，包括 title、requirementSummary、actor name/role/purpose、requirement title/question/resolution、assumptions、risks、node title/description/relationReason/objective、successCriteria 及 evidenceRequirement。JSON key、id、enum、URL、用户名和用户原文值保持原样；currentPlan、schema 与校验错误的语言都不能改变这一要求。`,
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
    '- 账号密码由后台按域名与用户名保存，目标卡片不直接填写密码。已有账号时只引用 domain + username；没有匹配账号时，account requirement 应引导用户点击目标卡片中的“新增账号”按钮。密码绝不能进入计划、对话或日志。',
    '- “后台已保存账号”只包含安全元数据。只有 domain 与 username 能唯一精确匹配时，才把它们分别写入 actor.auth.credentialDomain 与 actor.auth.username；不要输出或猜测 credentialId。匹配账号的 loginUrl 可作为 actor.auth.loginUrl。',
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
    '- 需求调研证据是规划事实的首要来源。已经在 research.facts 中确认的内容不得再次询问用户；research.unresolved、blocked 或 failed 来源中确实阻塞执行判断的内容才转为 missing requirement。',
    '- Axure 原型属于 PRD 证据来源。规划必须结合调研 Agent 实际读取到的页面树、页面说明、交互状态、图片和关联页面，不能仅根据 Axure 链接文字猜测需求。',
    '- 每条 successCriteria 的 sourceIds 必须引用支撑该标准的 research.sources[].id；如果该标准只来自用户明确补充，则 sourceIds 可以为空，并在 evidenceRequirement 中说明需要保存用户确认。',
    '- 仅在 analysisComplete=true 时 rootNodeId 才必须存在；完整树中除根节点外每个节点只能有一个父节点，不得有环或游离节点。资料收集阶段必须省略 rootNodeId。',
    '- 可选字段没有信息时直接省略；即使输出为 null，系统也会按“未提供”处理。',
    '',
    `当前目标地址：${input.targetUrl || '[未提供]'}`,
    '',
    `后台已保存账号（仅域名、用户名与标签，不含密码）：\n${availableAccounts.length ? JSON.stringify(availableAccounts, null, 2) : '[none]'}`,
    '',
    `当前计划（如有）：\n${previousPlan}`,
    '',
    `需求调研证据（由完整浏览器 Agent 实际读取）：\n${research}`,
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

function normalizedCredentialDomain(value?: string) {
  const text = (value || '').trim();
  if (!text) return '';
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return text.toLowerCase().replace(/^https?:\/\//, '').split(/[/:?#]/)[0];
  }
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
  const credentialDomain = normalizedCredentialDomain(actor.auth.credentialDomain || previous?.auth.credentialDomain || actor.auth.loginUrl);
  const username = actor.auth.username || previous?.auth.username;
  const nextAuth = {
    ...actor.auth,
    credentialDomain: credentialDomain || undefined,
    username: username || undefined,
  };
  const sameIdentity = previous
    && previous.name === actor.name
    && previous.role === actor.role
    && (previous.auth.loginUrl || '') === (actor.auth.loginUrl || previous.auth.loginUrl || '')
    && normalizedCredentialDomain(previous.auth.credentialDomain || previous.auth.loginUrl) === credentialDomain
    && (previous.auth.username || '') === (username || '');
  if (sameIdentity && (previous?.auth.status === 'ready'
    || previous?.auth.status === 'awaiting_user'
    || previous?.auth.status === 'verifying'
    || previous?.auth.status === 'failed')) {
    return {
      ...nextAuth,
      mode: previous.auth.status !== 'ready' && previous.auth.mode === 'manual'
        ? 'credentials' as const
        : previous.auth.mode,
      status: previous.auth.status,
      browserSessionId: previous.auth.browserSessionId,
      credentialId: previous.auth.credentialId,
      credentialsAvailable: previous.auth.credentialsAvailable,
      message: previous.auth.message,
    };
  }
  return {
    ...nextAuth,
    mode: actor.auth.mode === 'none' || actor.auth.mode === 'manual'
      ? 'credentials' as const
      : actor.auth.mode,
    status: 'missing' as const,
    browserSessionId: undefined,
    credentialsAvailable: false,
  };
}

function attachAvailableAccount(actor: TargetActor, input: GenerateTargetPlanInput): TargetActor {
  if (!actor.auth.required || actor.auth.status === 'ready') return actor;
  const domain = normalizedCredentialDomain(actor.auth.credentialDomain || actor.auth.loginUrl || input.targetUrl);
  if (!domain) return actor;
  const domainAccounts = (input.availableAccounts || []).filter((account) => (
    normalizedCredentialDomain(account.domain) === domain
  ));
  const requestedUsername = (actor.auth.username || '').trim().toLocaleLowerCase();
  const account = requestedUsername
    ? domainAccounts.find((item) => item.username.trim().toLocaleLowerCase() === requestedUsername)
    : domainAccounts.length === 1 ? domainAccounts[0] : undefined;
  if (!account) {
    return {
      ...actor,
      auth: {
        ...actor.auth,
        credentialDomain: domain,
        credentialId: undefined,
        credentialsAvailable: false,
      },
    };
  }
  return {
    ...actor,
    auth: {
      ...actor.auth,
      credentialDomain: account.domain,
      credentialId: account.id,
      credentialsAvailable: true,
      loginUrl: actor.auth.loginUrl || account.loginUrl,
      message: actor.auth.message || `已匹配后台保存的账号 ${account.username}。`,
      username: account.username,
    },
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
  const zh = plan.locale !== 'en';
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
              title: zh ? `${actor.name}的账号登录` : `${actor.name} account login`,
              required: true,
              status: 'resolved',
              resolution: zh
                ? `${actor.name}（${actor.role}）的账号会话已通过安全登录验证。`
                : `The account session for ${actor.name} (${actor.role}) passed secure login verification.`,
            }
          : {
              ...requirement,
              title: zh ? `${actor.name}的账号登录` : `${actor.name} account login`,
              required: true,
              question: actor.auth.credentialsAvailable
                ? zh
                  ? `已为“${actor.name}（${actor.role}）”匹配后台账号 ${actor.auth.username || ''}（${actor.auth.credentialDomain || ''}），开始执行时会通过安全引用登录。`
                  : `Saved account ${actor.auth.username || ''} (${actor.auth.credentialDomain || ''}) is matched for ${actor.name} (${actor.role}) and will be used through secure references.`
                : zh
                  ? `请在目标卡片中为“${actor.name}（${actor.role}）”选择已按域名保存的账号；若尚未保存，请点击“新增账号”。`
                  : `Choose a saved domain account for ${actor.name} (${actor.role}) in the target card, or click "Add account" if it has not been saved yet.`,
              status: 'missing',
              resolution: undefined,
            };
      }
      continue;
    }
    const requirement: TargetPlanningRequirement = {
      id: uniqueRequirementId(requirements, `requirement_account_${actor.id}`),
      category: 'account',
      title: zh ? `${actor.name}的账号登录` : `${actor.name} account login`,
      question: actor.auth.credentialsAvailable
        ? zh
          ? `已为“${actor.name}（${actor.role}）”匹配后台账号 ${actor.auth.username || ''}（${actor.auth.credentialDomain || ''}），开始执行时会通过安全引用登录。`
          : `Saved account ${actor.auth.username || ''} (${actor.auth.credentialDomain || ''}) is matched for ${actor.name} (${actor.role}) and will be used through secure references.`
        : zh
          ? `请在目标卡片中为“${actor.name}（${actor.role}）”选择已按域名保存的账号；若尚未保存，请点击“新增账号”。`
          : `Choose a saved domain account for ${actor.name} (${actor.role}) in the target card, or click "Add account" if it has not been saved yet.`,
      required: true,
      actorId: actor.id,
      status: actor.auth.status === 'ready' ? 'resolved' : 'missing',
      resolution: actor.auth.status === 'ready'
        ? zh
          ? `${actor.name}（${actor.role}）的账号会话已通过安全登录验证。`
          : `The account session for ${actor.name} (${actor.role}) passed secure login verification.`
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
  const zh = plan.locale !== 'en';
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
      .map((permission) => zh
        ? `- ${actor.name}（${actor.role}）：${permission.resource} / ${permission.action}`
        : `- ${actor.name} (${actor.role}): ${permission.resource} / ${permission.action}`)
  ));
  const requirement: TargetPlanningRequirement = {
    id: uniqueRequirementId(plan.requirements),
    category: 'permission',
    title: zh ? '确认待定的账号权限' : 'Confirm unresolved account permissions',
    question: boundedText(
      zh
        ? `以下权限预期尚不明确，请确认应当允许、禁止还是有限允许：\n${permissionLines.join('\n')}`
        : `The following permission expectations are unclear. Confirm whether each should be allowed, denied, or limited:\n${permissionLines.join('\n')}`,
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
          title: boundedText(zh ? `${previous.title}及待定权限确认` : `${previous.title} and unresolved permissions`, maxRequirementTitleLength),
          question: boundedText(
            zh
              ? `${requirement.question}\n\n其他待补充信息：${previous.question}`
              : `${requirement.question}\n\nOther missing information: ${previous.question}`,
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
  const locale = planningLocale(input);
  const researchSourceIds = new Set((input.research?.sources || []).map((source) => source.id));
  const normalizedAccounts = normalizeAccountRequirements({
    ...plan,
    id: input.currentPlan?.id || plan.id || `plan_${randomUUID()}`,
    version: (input.currentPlan?.version || 0) + 1,
    locale,
    targetUrl: plan.targetUrl || input.targetUrl || undefined,
    actors: plan.actors.map((actor) => attachAvailableAccount({
      ...actor,
      auth: preservedActorAuth(actor, input.currentPlan),
    }, input)),
    requirements: plan.requirements.map((requirement) => ({
      ...requirement,
      actorId: requirement.actorId || undefined,
    })),
    rootNodeId: plan.rootNodeId || '',
    nodes: plan.nodes.map((node) => (
      node.type === 'target'
        ? {
            ...node,
            actorId: node.actorId || undefined,
            successCriteria: node.successCriteria.map((criterion) => ({
              ...criterion,
              sourceIds: (criterion.sourceIds || []).filter((sourceId) => researchSourceIds.has(sourceId)),
            })),
          }
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

function validateTargetPlanResearchCitations(plan: TargetPlan, research?: TargetResearchBundle) {
  if (!research?.sources.length) return [];
  const sourceIds = new Set(research.sources.map((source) => source.id));
  return plan.nodes.flatMap((node) => node.type === 'target'
    ? node.successCriteria.flatMap((criterion) => (criterion.sourceIds || [])
      .filter((sourceId) => !sourceIds.has(sourceId))
      .map((sourceId) => `Success criterion ${criterion.id} references missing research source ${sourceId}.`))
    : []);
}

function validateTargetPlanLocale(plan: TargetPlan, locale: 'zh' | 'en') {
  if (locale !== 'zh') return [];
  const errors: string[] = [];
  if (!/[\u3400-\u9fff]/u.test(plan.requirementSummary)) {
    errors.push('requirementSummary must use Simplified Chinese because the user is speaking Chinese.');
  }
  for (const requirement of plan.requirements) {
    if (requirement.status !== 'missing') continue;
    if (!/[\u3400-\u9fff]/u.test(`${requirement.title}\n${requirement.question}`)) {
      errors.push(`Missing requirement ${requirement.id} title and question must use Simplified Chinese.`);
    }
  }
  return errors;
}

async function generate(input: GenerateTargetPlanInput, validationErrors: string[] = []) {
  try {
    const result = await generateObject({
      model: getModel(),
      schema: targetPlanSchema,
      schemaName: 'target_workflow_plan',
      schemaDescription: `目标测试的参与者、前置需求与串并联流程树。所有用户可见自然语言字段必须使用 ${localeName(planningLocale(input))}；可选字段允许省略或为 null。`,
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
  const locale = planningLocale(input);
  const firstErrors = [
    ...validateTargetPlanStructure(first),
    ...validateTargetPlanLocale(first, locale),
    ...validateTargetPlanResearchCitations(first, input.research),
  ];
  input.onValidation?.({ attempt: 'initial', errors: firstErrors });
  if (!firstErrors.length) return first;
  const repaired = await generate({ ...input, currentPlan: first }, firstErrors);
  const repairedErrors = [
    ...validateTargetPlanStructure(repaired),
    ...validateTargetPlanLocale(repaired, locale),
    ...validateTargetPlanResearchCitations(repaired, input.research),
  ];
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
  if (plan.locale === 'en') {
    const lines = [plan.analysisComplete
      ? `Target analysis version ${plan.version} is ready: ${targetCount} test targets, ${sequenceCount} sequence nodes, and ${parallelCount} parallel nodes.`
      : `Execution-data analysis version ${plan.version} is ready. The flow tree will be generated after all required information and account sessions are available.`,
    ];
    if (unresolved.length) lines.push(`${unresolved.length} required items are still missing. Review the checklist in the target plan and reply directly in the conversation.`);
    if (pendingActors.length) lines.push(`${pendingActors.length} account sessions still need preparation; each account uses an isolated browser identity.`);
    if (!unresolved.length && !pendingActors.length) lines.push('All information and account sessions are ready. Review the flow tree and confirm execution.');
    return lines.join('\n\n');
  }
  const lines = [plan.analysisComplete
    ? `已完成第 ${plan.version} 版目标分析：共 ${targetCount} 个测试目标，包含 ${sequenceCount} 个串联节点和 ${parallelCount} 个并联节点。`
    : `已完成第 ${plan.version} 版执行资料分析；流程树会在所需资料和账号会话全部齐全后生成。`,
  ];
  if (unresolved.length) lines.push(`开始执行前还需要补充 ${unresolved.length} 项需求信息，请查看目标计划中的缺失清单，并直接在对话中回复。`);
  if (pendingActors.length) lines.push(`还需要准备 ${pendingActors.length} 个账号会话；每个账号会使用独立浏览器身份。`);
  if (!unresolved.length && !pendingActors.length) lines.push('所需信息与账号会话已经齐全，请检查流程树并确认开始执行。');
  return lines.join('\n\n');
}
