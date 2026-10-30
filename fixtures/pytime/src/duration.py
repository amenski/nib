"""Parses human durations like "90m" or "2h30m" into whole seconds."""

_UNITS = {"s": 1, "m": 60, "h": 3600}


def parse_duration(text):
    """Return the number of seconds in `text`.

    `text` is a sequence of <number><unit> pairs with no separators, where a
    unit is one of s, m or h: "45s", "90m", "2h", "1h30m".
    """
    total = 0
    number = ""
    for char in text:
        if char.isdigit():
            number += char
        elif char in _UNITS:
            total += int(number) * _UNITS[char]
            number = ""
        else:
            raise ValueError("unexpected character: " + char)
    return total
