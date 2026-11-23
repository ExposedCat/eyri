"""Exercise the patched controller without launching Gateway or using an account.

Run this with Python inside the built image, or set IBG_CONTROLLER_SOURCE to
the path of a patched controller file.
"""

import os
import runpy
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch


controller = runpy.run_path(
    os.environ.get(
        "IBG_CONTROLLER_SOURCE",
        "/home/ibgateway/scripts/gateway_controller.py",
    ),
)
adopt_gateway = controller["_adopt_self_restarted_gateway"]


class RestartAdoptionTest(unittest.TestCase):
    def adopt(self, port_opens_at, login_state, relogin_succeeds=False, port_after_relogin=False):
        clock = SimpleNamespace(seconds=0)
        clock.monotonic = lambda: clock.seconds

        def sleep(seconds):
            clock.seconds += seconds

        clock.sleep = sleep
        relogins = []

        def redrive_login(_app):
            relogins.append(clock.seconds)
            return relogin_succeeds

        def port_is_open(_port):
            return (port_opens_at is not None and clock.seconds >= port_opens_at
                    or port_after_relogin and bool(relogins))

        ready = Mock()
        with patch.dict(adopt_gateway.__globals__, {
            "time": clock,
            "_install4j_restarter_age": lambda: 1,
            "_install4j_restarter_mtime": lambda: None,
            "_wait_for_self_restarted_agent": Mock(return_value=5020),
            "_AdoptedProcess": Mock(return_value=SimpleNamespace(poll=lambda: None)),
            "find_app": Mock(),
            "is_api_port_open": port_is_open,
            "agent_list": lambda: ({"Username", "Password"}, set()),
            "agent_login_state": lambda: login_state(clock.seconds),
            "agent_windows": lambda: [],
            "_is_ibkr_maintenance_window": lambda: False,
            "_redrive_login": redrive_login,
            "signal_ready": ready,
        }):
            adopted = adopt_gateway("Gateway's daily restart", exit_code=0)
        return adopted, relogins, ready.call_count

    def test_saved_session_opens_the_api_while_login_window_is_still_visible(self):
        for state in (None, "ready"):
            with self.subTest(state=state):
                self.assertEqual(self.adopt(35, lambda _: state), (True, [], 1))

    def test_login_can_proceed_when_a_fresh_sign_in_is_required(self):
        self.assertEqual(
            self.adopt(None, lambda _: "ready", relogin_succeeds=True),
            (True, [60], 0),
        )

    def test_inconclusive_poll_resets_the_login_prompt_timer(self):
        self.assertEqual(
            self.adopt(None, lambda now: None if now == 60 else "ready",
                       relogin_succeeds=True),
            (True, [66], 0),
        )

    def test_missing_login_state_does_not_submit_credentials(self):
        self.assertEqual(self.adopt(None, lambda _: None), (False, [], 0))

    def test_gateway_that_becomes_ready_during_login_is_kept(self):
        self.assertEqual(
            self.adopt(None, lambda _: "ready", port_after_relogin=True),
            (True, [60], 1),
        )

    def test_failed_login_without_api_readiness_still_requests_relaunch(self):
        self.assertEqual(self.adopt(None, lambda _: "ready"), (False, [60], 0))


if __name__ == "__main__":
    unittest.main()
