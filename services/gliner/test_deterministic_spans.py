from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from deterministic_spans import amount_spans, canonical_money_value, contextual_identifier_spans  # noqa: E402


class DeterministicAmountTests(unittest.TestCase):
    def detected(self, text: str) -> list[str]:
        return [text[item.start:item.end] for item in amount_spans(text)]

    def test_recognizes_currency_suffix_with_or_without_spaces(self):
        self.assertEqual(self.detected("有500元呢？"), ["500元"])
        self.assertEqual(self.detected("服务报价500元"), ["500元"])
        self.assertEqual(self.detected("费用为 500 元"), ["500 元"])

    def test_recognizes_prefix_decimal_and_large_chinese_units(self):
        self.assertEqual(self.detected("金额为人民币1,280.50元"), ["人民币1,280.50元"])
        self.assertEqual(self.detected("预算约3.5亿元"), ["3.5亿元"])
        self.assertEqual(self.detected("合同额为2000万"), ["2000万"])

    def test_recognizes_salary_context_without_a_currency_word(self):
        self.assertEqual(self.detected("该岗位月薪18500"), ["18500"])
        self.assertEqual(self.detected("薪资税前30K/月"), ["30K/月"])

    def test_rejects_non_money_counts(self):
        self.assertEqual(self.detected("本月服务2000万人次，共处理500件工单"), [])
        self.assertEqual(self.detected("版本号是3.5，部署500台设备"), [])
        self.assertEqual(self.detected("项目编号PRJ-2026-0815，合同金额500元"), ["500元"])
        self.assertEqual(self.detected("目标年薪45万元，电话021-6123-4567"), ["45万元"])

    def test_normalizes_equivalent_currency_spellings(self):
        self.assertEqual(canonical_money_value("￥500"), canonical_money_value("500元"))
        self.assertEqual(canonical_money_value("2000万"), canonical_money_value("2000万元"))

    def test_extracts_contextual_business_identifiers(self):
        samples = {
            "合同编号：HT-2026-008731": "HT-2026-008731",
            "项目代号为NOVA-SZ-042。": "NOVA-SZ-042",
            "项目编码IPD/2026/0097；本期回款金额￥500,000。": "IPD/2026/0097",
            "申请人的工号是A10397。": "A10397",
            "审批人欧阳子轩，流程继续。": "欧阳子轩",
            "生产环境管理员用户名：ops.admin": "ops.admin",
            "职位为区域销售总监。": "区域销售总监",
            "当前岗位是供应链计划专员。": "供应链计划专员",
            "海外电话+86 13912345678，账单已生成。": "+86 13912345678",
            "联系电话021-6123-4567，工作邮箱另附。": "021-6123-4567",
            "交付产品：DOMP研发管理系统。": "DOMP研发管理系统",
            "出生日期1988年6月15日。": "1988年6月15日",
            "退款账户102100099996888。": "102100099996888",
            "邮寄地址：深圳市南山区科技园科苑路15号。": "深圳市南山区科技园科苑路15号",
            "办公地址上海市浦东新区张江路500号。": "上海市浦东新区张江路500号",
        }
        for text, expected in samples.items():
            with self.subTest(text=text):
                spans = contextual_identifier_spans(text)
                self.assertEqual([text[item.start:item.end] for item in spans], [expected])

    def test_amount_context_does_not_split_identifiers_or_phones(self):
        text = (
            "项目编码IPD/2026/0097；本期回款金额￥500,000；"
            "海外电话+86 13912345678；年度预算3.5亿元。"
        )
        self.assertEqual(self.detected(text), ["￥500,000", "3.5亿元"])

    def test_full_business_paragraphs_keep_complete_contextual_values(self):
        scenarios = (
            (
                "合同号DOMP-CN-2026-0918；项目代号NOVA-SZ-042；年度预算约3.5亿元。"
                "业务联系人王晓雯，职位为区域销售总监，当前岗位是供应链计划专员，"
                "工号A10397，管理员用户名ops.admin。目标年薪45万元/年，"
                "联系电话021-6123-4567，出生日期1988年6月15日，"
                "对公账户6214830209987654321，办公地址上海市浦东新区张江路500号。",
                {
                    "DOMP-CN-2026-0918", "NOVA-SZ-042", "3.5亿元", "王晓雯",
                    "区域销售总监", "供应链计划专员", "A10397", "ops.admin",
                    "45万元/年", "021-6123-4567", "1988年6月15日",
                    "6214830209987654321", "上海市浦东新区张江路500号",
                },
            ),
            (
                "框架合同编码NDA/SH/2026/0032；项目编码IPD/2026/0097；"
                "本期回款金额￥500,000。审批人欧阳子轩，职位为首席财务官，"
                "所在岗位是高级测试工程师，员工IDEID-2026-7788，"
                "堡垒机用户名user_chenjf。试用期薪资税前30K/月，"
                "海外电话+86 13912345678，出生日期2001/12/09，"
                "退款账户102100099996888，邮寄地址深圳市南山区科技园科苑路15号。",
                {
                    "NDA/SH/2026/0032", "IPD/2026/0097", "￥500,000", "欧阳子轩",
                    "首席财务官", "高级测试工程师", "EID-2026-7788", "user_chenjf",
                    "30K/月", "+86 13912345678", "2001/12/09", "102100099996888",
                    "深圳市南山区科技园科苑路15号",
                },
            ),
        )
        for text, expected in scenarios:
            with self.subTest(text=text[:30]):
                spans = [*amount_spans(text), *contextual_identifier_spans(text)]
                detected = {text[item.start:item.end] for item in spans}
                self.assertTrue(expected.issubset(detected), expected - detected)


if __name__ == "__main__":
    unittest.main()
