from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from candidate_resolution import Candidate, correct_organization_boundaries, select_non_overlapping  # noqa: E402
from entity_boundaries import company_label_kind, refine_company_candidate_spans  # noqa: E402


class CompanyCandidateBoundaryTests(unittest.TestCase):
    def test_classifies_open_company_and_organization_labels(self):
        self.assertEqual(company_label_kind("companyName"), "company")
        self.assertEqual(company_label_kind("organization name"), "organization")
        self.assertIsNone(company_label_kind("service"))

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
        corrected = correct_organization_boundaries(text, open_candidates, roberta_candidates)
        selected = select_non_overlapping(corrected)
        self.assertEqual([text[item.start:item.end] for item in selected], [
            "中科科技有限公司",
            "华为技术有限公司",
        ])

    def test_suffix_fallback_keeps_an_organization_missed_by_roberta(self):
        text = "中科科技有限公司向华为技术有限公司提供"
        corrected = correct_organization_boundaries(
            text,
            [Candidate(0, len(text), "company", 0.8, 10)],
            [Candidate(0, 8, "company", 0.96, 40)],
        )
        selected = select_non_overlapping(corrected)
        self.assertEqual([text[item.start:item.end] for item in selected], [
            "中科科技有限公司",
            "华为技术有限公司",
        ])


if __name__ == "__main__":
    unittest.main()
