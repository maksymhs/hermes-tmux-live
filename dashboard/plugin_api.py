"""tmux-live -- live view of the tmux panes on this host, with keyboard input.

Mounted by the Hermes dashboard at ``/api/plugins/tmux-live/``.

Safety notes:
  * every tmux call is an argv list -- no shell, ever;
  * pane targets are matched against a strict whitelist before they reach
    tmux, so a route cannot smuggle flags or shell metacharacters;
  * writing is limited to ``send-keys`` with literal text or one of a fixed
    set of key names -- there is no command execution endpoint;
  * the dashboard's own auth gate protects every route here.

Socket note: the dashboard service can run with systemd's ``PrivateTmp=yes``,
which hides ``/tmp/tmux-<uid>/default`` behind a private mount. The client
therefore probes the usual places (including the host's ``/tmp`` through
another same-user process) and caches the first socket tmux accepts.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import signal
import subprocess

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()

_FIELD = "\x1f"
_TARGET_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:@%+-]{0,79}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_MAX_LINES = 2000
_MAX_TEXT = 4000
_TIMEOUT = 4.0

# Resolved on the first successful call: "" = tmux's own default socket.
_SOCKET: str | None = None

_CONNECT_ERRORS = ("error connecting to", "no such file or directory")

# tmux says one of these when there is simply nothing to look at.
_NO_SERVER = (
    "no server running",
    "error connecting to",
    "no current server",
    "no sessions",
    "no current session",
)

_ALLOWED_KEYS = {
    "Enter",
    "Escape",
    "Tab",
    "BTab",
    "Space",
    "BSpace",
    "Up",
    "Down",
    "Left",
    "Right",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "DC",
    "IC",
    "C-a",
    "C-c",
    "C-d",
    "C-e",
    "C-k",
    "C-l",
    "C-r",
    "C-u",
    "C-z",
}

_PANE_FORMAT = _FIELD.join(
    (
        "#{session_name}",
        "#{window_index}",
        "#{pane_index}",
        "#{pane_current_command}",
        "#{pane_current_path}",
        "#{pane_width}x#{pane_height}",
        "#{pane_active}",
        "#{window_active}",
        "#{session_attached}",
        "#{session_created}",
    )
)


class _SendBody(BaseModel):
    target: str
    text: str | None = None
    key: str | None = None


class _KillBody(BaseModel):
    target: str
    mode: str  # process | pane | session
    signal: str = "TERM"


def _tmux_bin() -> str:
    path = shutil.which("tmux")
    if not path:
        raise HTTPException(status_code=503, detail="tmux is not installed on this host")
    return path


def _socket_candidates() -> list[str]:
    uid = os.getuid()
    candidates: list[str] = [""]
    tmpdir = os.environ.get("TMUX_TMPDIR")
    if tmpdir:
        candidates.append(os.path.join(tmpdir, f"tmux-{uid}", "default"))
    candidates.append(f"/tmp/tmux-{uid}/default")
    # systemd PrivateTmp=yes gives the dashboard its own /tmp. Another process
    # of the same user (the shell that started tmux, the gateway) still sees
    # the real one, so reach it through that process's root.
    candidates.extend(_host_tmp_sockets(uid))
    # Last resort: PID 1's root, when it lives outside the private namespace.
    candidates.append(f"/proc/1/root/tmp/tmux-{uid}/default")
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        candidates.append(os.path.join(xdg, f"tmux-{uid}", "default"))
    seen: set[str] = set()
    unique: list[str] = []
    for item in candidates:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


def _host_tmp_sockets(uid: int, limit: int = 4) -> list[str]:
    """``/proc/<pid>/root/tmp/tmux-<uid>/default`` for same-user processes."""
    found: list[str] = []
    try:
        pids = [entry for entry in os.listdir("/proc") if entry.isdigit()]
    except OSError:
        return found
    for pid in pids:
        if len(found) >= limit:
            break
        path = f"/proc/{pid}/root/tmp/tmux-{uid}/default"
        try:
            info = os.stat(path)
        except OSError:
            continue
        if info.st_uid == uid:
            found.append(path)
    return found


def _exec(socket: str, args: list[str], timeout: float) -> subprocess.CompletedProcess:
    command = [_tmux_bin()]
    if socket:
        command += ["-S", socket]
    command += args
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="tmux did not answer in time")
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"cannot run tmux: {exc}")


def _run(
    args: list[str],
    timeout: float = _TIMEOUT,
    *,
    cache: bool = True,
    retry: bool = True,
) -> str:
    """Run tmux, resolving the socket once for commands that need a server.

    ``cache=False`` is for ``-V``: it answers without a socket, so caching its
    result would pin the default path and hide a working alternative.
    """
    global _SOCKET
    attempts = [_SOCKET] if _SOCKET is not None else _socket_candidates()
    message = ""
    for socket in attempts:
        proc = _exec(socket, args, timeout)
        if proc.returncode == 0:
            if _SOCKET is None and cache:
                _SOCKET = socket
            return proc.stdout
        message = (proc.stderr or proc.stdout or "").strip()
        if not any(needle in message.lower() for needle in _CONNECT_ERRORS):
            break
    # A cached /proc/<pid>/root socket dies with that process: probe again once.
    if retry and _SOCKET is not None and any(needle in message.lower() for needle in _CONNECT_ERRORS):
        _SOCKET = None
        return _run(args, timeout, cache=cache, retry=False)
    raise HTTPException(status_code=409, detail=message or "tmux failed")


def _check_target(target: str) -> str:
    target = (target or "").strip()
    if not _TARGET_RE.match(target):
        raise HTTPException(status_code=400, detail="invalid pane target")
    return target


def _parse_panes(raw: str) -> list[dict]:
    panes: list[dict] = []
    for line in raw.splitlines():
        parts = line.split(_FIELD)
        if len(parts) != 10:
            continue
        session, window, pane, command, path, size, pane_active, win_active, attached, created = parts
        panes.append(
            {
                "target": f"{session}:{window}.{pane}",
                "session": session,
                "window": window,
                "pane": pane,
                "command": command,
                "path": path,
                "size": size,
                "active": pane_active == "1" and win_active == "1",
                "attached": attached not in ("0", ""),
                "created": int(created) if created.isdigit() else 0,
            }
        )
    return panes


def _panes() -> tuple[bool, list[dict]]:
    """Return (tmux_running, panes)."""
    try:
        raw = _run(["list-panes", "-a", "-F", _PANE_FORMAT])
    except HTTPException as exc:
        message = str(exc.detail).lower()
        if exc.status_code in (409, 503) and any(needle in message for needle in _NO_SERVER):
            return False, []
        raise
    return True, _parse_panes(raw)


@router.get("/health")
def health() -> dict:
    version = ""
    try:
        version = _run(["-V"], cache=False).strip()
    except HTTPException:
        pass
    running, panes = _panes()
    return {
        "tmux": bool(shutil.which("tmux")),
        "version": version,
        "server_running": running,
        "panes": len(panes),
        "socket": _SOCKET or "default",
    }


@router.get("/panes")
def list_panes() -> dict:
    running, panes = _panes()
    return {"server_running": running, "panes": panes}


@router.post("/kill")
def kill(body: _KillBody) -> dict:
    """Stop the pane's foreground process, close the pane, or kill the session."""
    target = _check_target(body.target)
    if body.mode == "pane":
        _run(["kill-pane", "-t", target])
        return {"ok": True, "killed": "pane"}
    if body.mode == "session":
        session = target.split(":", 1)[0]
        _check_target(session)
        _run(["kill-session", "-t", session])
        return {"ok": True, "killed": "session"}
    if body.mode != "process":
        raise HTTPException(status_code=400, detail="unknown kill mode")
    if body.signal not in ("TERM", "KILL", "INT"):
        raise HTTPException(status_code=400, detail="unsupported signal")

    pid = _pane_pid(target)
    if not pid:
        raise HTTPException(status_code=409, detail="tmux did not report a pid for this pane")
    pgid = _foreground_pgid(pid) or _group_of(pid)
    signum = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL, "INT": signal.SIGINT}[body.signal]
    try:
        if pgid > 1:
            os.killpg(pgid, signum)
        else:
            os.kill(pid, signum)
    except ProcessLookupError:
        raise HTTPException(status_code=409, detail="the process is already gone")
    except PermissionError:
        raise HTTPException(status_code=403, detail="not allowed to signal that process")
    return {"ok": True, "killed": "process", "pid": pid, "pgid": pgid, "signal": body.signal}


