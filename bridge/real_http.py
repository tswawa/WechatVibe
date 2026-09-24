"""Loopback-only HTTP transport for the real-data chat UI."""
from __future__ import annotations

import json
import mimetypes
import os
import threading
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from real_backend import Backend, ForecastRequestError, WeChatSource, ROOT
from account_store import AccountConflict, AccountNotFound

CHATUI = ROOT / "chatui"


def integer(value, default, maximum):
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, str)) or not str(value).isdigit():
        raise ValueError("invalid limit")
    result = int(value)
    if not 1 <= result <= maximum:
        raise ValueError("limit out of range")
    return result


def user_value(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or any(ord(char) < 32 for char in value):
        raise ValueError("invalid user")
    return value


def request_id_value(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 128 or any(ord(char) < 32 for char in value):
        raise ValueError("invalid requestId")
    return value


def make_handler(backend, accounts=None):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def trusted_request(self):
            port = self.server.server_port
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            origins = {f"http://{host}" for host in hosts}
            origin = self.headers.get("Origin")
            return (self.headers.get("Host") in hosts and
                    (origin is None or origin in origins) and
                    self.path.startswith("/") and not self.path.startswith("//"))

        def send(self, status, body, content_type="application/json; charset=utf-8"):
            payload = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
            try:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # Switching chats cancels obsolete requests. There is no client left to
                # receive a second 503 response; retain the successfully read result.
                self.close_connection = True

        def query(self, path):
            return {key: values[0] for key, values in parse_qs(path.query, keep_blank_values=True).items()}

        def do_GET(self):
            lease = getattr(backend, "request_lease", None)
            try:
                with lease() if callable(lease) else nullcontext():
                    return self._do_GET()
            except RuntimeError:
                return self.send(503, {"error": "bridge-closing"})

        def _do_GET(self):
            if not self.trusted_request():
                return self.send(403, {"error": "forbidden"})
            parsed = urlsplit(self.path)
            try:
                query = self.query(parsed)
                if parsed.path == "/api/health":
                    return self.send(200, backend.health())
                if parsed.path == "/api/runtime":
                    return self.send(200, backend.runtime())
                if parsed.path == "/api/sessions":
                    data = backend.source.sessions()
                    if accounts is not None:
                        accounts.observe(data)
                    return self.send(200, data)
                if parsed.path == "/api/accounts" and accounts is not None:
                    return self.send(200, accounts.list())
                if parsed.path == "/api/messages":
                    return self.send(200, backend.messages(user_value(query.get("user")), integer(query.get("limit"), 80, 500)))
                if parsed.path == "/api/history":
                    return self.send(200, backend.history(
                        user_value(query.get("account")), user_value(query.get("user")),
                        before=query.get("before"), around=query.get("around"),
                        limit=integer(query.get("limit"), 80, 200)))
                if parsed.path == "/api/history/search":
                    return self.send(200, backend.history_search(
                        user_value(query.get("account")), user_value(query.get("user")),
                        query=query.get("q"), day=query.get("date"),
                        before=query.get("before"), limit=integer(query.get("limit"), 50, 100)))
                if parsed.path == "/api/analysis":
                    return self.send(200, backend.analysis(user_value(query.get("user"))))
                if parsed.path == "/api/profile":
                    member = query.get("member")
                    return self.send(200, backend.profile(user_value(query.get("user")),
                        user_value(member) if member else None, retry=query.get("retry") == "1"))
                if parsed.path == "/api/media":
                    image = backend.source.media(user_value(query.get("user")), user_value(query.get("id")))
                    return self.send(200, image[0], image[1]) if image else self.send(404, {
                        "error": "media unavailable",
                        "reason": getattr(getattr(backend.source, "media_reason", None), "value", None)})
                if parsed.path.startswith("/api/"):
                    return self.send(404, {"error": "not found"})
                target = (CHATUI / (parsed.path.lstrip("/") or "index.html")).resolve()
                if not target.is_relative_to(CHATUI.resolve()) or not target.is_file():
                    return self.send(404, {"error": "not found"})
                mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                return self.send(200, target.read_bytes(), mime)
            except ValueError as exc:
                return self.send(400, {"error": str(exc)})
            except Exception as exc:
                return self.send(503, {"error": type(exc).__name__, "message": str(exc)[:200]})

        def do_POST(self):
            lease = getattr(backend, "request_lease", None)
            try:
                with lease() if callable(lease) else nullcontext():
                    return self._do_POST()
            except RuntimeError:
                return self.send(503, {"error": "bridge-closing"})

        def _do_POST(self):
            if not self.trusted_request():
                return self.send(403, {"error": "forbidden"})
            endpoint = urlsplit(self.path).path
            if endpoint not in ("/api/analyze", "/api/predict-reply", "/api/messages/batch", "/api/runtime"):
                return self.send(404, {"error": "not found"})
            content_type = [part.strip().lower() for part in self.headers.get("Content-Type", "").split(";")]
            if content_type[0] != "application/json" or any(part != "charset=utf-8" for part in content_type[1:]):
                return self.send(415, {"error": "application/json required"})
            echo = {}
            try:
                length = integer(self.headers.get("Content-Length"), None, 65536)
                if length is None:
                    raise ValueError("body required")
                request = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(request, dict) or "texts" in request:
                    raise ValueError("invalid request")
                if endpoint == "/api/runtime":
                    if set(request) != {"provider"} or request["provider"] not in ("cpu", "gpu"):
                        raise ValueError("invalid provider")
                    return self.send(200, backend.configure_runtime(request["provider"]))
                if endpoint == "/api/messages/batch":
                    account = user_value(request.get("account"))
                    users = request.get("users")
                    if not isinstance(users, list) or not 1 <= len(users) <= 64:
                        raise ValueError("invalid users")
                    users = [user_value(user) for user in users]
                    if len(set(users)) != len(users):
                        raise ValueError("duplicate users")
                    return self.send(200, backend.message_windows(account, users))
                if endpoint == "/api/predict-reply":
                    echo = {key: request[key] for key in ("user", "account", "requestId")
                            if isinstance(request.get(key), str)}
                    user = user_value(request.get("user"))
                    account = user_value(request.get("account"))
                    request_id = request_id_value(request.get("requestId"))
                    draft = request.get("draft", "")
                    if not isinstance(draft, str) or len(draft) > 2000:
                        raise ValueError("invalid draft")
                    expected = request.get("expectedLastMessageId")
                    if expected is not None:
                        expected = user_value(expected)
                    member = request.get("member")
                    if member is not None:
                        member = user_value(member)
                    return self.send(200, backend.predict_reply(user, account, request_id, draft, expected, member))
                user = user_value(request.get("user"))
                mode = request.get("mode")
                if mode not in ("recent", "history", "incremental"):
                    raise ValueError("invalid mode")
                limit = (None if mode == "incremental" else
                         "all" if mode == "history" and request.get("limit") == "all" else
                         integer(request.get("limit"), 80 if mode == "recent" else 500,
                                 80 if mode == "recent" else 5000))
                return self.send(202, {"job": backend.start(user, mode, limit)})
            except ForecastRequestError as exc:
                return self.send(exc.status, {**echo, "error": exc.code, "message": exc.message})
            except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
                return self.send(400, {**echo, "error": str(exc)})
            except Exception as exc:
                return self.send(503, {**echo, "error": type(exc).__name__, "message": str(exc)[:200]})

        def do_DELETE(self):
            if not self.trusted_request():
                return self.send(403, {"error": "forbidden"})
            path = urlsplit(self.path).path
            prefix = "/api/accounts/"
            if accounts is None or not path.startswith(prefix):
                return self.send(404, {"error": "not found"})
            try:
                result = accounts.delete(path[len(prefix):])
                try:
                    return self.send(200, result)
                finally:
                    if result.get("exitApp"):
                        threading.Thread(target=self.server.shutdown, daemon=True).start()
            except AccountConflict as exc:
                return self.send(409, {"error": "account-busy", "message": str(exc)})
            except AccountNotFound as exc:
                return self.send(404, {"error": "account-not-found", "message": str(exc)})
            except ValueError:
                return self.send(400, {"error": "invalid-account"})
            except OSError:
                return self.send(409, {"error": "account-busy", "message": "账号缓存正在使用，请稍后重试"})
            except Exception:
                return self.send(503, {"error": "account-unavailable", "message": "暂时无法清理账号数据，请稍后重试"})

    return Handler


def main(classifier):
    from account_api import AccountAPI
    backend = Backend(WeChatSource(classifier=classifier))
    port = integer(os.environ.get("CHATUI_PORT"), 8805, 65535)
    accounts = AccountAPI(backend, ROOT / ".local" / "real-client-data")
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(backend, accounts))
    print(f"chatui server on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        backend.shutdown()
    return 0
