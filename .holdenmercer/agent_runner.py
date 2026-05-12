"""
Holden Mercer — background agent runner.

This script runs INSIDE GitHub Actions (the holden-mercer-task.yml workflow)
to execute long-running Claude tasks. The dashboard dispatches the workflow
with a prompt; the workflow runs this script; the script:

    1. Calls Anthropic with a tool-use loop (read/write files, run gate, web fetch).
    2. Writes a summary of what it did to .holdenmercer/tasks/<task_id>.md.
    3. Commits both the work AND the summary.

The dashboard polls the workflow run for status and reads the summary file.

This is intentionally self-contained — no imports from the Holden Mercer
backend. The workflow setup tool drops it at .holdenmercer/agent_runner.py
in your repo. You can edit it freely; re-running setup_task_workflow
overwrites it.

Required env (set by the workflow):
    HM_REPO            owner/repo
    HM_TASK_ID         opaque task id from the dashboard
    HM_PROMPT          user-supplied task prompt
    HM_BRIEF           project brief (system context)
    HM_MODEL           claude-opus-4-7 / etc
    HM_MAX_ITERS       safety cap on tool-use turns (default 30)
    ANTHROPIC_API_KEY  user's BYOK key, stored as a repo secret
    GITHUB_TOKEN       provided by GitHub Actions
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import re
import sys
import time
from typing import Any

import anthropic
import httpx


# ── Config from environment ─────────────────────────────────────────────────

REPO          = os.environ["HM_REPO"]
TASK_ID       = os.environ["HM_TASK_ID"]
PROMPT        = os.environ["HM_PROMPT"]
BRIEF         = os.environ.get("HM_BRIEF", "")
MODEL         = os.environ.get("HM_MODEL", "claude-opus-4-7")
MAX_ITERS     = int(os.environ.get("HM_MAX_ITERS", "30"))
BRANCH        = os.environ.get("HM_BRANCH") or None
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
GH_TOKEN      = os.environ["GITHUB_TOKEN"]

GH_API     = "https://api.github.com"
USER_AGENT = "Holden Mercer Background Agent"

GH_HEADERS = {
    "Authorization":         f"Bearer {GH_TOKEN}",
    "Accept":                "application/vnd.github+json",
    "X-GitHub-Api-Version":  "2022-11-28",
    "User-Agent":            USER_AGENT,
}


# ── Tools the agent can use ─────────────────────────────────────────────────

TOOLS: list[dict] = [
    {
        "name": "read_file",
        "description": "Read a file from this repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path within the repo."},
                "ref":  {"type": "string", "description": "Optional branch / SHA. Default: repo default branch."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_dir",
        "description": "List the contents of a directory in this repository.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path. Empty = repo root."},
                "ref":  {"type": "string"},
            },
        },
    },
    {
        "name": "write_file",
        "description": (
            "Create or overwrite a SINGLE file (one commit). Prefer commit_changes "
            "for multi-file edits."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path":           {"type": "string"},
                "content":        {"type": "string"},
                "commit_message": {"type": "string"},
                "branch":         {"type": "string"},
            },
            "required": ["path", "content", "commit_message"],
        },
    },
    {
        "name": "commit_changes",
        "description": (
            "Make ONE atomic commit touching multiple files. Strongly preferred over "
            "calling write_file many times when a logical change spans multiple files."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "commit_message": {"type": "string"},
                "files": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path":    {"type": "string"},
                            "action":  {"type": "string", "enum": ["create", "update", "delete"]},
                            "content": {"type": "string"},
                        },
                        "required": ["path", "action"],
                    },
                },
                "branch": {"type": "string"},
            },
            "required": ["commit_message", "files"],
        },
    },
    {
        "name": "open_pull_request",
        "description": (
            "Open a PR from a working branch back to the default branch (or a specified base). "
            "Use this AFTER committing your work to a working branch. Returns the PR number."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "head":  {"type": "string"},
                "base":  {"type": "string"},
                "title": {"type": "string"},
                "body":  {"type": "string"},
            },
            "required": ["head", "title"],
        },
    },
    {
        "name": "merge_pull_request",
        "description": (
            "Merge a PR. REFUSES TO MERGE if the Holden Mercer gate isn't ✅ on the head SHA. "
            "Squash-merges by default. This is the regression guarantee: nothing red lands on main."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pull_number":  {"type": "integer"},
                "merge_method": {"type": "string", "enum": ["squash", "merge", "rebase"]},
            },
            "required": ["pull_number"],
        },
    },
    {
        "name": "check_recent_activity",
        "description": (
            "Snapshot of recent commits, open PRs, in-progress workflow runs, and the "
            "active-work manifest. Run this before editing if the agent run has been going "
            "long enough that the world might have changed underneath."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "claim_work",
        "description": (
            "Record this branch in .holdenmercer/active-work.json so concurrent agents see "
            "the claim and avoid colliding. Call right after creating the branch and before editing."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "branch": {"type": "string"},
                "intent": {"type": "string"},
                "scope":  {"type": "array", "items": {"type": "string"}},
            },
            "required": ["branch", "intent"],
        },
    },
    {
        "name": "release_work",
        "description": "Clear this branch's entry from the active-work manifest after merge or abandonment.",
        "input_schema": {
            "type": "object",
            "properties": {"branch": {"type": "string"}},
            "required": ["branch"],
        },
    },
    {
        "name": "delete_file",
        "description": "Delete a file from this repository (real commit). Use sparingly.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path":           {"type": "string"},
                "commit_message": {"type": "string"},
                "branch":         {"type": "string"},
            },
            "required": ["path", "commit_message"],
        },
    },
    {
        "name": "web_fetch",
        "description": "Fetch any public web page or HTML / text URL.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "trigger_gate",
        "description": (
            "Trigger the Holden Mercer gate workflow. Returns immediately with the "
            "run URL — does not wait for completion."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "branch": {"type": "string"},
            },
        },
    },
    {
        "name": "report_result",
        "description": (
            "Call this once when you are done. Pass a one-paragraph summary of what "
            "you accomplished. The agent loop will exit after this is called."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary":  {"type": "string"},
                "success":  {"type": "boolean"},
            },
            "required": ["summary", "success"],
        },
    },
]


# ── Tool implementations ────────────────────────────────────────────────────

class Done(Exception):
    """Raised when the agent calls report_result."""

    def __init__(self, summary: str, success: bool) -> None:
        self.summary = summary
        self.success = success


def _gh(method: str, path: str, **kwargs) -> httpx.Response:
    url = f"{GH_API}/repos/{REPO}{path}"
    return httpx.request(method, url, headers=GH_HEADERS, timeout=30.0, **kwargs)


def tool_read_file(path: str, ref: str | None = None) -> str:
    headers = {**GH_HEADERS, "Accept": "application/vnd.github.raw"}
    params  = {"ref": ref} if ref else None
    resp    = httpx.get(
        f"{GH_API}/repos/{REPO}/contents/{path.lstrip('/')}",
        headers=headers, params=params, timeout=30.0,
    )
    if resp.status_code == 404:
        return f"[not found: {path}]"
    resp.raise_for_status()
    if len(resp.content) > 200_000:
        return f"[refused: {len(resp.content)} bytes, over 200 KB cap]"
    try:
        return resp.text
    except UnicodeDecodeError:
        return "[refused: binary file]"


def tool_list_dir(path: str = "", ref: str | None = None) -> str:
    params = {"ref": ref} if ref else None
    resp   = _gh("GET", f"/contents/{path.lstrip('/')}", params=params)
    if resp.status_code == 404:
        return f"[not found: {path or '(root)'}]"
    resp.raise_for_status()
    items = resp.json()
    if isinstance(items, dict):
        return f"{items.get('type', 'file')}  {items.get('path')}"
    rows = []
    for it in items:
        kind = it.get('type', '?')
        name = it.get('name', '?')
        size = it.get('size', 0)
        suffix = '' if kind == 'dir' else f'  ({size} bytes)'
        rows.append(f"{kind:5}  {name}{suffix}")
    return "\n".join(rows) or "[empty]"


def tool_write_file(path: str, content: str, commit_message: str, branch: str | None = None) -> str:
    branch = branch or BRANCH
    # Resolve existing SHA so we can overwrite cleanly
    params = {"ref": branch} if branch else None
    head = _gh("GET", f"/contents/{path.lstrip('/')}", params=params)
    sha = head.json().get("sha") if head.status_code == 200 else None

    body: dict[str, Any] = {
        "message": commit_message,
        "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
    }
    if sha:    body["sha"]    = sha
    if branch: body["branch"] = branch

    resp = _gh("PUT", f"/contents/{path.lstrip('/')}", json=body)
    if resp.status_code >= 400:
        return f"[error: {resp.status_code} {resp.text[:300]}]"
    sha = resp.json().get("commit", {}).get("sha", "")
    action = "updated" if head.status_code == 200 else "created"
    return f"{action} {path} ({len(content)} bytes, commit {sha[:7]})"


def tool_commit_changes(commit_message: str, files: list[dict], branch: str | None = None) -> str:
    branch = branch or BRANCH
    if not files:
        return "[no files supplied]"

    # Resolve target branch
    target = branch
    if not target:
        r = httpx.get(f"{GH_API}/repos/{REPO}", headers=GH_HEADERS, timeout=20.0)
        r.raise_for_status()
        target = r.json().get("default_branch", "main")

    # Get head ref + base tree
    ref = httpx.get(f"{GH_API}/repos/{REPO}/git/refs/heads/{target}", headers=GH_HEADERS, timeout=20.0)
    if ref.status_code == 404:
        return f"[branch not found: {target}]"
    ref.raise_for_status()
    head_sha = ref.json()["object"]["sha"]
    head_commit = httpx.get(f"{GH_API}/repos/{REPO}/git/commits/{head_sha}", headers=GH_HEADERS, timeout=20.0)
    head_commit.raise_for_status()
    base_tree = head_commit.json()["tree"]["sha"]

    # Build tree entries
    tree_entries: list[dict] = []
    writes = deletes = 0
    for f in files:
        path   = (f.get("path") or "").lstrip("/")
        action = (f.get("action") or "update").lower()
        if not path:
            return "[error: file entry missing 'path']"
        if action == "delete":
            deletes += 1
            tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue
        content = f.get("content") or ""
        blob = httpx.post(
            f"{GH_API}/repos/{REPO}/git/blobs",
            headers=GH_HEADERS, timeout=30.0,
            json={"content": content, "encoding": "utf-8"},
        )
        if blob.status_code >= 400:
            return f"[blob error for {path}: {blob.status_code}]"
        tree_entries.append({
            "path": path, "mode": "100644", "type": "blob", "sha": blob.json()["sha"],
        })
        writes += 1

    new_tree = httpx.post(
        f"{GH_API}/repos/{REPO}/git/trees",
        headers=GH_HEADERS, timeout=30.0,
        json={"base_tree": base_tree, "tree": tree_entries},
    )
    if new_tree.status_code >= 400:
        return f"[tree error: {new_tree.status_code} {new_tree.text[:200]}]"

    commit = httpx.post(
        f"{GH_API}/repos/{REPO}/git/commits",
        headers=GH_HEADERS, timeout=30.0,
        json={"message": commit_message, "tree": new_tree.json()["sha"], "parents": [head_sha]},
    )
    if commit.status_code >= 400:
        return f"[commit error: {commit.status_code} {commit.text[:200]}]"
    new_sha = commit.json()["sha"]

    update = httpx.patch(
        f"{GH_API}/repos/{REPO}/git/refs/heads/{target}",
        headers=GH_HEADERS, timeout=20.0,
        json={"sha": new_sha, "force": False},
    )
    if update.status_code >= 400:
        return f"[ref update error: {update.status_code} {update.text[:200]}]"
    return f"committed {writes} write(s) + {deletes} delete(s) to {target} as {new_sha[:7]} — \"{commit_message}\""


def tool_delete_file(path: str, commit_message: str, branch: str | None = None) -> str:
    branch = branch or BRANCH
    params = {"ref": branch} if branch else None
    head = _gh("GET", f"/contents/{path.lstrip('/')}", params=params)
    if head.status_code == 404:
        return f"[not found: {path}]"
    head.raise_for_status()
    sha = head.json().get("sha")
    body: dict[str, Any] = {"message": commit_message, "sha": sha}
    if branch: body["branch"] = branch
    resp = _gh("DELETE", f"/contents/{path.lstrip('/')}", json=body)
    if resp.status_code >= 400:
        return f"[error: {resp.status_code} {resp.text[:300]}]"
    return f"deleted {path}"


def tool_web_fetch(url: str) -> str:
    if not url or not re.match(r"^https?://", url):
        return "[refused: URL must be absolute http(s)]"
    with httpx.Client(follow_redirects=True, timeout=20.0, headers={"User-Agent": USER_AGENT}) as c:
        resp = c.get(url)
    if resp.status_code >= 400:
        return f"[error: {resp.status_code}]"
    ct = resp.headers.get("content-type", "").lower()
    if not any(t in ct for t in ("text/", "json", "xml", "html", "javascript", "css", "yaml")):
        return f"[refused: content-type {ct!r}]"
    body = resp.text
    if "html" in ct:
        body = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body, flags=re.S | re.I)
        body = re.sub(r"<[^>]+>", " ", body)
    if len(body) > 200_000:
        body = body[:200_000] + "\n…[truncated]"
    return body.strip()


def tool_trigger_gate(branch: str | None = None) -> str:
    branch = branch or BRANCH or "main"
    resp = _gh(
        "POST",
        "/actions/workflows/holden-mercer-gate.yml/dispatches",
        json={"ref": branch},
    )
    if resp.status_code == 404:
        return "[gate workflow not installed in this repo]"
    if resp.status_code >= 400:
        return f"[error: {resp.status_code} {resp.text[:200]}]"
    return f"gate triggered on {branch} — view at https://github.com/{REPO}/actions/workflows/holden-mercer-gate.yml"


def tool_open_pull_request(head: str, title: str, body: str = "", base: str | None = None) -> str:
    if not head or not title:
        return "[error: head + title required]"
    target = base
    if not target:
        r = httpx.get(f"{GH_API}/repos/{REPO}", headers=GH_HEADERS, timeout=20.0)
        r.raise_for_status()
        target = r.json().get("default_branch", "main")
    resp = httpx.post(
        f"{GH_API}/repos/{REPO}/pulls",
        headers=GH_HEADERS, timeout=30.0,
        json={"head": head, "base": target, "title": title, "body": body or ""},
    )
    if resp.status_code >= 400:
        return f"[error: {resp.status_code} {resp.text[:200]}]"
    data = resp.json()
    return (
        f"opened PR #{data.get('number')} ({head} → {target}) — {title}\n"
        f"  {data.get('html_url')}"
    )


def tool_merge_pull_request(pull_number: int, merge_method: str = "squash") -> str:
    if not pull_number:
        return "[error: pull_number required]"
    if merge_method not in ("squash", "merge", "rebase"):
        merge_method = "squash"

    pr = httpx.get(f"{GH_API}/repos/{REPO}/pulls/{pull_number}", headers=GH_HEADERS, timeout=20.0)
    if pr.status_code == 404:
        return f"[PR #{pull_number} not found]"
    pr.raise_for_status()
    p = pr.json()
    head_sha = p.get("head", {}).get("sha", "")
    head_ref = p.get("head", {}).get("ref", "")
    base_ref = p.get("base", {}).get("ref", "")
    if p.get("merged"):
        return f"[PR #{pull_number} is already merged]"

    runs = httpx.get(
        f"{GH_API}/repos/{REPO}/actions/workflows/holden-mercer-gate.yml/runs",
        headers=GH_HEADERS, timeout=20.0,
        params={"head_sha": head_sha, "per_page": 1},
    )
    if runs.status_code == 404:
        return "[REFUSED: gate workflow not installed; install + run before merging]"
    runs.raise_for_status()
    items = runs.json().get("workflow_runs", [])
    if not items:
        return f"[REFUSED: no gate run for {head_sha[:7]} — call trigger_gate first]"
    latest = items[0]
    if latest.get("status") != "completed":
        return f"[REFUSED: gate run still {latest.get('status')!r} on {head_sha[:7]}]"
    if latest.get("conclusion") != "success":
        return (
            f"[REFUSED: gate concluded {latest.get('conclusion')!r} on {head_sha[:7]} — "
            f"main never receives red commits. Fix on this branch + trigger_gate again.]"
        )

    merge = httpx.put(
        f"{GH_API}/repos/{REPO}/pulls/{pull_number}/merge",
        headers=GH_HEADERS, timeout=30.0,
        json={"merge_method": merge_method},
    )
    if merge.status_code >= 400:
        return f"[error: {merge.status_code} {merge.text[:200]}]"
    return f"merged PR #{pull_number} ({head_ref} → {base_ref}) via {merge_method} — gate ✅ on {head_sha[:7]}"


_ACTIVE_WORK_PATH = ".holdenmercer/active-work.json"


def tool_check_recent_activity() -> str:
    repo_info = httpx.get(f"{GH_API}/repos/{REPO}", headers=GH_HEADERS, timeout=20.0)
    repo_info.raise_for_status()
    default_branch = repo_info.json().get("default_branch", "main")

    commits = httpx.get(
        f"{GH_API}/repos/{REPO}/commits",
        headers=GH_HEADERS, timeout=20.0,
        params={"sha": default_branch, "per_page": 10},
    )
    prs = httpx.get(
        f"{GH_API}/repos/{REPO}/pulls",
        headers=GH_HEADERS, timeout=20.0,
        params={"state": "open", "per_page": 10, "sort": "updated", "direction": "desc"},
    )
    runs = httpx.get(
        f"{GH_API}/repos/{REPO}/actions/runs",
        headers=GH_HEADERS, timeout=20.0,
        params={"status": "in_progress", "per_page": 10},
    )

    out = [f"Pre-flight briefing for {REPO} (default branch: {default_branch})", ""]
    if commits.status_code < 400:
        items = commits.json() or []
        out.append(f"## Last {len(items)} commits on {default_branch}")
        for c in items:
            sha = (c.get("sha") or "")[:7]
            msg = (c.get("commit", {}).get("message") or "").split("\n", 1)[0]
            author = c.get("commit", {}).get("author", {}).get("name") \
                or (c.get("author") or {}).get("login") or "?"
            date = c.get("commit", {}).get("author", {}).get("date") or ""
            out.append(f"  {sha}  {date}  {author}: {msg}")
        out.append("")
    if prs.status_code < 400:
        items = prs.json() or []
        out.append(f"## Open PRs ({len(items)})")
        if not items: out.append("  (none)")
        for p in items:
            out.append(
                f"  #{p.get('number')}  {p.get('head', {}).get('ref')} → "
                f"{p.get('base', {}).get('ref')}  by {(p.get('user') or {}).get('login', '?')}: "
                f"{p.get('title')}"
            )
        out.append("")
    if runs.status_code < 400:
        items = runs.json().get("workflow_runs", []) or []
        out.append(f"## In-progress workflow runs ({len(items)})")
        if not items: out.append("  (none)")
        for r in items:
            out.append(f"  run {r.get('id')}  {r.get('name')}  on {r.get('head_branch')}  ({r.get('status')})")
        out.append("")

    manifest = _read_active_work_manifest(default_branch)
    out.append(f"## Active-work manifest ({len(manifest.get('active', []))} entries)")
    if not manifest.get("active"):
        out.append("  (no in-flight branches claimed)")
    else:
        for c in manifest["active"]:
            paths = ", ".join((c.get("scope") or [])[:6]) or "(no scope listed)"
            out.append(f"  {c.get('branch')}  agent={c.get('agent', '?')}")
            out.append(f"    intent: {c.get('intent', '')}")
            out.append(f"    scope:  {paths}")
    return "\n".join(out)


def _read_active_work_manifest(branch: str | None = None) -> dict:
    headers = {**GH_HEADERS, "Accept": "application/vnd.github.raw"}
    params  = {"ref": branch} if branch else None
    r = httpx.get(
        f"{GH_API}/repos/{REPO}/contents/{_ACTIVE_WORK_PATH}",
        headers=headers, params=params, timeout=20.0,
    )
    if r.status_code != 200:
        return {"version": 1, "active": []}
    try:
        data = json.loads(r.text)
    except Exception:
        return {"version": 1, "active": []}
    if not isinstance(data, dict) or not isinstance(data.get("active"), list):
        return {"version": 1, "active": []}
    data.setdefault("version", 1)
    return data


def tool_claim_work(branch: str, intent: str, scope: list[str] | None = None) -> str:
    if not branch or not intent:
        return "[error: branch + intent required]"
    repo_info = httpx.get(f"{GH_API}/repos/{REPO}", headers=GH_HEADERS, timeout=20.0)
    repo_info.raise_for_status()
    default_branch = repo_info.json().get("default_branch", "main")

    manifest = _read_active_work_manifest(default_branch)
    manifest["active"] = [c for c in manifest["active"] if c.get("branch") != branch]
    manifest["active"].insert(0, {
        "branch":    branch,
        "agent":     f"task:{TASK_ID}",
        "scope":     list(scope or []),
        "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "intent":    intent[:240],
    })
    body = json.dumps(manifest, indent=2) + "\n"
    return tool_write_file(
        _ACTIVE_WORK_PATH, body,
        f"chore(active-work): claim {branch}",
        branch=default_branch,
    )


def tool_release_work(branch: str) -> str:
    if not branch:
        return "[error: branch required]"
    repo_info = httpx.get(f"{GH_API}/repos/{REPO}", headers=GH_HEADERS, timeout=20.0)
    repo_info.raise_for_status()
    default_branch = repo_info.json().get("default_branch", "main")

    manifest = _read_active_work_manifest(default_branch)
    before = len(manifest["active"])
    manifest["active"] = [c for c in manifest["active"] if c.get("branch") != branch]
    if len(manifest["active"]) == before:
        return f"[no claim found for {branch}]"
    body = json.dumps(manifest, indent=2) + "\n"
    return tool_write_file(
        _ACTIVE_WORK_PATH, body,
        f"chore(active-work): release {branch}",
        branch=default_branch,
    )


def tool_report_result(summary: str, success: bool) -> str:
    raise Done(summary=summary, success=success)


def run_tool(name: str, inp: dict) -> str:
    try:
        if name == "read_file":      return tool_read_file(inp.get("path", ""), inp.get("ref"))
        if name == "list_dir":       return tool_list_dir(inp.get("path", ""), inp.get("ref"))
        if name == "write_file":     return tool_write_file(inp["path"], inp["content"], inp["commit_message"], inp.get("branch"))
        if name == "commit_changes": return tool_commit_changes(inp["commit_message"], inp.get("files") or [], inp.get("branch"))
        if name == "delete_file":    return tool_delete_file(inp["path"], inp["commit_message"], inp.get("branch"))
        if name == "web_fetch":      return tool_web_fetch(inp.get("url", ""))
        if name == "trigger_gate":   return tool_trigger_gate(inp.get("branch"))
        if name == "open_pull_request":  return tool_open_pull_request(inp.get("head", ""), inp.get("title", ""), inp.get("body", ""), inp.get("base"))
        if name == "merge_pull_request": return tool_merge_pull_request(int(inp.get("pull_number") or 0), inp.get("merge_method") or "squash")
        if name == "check_recent_activity": return tool_check_recent_activity()
        if name == "claim_work":         return tool_claim_work(inp.get("branch", ""), inp.get("intent", ""), inp.get("scope") or [])
        if name == "release_work":       return tool_release_work(inp.get("branch", ""))
        if name == "report_result":  return tool_report_result(inp["summary"], bool(inp.get("success", True)))
        return f"[unknown tool: {name}]"
    except Done:
        raise
    except Exception as exc:
        return f"[tool error: {type(exc).__name__}: {exc}]"


# ── System prompt + agent loop ──────────────────────────────────────────────

SYSTEM_PROMPT = f"""You are a background build agent for project repo {REPO}.
You run autonomously inside GitHub Actions — there is no user to ask follow-up
questions. Make decisions, commit changes, then call `report_result` exactly
once when finished.

