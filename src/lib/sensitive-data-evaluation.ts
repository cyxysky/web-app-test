export const SENSITIVE_DATA_EVALUATION_CASE_LIMIT = 100;
export const SENSITIVE_DATA_EVALUATION_TEXT_LIMIT = 100_000;
export const SENSITIVE_DATA_EVALUATION_TOTAL_TEXT_LIMIT = 1_000_000;
export const SENSITIVE_DATA_EVALUATION_EXPECTED_VALUE_LIMIT = 100;

export type SensitiveDataEvaluationCase = {
  id: string;
  name: string;
  text: string;
  expectedValues: string[];
};

export type SensitiveDataEvaluationComparison = {
  passed: boolean;
  matchedValues: string[];
  missingValues: string[];
  unexpectedValues: string[];
};

export const DEFAULT_SENSITIVE_DATA_EVALUATION_CASES: SensitiveDataEvaluationCase[] = [
  {
    id: 'default-business-v2-sales-contract',
    name: '综合业务场景 · 销售合同与交付',
    text: [
      '【销售合同与交付记录】',
      '客户名称：星海零售；供应商：深圳齐治科技有限公司；采购产品：ACA云管平台。',
      '合同编号：HT-2026-008731；项目编号：PRJ-2026-0815；合同金额：人民币1,280.50万元。',
      '项目负责人：陈劲帆；职位：研发副总裁；交付岗位：Java开发工程师；员工工号：EMP-004821；登录用户名：zhangsan。',
      '该员工月薪18,500元/月，手机13800138000，邮箱zhangsan@example.com。',
      '身份信息：身份证号110101199003074512，出生日期1990-03-07，护照号码E12345678。',
      '收款银行账号：6222020200123456789；交付地址：北京市朝阳区建国路88号。',
      '联调API Key：sk-proj-1234567890abcdefghijkl；部署服务器IP：10.10.0.90。',
    ].join('\n'),
    expectedValues: [
      '星海零售',
      '深圳齐治科技有限公司',
      'ACA云管平台',
      'HT-2026-008731',
      'PRJ-2026-0815',
      '人民币1,280.50万元',
      '陈劲帆',
      '研发副总裁',
      'Java开发工程师',
      'EMP-004821',
      'zhangsan',
      '18,500元/月',
      '13800138000',
      'zhangsan@example.com',
      '110101199003074512',
      '1990-03-07',
      'E12345678',
      '6222020200123456789',
      '北京市朝阳区建国路88号',
      'sk-proj-1234567890abcdefghijkl',
      '10.10.0.90',
    ],
  },
  {
    id: 'default-business-v2-supplier-security',
    name: '综合业务场景 · 供应链与安全审计',
    text: [
      '【供应链与安全审计记录】',
      '客户名称：远山智造；实施方：华为技术有限公司；涉及产品：PAM特权访问管理系统。',
      '合同号ORBT-CN-2026-0918；项目代号NOVA-SZ-042；年度预算约3.5亿元。',
      '业务联系人王晓雯，职位为区域销售总监，当前岗位是供应链计划专员，工号A10397，管理员用户名ops.admin。',
      '目标年薪45万元/年，联系电话021-6123-4567，工作邮箱service@qizhi.cn。',
      '实名资料包含身份证号320311198806153274、出生日期1988年6月15日、护照号G87654321。',
      '对公账户6214830209987654321，办公地址上海市浦东新区张江路500号。',
      'GitHub令牌ghp_1234567890abcdefghijklmnopqrstuvwxyz，审计来源IP为192.168.31.45。',
    ].join('\n'),
    expectedValues: [
      '远山智造',
      '华为技术有限公司',
      'PAM特权访问管理系统',
      'ORBT-CN-2026-0918',
      'NOVA-SZ-042',
      '3.5亿元',
      '王晓雯',
      '区域销售总监',
      '供应链计划专员',
      'A10397',
      'ops.admin',
      '45万元/年',
      '021-6123-4567',
      'service@qizhi.cn',
      '320311198806153274',
      '1988年6月15日',
      'G87654321',
      '6214830209987654321',
      '上海市浦东新区张江路500号',
      'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      '192.168.31.45',
    ],
  },
  {
    id: 'default-business-v2-hr-project',
    name: '综合业务场景 · 人力与项目回款',
    text: [
      '【人力与项目回款记录】',
      '客户名称：蓝鲸医疗；合同相对方：阿里云计算有限公司；交付产品：企业研发管理系统。',
      '框架合同编码NDA/SH/2026/0032；项目编码IPD/2026/0097；本期回款金额￥500,000。',
      '审批人欧阳子轩，职位为首席财务官，所在岗位是高级测试工程师，员工IDEID-2026-7788，堡垒机用户名user_chenjf。',
      '试用期薪资税前30K/月，海外电话+86 13912345678，账单邮箱finance.ops@example.org。',
      '证件资料为身份证号44010619951230483X、出生日期2001/12/09、护照编号PE1234567。',
      '退款账户102100099996888，邮寄地址深圳市南山区科技园科苑路15号。',
      'AWS访问密钥AKIA1234567890ABCDEF，生产公网IP为203.0.113.18。',
    ].join('\n'),
    expectedValues: [
      '蓝鲸医疗',
      '阿里云计算有限公司',
      '企业研发管理系统',
      'NDA/SH/2026/0032',
      'IPD/2026/0097',
      '￥500,000',
      '欧阳子轩',
      '首席财务官',
      '高级测试工程师',
      'EID-2026-7788',
      'user_chenjf',
      '30K/月',
      '+86 13912345678',
      'finance.ops@example.org',
      '44010619951230483X',
      '2001/12/09',
      'PE1234567',
      '102100099996888',
      '深圳市南山区科技园科苑路15号',
      'AKIA1234567890ABCDEF',
      '203.0.113.18',
    ],
  },
];

