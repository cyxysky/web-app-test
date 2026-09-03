"""Deterministic sensitive-span rules shipped with the redaction package."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class DeterministicSpan:
    start: int
    end: int
    label: str
    priority: int


ARABIC_NUMBER = r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"
CHINESE_NUMBER = r"[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億]+"
CURRENCY_PREFIX = r"(?:人民币|RMB|CNY|USD|EUR|GBP|JPY|HKD|AUD|CAD|￥|¥|\$|€|£)"
CURRENCY_SUFFIX = r"(?:人民币|元|块钱?|美元|美金|欧元|英镑|日元|港元|澳元|加元)"
MAGNITUDE = r"(?:百|千|万|萬|亿|億|[KkMmWw])"
COLLOQUIAL_MONEY_MAGNITUDE = r"(?:万|萬|亿|億|[Ww])"
PERIOD_SUFFIX = r"(?:\s*(?:/|每)\s*(?:月|年|天|小时))?"

PREFIXED_AMOUNT_PATTERN = re.compile(
    rf"(?<![A-Za-z0-9]){CURRENCY_PREFIX}\s*(?:{ARABIC_NUMBER}|{CHINESE_NUMBER})\s*{MAGNITUDE}?\s*{CURRENCY_SUFFIX}?{PERIOD_SUFFIX}",
    re.IGNORECASE,
)
SUFFIXED_AMOUNT_PATTERN = re.compile(
    rf"(?<![A-Za-z0-9])(?:{ARABIC_NUMBER}|{CHINESE_NUMBER})\s*{MAGNITUDE}?\s*{CURRENCY_SUFFIX}{PERIOD_SUFFIX}",
    re.IGNORECASE,
)
MAGNITUDE_AMOUNT_PATTERN = re.compile(
    rf"(?<![A-Za-z0-9_+/-]){ARABIC_NUMBER}\s*{MAGNITUDE}{PERIOD_SUFFIX}(?![A-Za-z0-9_+/-])",
    re.IGNORECASE,
)
COLLOQUIAL_AMOUNT_PATTERN = re.compile(
    rf"(?<![A-Za-z0-9_+/-]){ARABIC_NUMBER}\s*{COLLOQUIAL_MONEY_MAGNITUDE}{PERIOD_SUFFIX}(?![A-Za-z0-9_+/-])",
    re.IGNORECASE,
)
CONTEXT_NUMBER_PATTERN = re.compile(
    rf"(?<![A-Za-z0-9_+/-]){ARABIC_NUMBER}\s*{MAGNITUDE}?{PERIOD_SUFFIX}(?![A-Za-z0-9_+/-])",
    re.IGNORECASE,
)
AMOUNT_CONTEXT_PATTERN = re.compile(
    r"金额|报价|费用|预算|成本|单价|总价|售价|成交价|合同额|薪资|工资|月薪|年薪|"
    r"报酬|奖金|余额|应付|实付|支付|付款|收入|支出|回款|毛利|利润",
    re.IGNORECASE,
)
NON_AMOUNT_FOLLOW_PATTERN = re.compile(
    r"^(?:人次|人口|用户|粉丝|播放|阅读|访问|销量|订单|工单|"
    r"人|名|家|户|次|件|台|个|套|条|辆|本|枚|张|吨|股|单|笔|倍|"
    r"字符|公里|千米|米|秒|分钟|小时|天|年|月|份|页|章|期|号)"
)
PHONE_LIKE_PATTERN = re.compile(
    r"(?<!\d)(?:\+?\d{1,3}[- ]?)?(?:1[3-9]\d{9}|\(?\d{2,4}\)?[- ]\d{3,4}[- ]\d{4})(?!\d)"
)

CONTEXT_IDENTIFIER_RULES = (
    (
        "person",
        re.compile(r"(?:项目负责人|业务联系人|审批人|申请人|经办人|联系人|负责人)\s*(?:为|是|[:：])?\s*(?!的)([\u3400-\u9fff·]{2,12})", re.IGNORECASE),
        129,
    ),
    (
        "contract number",
        re.compile(r"(?:框架)?合同(?:编号|号码|号|编码)\s*(?:为|是|[:：])?\s*([A-Za-z0-9][A-Za-z0-9/_-]{3,})", re.IGNORECASE),
        129,
    ),
    (
        "project code",
        re.compile(r"项目(?:编号|号码|号|编码|代号)\s*(?:为|是|[:：])?\s*([A-Za-z0-9][A-Za-z0-9/_-]{3,})", re.IGNORECASE),
        129,
    ),
    (
        "employee id",
        re.compile(r"(?:员工(?:编号|号码|ID|Id|id|工号)|工号)\s*(?:为|是|[:：])?\s*([A-Za-z0-9][A-Za-z0-9_-]{3,})", re.IGNORECASE),
        129,
    ),
    (
        "username",
        re.compile(r"(?:登录)?用户名\s*(?:为|是|[:：])?\s*([A-Za-z0-9][A-Za-z0-9._-]{2,})", re.IGNORECASE),
        128,
    ),
    (
        "customer name",
        re.compile(r"客户名称\s*[:：]\s*([^，；。\n]{2,40})", re.IGNORECASE),
        128,
    ),
    (
        "product",
        re.compile(r"(?:采购产品|涉及产品|交付产品|产品)\s*[:：]\s*([^，；。\n]{2,50})", re.IGNORECASE),
        128,
    ),
    (
        "job title",
        re.compile(r"职位\s*(?:为|是|[:：])\s*([^，；。\n]{2,30})", re.IGNORECASE),
        128,
    ),
    (
        "position",
        re.compile(r"(?:交付岗位|当前岗位|所在岗位|岗位名称|岗位)\s*(?:为|是|[:：])\s*([^，；。\n]{2,40})", re.IGNORECASE),
        128,
    ),
    (
        "phone number",
        re.compile(
            r"(?:联系电话|联系手机|海外电话|手机号码|手机号|电话)\s*(?:为|是|[:：])?\s*"
            r"((?:\+?\d{1,3}[- ]?)?(?:1[3-9]\d{9}|\(?\d{2,4}\)?[- ]\d{3,4}[- ]\d{4}))",
            re.IGNORECASE,
        ),
        129,
    ),
    (
        "date of birth",
        re.compile(r"(?:出生日期|生日)\s*(?:为|是|[:：])?\s*(\d{4}(?:[-/]\d{1,2}[-/]\d{1,2}|年\d{1,2}月\d{1,2}日))", re.IGNORECASE),
        119,
    ),
    (
        "bank account number",
        re.compile(r"(?:收款银行账号|对公账户|退款账户|银行账号|账户号码)\s*[:：]?\s*(\d{12,30})", re.IGNORECASE),
        128,
    ),
    (
        "address",
        re.compile(r"(?:交付地址|办公地址|邮寄地址|收货地址|联系地址|地址)\s*(?:为|是|[:：])?\s*([^，；。\n]{5,80})", re.IGNORECASE),
        128,
    ),
)


def _has_amount_context(text: str, start: int, end: int) -> bool:
    return bool(AMOUNT_CONTEXT_PATTERN.search(text[max(0, start - 24):min(len(text), end + 16)]))


def _trim_span(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def amount_spans(text: str) -> list[DeterministicSpan]:
    """Return high-recall currency spans without treating ordinary counts as money."""
    candidates: list[tuple[int, int, int]] = []
    for priority, pattern, requires_context in (
        (122, PREFIXED_AMOUNT_PATTERN, False),
        (121, SUFFIXED_AMOUNT_PATTERN, False),
        (120, COLLOQUIAL_AMOUNT_PATTERN, False),
        (120, MAGNITUDE_AMOUNT_PATTERN, True),
        (104, CONTEXT_NUMBER_PATTERN, True),
    ):
        for match in pattern.finditer(text):
            start, end = _trim_span(text, *match.span())
            if end <= start:
                continue
            if NON_AMOUNT_FOLLOW_PATTERN.match(text[end:]):
                continue
            if requires_context and not _has_amount_context(text, start, end):
                continue
            if priority == 104 and any(
                start < phone_match.end() and end > phone_match.start()
                for phone_match in PHONE_LIKE_PATTERN.finditer(text)
            ):
                continue
            candidates.append((start, end, priority))

    candidates.sort(key=lambda item: (item[2], item[1] - item[0], -item[0]), reverse=True)
    selected: list[DeterministicSpan] = []
    for start, end, priority in candidates:
        if any(start < item.end and end > item.start for item in selected):
            continue
        selected.append(DeterministicSpan(start, end, "money", priority))
    return sorted(selected, key=lambda item: (item.start, item.end))


def contextual_identifier_spans(text: str) -> list[DeterministicSpan]:
    spans: list[DeterministicSpan] = []
    for label, pattern, priority in CONTEXT_IDENTIFIER_RULES:
        for match in pattern.finditer(text):
            start, end = match.span(1)
            if start < end:
                spans.append(DeterministicSpan(start, end, label, priority))
    return spans


def canonical_money_value(value: str) -> str:
    """Normalize equivalent Arabic currency spellings for placeholder reuse."""
    normalized = unicodedata.normalize("NFKC", value).strip().casefold()
    compact = re.sub(r"\s+", "", normalized)
    currency = "cny"
    if re.search(r"usd|美元|美金|\$", compact):
        currency = "usd"
    elif re.search(r"eur|欧元|€", compact):
        currency = "eur"
    elif re.search(r"gbp|英镑|£", compact):
        currency = "gbp"
    elif re.search(r"jpy|日元", compact):
        currency = "jpy"
    elif re.search(r"hkd|港元", compact):
        currency = "hkd"
    elif re.search(r"aud|澳元", compact):
        currency = "aud"
    elif re.search(r"cad|加元", compact):
        currency = "cad"

    number_match = re.search(ARABIC_NUMBER, compact)
    if not number_match:
        return f"money:{compact}"
    number = number_match.group(0).replace(",", "")
    try:
        from decimal import Decimal

        amount = Decimal(number)
        tail = compact[number_match.end():]
        scale = Decimal(1)
        if tail.startswith(("亿", "億")):
            scale = Decimal(100_000_000)
        elif tail.startswith(("万", "萬", "w")):
            scale = Decimal(10_000)
        elif tail.startswith(("千", "k")):
            scale = Decimal(1_000)
        elif tail.startswith(("百",)):
            scale = Decimal(100)
        elif tail.startswith(("m",)):
            scale = Decimal(1_000_000)
        canonical = format((amount * scale).normalize(), "f")
        return f"money:{currency}:{canonical}"
    except Exception:
        return f"money:{compact}"
