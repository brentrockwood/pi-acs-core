"""Expose upstream's CaptureGuardian to the real-host TypeScript tests.

The supplied Python environment owns the pinned upstream dependency. Validation
and signing remain upstream; this bridge only starts it and returns its records.
"""
import json
import os
import sys
import unittest

from acs.testing.capture_guardian import CaptureGuardian


def main():
    guardian = CaptureGuardian(hmac_secret=os.environ["ACS_CAPTURE_SECRET"])
    guardian.key_id = os.environ["ACS_CAPTURE_KEY_ID"]

    def tool_request(request):
        command = request["params"]["payload"].get("raw_command", "")
        if "# acs-deny" in command:
            return {"decision": "deny", "reasoning": "capture fixture deny marker"}
        return guardian._default_allow(request)

    guardian.handlers["steps/toolCallRequest"] = tool_request
    # Upstream's generic allow contains a dummy chain head; ping must have none.
    guardian.handlers["system/ping"] = lambda request: {"decision": "allow"}
    with guardian:
        print(json.dumps({"url": guardian.url()}), flush=True)
        sys.stdin.readline()

    errors = []
    if not guardian.captures:
        errors.append("no requests captured")
    try:
        guardian.assert_all_valid(unittest.TestCase())
    except AssertionError as error:
        errors.append(str(error))
    if guardian.duplicate_request_ids():
        errors.append("duplicate request IDs captured")
    report = {
        "captures": [
            {"method": record.method, "parsed": record.parsed, "errors": record.errors}
            for record in guardian.captures
        ],
        "errors": errors,
    }
    print(json.dumps(report), flush=True)
    return bool(errors)


if __name__ == "__main__":
    sys.exit(main())
