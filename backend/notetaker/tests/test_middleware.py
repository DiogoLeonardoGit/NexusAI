from django.test import SimpleTestCase, override_settings


@override_settings(LOCAL_API_TOKEN="secret")
class LocalMiddlewareTests(SimpleTestCase):
    def test_health_does_not_require_token(self):
        response = self.client.get("/api/health/")
        self.assertIn(response.status_code, {200, 503})

    def test_api_requires_token(self):
        response = self.client.get("/api/tasks/")
        self.assertEqual(response.status_code, 401)

    def test_packaged_file_origin_is_allowed(self):
        response = self.client.options(
            "/api/health/",
            HTTP_ORIGIN="null",
            HTTP_ACCESS_CONTROL_REQUEST_METHOD="GET",
        )
        self.assertEqual(response.headers["access-control-allow-origin"], "null")