function canonicalValue(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function uniqueValues(values: string[], limit = SENSITIVE_DATA_EVALUATION_EXPECTED_VALUE_LIMIT) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of values) {
    const value = String(item || '').trim();
    const canonical = canonicalValue(value);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

export function normalizeSensitiveDataEvaluationCases(input: unknown): SensitiveDataEvaluationCase[] {
  if (!Array.isArray(input)) return [];
  const seenIds = new Set<string>();
  const output: SensitiveDataEvaluationCase[] = [];
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<SensitiveDataEvaluationCase>;
    const text = typeof record.text === 'string'
      ? record.text.slice(0, SENSITIVE_DATA_EVALUATION_TEXT_LIMIT)
      : '';
    if (!text.trim()) continue;
    const baseId = String(record.id || `evaluation-${index + 1}`).trim().slice(0, 120) || `evaluation-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) id = `${baseId}-${suffix++}`;
    seenIds.add(id);
    const expectedValues = uniqueValues(Array.isArray(record.expectedValues) ? record.expectedValues : []);
    output.push({
      id,
      name: String(record.name || '').trim().slice(0, 200),
      text,
      expectedValues,
    });
    if (output.length >= SENSITIVE_DATA_EVALUATION_CASE_LIMIT) break;
  }
  return output;
}

export function compareSensitiveDataEvaluationValues(
  expectedValues: string[],
  detectedValues: string[],
): SensitiveDataEvaluationComparison {
  const expected = uniqueValues(expectedValues);
  const detected = uniqueValues(detectedValues);
  const expectedKeys = new Set(expected.map(canonicalValue));
  const detectedKeys = new Set(detected.map(canonicalValue));
  return {
    passed: expectedKeys.size === detectedKeys.size && [...expectedKeys].every((value) => detectedKeys.has(value)),
    matchedValues: expected.filter((value) => detectedKeys.has(canonicalValue(value))),
    missingValues: expected.filter((value) => !detectedKeys.has(canonicalValue(value))),
    unexpectedValues: detected.filter((value) => !expectedKeys.has(canonicalValue(value))),
  };
}
