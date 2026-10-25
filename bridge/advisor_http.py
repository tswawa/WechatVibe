"""Allowlisted HTTP projection for the read-only Advisor feature."""
from advisor_contracts import AdvisorError


POST_PATHS = frozenset({"/api/advisor/templates", "/api/advisor/skills", "/api/advisor/context",
                        "/api/advisor/run", "/api/advisor/stop", "/api/advisor/new-thread",
                        "/api/advisor/threads/delete",
                        "/api/advisor/import/preview", "/api/advisor/import/commit", "/api/advisor/import/cancel"})
GET_PATHS = frozenset({"/api/advisor/catalog", "/api/advisor/thread", "/api/advisor/threads",
                       "/api/advisor/events"})


def _shape(request, required, optional=()):
    if not isinstance(request, dict) or not set(required) <= request.keys() or not request.keys() <= set(required) | set(optional):
        raise AdvisorError("invalid-request", "请求参数不正确")


def get(service, path, query):
    if path == "/api/advisor/catalog":
        _shape(query, ())
        return service.catalog()
    if path == "/api/advisor/thread":
        _shape(query, ("account", "user", "agentId"), ("threadId",))
        thread_id = query.get("threadId")
        if thread_id is not None and not isinstance(thread_id, str):
            raise AdvisorError("invalid-request", "会话编号不正确")
        return service.thread(query["account"], query["user"], query["agentId"], thread_id)
    if path == "/api/advisor/threads":
        _shape(query, ("account", "user", "agentId"))
        return service.threads(query["account"], query["user"], query["agentId"])
    if path == "/api/advisor/events":
        _shape(query, ("account", "user", "runId"), ("after",))
        raw = query.get("after", "0")
        if not isinstance(raw, str) or not raw.isdecimal() or len(raw) > 12:
            raise AdvisorError("invalid-request", "事件位置不正确")
        return service.events(query["account"], query["user"], query["runId"], int(raw))
    raise AdvisorError("invalid-request", "接口不存在")


def post(service, path, request):
    if path == "/api/advisor/import/preview":
        _shape(request, ("source",))
        return service.preview_assistant_import(request["source"])
    if path == "/api/advisor/import/commit":
        _shape(request, ("previewId", "requestId", "agent"), ("acceptPartial",))
        return service.commit_assistant_import(request["previewId"], request["requestId"], request["agent"], request.get("acceptPartial", False))
    if path == "/api/advisor/import/cancel":
        _shape(request, ("previewId",))
        return service.cancel_assistant_import(request["previewId"])
    if path == "/api/advisor/templates":
        action = request.get("action")
        if action == "save":
            _shape(request, ("action", "agent"))
        elif action == "enable":
            _shape(request, ("action", "id", "enabled"))
        elif action == "delete":
            _shape(request, ("action", "id"))
        else:
            raise AdvisorError("invalid-request", "模板操作不正确")
        return service.save_template(request)
    if path == "/api/advisor/skills":
        action = request.get("action", "import")
        if action == "delete":
            _shape(request, ("action", "id"))
        elif action == "import":
            _shape(request, ("name", "description", "content"), ("action",))
        else:
            raise AdvisorError("invalid-request", "技能操作不正确")
        return service.import_skill(request)
    if path == "/api/advisor/context":
        _shape(request, ("account", "user"))
        return service.prepare_context(request["account"], request["user"])
    if path == "/api/advisor/run":
        _shape(request, ("account", "user", "agentId", "message", "requestId"), ("threadId",))
        return service.start(request["account"], request["user"], request["agentId"],
                             request.get("threadId"), request["message"], request["requestId"])
    if path == "/api/advisor/stop":
        _shape(request, ("account", "user", "runId"))
        return service.stop(request["account"], request["user"], request["runId"])
    if path == "/api/advisor/new-thread":
        _shape(request, ("account", "user", "agentId"))
        return service.new_thread(request["account"], request["user"], request["agentId"])
    if path == "/api/advisor/threads/delete":
        _shape(request, ("account", "user", "agentId", "threadId"))
        return service.delete_thread(request["account"], request["user"], request["agentId"],
                                     request["threadId"])
    raise AdvisorError("invalid-request", "接口不存在")


def error_status(error):
    if error.code in {"agent-unknown", "thread-unknown", "run-unknown", "not-found"}:
        return 404
    if error.code in {"run-active", "account-paused", "account-closed", "agent-disabled", "agent-changed"}:
        return 409
    if error.code in {"api-not-configured", "engine-unavailable"}:
        return 503
    return 400