{('Project brief:' + chr(10) + BRIEF) if BRIEF.strip() else 'No project brief was provided.'}

Tools:
  - read_file(path), list_dir(path) — explore the repo
  - write_file(path, content, commit_message, branch?) — single-file commit
  - commit_changes(commit_message, files=[{{path, action, content}}], branch?) — ATOMIC
    multi-file commit (preferred when a logical change touches several files)
  - delete_file(path, commit_message, branch?) — remove files (sparingly)
  - web_fetch(url) — pull external context
  - trigger_gate(branch?) — fire the lint/typecheck/tests workflow
  - open_pull_request(head, title, body?, base?) — open a PR from a working branch
  - merge_pull_request(pull_number, merge_method?) — merges ONLY if the gate is ✅
    on the head SHA. Refuses otherwise. The regression guarantee: nothing red lands
    on main.
  - report_result(summary, success) — REQUIRED: call this when done with a one-paragraph
    summary + a success boolean.

DOCTRINE — flywheel-first, don't break what's working:
  This session was bootstrapped from the project's FLYWHEEL — the brief, any
  invariants, recent commits, open PRs, in-flight runs, active claims. They're
  in your prior assistant turn. You have already acknowledged them. Respect them.

  0. RE-CHECK: if anything in your plan touches code where you're uncertain
     about current state, call check_recent_activity() to refresh. If a planned
     file is in another open PR's diff or another agent's claimed scope, branch
     from THAT branch — don't race.
  1. Work on a feature branch named `claude/<short-task>` — NEVER commit directly
     to the default branch.
  2. claim_work(branch, intent, scope) — record your claim BEFORE editing so
     concurrent agents see it.
  3. Make your edits — atomic commits via commit_changes when multi-file.
  4. trigger_gate() with branch=<your branch>. If it fails, fix + retry.
  5. open_pull_request(head=<your branch>, title=…) — record the PR number.
  6. merge_pull_request(pull_number=<number>) — refuses if gate isn't green.
  7. release_work(branch) — clear your manifest entry now that it's shipped.

