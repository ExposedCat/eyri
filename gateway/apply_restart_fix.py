"""Patch daily restart adoption in the pinned ibg-controller 0.16.3."""

import sys
from pathlib import Path


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError(f"Unexpected ibg-controller source near {before.splitlines()[0]!r}")
    return source.replace(before, after, 1)


def patch_controller(source):
    source = replace_once(
        source,
        "_AUTO_RESTART_API_TIMEOUT_SECONDS = 180\n",
        """_AUTO_RESTART_API_TIMEOUT_SECONDS = 180
# The login frame can outlive successful saved-session authentication.
# Give Gateway time to open its API before treating the frame as actionable.
_AUTO_RESTART_LOGIN_GRACE_SECONDS = 60
_AUTO_RESTART_LOGIN_STABLE_SECONDS = 5
""",
    )
    source = replace_once(
        source,
        """        deadline = time.monotonic() + _AUTO_RESTART_API_TIMEOUT_SECONDS
        last_status = time.monotonic()
        died = False
        own_login_seen = False
        ready_polls = 0
        while time.monotonic() < deadline:
            if GATEWAY_PROC.poll() is not None:
                died = True
                break
            if is_api_port_open(api_port):
                _alert(log.info, "adopted", new_pid,
                       f"API port {api_port} open — session preserved across "
                       "Gateway's auto-restart, no login and no second factor "
                       "required")
                signal_ready()
                return True
""",
        """        def saved_session_ready():
            if not is_api_port_open(api_port):
                return False
            _alert(log.info, "adopted", new_pid,
                   f"API port {api_port} open — saved session is ready")
            signal_ready()
            return True

        adopted_at = time.monotonic()
        deadline = adopted_at + _AUTO_RESTART_API_TIMEOUT_SECONDS
        login_not_before = adopted_at + _AUTO_RESTART_LOGIN_GRACE_SECONDS
        last_status = adopted_at
        died = False
        own_login_seen = False
        ready_since = None
        while time.monotonic() < deadline:
            if GATEWAY_PROC.poll() is not None:
                died = True
                break
            if saved_session_ready():
                return True
""",
    )
    source = replace_once(
        source,
        """                ready_polls = 0
            elif state == "ready" and ready_polls == 0:
                # Gateway may start that login a moment after showing the
                # window, so look once more before treating it as waiting
                # for us.
                ready_polls = 1
            elif login_window:
""",
        """            now = time.monotonic()
            if state != "ready":
                # A missing or ambiguous LOGIN_STATE is not permission to
                # type into the login form, even if LIST sees its labels.
                ready_since = None
            elif ready_since is None:
                ready_since = now
            if (ready_since is not None and now >= login_not_before
                    and now - ready_since >= _AUTO_RESTART_LOGIN_STABLE_SECONDS):
""",
    )
    return replace_once(
        source,
        """                if _redrive_login(new_app):
                    _alert(log.info, "adopted", new_pid,
                           "session not preserved; full login re-driven on the "
                           "adopted JVM")
                    return True
                _alert(log.warning, "failed_login", new_pid,
                       "login on the adopted Gateway failed; falling back to a "
                       "controller-driven relaunch")
                return False
            else:
                ready_polls = 0
""",
        """                if saved_session_ready():
                    return True
                if _redrive_login(new_app):
                    _alert(log.info, "adopted", new_pid,
                           "session not preserved; full login re-driven on the "
                           "adopted JVM")
                    return True
                # The API may have opened while credential entry was waiting.
                # Keep the live JVM instead of falling through to teardown.
                if is_api_port_open(api_port):
                    _alert(log.info, "adopted", new_pid,
                           "API opened during the login attempt")
                    signal_ready()
                    return True
                _alert(log.warning, "failed_login", new_pid,
                       "login on the adopted Gateway failed; falling back to a "
                       "controller-driven relaunch")
                return False
""",
    )


if __name__ == "__main__":
    path = Path(sys.argv[1])
    updated = patch_controller(path.read_text(encoding="utf-8"))
    compile(updated, str(path), "exec")
    path.write_text(updated, encoding="utf-8")
