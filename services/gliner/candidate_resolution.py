from __future__ import annotations

from dataclasses import dataclass

from entity_boundaries import chinese_boundary_label_kind, refine_company_candidate_spans


@dataclass(frozen=True)
class Candidate:
    start: int
    end: int
    label: str
    score: float
    priority: int


def overlaps(start: int, end: int, other_start: int, other_end: int) -> bool:
    return start < other_end and end > other_start


def candidates_from_chunk_predictions(
    texts: list[str],
    text_index: int,
    chunk_start: int,
    chunk: str,
    predictions: object,
    label_map: dict[str, str],
    placeholder_spans: list[tuple[int, int]],
    priority: int,
) -> list[Candidate]:
    candidates: list[Candidate] = []
    for entity in predictions if isinstance(predictions, list) else []:
        if not isinstance(entity, dict):
            continue
        label = label_map.get(str(entity.get("type", "")).strip())
        local_start = int(entity.get("start", -1))
        local_end = int(entity.get("end", -1))
        if not label or local_start < 0 or local_end <= local_start or local_end > len(chunk):
            continue
        if (local_start == 0 and chunk_start > 0) or (
            local_end == len(chunk) and chunk_start + len(chunk) < len(texts[text_index])
        ):
            continue
        start = chunk_start + local_start
        end = chunk_start + local_end
        if any(overlaps(start, end, span_start, span_end) for span_start, span_end in placeholder_spans):
            continue
        candidates.append(Candidate(start, end, label, 1.0, priority))
    return candidates


def same_chinese_boundary_family(left_label: str, right_label: str) -> bool:
    left = chinese_boundary_label_kind(left_label)
    right = chinese_boundary_label_kind(right_label)
    if left == "name" or right == "name":
        return left == right == "name"
    organization_kinds = {"company", "organization"}
    return left in organization_kinds and right in organization_kinds


def correct_chinese_entity_boundaries(
    text: str,
    open_candidates: list[Candidate],
    roberta_candidates: list[Candidate],
) -> list[Candidate]:
    """Replace overlapping GLiNER person and organization spans with RoBERTa boundaries.

    GLiNER's unrelated open-label candidates remain available for the final
    priority-based overlap resolver. The deterministic suffix splitter preserves
    company segments that RoBERTa missed, while overlapping Chinese person and
    organization spans use RoBERTa's higher-priority character boundaries.
    """
    corrected: list[Candidate] = list(roberta_candidates)
    for candidate in open_candidates:
        spans = refine_company_candidate_spans(text, candidate.start, candidate.end, candidate.label)
        for start, end in spans:
            if any(
                same_chinese_boundary_family(candidate.label, boundary.label)
                and overlaps(start, end, boundary.start, boundary.end)
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
