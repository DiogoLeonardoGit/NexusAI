from unittest.mock import patch

from django.test import TestCase

from notetaker.services.lmstudio import LMStudioError, generate_json


class LMStudioJsonTests(TestCase):
    @patch("notetaker.services.lmstudio._request")
    def test_invalid_json_fails_after_structured_output_retry(self, request):
        request.return_value = {"choices": [{"message": {"content": '{"title": "Only a title"}'}}]}
        schema = {
            "type": "object",
            "properties": {"title": {"type": "string"}, "summary": {"type": "string"}},
            "required": ["title", "summary"],
        }
        with self.assertRaises(LMStudioError):
            generate_json("prompt", schema)
        self.assertEqual(request.call_count, 2)
