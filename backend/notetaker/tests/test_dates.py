from datetime import datetime
from zoneinfo import ZoneInfo

from django.test import SimpleTestCase

from notetaker.services.dates import parse_spoken_date


class SpokenDateTests(SimpleTestCase):
    def setUp(self):
        self.base = datetime(2026, 9, 28, 10, 0, tzinfo=ZoneInfo("Europe/Lisbon"))

    def test_tomorrow_end_of_afternoon(self):
        result = parse_spoken_date("amanhã ao final da tarde", self.base)
        self.assertEqual(result.value.hour, 17)
        self.assertEqual(result.value.day, 29)
        self.assertFalse(result.ambiguous)

    def test_time_of_day_without_day_is_ambiguous(self):
        result = parse_spoken_date("ao final da tarde", self.base)
        self.assertTrue(result.ambiguous)

    def test_empty_phrase_is_ambiguous(self):
        result = parse_spoken_date("", self.base)
        self.assertIsNone(result.value)
        self.assertTrue(result.ambiguous)
