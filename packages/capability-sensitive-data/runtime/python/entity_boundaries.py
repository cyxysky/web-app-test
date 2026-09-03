"""Chinese entity-boundary helpers for the packaged redaction runtime."""

from __future__ import annotations

import re


COMPANY_LABEL_TOKENS = {
    "business",
    "businessorganization",
    "company",
    "companyname",
    "corporation",
    "corporateentity",
    "enterprise",
    "企业",
    "企业名称",
    "公司",
    "公司名称",
}

ORGANIZATION_LABEL_TOKENS = {
    "organisation",
    "organisationname",
    "organization",
    "organizationname",
    "org",
    "机构",
    "机构名称",
    "组织",
    "组织名称",
}

PERSON_LABEL_TOKENS = {
    "contactperson",
    "fullname",
    "name",
    "personalname",
    "person",
    "personname",
    "人员姓名",
    "人名",
    "姓名",
    "联系人",
}

COMPANY_SUFFIX_PATTERN = re.compile(
    r"有限责任公司|股份有限公司|集团有限公司|控股有限公司|有限公司|集团公司|"
    r"分公司|总公司|公司|集团|银行|大学|学院|医院|研究院|研究所|事务所|"
    r"委员会|协会|基金会|中心"
)

RELATION_WORDS = (
    "向",
    "给",
    "为",
    "与",
    "和",
    "及",
    "同",
    "由",
    "让",
    "替",
    "跟",
    "对",
    "到",
    "至",
)

BOUNDARY_CHARACTERS = frozenset(" \t\r\n,，、;；:：/|（）()[]【】")


def company_label_kind(label: str) -> str | None:
    token = re.sub(r"[\s_-]+", "", label).casefold()
    if token in COMPANY_LABEL_TOKENS:
        return "company"
    if token in ORGANIZATION_LABEL_TOKENS:
        return "organization"
    return None


def chinese_boundary_label_kind(label: str) -> str | None:
    company_kind = company_label_kind(label)
    if company_kind:
        return company_kind
    token = re.sub(r"[\s_-]+", "", label).casefold()
    if token in PERSON_LABEL_TOKENS:
        return "name"
    return None


def requested_chinese_boundary_labels(labels: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for label in labels:
        kind = chinese_boundary_label_kind(label)
        if kind and kind not in result:
            result[kind] = label
    if "company" in result and "organization" not in result:
        result["organization"] = result["company"]
    if "organization" in result and "company" not in result:
        result["company"] = result["organization"]
    return result


def is_company_label(label: str) -> bool:
    return company_label_kind(label) is not None


def leading_boundary_length(value: str) -> int:
    index = 0
    found_boundary = False
    while index < len(value):
        while index < len(value) and value[index] in BOUNDARY_CHARACTERS:
            index += 1
            found_boundary = True
        relation = next((word for word in RELATION_WORDS if value.startswith(word, index)), "")
        if not relation:
            break
        index += len(relation)
        found_boundary = True
    return index if found_boundary else 0


def refine_company_candidate_spans(text: str, start: int, end: int, label: str) -> list[tuple[int, int]]:
    """Split a merged Chinese company candidate and trim relationship verbs.

    Multilingual zero-shot NER can merge text such as
    ``A有限公司向B有限公司提供`` into one company. Corporate suffixes give us
    deterministic boundaries without inventing entities that the model did not
    already select.
    """
    if not is_company_label(label) or start < 0 or end <= start or end > len(text):
        return [(start, end)]

    value = text[start:end]
    suffixes = list(COMPANY_SUFFIX_PATTERN.finditer(value))
    if not suffixes:
        return [(start, end)]

    spans: list[tuple[int, int]] = [(0, suffixes[0].end())]
    previous_suffix_end = suffixes[0].end()
    for suffix in suffixes[1:]:
        gap = value[previous_suffix_end:suffix.start()]
        boundary_length = leading_boundary_length(gap)
        proposed_start = previous_suffix_end + boundary_length
        if boundary_length and suffix.start() - proposed_start >= 1:
            spans.append((proposed_start, suffix.end()))
        else:
            spans[-1] = (spans[-1][0], suffix.end())
        previous_suffix_end = suffix.end()

    refined = [
        (start + local_start, start + local_end)
        for local_start, local_end in spans
        if local_end > local_start
    ]
    return refined or [(start, end)]
