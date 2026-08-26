from __future__ import annotations

from dataclasses import dataclass

from entity_boundaries import company_label_kind, refine_company_candidate_spans


@dataclass(frozen=True)
class Candidate:
    start: int
    end: int
    label: str
    score: float
    priority: int


def overlaps(start: int, end: int, other_start: int, other_end: int) -> bool:
    return start < other_end and end > other_start


def correct_organization_boundaries(
    text: str,
    open_candidates: list[Candidate],
    roberta_candidates: list[Candidate],
) -> list[Candidate]:
    """Replace overlapping GLiNER organization spans with RoBERTa boundaries.

    GLiNER's non-organization open-label candidates remain available for the
    final priority-based overlap resolver. The deterministic suffix splitter
    preserves any company segment that RoBERTa missed, while overlapping
    segments always use RoBERTa's higher-priority character boundaries.
    """
    corrected: list[Candidate] = list(roberta_candidates)
    for candidate in open_candidates:
        spans = refine_company_candidate_spans(text, candidate.start, candidate.end, candidate.label)
        for start, end in spans:
            if company_label_kind(candidate.label) and any(
                overlaps(start, end, boundary.start, boundary.end)
                for boundary in roberta_candidates
            ):
                continue
            corrected.append(Candidate(start, end, candidate.label, candidate.score, candidate.priority))
    return corrected


def select_non_overlapping(candidates: list[Candidate]) -> list[Candidate]:
    selected: list[Candidate] = []
    for candidate in sorted(
        candidates,
        key=lambda item: (item.priority, item.score, item.end - item.start, -item.start),
        reverse=True,
    ):
        if any(overlaps(candidate.start, candidate.end, item.start, item.end) for item in selected):
            continue
        selected.append(candidate)
    return sorted(selected, key=lambda item: item.start)
