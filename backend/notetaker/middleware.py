from django.conf import settings
from django.http import JsonResponse


class LocalOnlyMiddleware:
    """Reject non-loopback clients and require Electron's ephemeral token."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        remote = request.META.get("REMOTE_ADDR", "")
        if remote not in {"127.0.0.1", "::1"}:
            return JsonResponse({"detail": "Local access only."}, status=403)
        if request.path != "/api/health/":
            supplied = request.headers.get("X-Local-Token", "")
            if not supplied or supplied != settings.LOCAL_API_TOKEN:
                return JsonResponse({"detail": "Invalid local token."}, status=401)
        return self.get_response(request)
