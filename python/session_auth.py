"""Verify website cookies with their issuer before trusting a user ID."""
import json
import os
from functools import wraps
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from flask import g, request


def require_session(handler):
    @wraps(handler)
    def protected(*args, **kwargs):
        cookie = request.cookies.get("ss_session")
        if not cookie:
            return {"error": "Sign in first"}, 401
        auth_url = os.environ.get("WEB_AUTH_URL", "http://127.0.0.1:3001").rstrip("/")
        verification = Request(
            auth_url + "/api/auth/session",
            headers={"Cookie": "ss_session=" + quote(cookie, safe="")},
        )
        try:
            with urlopen(verification, timeout=5) as response:
                session = json.load(response)
            user_id = session.get("user_id")
            if not isinstance(user_id, str) or not user_id:
                return {"error": "Invalid session"}, 401
        except HTTPError as error:
            if error.code in (401, 403):
                return {"error": "Invalid or expired session"}, 401
            return {"error": "Unable to verify session"}, 503
        except (URLError, TimeoutError, ValueError, AttributeError):
            return {"error": "Unable to verify session"}, 503
        g.user_id = user_id
        return handler(*args, **kwargs)

    return protected
