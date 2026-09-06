const bilingualConcepts = [
  ['open', 'visit', 'enter', 'navigate', '打开', '访问', '进入', '跳转'],
  ['search', 'find', 'lookup', 'query', '搜索', '查找', '查询', '检索'],
  ['create', 'add', 'new', '新增', '创建', '新建', '添加'],
  ['edit', 'update', 'modify', 'change', '编辑', '更新', '修改', '变更'],
  ['delete', 'remove', 'clear', '删除', '移除', '清除'],
  ['save', 'submit', 'confirm', '保存', '提交', '确认'],
  ['export', 'download', '导出', '下载'],
  ['import', 'upload', 'attach', '导入', '上传', '附件'],
  ['login', 'signin', 'sign in', 'authenticate', '登录', '登陆', '认证'],
  ['logout', 'signout', '退出登录', '注销'],
  ['browser', 'webpage', 'page', '浏览器', '网页', '页面'],
  ['tab', 'tabs', 'tabgroup', '标签页', '标签组', '页签'],
  ['skill', 'skills', '技能'],
  ['memory', 'memories', 'preference', '记忆', '偏好'],
  ['setting', 'settings', 'configuration', 'config', '设置', '配置'],
  ['customer', 'client', '客户'],
  ['project', '项目'],
  ['issue', 'ticket', 'bug', '问题', '工单', '缺陷'],
  ['contract', 'agreement', '合同', '协议'],
  ['order', 'purchase', '订单', '采购'],
  ['report', 'dashboard', '报表', '报告', '看板'],
  ['document', 'file', '文档', '文件'],
  ['spreadsheet', 'excel', 'sheet', '表格', '电子表格'],
  ['presentation', 'slides', 'ppt', '演示文稿', '幻灯片'],
  ['date', 'deadline', 'deliverydate', '日期', '截止日期', '交付日期'],
  ['status', 'state', '状态'],
  ['detail', 'details', '详情', '明细'],
  ['list', 'table', '列表', '清单'],
  ['filter', '筛选', '过滤'],
  ['sort', '排序'],
  ['click', 'press', '点击', '按下'],
  ['type', 'input', 'fill', '输入', '填写', '填充'],
  ['select', 'choose', 'pick', '选择', '选取'],
  ['copy', 'duplicate', '复制'],
  ['move', 'transfer', '移动', '转移'],
  ['refresh', 'reload', '刷新', '重新加载'],
  ['test', 'verify', 'validate', '测试', '验证', '校验'],
  ['error', 'failure', 'exception', '错误', '失败', '异常'],
  ['log', 'trace', '日志', '记录'],
  ['image', 'picture', 'screenshot', '图片', '图像', '截图'],
  ['user', 'employee', 'member', '用户', '员工', '成员'],
  ['department', 'team', '部门', '团队'],
] as const;

function textValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textValues);
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (value === undefined || value === null) return [];
  return [String(value)];
}

export function normalizeRetrievalText(value: unknown) {
  return textValues(value).join(' ')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function retrievalQueryTexts(value: unknown) {
  return Array.from(new Set(textValues(value).map(normalizeRetrievalText).filter(Boolean)));
}

function compact(value: string) {
  return value.replace(/\s+/g, '');
}

function grams(value: string) {
  const source = compact(value);
  if (source.length < 2) return source ? new Set([source]) : new Set<string>();
  const result = new Set<string>();
  for (let index = 0; index < source.length - 1; index += 1) result.add(source.slice(index, index + 2));
  return result;
}

function dice(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function wordTokens(value: string) {
  return new Set(value.split(' ').filter((token) => token.length >= 2));
}

function tokenCoverage(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return overlap / Math.min(left.size, right.size);
}

const normalizedBilingualConcepts = bilingualConcepts.map((terms) => (
  terms.map((term) => normalizeRetrievalText(term))
));

function conceptIds(value: string) {
  const source = normalizeRetrievalText(value);
  const sourceCompact = compact(source);
  const sourceTokens = new Set(source.split(' '));
  const result = new Set<number>();
  normalizedBilingualConcepts.forEach((terms, index) => {
    if (terms.some((term) => (/^[a-z0-9 ]+$/.test(term)
      ? term.includes(' ') ? source.includes(term) : sourceTokens.has(term)
      : sourceCompact.includes(compact(term))))) result.add(index);
  });
  return result;
}

const genericTerms = new Set(['open', 'search', 'create', 'edit', 'delete', 'save', 'export', 'import',
  'browser', 'setting', 'detail', 'list', 'filter', 'sort', 'click', 'type', 'select', 'copy', 'move', 'refresh', 'test']);
const generic = new Set(normalizedBilingualConcepts.flatMap((terms, index) => genericTerms.has(terms[0]) ? [index] : []));

function withoutGeneric(value: string) {
  let result = ` ${value} `;
  for (const index of generic) for (const term of normalizedBilingualConcepts[index]) {
    result = /^[a-z0-9 ]+$/.test(term)
      ? result.replaceAll(` ${term} `, ' ')
      : result.replaceAll(term, '');
  }
  return result.trim();
}

function pairScore(query: string, candidate: string) {
  const queryCompact = compact(query);
  const candidateCompact = compact(candidate);
  if (!queryCompact || !candidateCompact) return 0;
  if (queryCompact === candidateCompact) return 1;
  if (withoutGeneric(query) && queryCompact.length >= 2 && candidateCompact.includes(queryCompact)) return 0.98;
  if (withoutGeneric(candidate) && candidateCompact.length >= 2 && queryCompact.includes(candidateCompact)) return 0.94;

  const queryConcepts = conceptIds(query);
  const candidateConcepts = conceptIds(candidate);
  // A shared action ("open", "edit") is not a shared task. Compare the
  // specific concepts and remaining entities as well, in either language.
  const shared = [...queryConcepts].filter((concept) => candidateConcepts.has(concept));
  const specificShared = shared.filter((concept) => !generic.has(concept));
  const conceptScore = specificShared.length
    ? 0.55 + 0.35 * shared.length / Math.max(queryConcepts.size, candidateConcepts.size, 1)
    : shared.length ? 0.18 : 0;

  const tokenScore = tokenCoverage(wordTokens(query), wordTokens(candidate));
  const gramScore = dice(grams(query), grams(candidate));
  // Remove shared generic vocabulary before allowing lexical overlap to win.
  const meaningfulQuery = withoutGeneric(query);
  const meaningfulCandidate = withoutGeneric(candidate);
  const lexicalScore = shared.length && !specificShared.length
    ? Math.max(tokenCoverage(wordTokens(meaningfulQuery), wordTokens(meaningfulCandidate)) * 0.9,
      dice(grams(meaningfulQuery), grams(meaningfulCandidate)) * 0.86)
    : Math.max(tokenScore * 0.9, gramScore * 0.86);
  return Math.max(conceptScore, lexicalScore);
}

export function fuzzyRetrievalScore(query: unknown, candidates: unknown[]) {
  const queries = retrievalQueryTexts(query);
  const candidateTexts = candidates.flatMap(retrievalQueryTexts);
  let best = 0;
  for (const queryText of queries) {
    for (const candidateText of candidateTexts) best = Math.max(best, pairScore(queryText, candidateText));
  }
  return best;
}
