from unittest.mock import patch

from django.test import SimpleTestCase

from notetaker.services.ollama import OllamaError, generate_json


class OllamaJsonTests(SimpleTestCase):
    @patch("notetaker.services.ollama._request")
    def test_invalid_json_does_not_trigger_another_generation(self, request):
        request.return_value = {"message": {"content": '{"title": "Only a title"}'}}
        schema = {
            "type": "object",
            "properties": {"title": {"type": "string"}, "summary": {"type": "string"}},
            "required": ["title", "summary"],
        }
        with self.assertRaises(OllamaError):
            generate_json("prompt", schema)
        self.assertEqual(request.call_count, 1)
