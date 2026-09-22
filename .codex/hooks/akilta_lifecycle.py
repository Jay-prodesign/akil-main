#!/usr/bin/env python3
"""AKILTA repo-local lifecycle hooks.

This script is a guardrail, not a source of project authority. It keeps output
small and points the agent back to the existing AKILTA canonical workflow.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Callable


PROJECT = "AKILTA"
MUTATION_TOOL_RE = re.compile(r"(create|update|delete|write|edit|mutate|publish|merge|push|apply|replace)", re.I)
CROSS_PROJECT_RE = re.compile(
    r"(BestPrintsCo|Best Prints Co|\bBPC\b|AI Commerce|Akilta Commerce|akilta-commerce|FVCKU|fvcku)",
    re.I,
)
PROVIDER_MUTATION_RE = re.compile(
    r"(themePublish|themes?/\d+|OnlineStoreTheme/\d+|theme[_-]?id\s*[:=]\s*\d+|--theme\s+\d+|gid://shopify/OnlineStoreTheme/\d+)",
    re.I,
)
MAIN_LIVE_RE = re.compile(r"\b(MAIN|main|live|production)\b", re.I)
WRITE_COMMAND_RE = re.compile(
    r"(^|\s)(rm|mv|cp|git\s+push|git\s+merge|git\s+rebase|git\s+reset|sed\s+-i|tee|chmod|chown|npm\s+version)\b|>>|>[^&]",
    re.I,
)
STOP_PROOF_RE = re.compile(
    r"STOP_CLASS\s*[:=]\s*[A-G].*BLOCKED_EDGE.*WHY_NO_OTHER_READY_WORK.*NEXT_WAKE_TRIGGER.*NEXT_EXACT_ACTION",
    re.I | re.S,
)
GENUINE_GATE_RE = re.compile(
    r"(genuine|real|actual)\s+(Founder|Owner).{0,80}gate|OWNER_GATE\s*[:=]\s*(OPEN|REQUIRED)|FOUNDER_GATE\s*[:=]\s*(OPEN|REQUIRED)",
    re.I | re.S,
)
MICRO_STOP_RE = re.compile(
    r"(waiting for|wait for|pending)\s+(Brain|review|continue|devam)|\b(devam|continue)\b.*\?|should I continue|ask .*Founder.*continue|IMPLEMENTED\b.*(stop|pause|wait)",
    re.I | re.S,
)


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")))


def read_event() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {"hook_event_name": "UNKNOWN", "_raw": raw}
    return value if isinstance(value, dict) else {"hook_event_name": "UNKNOWN", "value": value}


def compact_text(value: Any, limit: int = 12000) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value[:limit]
    try:
        return json.dumps(value, ensure_ascii=True)[:limit]
    except TypeError:
        return str(value)[:limit]


def is_mutation_tool(event: dict[str, Any]) -> bool:
    name = str(event.get("tool_name") or "")
    if name == "apply_patch":
        return True
    if name == "Bash":
        command_text = compact_text(event.get("tool_input"))
        return bool(
            WRITE_COMMAND_RE.search(command_text)
            or PROVIDER_MUTATION_RE.search(command_text)
            or re.search(r"\b(push|publish|mutate|update|write|delete|replace)\b", command_text, re.I)
        )
    return bool(MUTATION_TOOL_RE.search(name))


def deny(reason: str) -> dict[str, Any]:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }


def pre_tool_use(event: dict[str, Any]) -> dict[str, Any] | None:
    if not is_mutation_tool(event):
        return None

    tool_name = str(event.get("tool_name") or "")
    text = compact_text(event.get("tool_input"))

    if CROSS_PROJECT_RE.search(text):
        return deny(
            "AKILTA project-isolation guard: this mutation mentions another project. "
            "Recompile AKILTA context and do not mutate foreign repositories/providers."
        )

    if tool_name.startswith("mcp__codex_apps__github") and MUTATION_TOOL_RE.search(tool_name):
        args = event.get("tool_input") if isinstance(event.get("tool_input"), dict) else {}
        repo = str(args.get("repository_full_name") or args.get("repo_full_name") or "")
        branch = args.get("branch")
        path = str(args.get("path") or "")
        if repo and repo != "Jay-prodesign/akil-main":
            return deny("AKILTA GitHub guard: mutation target is not Jay-prodesign/akil-main.")
        if branch in (None, "", "main", "master"):
            return deny(
                "AKILTA GitHub guard: direct default-branch mutation is blocked. "
                "Use the current authorized task/governance branch and exact-head readback."
            )
        if CROSS_PROJECT_RE.search(path):
            return deny("AKILTA GitHub guard: path appears to target a foreign project.")

    if PROVIDER_MUTATION_RE.search(text):
        if MAIN_LIVE_RE.search(text) or "themePublish" in text:
            return deny(
                "AKILTA provider guard: MAIN/live or publish mutation is protected/read-only. "
                "Fresh-read current authority; use only the dynamically resolved writable target."
            )
        return deny(
            "AKILTA provider guard: mutable provider target ID detected. "
            "Run akilta-context-compiler/provider-safe-write with fresh readback before retrying."
        )

    if re.search(r"git\s+push\s+[^\n]*(\s|:)main\b|git\s+push\s+origin\s+HEAD:main\b", text, re.I):
        return deny("AKILTA git guard: pushing directly to main is blocked.")

    return None


def session_start(event: dict[str, Any]) -> dict[str, Any]:
    source = event.get("source", "startup")
    context = (
        "AKILTA bootstrap: PROJECT=AKILTA. Before material action, use "
        "akilta-context-compiler to resolve actor, AA-002 Current Project State, "
        "AA-004 Session Bootstrap, Active Authority/Execution Capsule, current "
        "handoff/task, and live repo/provider evidence when decision-relevant. "
        "Do not execute from conversation memory. Historical/superseded/cold "
        "artifacts are non-runtime. Resolve writable targets dynamically. "
        "Missing continue/devam is never a stop predicate. Source=%s."
    ) % source
    return {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }


def post_tool_use(event: dict[str, Any]) -> dict[str, Any] | None:
    if not is_mutation_tool(event):
        return None
    response_text = compact_text(event.get("tool_response"), limit=6000)
    if re.search(r"\\berror\\b|failed|conflict|stale|not found|403|denied", response_text, re.I):
        return {
            "decision": "block",
            "reason": (
                "AKILTA write-result verifier: mutation response contains failure/conflict language. "
                "Do not claim success; fresh-read target state, reconcile inside the same authorized mission, "
                "and preserve only bounded evidence."
            ),
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": "Write verification failed or is ambiguous; readback is required before VERIFIED/COMPLETED claims.",
            },
        }
    return {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": (
                "AKILTA write-result verifier: mutation-capable tool completed. "
                "Do provider/repository readback and invariant verification before claiming PROVIDER_PASS, VERIFIED, COMPLETED, RELEASED, LIVE, or VISUAL_PASS."
            ),
        }
    }


def pre_compact(_: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "Before compaction preserve only: PROJECT, ACTOR, OBJECTIVE, CURRENT TASK, "
        "CAPSULE_FINGERPRINT, CURRENT TARGET, exact HEAD/REVISION where necessary, "
        "OWNER_GATES, EVIDENCE POINTERS, NEXT_ACTION. Do not preserve broad history "
        "as runtime authority."
    )
    return {"hookSpecificOutput": {"hookEventName": "PreCompact", "additionalContext": fields}}


def post_compact(_: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "After compaction, reconcile AKILTA capsule fingerprints against current canonical/live sources. "
        "If unchanged, resume unchanged state. If an admitted source changed, recompile only affected fields. "
        "Never recover authority from old conversation prose when canonical state is available."
    )
    return {"hookSpecificOutput": {"hookEventName": "PostCompact", "additionalContext": fields}}


def stop(event: dict[str, Any]) -> dict[str, Any]:
    if event.get("stop_hook_active"):
        return {"systemMessage": "AKILTA continuation guard allowed stop after one bounded re-entry check."}

    msg = str(event.get("last_assistant_message") or "")
    if STOP_PROOF_RE.search(msg) or GENUINE_GATE_RE.search(msg):
        return {}

    if MICRO_STOP_RE.search(msg):
        return {
            "decision": "block",
            "reason": (
                "AKILTA CONTINUATION GUARD: before stopping, ask whether another dependency-safe, "
                "reversible, scope-valid action is already authorized now. A finished microstep, "
                "pending review, IMPLEMENTED state, or missing continue/devam is not enough to stop. "
                "Either continue that next action, or produce STOP_CLASS/BLOCKED_EDGE/"
                "WHY_NO_OTHER_READY_WORK/NEXT_WAKE_TRIGGER/NEXT_EXACT_ACTION."
            ),
        }

    return {}


def session_end(_: dict[str, Any]) -> dict[str, Any]:
    return {
        "systemMessage": (
            "AKILTA SessionEnd: close out only objective, starting/current state, completed work, "
            "material artifacts changed, verification/evidence result, unresolved blocker, genuine owner decision, "
            "next valid action, and learning disposition if current authority requires it."
        )
    }


HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any] | None]] = {
    "SessionStart": session_start,
    "PreToolUse": pre_tool_use,
    "PostToolUse": post_tool_use,
    "PreCompact": pre_compact,
    "PostCompact": post_compact,
    "Stop": stop,
    "SessionEnd": session_end,
}


@dataclass
class Scenario:
    name: str
    event: dict[str, Any]
    expect: Callable[[dict[str, Any] | None], bool]


def run_self_tests() -> int:
    def blocked(result: dict[str, Any] | None) -> bool:
        return bool(result and result.get("hookSpecificOutput", {}).get("permissionDecision") == "deny")

    def continues(result: dict[str, Any] | None) -> bool:
        return bool(result and result.get("decision") == "block")

    def allows(result: dict[str, Any] | None) -> bool:
        return result in (None, {}) or ("permissionDecision" not in compact_text(result))

    scenarios = [
        Scenario(
            "TEST 1 - stale provider target denied",
            {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "shopify theme push --theme 111111"}},
            blocked,
        ),
        Scenario(
            "TEST 2 - MAIN protection denied",
            {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "themePublish gid://shopify/OnlineStoreTheme/222222 MAIN"}},
            blocked,
        ),
        Scenario(
            "TEST 3 - no dvm micro-stop continues",
            {"hook_event_name": "Stop", "last_assistant_message": "Implemented. Waiting for devam before next small safe task."},
            continues,
        ),
        Scenario(
            "TEST 4 - real owner gate stops cleanly",
            {"hook_event_name": "Stop", "last_assistant_message": "OWNER_GATE: REQUIRED. STOP_CLASS=A BLOCKED_EDGE=publish WHY_NO_OTHER_READY_WORK=none NEXT_WAKE_TRIGGER=Founder approval NEXT_EXACT_ACTION=publish if approved"},
            allows,
        ),
        Scenario(
            "TEST 5 - no ready work stop proof stops cleanly",
            {"hook_event_name": "Stop", "last_assistant_message": "STOP_CLASS=F BLOCKED_EDGE=all candidates WHY_NO_OTHER_READY_WORK=scan exhausted NEXT_WAKE_TRIGGER=new evidence NEXT_EXACT_ACTION=fresh scan"},
            allows,
        ),
        Scenario(
            "TEST 6 - compaction context emitted",
            {"hook_event_name": "PreCompact", "trigger": "auto"},
            lambda r: "CAPSULE_FINGERPRINT" in compact_text(r),
        ),
        Scenario(
            "TEST 7 - source-only visual cannot be visual pass",
            {"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "python source_audit.py > report.txt"}, "tool_response": {"exit_code": 0}},
            lambda r: r is not None and "before claiming" in compact_text(r),
        ),
        Scenario(
            "TEST 8 - actual render evidence is not blocked",
            {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "npx playwright test visual.spec.ts"}},
            allows,
        ),
        Scenario(
            "TEST 9 - exact-head review changed head reminder",
            {"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "git push origin branch"}, "tool_response": {"output": "new head abc123"}},
            lambda r: "readback" in compact_text(r).lower(),
        ),
        Scenario(
            "TEST 10 - cross-project mutation denied",
            {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "python mutate.py BestPrintsCo"}},
            blocked,
        ),
        Scenario(
            "TEST 11 - readback mismatch blocks success claim",
            {"hook_event_name": "PostToolUse", "tool_name": "mcp__codex_apps__github._update_file", "tool_input": {"repository_full_name": "Jay-prodesign/akil-main", "branch": "claude/x", "path": "x"}, "tool_response": {"error": "readback invariant failed"}},
            continues,
        ),
        Scenario(
            "TEST 12 - connector outage scopes only dependent edge",
            {"hook_event_name": "SessionStart", "source": "resume"},
            lambda r: "connector" in compact_text(r).lower() or "provider" in compact_text(r).lower(),
        ),
    ]
    failures: list[str] = []
    for scenario in scenarios:
        handler = HANDLERS.get(str(scenario.event["hook_event_name"]))
        result = handler(scenario.event) if handler else None
        if not scenario.expect(result):
            failures.append(f"{scenario.name}: {result}")
    if failures:
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1
    for scenario in scenarios:
        print(f"PASS {scenario.name}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return run_self_tests()

    event = read_event()
    handler = HANDLERS.get(str(event.get("hook_event_name") or ""))
    if not handler:
        return 0
    result = handler(event)
    if result:
        emit(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
