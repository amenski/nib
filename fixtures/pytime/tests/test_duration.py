import unittest

from src.duration import parse_duration


class ParseDurationTest(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(parse_duration("45s"), 45)

    def test_minutes(self):
        self.assertEqual(parse_duration("90m"), 5400)

    def test_hours_and_minutes(self):
        self.assertEqual(parse_duration("2h30m"), 9000)

    def test_trailing_number_is_rejected(self):
        # "90" has no unit, so it means nothing — silently dropping it turns a
        # typo into a plausible-looking wrong answer.
        with self.assertRaises(ValueError):
            parse_duration("5m30")


if __name__ == "__main__":
    unittest.main()
