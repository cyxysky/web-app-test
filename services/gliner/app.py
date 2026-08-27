from __future__ import annotations

import hmac
import hashlib
import importlib.util
import os
import re
import sys
import threading
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import torch
from fastapi import FastAPI, Header, HTTPException
from gliner2 import AutoExtractor
from huggingface_hub import hf_hub_download
from pydantic import BaseModel, Field
from tokenizers import Tokenizer
from transformers import AutoModelForTokenClassification, PreTrainedTokenizerFast, pipeline

from candidate_resolution import (
    Candidate,
    candidates_from_chunk_predictions,
    correct_chinese_entity_boundaries,
    overlaps,
    select_non_overlapping,
)
from deterministic_spans import amount_spans, canonical_money_value, contextual_identifier_spans
from entity_boundaries import requested_chinese_boundary_labels


def compute_service_revision() -> str:
    digest = hashlib.sha256()
    service_directory = Path(__file__).resolve().parent
    for filename in ("app.py", "candidate_resolution.py", "entity_boundaries.py", "deterministic_spans.py"):
        digest.update((service_directory / filename).read_bytes())
    return digest.hexdigest()


SERVICE_REVISION = compute_service_revision()


DEFAULT_LABELS = (
    "person",
    "phone number",
    "mobile phone number",
    "landline phone number",
    "address",
    "postal code",
    "passport number",
    "email",
    "email address",
    "credit card number",
    "credit card expiration date",
    "bank account number",
    "iban",
    "cvv",
    "date of birth",
    "driver's license number",
    "identity card number",
    "national id number",
    "tax identification number",
    "health insurance number",
    "medical record number",
    "ip address",
    "username",
    "company",
    "organization",
    "money",
    "amount",
    "contract number",
    "job title",
    "position",
    "salary",
    "product",
    "customer name",
    "project code",
    "employee id",
)

