#!/usr/bin/env python3
"""Upload local project files to a GitHub repo via API (SSRF-safe)."""
import base64
import ipaddress
import os
import sys
import socket
import threading
from urllib.parse import urlparse
import requests

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
if not GITHUB_TOKEN:
    print("ERROR: GITHUB_TOKEN environment variable is required", file=sys.stderr)
    sys.exit(1)
OWNER = "wangxiangchaosheng-wq"
REPO = "storyboard-character-assets"
BRANCH = "main"
BASE_DIR = r"C:\Users\72952\OneDrive\Desktop\历史游戏"

HEADERS = {
    "Authorization": f"token {GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json",
}
API_BASE = f"https://api.github.com/repos/{OWNER}/{REPO}"


class _SecurityGuard(requests.adapters.HTTPAdapter):
    """Reject any request that does not target allowed hosts after resolution."""

    ALLOWED_HOSTS = {"github.com", "api.github.com"}

    def send(self, request, **kwargs):
        url = request.url
        if not url.startswith("https://"):
            raise requests.exceptions.SSLError(f"Only HTTPS allowed, got: {url}")
        # Parse hostname from URL before sending
        host = urlparse(url).hostname
        if not host:
            raise requests.exceptions.SSLError(f"No hostname in URL: {url}")
        host = host.lower().split(":")[0]
        if host not in self.ALLOWED_HOSTS:
            raise requests.exceptions.SSLError(f"Host {host!r} not in allowed list")
        # Resolve and block private / loopback / link-local IPs
        try:
            addrs = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
        except socket.gaierror as e:
            raise requests.exceptions.ConnectionError(f"DNS resolution failed for {host}: {e}")
        for family, _, __, ___, sockaddr in addrs:
            ip_str = sockaddr[0]
            try:
                ip = ipaddress.ip_address(ip_str)
            except ValueError:
                continue
            if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
                raise requests.exceptions.SSLError(
                    f"Resolved {host} -> {ip_str} is a private/loopback address, blocked"
                )
        return super().send(request, **kwargs)


def _session() -> requests.Session:
    s = requests.Session()
    s.adapters["https://"] = _SecurityGuard()
    s.max_redirects = 0  # Disable redirects to prevent SSRF via 3xx
    return s


sess = _session()


def api_get(path: str) -> dict | None:
    url = f"{API_BASE}/{path}"
    try:
        r = sess.get(url, headers=HEADERS, timeout=15)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 404:
            return None
        print(f"  WARN api_get {path}: {r.status_code} {r.text[:200]}")
        return None
    except Exception as e:
        print(f"  ERROR api_get {path}: {e}")
        return None


def api_put(path: str, payload: dict) -> tuple[bool, str]:
    url = f"{API_BASE}/{path}"
    try:
        r = sess.put(url, headers=HEADERS, json=payload, timeout=60)
        if r.status_code in (200, 201):
            return True, r.json().get("commit", {}).get("sha", "")
        else:
            return False, f"{r.status_code}: {r.text[:300]}"
    except Exception as e:
        return False, str(e)


def upload_file(local_path: str, repo_path: str, sha: str | None, commit_msg: str) -> bool:
    with open(local_path, "rb") as f:
        content = f.read()
    encoded = base64.b64encode(content).decode("utf-8")
    payload = {
        "message": commit_msg,
        "content": encoded,
        "branch": BRANCH,
    }
    if sha:
        payload["sha"] = sha
    ok, info = api_put(f"contents/{repo_path}", payload)
    if ok:
        print(f"  OK   {repo_path}")
    else:
        print(f"  FAIL {repo_path}: {info}")
    return ok


def main():
    skip_dirs = {
        ".git", "node_modules", "out", ".mimosa", ".data", ".v2c",
        "apps/web/dist", "apps/web/node_modules",
        "apps/desktop/node_modules", "apps/mobile/node_modules", "apps/mini/node_modules",
        "packages/engine-core/node_modules", "packages/facts/node_modules",
        "packages/llm/node_modules", "packages/serve/node_modules",
        "packages/topic-pipeline/node_modules", "shared/contracts/node_modules",
        "_refs",
    }
    skip_dirs_abs = {
        "apps/web/.mimosa", "packages/engine-core/.mimosa",
        "packages/facts/.mimosa", "packages/llm/.mimosa",
        "packages/serve/.mimosa", "packages/topic-pipeline/.mimosa",
        "shared/contracts/.mimosa",
    }
    skip_ext = {".log"}

    files_to_upload = []
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        rel = os.path.relpath(root, BASE_DIR)
        # prune .mimosa hidden subdirs at any depth
        if any(p in skip_dirs_abs for p in rel.split(os.sep) if p):
            continue
        for fname in sorted(files):
            fpath = os.path.join(root, fname)
            frel = os.path.relpath(fpath, BASE_DIR)
            if fname in skip_ext:
                continue
            if frel.startswith(".git/") or "node_modules" in frel:
                continue
            if ".mimosa/" in frel:
                continue
            if fname.endswith(".tsbuildinfo") or ".source" in frel:
                continue
            if fname.endswith(".zip"):
                continue
            files_to_upload.append(frel.replace(os.sep, "/"))

    print(f"Will upload {len(files_to_upload)} files...")
    ok, fail = 0, 0
    for frel in files_to_upload:
        data = api_get(f"contents/{frel}")
        sha = data["sha"] if data else None
        if upload_file(os.path.join(BASE_DIR, frel), frel, sha, f"chore: upload {frel}"):
            ok += 1
        else:
            fail += 1

    print(f"\nDone: {ok} OK, {fail} FAIL out of {len(files_to_upload)}")
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
