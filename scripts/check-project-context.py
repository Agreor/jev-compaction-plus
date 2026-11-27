#!/usr/bin/env python3
"""Validate project-context structure and prevent growth beyond its temporary budget."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


POLICY_NAME = ".project-context-policy.json"
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$")


def run_git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ("git", *args), cwd=root, text=True, capture_output=True, check=False
    )


def load_policy(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read policy: {exc}") from exc
    required = {
        "version",
        "context_path",
        "review_lines",
        "temporary_max_lines",
        "enforcement_baseline_lines",
        "required_sections",
        "checker_sha256",
    }
    missing = sorted(required - data.keys())
    if missing:
        raise ValueError(f"policy missing keys: {', '.join(missing)}")
    if data["version"] != 1:
        raise ValueError("policy version must be 1")
    if not isinstance(data["required_sections"], dict) or not data["required_sections"]:
        raise ValueError("required_sections must be a non-empty object")
    review = data["review_lines"]
    maximum = data["temporary_max_lines"]
    baseline = data["enforcement_baseline_lines"]
    if (
        not isinstance(review, int)
        or not isinstance(maximum, int)
        or not isinstance(baseline, int)
        or review < 1
        or maximum < review
        or baseline < 0
    ):
        raise ValueError("line budgets must be positive integers with temporary_max_lines >= review_lines")
    rationale = data.get("override_rationale")
    if (review, maximum) != (180, 220) and not isinstance(rationale, str):
        raise ValueError("non-default line budgets require override_rationale")
    return data


# A line budget stands in for content, and rewrapping defeats it: on 2026-09-09 a
# 220-line context reached 174 lines with every word intact, on 122-character
# lines. Words cannot be rewrapped away. The budget is derived from the line
# budget so no project has to configure a second number; 10 words per line sits
# above a well-wrapped file (measured 7.4 and 7.9 words per line) and below a
# reflowed one (14.1).
WORDS_PER_LINE = 10


def normalized_headings(text: str) -> list[str]:
    headings: list[str] = []
    for line in text.splitlines():
        match = HEADING_RE.match(line)
        if match:
            headings.append(match.group(1).strip().casefold())
    return headings


def resolve_base(root: Path, explicit: str | None) -> str | None:
    if explicit:
        return explicit
    github_base = os.environ.get("GITHUB_BASE_REF")
    if github_base:
        candidate = f"origin/{github_base}"
        if run_git(root, "rev-parse", "--verify", candidate).returncode == 0:
            merge_base = run_git(root, "merge-base", "HEAD", candidate)
            if merge_base.returncode == 0:
                return merge_base.stdout.strip()
    branch = run_git(root, "branch", "--show-current").stdout.strip()
    for candidate in ("origin/main", "origin/master"):
        if branch not in {"main", "master"} and run_git(root, "rev-parse", "--verify", candidate).returncode == 0:
            merge_base = run_git(root, "merge-base", "HEAD", candidate)
            if merge_base.returncode == 0:
                return merge_base.stdout.strip()
    return None


def line_delta(root: Path, context_path: str, base_ref: str | None) -> tuple[int, int]:
    args = ["diff", "--numstat"]
    if base_ref:
        if run_git(root, "rev-parse", "--verify", base_ref).returncode != 0:
            raise ValueError(f"base ref is not available: {base_ref}")
        args.append(base_ref)
    args.extend(("--", context_path))
    result = run_git(root, *args)
    if result.returncode != 0:
        raise ValueError(result.stderr.strip() or "git diff failed")
    added = deleted = 0
    for row in result.stdout.splitlines():
        parts = row.split("\t", 2)
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            added += int(parts[0])
            deleted += int(parts[1])
    return added, deleted


def build_report(root: Path, policy_path: Path, base_ref: str | None = None) -> dict[str, object]:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        policy = load_policy(policy_path)
    except ValueError as exc:
        return {"status": "FAIL", "errors": [str(exc)], "warnings": []}

    expected_hash = str(policy["checker_sha256"])
    actual_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if actual_hash != expected_hash:
        errors.append("managed checker hash does not match policy")

    context_path = str(policy["context_path"])
    context = root / context_path
    try:
        text = context.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"cannot read context: {exc}")
        text = ""

    headings = normalized_headings(text)
    for label, heading in dict(policy["required_sections"]).items():
        if not isinstance(heading, str) or not heading.strip():
            errors.append(f"required section {label} is invalid")
            continue
        count = headings.count(heading.strip().casefold())
        if count == 0:
            errors.append(f"missing required section: {label} ({heading})")
        elif count > 1:
            errors.append(f"duplicate required section: {label} ({heading})")

    lines = len(text.splitlines())
    review = int(policy["review_lines"])
    maximum = int(policy["temporary_max_lines"])
    baseline = int(policy["enforcement_baseline_lines"])
    if lines > review:
        warnings.append(f"context has {lines} lines; review trigger is {review}")
    if lines > maximum:
        warnings.append(f"context has {lines} lines; temporary maximum is {maximum}")

    words = len(text.split())
    review_words = review * WORDS_PER_LINE
    if words > review_words:
        warnings.append(f"context has {words} words; review trigger is {review_words}")

    added = deleted = 0
    resolved_base = resolve_base(root, base_ref)
    try:
        added, deleted = line_delta(root, context_path, resolved_base)
    except ValueError as exc:
        errors.append(str(exc))
    net_growth = added - deleted
    accepted_ceiling = max(maximum, baseline)
    if lines > accepted_ceiling:
        errors.append(
            f"oversized context grew beyond its accepted baseline of {accepted_ceiling} lines; "
            "slim or replace content before appending"
        )

    status = "FAIL" if errors else "WARN" if warnings else "OK"
    return {
        "status": status,
        "context_path": context_path,
        "lines": lines,
        "words": words,
        "review_words": review_words,
        "review_lines": review,
        "temporary_max_lines": maximum,
        "enforcement_baseline_lines": baseline,
        "base_ref": resolved_base,
        "added_lines": added,
        "deleted_lines": deleted,
        "net_growth": net_growth,
        "errors": errors,
        "warnings": warnings,
        "read_only": True,
    }


def print_text(report: dict[str, object]) -> None:
    print(
        "project_context_retention\t"
        f"{report['status']}\t"
        f"lines={report.get('lines', 0)} words={report.get('words', 0)} "
        f"added={report.get('added_lines', 0)} deleted={report.get('deleted_lines', 0)}"
    )
    for message in report.get("errors", []):
        print(f"ERROR\t{message}")
    for message in report.get("warnings", []):
        print(f"WARN\t{message}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--policy", default=POLICY_NAME)
    parser.add_argument("--base-ref")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    policy_path = Path(args.policy)
    if not policy_path.is_absolute():
        policy_path = root / policy_path
    report = build_report(root, policy_path, args.base_ref)
    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text(report)
    return 1 if report["status"] == "FAIL" else 0


if __name__ == "__main__":
    sys.exit(main())
