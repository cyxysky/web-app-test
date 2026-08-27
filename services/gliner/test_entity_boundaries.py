from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from candidate_resolution import (  # noqa: E402
    Candidate,
    candidates_from_chunk_predictions,
    correct_chinese_entity_boundaries,
    select_non_overlapping,
)
from entity_boundaries import (  # noqa: E402
    chinese_boundary_label_kind,
    company_label_kind,
    refine_company_candidate_spans,
    requested_chinese_boundary_labels,
)


class ChineseEntityBoundaryTests(unittest.TestCase):
    def test_chunk_end_prediction_uses_the_indexed_original_text(self):
        texts = ["unrelated", "Alice suffix"]
        self.assertEqual(
            candidates_from_chunk_predictions(
                texts,
                1,
                0,
                "Alice",
                [{"start": 0, "end": 5, "type": "identity.person_name"}],
                {"identity.person_name": "person"},
                [],
                50,
            ),
            [],
        )

    def test_classifies_open_company_and_organization_labels(self):
        self.assertEqual(company_label_kind("companyName"), "company")
        self.assertEqual(company_label_kind("organization name"), "organization")
        self.assertIsNone(company_label_kind("service"))

    def test_classifies_person_labels_for_chinese_boundary_correction(self):
        self.assertEqual(chinese_boundary_label_kind("name"), "name")
        self.assertEqual(chinese_boundary_label_kind("full name"), "name")
        self.assertEqual(chinese_boundary_label_kind("person"), "name")
        self.assertEqual(chinese_boundary_label_kind("姓名"), "name")
        self.assertIsNone(chinese_boundary_label_kind("product"))

    def test_maps_requested_labels_to_roberta_entity_groups(self):
        self.assertEqual(
            requested_chinese_boundary_labels(["name", "company"]),
            {"name": "name", "company": "company", "organization": "company"},
        )

    def test_splits_two_companies_joined_by_a_relationship_word(self):
        text = "中科科技有限公司向华为技术有限公司提供 ACA 云服务。"
        spans = refine_company_candidate_spans(text, 0, 19, "company")
        self.assertEqual([text[start:end] for start, end in spans], [
            "中科科技有限公司",
            "华为技术有限公司",
        ])

    def test_trims_a_relationship_verb_after_one_company(self):
        text = "中科科技有限公司提供"
        spans = refine_company_candidate_spans(text, 0, len(text), "company name")
        self.assertEqual([text[start:end] for start, end in spans], ["中科科技有限公司"])

    def test_keeps_a_branch_name_without_a_relationship_boundary_together(self):
        text = "北京示例有限公司上海分公司"
        spans = refine_company_candidate_spans(text, 0, len(text), "organization")
        self.assertEqual([text[start:end] for start, end in spans], [text])

    def test_does_not_change_non_company_candidates(self):
        text = "中科科技有限公司提供"
        self.assertEqual(
            refine_company_candidate_spans(text, 0, len(text), "service"),
            [(0, len(text))],
        )

    def test_roberta_boundaries_replace_one_merged_gliner_company(self):
        text = "中科科技有限公司向华为技术有限公司提供 ACA 云服务。"
        open_candidates = [Candidate(0, 19, "company", 0.8, 10)]
        roberta_candidates = [
            Candidate(0, 8, "company", 0.96, 40),
            Candidate(9, 17, "company", 0.95, 40),
        ]
        corrected = correct_chinese_entity_boundaries(text, open_candidates, roberta_candidates)
        selected = select_non_overlapping(corrected)
        self.assertEqual([text[item.start:item.end] for item in selected], [
            "中科科技有限公司",
            "华为技术有限公司",
        ])

    def test_suffix_fallback_keeps_an_organization_missed_by_roberta(self):
        text = "中科科技有限公司向华为技术有限公司提供"
        corrected = correct_chinese_entity_boundaries(
            text,
            [Candidate(0, len(text), "company", 0.8, 10)],
            [Candidate(0, 8, "company", 0.96, 40)],
        )
        selected = select_non_overlapping(corrected)
        self.assertEqual([text[item.start:item.end] for item in selected], [
            "中科科技有限公司",
            "华为技术有限公司",
        ])

    def test_roberta_name_boundary_replaces_merged_gliner_name(self):
        text = "例如：陈劲帆的邮箱是 zhangsan@example.com。"
        name_start = text.index("陈劲帆")
        open_candidates = [Candidate(name_start, text.index(" "), "name", 0.91, 10)]
        roberta_candidates = [Candidate(name_start, name_start + len("陈劲帆"), "name", 0.99, 40)]
        corrected = correct_chinese_entity_boundaries(text, open_candidates, roberta_candidates)
        selected = select_non_overlapping(corrected)
        self.assertEqual([text[item.start:item.end] for item in selected], ["陈劲帆"])


if __name__ == "__main__":
    unittest.main()