If `.holdenmercer/invariants.md` exists in the repo, READ IT FIRST. It lists
things that must not break. Treat each item as a hard constraint.

When you write production code, also write/update its test in the same commit.

Be decisive. You will not get another chance to ask the user.
"""


def _build_flywheel_bootstrap() -> list[dict]:
    """Returns a synthetic [user, assistant] pair that loads the project's
    flywheel — brief, invariants, recent activity, claims — into the agent's
    very first conversational turn. Same purpose as the Console version: the
    agent literally starts having acknowledged canonical state."""
    parts: list[str] = [f"# Flywheel snapshot — {REPO}", ""]

    if BRIEF.strip():
        parts += ["## Brief", BRIEF.strip()[:4000], ""]

    # Invariants
    headers = {**GH_HEADERS, "Accept": "application/vnd.github.raw"}
    inv = httpx.get(
        f"{GH_API}/repos/{REPO}/contents/.holdenmercer/invariants.md",
        headers=headers, timeout=20.0,
    )
    if inv.status_code == 200 and inv.text.strip():
        text = inv.text[:4000]
        parts += ["## Invariants (must NOT break)", text, ""]

    # Recent activity (commits / PRs / runs / active claims)
    try:
        parts += ["## Recent activity", "```", tool_check_recent_activity()[:4000], "```", ""]
    except Exception as exc:
        parts += [f"_(recent-activity fetch failed: {exc})_", ""]

    parts += [
        "---",
        (
            "I have loaded the flywheel. I will respect the brief, the invariants, "
            "the active-work claims, and the gate-protected branch+PR workflow on "
            "every change. Before any commit I will (1) create_github_branch, "
            "(2) claim_work, then edit, run_gate, open_pull_request, "
            "merge_pull_request (gate-protected), release_work."
        ),
    ]

    return [
        {"role": "user",      "content": "Initialize. Load the project flywheel state and confirm."},
        {"role": "assistant", "content": "\n".join(parts)},
    ]


def run() -> dict:
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY, timeout=120.0)
    messages: list[dict] = _build_flywheel_bootstrap() + [
        {"role": "user", "content": PROMPT},
    ]
    transcript: list[str] = []
    started = time.time()
    summary  = ""
    success  = False

    for i in range(MAX_ITERS):
        resp = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )

        assistant_blocks: list[dict] = []
        tool_uses: list[dict] = []
        for block in resp.content:
            if block.type == "text":
                if block.text.strip():
                    transcript.append(block.text.strip())
                assistant_blocks.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                assistant_blocks.append({
                    "type": "tool_use", "id": block.id, "name": block.name, "input": block.input,
                })
                tool_uses.append({"id": block.id, "name": block.name, "input": block.input})

        messages.append({"role": "assistant", "content": assistant_blocks})

        if resp.stop_reason != "tool_use" or not tool_uses:
            # Model stopped without calling report_result; treat as success-ish if it produced text
            summary = (transcript[-1] if transcript else "Agent finished without calling report_result.")
            break

        tool_results = []
        for tu in tool_uses:
            print(f"::group::tool {tu['name']}")
            print(json.dumps(tu["input"])[:1000])
            try:
                output = run_tool(tu["name"], tu["input"])
            except Done as done:
                summary = done.summary
                success = done.success
                tool_results.append({
                    "type": "tool_result", "tool_use_id": tu["id"],
                    "content": "Acknowledged. Exiting agent loop.",
                })
                messages.append({"role": "user", "content": tool_results})
                print("::endgroup::")
                return {"summary": summary, "success": success, "iters": i + 1, "duration_s": int(time.time() - started)}
            except Exception as exc:
                output = f"[tool crashed: {type(exc).__name__}: {exc}]"
            print(output[:1000])
            print("::endgroup::")
            tool_results.append({
                "type": "tool_result", "tool_use_id": tu["id"], "content": output,
            })
        messages.append({"role": "user", "content": tool_results})

    return {
        "summary":  summary or "Hit max iterations without report_result.",
        "success":  success,
        "iters":    MAX_ITERS,
        "duration_s": int(time.time() - started),
    }


def write_result(payload: dict) -> None:
    """Commit the result file so the dashboard can pick it up."""
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    body = (
        f"# Task `{TASK_ID}`\n\n"
        f"- **Status**: {'✅ success' if payload['success'] else '❌ ended without success'}\n"
        f"- **Model**: {MODEL}\n"
        f"- **Iterations**: {payload['iters']}\n"
        f"- **Duration**: {payload['duration_s']}s\n"
        f"- **Finished**: {now}\n\n"
        f"## Prompt\n\n{PROMPT}\n\n"
        f"## Summary\n\n{payload['summary']}\n"
    )
    msg = f"task({TASK_ID}): {'success' if payload['success'] else 'finished'}"
    print(tool_write_file(f".holdenmercer/tasks/{TASK_ID}.md", body, msg))


if __name__ == "__main__":
    try:
        result = run()
    except Exception as exc:
        result = {
            "summary":    f"Agent crashed: {type(exc).__name__}: {exc}",
            "success":    False,
            "iters":      0,
            "duration_s": 0,
        }
    print("::group::result")
    print(json.dumps(result, indent=2))
    print("::endgroup::")
    write_result(result)
    # Exit non-zero on failure so the workflow run shows red
    sys.exit(0 if result["success"] else 1)