def _pane_pid(target: str) -> int:
    try:
        raw = _run(["display-message", "-p", "-t", target, "#{pane_pid}"]).strip()
    except HTTPException:
        return 0
    return int(raw) if raw.isdigit() else 0


def _foreground_pgid(pid: int) -> int:
    """The terminal's foreground process group, read from /proc/<pid>/stat."""
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as handle:
            raw = handle.read()
        fields = raw[raw.rfind(")") + 2 :].split()
        return int(fields[5]) if len(fields) > 5 else 0
    except (OSError, ValueError, IndexError):
        return 0


def _group_of(pid: int) -> int:
    try:
        return os.getpgid(pid)
    except OSError:
        return 0



@router.get("/capture")
def capture(
    target: str = Query(..., description="session:window.pane"),
    lines: int = Query(300, ge=1, le=_MAX_LINES),
    ansi: int = Query(1, ge=0, le=1),
) -> dict:
    target = _check_target(target)
    args = ["capture-pane", "-p", "-J", "-t", target, "-S", f"-{lines}"]
    if ansi:
        args.append("-e")
    text = _run(args)
    meta = _run(
        [
            "display-message",
            "-p",
            "-t",
            target,
            _FIELD.join(
                (
                    "#{cursor_x}",
                    "#{cursor_y}",
                    "#{pane_width}",
                    "#{pane_height}",
                    "#{pane_in_mode}",
                    "#{pane_current_command}",
                    "#{pane_current_path}",
                )
            ),
        ]
    ).strip()
    bits = meta.split(_FIELD)
    geometry = {
        "cursor_x": int(bits[0]) if bits[0:1] and bits[0].isdigit() else 0,
        "cursor_y": int(bits[1]) if len(bits) > 1 and bits[1].isdigit() else 0,
        "columns": int(bits[2]) if len(bits) > 2 and bits[2].isdigit() else 0,
        "rows": int(bits[3]) if len(bits) > 3 and bits[3].isdigit() else 0,
        "in_mode": len(bits) > 4 and bits[4] == "1",
        "command": bits[5] if len(bits) > 5 else "",
        "path": bits[6] if len(bits) > 6 else "",
    }
    return {
        "target": target,
        "text": text,
        "hash": hashlib.sha1(text.encode("utf-8", "replace")).hexdigest(),
        **geometry,
    }


@router.post("/send")
def send(body: _SendBody) -> dict:
    target = _check_target(body.target)
    sent: list[str] = []
    if body.text:
        text = _CONTROL_RE.sub("", body.text.replace("\r", "")).replace("\n", " ")[:_MAX_TEXT]
        if text:
            _run(["send-keys", "-t", target, "-l", "--", text])
            sent.append("text")
    if body.key:
        if body.key not in _ALLOWED_KEYS:
            raise HTTPException(status_code=400, detail="unsupported key")
        _run(["send-keys", "-t", target, body.key])
        sent.append(body.key)
    if not sent:
        raise HTTPException(status_code=400, detail="nothing to send")
    return {"ok": True, "sent": sent}