PLACEHOLDER_PATTERN = re.compile(r"\[SENSITIVE_[A-Z0-9_]+_\d+\]")
CHINESE_TEXT_PATTERN = re.compile(r"[\u3400-\u9fff]")
MODEL_NAME = os.getenv("GLINER_MODEL", "fastino/gliner2.5-multi-v1").strip()
CHINESE_NER_MODEL_NAME = os.getenv(
    "GLINER_CHINESE_NER_MODEL",
    "uer/roberta-base-finetuned-cluener2020-chinese",
).strip()
LIQUID_PII_MODEL_NAME = os.getenv(
    "GLINER_PII_MODEL",
    "LiquidAI/LFM2.5-Encoder-350M-PII-Detector",
).strip()
DEVICE = os.getenv("GLINER_DEVICE", "").strip() or ("cuda" if torch.cuda.is_available() else "cpu")
DEFAULT_THRESHOLD = float(os.getenv("GLINER_THRESHOLD", "0.5"))
CHINESE_NER_THRESHOLD = float(os.getenv("GLINER_CHINESE_NER_THRESHOLD", "0.35"))
MAX_CHARS_PER_CHUNK = max(200, int(os.getenv("GLINER_MAX_CHARS_PER_CHUNK", "900")))
CHUNK_OVERLAP = min(MAX_CHARS_PER_CHUNK // 3, max(0, int(os.getenv("GLINER_CHUNK_OVERLAP", "120"))))
CHINESE_MAX_CHARS_PER_CHUNK = max(
    100,
    min(480, int(os.getenv("GLINER_CHINESE_MAX_CHARS_PER_CHUNK", "400"))),
)
CHINESE_CHUNK_OVERLAP = min(
    CHINESE_MAX_CHARS_PER_CHUNK // 3,
    max(0, int(os.getenv("GLINER_CHINESE_CHUNK_OVERLAP", "64"))),
)
LIQUID_MAX_CHARS_PER_CHUNK = max(
    200,
    min(1800, int(os.getenv("GLINER_PII_MAX_CHARS_PER_CHUNK", "1600"))),
)
LIQUID_CHUNK_OVERLAP = min(
    LIQUID_MAX_CHARS_PER_CHUNK // 3,
    max(0, int(os.getenv("GLINER_PII_CHUNK_OVERLAP", "160"))),
)
MAX_REQUEST_TEXTS = max(1, int(os.getenv("GLINER_MAX_REQUEST_TEXTS", "20000")))
MAX_REQUEST_CHARS = max(1, int(os.getenv("GLINER_MAX_REQUEST_CHARS", "4000000")))
INFERENCE_BATCH_SIZE = max(1, int(os.getenv("GLINER_BATCH_SIZE", "8")))
SERVICE_API_KEY = os.getenv("GLINER_SERVICE_API_KEY", "").strip()


LIQUID_LABEL_MAP = {
    "contact.address": "address",
    "contact.email": "email address",
    "contact.ip_address": "ip address",
    "contact.phone": "phone number",
    "contact.postal_code": "postal code",
    "credential.api_key": "api key",
    "credential.connection_string": "connection string",
    "credential.jwt": "jwt",
    "credential.password": "password",
    "credential.private_key": "private key",
    "developer.device_id": "device id",
    "developer.login_credentials": "login credentials",
    "device.imei": "imei",
    "device.mac_address": "mac address",
    "financial.amount": "money",
    "financial.bank_account": "bank account number",
    "financial.credit_card": "credit card number",
    "financial.crypto_wallet": "crypto wallet",
    "financial.iban": "iban",
    "financial.swift_bic": "swift bic",
    "healthcare.condition": "medical condition",
    "healthcare.health_plan_id": "health insurance number",
    "healthcare.medical_record": "medical record number",
    "healthcare.medication": "medication",
    "identity.date_of_birth": "date of birth",
    "identity.drivers_license": "driver's license number",
    "identity.national_id": "national id number",
    "identity.passport": "passport number",
    "identity.person_name": "person",
    "identity.ssn": "ssn",
    "identity.tax_id": "tax identification number",
    "legal.case_number": "case number",
    "location.gps_coordinates": "gps coordinates",
    "online.url": "url",
    "online.username": "username",
    "org.company_name": "company",
    "special.health_status": "health status",
    "special.orientation": "sexual orientation",
    "special.political": "political affiliation",
    "special.religion": "religion",
}


def configured_default_labels() -> list[str]:
    raw = os.getenv("GLINER_ENTITY_LABELS", "").strip()
    labels = re.split(r"[,\n]", raw) if raw else list(DEFAULT_LABELS)
    return list(dict.fromkeys(label.strip().lower() for label in labels if label.strip()))


class RedactRequest(BaseModel):
    texts: list[str]
    labels: list[str] | None = None
    threshold: float | None = Field(default=None, gt=0, le=1)


class RedactionReplacement(BaseModel):
    textIndex: int
    start: int
    end: int
    label: str
    placeholder: str


class RedactResponse(BaseModel):
    texts: list[str]
    entities_detected: int
    replacements: list[RedactionReplacement]


@dataclass(frozen=True)
class RegexRule:
    label: str
    pattern: re.Pattern[str]
    group: int = 0
    priority: int = 100
    validator: Callable[[str], bool] | None = None


def valid_ipv4(value: str) -> bool:
    try:
        return all(0 <= int(part) <= 255 for part in value.split("."))
    except ValueError:
        return False


def valid_payment_card(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if not 13 <= len(digits) <= 19 or len(set(digits)) == 1:
        return False
    checksum = 0
    parity = len(digits) % 2
    for index, digit in enumerate(map(int, digits)):
        if index % 2 == parity:
            digit *= 2
            if digit > 9:
                digit -= 9
        checksum += digit
    return checksum % 10 == 0


REGEX_RULES = (
    RegexRule(
        "private key",
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", re.DOTALL),
        priority=130,
    ),
    RegexRule(
        "api key",
        re.compile(r"(?i)\b(?:api[_ -]?key|access[_ -]?token|password|passwd|pwd|密码)\b\s*[:=：]\s*[\"']?([^\s,;，；\"']{4,})"),
        group=1,
        priority=125,
    ),
    RegexRule(
        "access token",
        re.compile(r"(?<![A-Za-z0-9])(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}|\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{16,}"),
        priority=125,
    ),
    RegexRule(
        "email address",
        re.compile(r"(?i)(?<![A-Z0-9._%+-])[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9.-])"),
        priority=120,
    ),
    RegexRule(
        "national id number",
        re.compile(r"(?<!\d)\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)"),
        priority=115,
    ),
    RegexRule("phone number", re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"), priority=110),
    RegexRule(
        "phone number",
        re.compile(r"(?<!\d)(?:\+\d{1,3}[- ]?)?(?:\(?\d{2,4}\)?[- ])\d{3,4}[- ]\d{4}(?!\d)"),
        priority=105,
    ),
    RegexRule(
        "credit card number",
        re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)"),
        priority=100,
        validator=valid_payment_card,
    ),
    RegexRule(
        "ip address",
        re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"),
        priority=100,
        validator=valid_ipv4,
    ),
)


def iter_character_chunks(text: str, maximum: int, overlap: int) -> Iterable[tuple[int, str]]:
    if len(text) <= maximum:
        yield 0, text
        return
    start = 0
    while start < len(text):
        end = min(len(text), start + maximum)
        yield start, text[start:end]
        if end >= len(text):
            break
        start = max(start + 1, end - overlap)


def overlaps_placeholder(start: int, end: int, placeholder_spans: list[tuple[int, int]]) -> bool:
    return any(overlaps(start, end, placeholder_start, placeholder_end) for placeholder_start, placeholder_end in placeholder_spans)


def regex_candidates(text: str, placeholder_spans: list[tuple[int, int]]) -> list[Candidate]:
    candidates: list[Candidate] = []
    for span in [*amount_spans(text), *contextual_identifier_spans(text)]:
        if not overlaps_placeholder(span.start, span.end, placeholder_spans):
            candidates.append(Candidate(span.start, span.end, span.label, 1.0, span.priority))
    for rule in REGEX_RULES:
        for match in rule.pattern.finditer(text):
            start, end = match.span(rule.group)
            value = match.group(rule.group)
            if not value or (rule.validator is not None and not rule.validator(value)):
                continue
            if overlaps_placeholder(start, end, placeholder_spans):
                continue
            candidates.append(Candidate(start, end, rule.label, 1.0, rule.priority))
    return candidates


def liquid_model_file(model_name: str, filename: str) -> Path:
    model_path = Path(model_name)
    if model_path.is_dir():
        resolved = model_path / filename
        if not resolved.is_file():
            raise FileNotFoundError(f"LiquidAI model helper is missing: {resolved}")
        return resolved
    cache_directory = os.getenv("TRANSFORMERS_CACHE", "").strip() or os.getenv("HF_HOME", "").strip() or None
    return Path(hf_hub_download(
        repo_id=model_name,
        filename=filename,
        cache_dir=cache_directory,
        local_files_only=os.getenv("HF_HUB_OFFLINE", "").strip() == "1",
    ))


def load_liquid_decoder(model_name: str):
    helper_path = liquid_model_file(model_name, "pii_hybrid_decode.py")
    helper_directory = str(helper_path.parent)
    if helper_directory not in sys.path:
        sys.path.insert(0, helper_directory)
    spec = importlib.util.spec_from_file_location("webpilot_liquid_pii_hybrid_decode", helper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load LiquidAI decoder: {helper_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    hybrid_spans = getattr(module, "hybrid_spans", None)
    if not callable(hybrid_spans):
        raise RuntimeError("LiquidAI decoder does not export hybrid_spans().")
    return hybrid_spans


def load_liquid_tokenizer(model_name: str) -> PreTrainedTokenizerFast:
    tokenizer_path = liquid_model_file(model_name, "tokenizer.json")
    return PreTrainedTokenizerFast(
        tokenizer_object=Tokenizer.from_file(str(tokenizer_path)),
        bos_token="<|startoftext|>",
        eos_token="<|im_end|>",
        pad_token="<|pad|>",
        mask_token="<|mask|>",
        model_input_names=["input_ids", "attention_mask"],
    )


def liquid_pii_candidates(
    texts: list[str],
    placeholder_spans_by_text: list[list[tuple[int, int]]],
) -> list[list[Candidate]]:
    candidates_by_text: list[list[Candidate]] = [[] for _ in texts]
    jobs = [
        (text_index, chunk_start, chunk)
        for text_index, text in enumerate(texts)
        for chunk_start, chunk in iter_character_chunks(
            text,
            LIQUID_MAX_CHARS_PER_CHUNK,
            LIQUID_CHUNK_OVERLAP,
        )
        if chunk.strip()
    ]
    for batch_start in range(0, len(jobs), INFERENCE_BATCH_SIZE):
        batch = jobs[batch_start:batch_start + INFERENCE_BATCH_SIZE]
        encoded = liquid_pii_tokenizer(
            [chunk for _, _, chunk in batch],
            padding=True,
            truncation=True,
            max_length=2048,
            return_offsets_mapping=True,
            return_tensors="pt",
        )
        offsets_by_chunk = encoded.pop("offset_mapping").tolist()
        encoded = {key: value.to(liquid_pii_model.device) for key, value in encoded.items()}
        prediction_ids = liquid_pii_model(**encoded).logits.argmax(-1).tolist()
        id_to_label = liquid_pii_model.config.id2label
        for (text_index, chunk_start, chunk), offsets, token_ids in zip(
            batch,
            offsets_by_chunk,
            prediction_ids,
            strict=True,
        ):
            model_spans: list[dict[str, object]] = []
            current: dict[str, object] | None = None
            for (local_start, local_end), token_id in zip(offsets, token_ids, strict=True):
                tag = str(id_to_label[int(token_id)])
                if local_end <= local_start or tag == "O":
                    if current is not None:
                        model_spans.append(current)
                        current = None
                    continue
                entity_type = tag.split("-", 1)[1] if "-" in tag else tag
                if tag.startswith(("B-", "S-")) or current is None or current["type"] != entity_type:
                    if current is not None:
                        model_spans.append(current)
                    current = {"start": local_start, "end": local_end, "type": entity_type}
                else:
                    current["end"] = local_end
            if current is not None:
                model_spans.append(current)
            for span in model_spans:
                start = int(span["start"])
                end = int(span["end"])
                while start < end and chunk[start].isspace():
                    start += 1
                while end > start and chunk[end - 1].isspace():
                    end -= 1
                span["start"] = start
                span["end"] = end
            predictions = liquid_pii_hybrid_spans(
                chunk,
                [span for span in model_spans if int(span["end"]) > int(span["start"])],
            )
            candidates_by_text[text_index].extend(candidates_from_chunk_predictions(
                texts,
                text_index,
                chunk_start,
                chunk,
                predictions,
                LIQUID_LABEL_MAP,
                placeholder_spans_by_text[text_index],
                50,
            ))
    return candidates_by_text


def gliner2_candidates(
    texts: list[str],
    labels: list[str],
    threshold: float,
    placeholder_spans_by_text: list[list[tuple[int, int]]],
) -> list[list[Candidate]]:
    candidates_by_text: list[list[Candidate]] = [[] for _ in texts]
    jobs = [
        (text_index, chunk_start, chunk)
        for text_index, text in enumerate(texts)
        for chunk_start, chunk in iter_character_chunks(text, MAX_CHARS_PER_CHUNK, CHUNK_OVERLAP)
        if chunk.strip()
    ]
    for batch_start in range(0, len(jobs), INFERENCE_BATCH_SIZE):
        batch = jobs[batch_start:batch_start + INFERENCE_BATCH_SIZE]
        predictions = open_label_model.batch_extract_entities(
            [chunk for _, _, chunk in batch],
            labels,
            threshold=threshold,
            include_confidence=True,
            include_spans=True,
            overlap_policy="allow",
            batch_size=INFERENCE_BATCH_SIZE,
        )
        for (text_index, chunk_start, _), result in zip(batch, predictions, strict=True):
            text = texts[text_index]
            entities_by_label = result.get("entities", {}) if isinstance(result, dict) else {}
            for label, entities in entities_by_label.items():
                for entity in entities if isinstance(entities, list) else []:
                    if not isinstance(entity, dict):
                        continue
                    start = chunk_start + int(entity.get("start", -1))
                    end = chunk_start + int(entity.get("end", -1))
                    score = float(entity.get("confidence", 0.0))
                    if start < 0 or end <= start or end > len(text) or score < threshold:
                        continue
                    if overlaps_placeholder(start, end, placeholder_spans_by_text[text_index]):
                        continue
                    candidates_by_text[text_index].append(Candidate(start, end, str(label), score, 10))
    return candidates_by_text


def chinese_roberta_candidates(
    texts: list[str],
    labels: list[str],
    placeholder_spans_by_text: list[list[tuple[int, int]]],
) -> list[list[Candidate]]:
    candidates_by_text: list[list[Candidate]] = [[] for _ in texts]
    label_map = requested_chinese_boundary_labels(labels)
    if not label_map:
        return candidates_by_text
    jobs = [
        (text_index, chunk_start, chunk)
        for text_index, text in enumerate(texts)
        if CHINESE_TEXT_PATTERN.search(text)
        for chunk_start, chunk in iter_character_chunks(text, CHINESE_MAX_CHARS_PER_CHUNK, CHINESE_CHUNK_OVERLAP)
        if chunk.strip()
    ]
    for batch_start in range(0, len(jobs), INFERENCE_BATCH_SIZE):
        batch = jobs[batch_start:batch_start + INFERENCE_BATCH_SIZE]
        predictions = chinese_boundary_model(
            [chunk for _, _, chunk in batch],
            batch_size=INFERENCE_BATCH_SIZE,
        )
        for (text_index, chunk_start, chunk), entities in zip(batch, predictions, strict=True):
            text = texts[text_index]
            for entity in entities:
                kind = str(entity.get("entity_group", "")).strip().lower()
                label = label_map.get(kind)
                score = float(entity.get("score", 0.0))
                if not label or score < CHINESE_NER_THRESHOLD:
                    continue
                local_start = int(entity.get("start", -1))
                local_end = int(entity.get("end", -1))
                if (local_start == 0 and chunk_start > 0) or (
                    local_end == len(chunk) and chunk_start + len(chunk) < len(text)
                ):
                    continue
                start = chunk_start + local_start
                end = chunk_start + local_end
                if start < 0 or end <= start or end > len(text):
                    continue
                if overlaps_placeholder(start, end, placeholder_spans_by_text[text_index]):
                    continue
                candidates_by_text[text_index].append(Candidate(start, end, label, score, 60))
    return candidates_by_text


def label_token(label: str) -> str:
    token = re.sub(r"[^A-Z0-9]+", "_", label.upper()).strip("_")
    return token or "DATA"


def canonical_replacement_value(value: str, label: str) -> str:
    if label_token(label) in {"MONEY", "AMOUNT", "SALARY"}:
        return canonical_money_value(value)
    return value.casefold()


def redact_texts(
    texts: list[str],
    labels: list[str],
    threshold: float,
) -> tuple[list[str], int, list[RedactionReplacement]]:
    placeholders_by_value: dict[str, str] = {}
    counters: defaultdict[str, int] = defaultdict(int)
    reserved = {match.group(0) for text in texts for match in PLACEHOLDER_PATTERN.finditer(text)}
    output: list[str] = []
    total_entities = 0
    response_replacements: list[RedactionReplacement] = []
    placeholder_spans_by_text = [[match.span() for match in PLACEHOLDER_PATTERN.finditer(text)] for text in texts]
    open_candidates_by_text = gliner2_candidates(texts, labels, threshold, placeholder_spans_by_text)
    liquid_candidates_by_text = liquid_pii_candidates(texts, placeholder_spans_by_text)
    boundary_labels = list(dict.fromkeys([*labels, "person", "company"]))
    roberta_candidates_by_text = chinese_roberta_candidates(texts, boundary_labels, placeholder_spans_by_text)

    for text_index, text in enumerate(texts):
        candidates = regex_candidates(text, placeholder_spans_by_text[text_index])
        candidates.extend(correct_chinese_entity_boundaries(
            text,
            [*open_candidates_by_text[text_index], *liquid_candidates_by_text[text_index]],
            roberta_candidates_by_text[text_index],
        ))
        selected = select_non_overlapping(candidates)
        replacements: list[tuple[int, int, str]] = []
        for candidate in selected:
            value_key = canonical_replacement_value(
                text[candidate.start:candidate.end],
                candidate.label,
            )
            placeholder = placeholders_by_value.get(value_key)
            if placeholder is None:
                token = label_token(candidate.label)
                while True:
                    counters[token] += 1
                    placeholder = f"[SENSITIVE_{token}_{counters[token]}]"
                    if placeholder not in reserved:
                        break
                reserved.add(placeholder)
                placeholders_by_value[value_key] = placeholder
            replacements.append((candidate.start, candidate.end, placeholder))
            response_replacements.append(RedactionReplacement(
                textIndex=text_index,
                start=candidate.start,
                end=candidate.end,
                label=candidate.label,
                placeholder=placeholder,
            ))
        redacted = text
        for start, end, placeholder in reversed(replacements):
            redacted = f"{redacted[:start]}{placeholder}{redacted[end:]}"
        output.append(redacted)
        total_entities += len(replacements)
    return output, total_entities, response_replacements


def pipeline_device():
    normalized = DEVICE.lower()
    if normalized == "cpu":
        return -1
    if normalized.startswith("cuda:"):
        return int(normalized.split(":", 1)[1])
    return 0


open_label_model = AutoExtractor.from_pretrained(MODEL_NAME, map_location=DEVICE)
liquid_pii_tokenizer = load_liquid_tokenizer(LIQUID_PII_MODEL_NAME)
liquid_pii_model = AutoModelForTokenClassification.from_pretrained(
    LIQUID_PII_MODEL_NAME,
    trust_remote_code=True,
).to(DEVICE).eval()
liquid_pii_hybrid_spans = load_liquid_decoder(LIQUID_PII_MODEL_NAME)
chinese_boundary_model = pipeline(
    "token-classification",
    model=CHINESE_NER_MODEL_NAME,
    tokenizer=CHINESE_NER_MODEL_NAME,
    aggregation_strategy="simple",
    device=pipeline_device(),
)
model_lock = threading.Lock()
app = FastAPI(title="WebPilot hybrid sensitive-data filter", docs_url=None, redoc_url=None)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "pipeline": "deterministic -> liquid-pii + gliner2.5-open-label -> chinese-roberta-boundary -> redact",
        "serviceRevision": SERVICE_REVISION,
        "model": MODEL_NAME,
        "piiModel": LIQUID_PII_MODEL_NAME,
        "chineseBoundaryModel": CHINESE_NER_MODEL_NAME,
        "device": DEVICE,
    }


@app.post("/redact", response_model=RedactResponse)
def redact(request: RedactRequest, x_api_key: str | None = Header(default=None)):
    if SERVICE_API_KEY and (x_api_key is None or not hmac.compare_digest(x_api_key, SERVICE_API_KEY)):
        raise HTTPException(status_code=401, detail="Invalid service API key.")
    if len(request.texts) > MAX_REQUEST_TEXTS:
        raise HTTPException(status_code=413, detail="Too many text values in one request.")
    if sum(len(text) for text in request.texts) > MAX_REQUEST_CHARS:
        raise HTTPException(status_code=413, detail="Request text is too large.")

    labels = list(dict.fromkeys(
        label.strip().lower()
        for label in (request.labels or configured_default_labels())
        if label.strip()
    ))
    if not labels or len(labels) > 64:
        raise HTTPException(status_code=422, detail="Provide between 1 and 64 entity labels.")
    threshold = request.threshold if request.threshold is not None else DEFAULT_THRESHOLD

    try:
        with model_lock, torch.inference_mode():
            texts, count, replacements = redact_texts(request.texts, labels, threshold)
    except Exception as error:
        print(f"Sensitive-data inference failed ({type(error).__name__}).", flush=True)
        raise HTTPException(status_code=500, detail="Sensitive-data inference failed.") from None
    return RedactResponse(texts=texts, entities_detected=count, replacements=replacements)
