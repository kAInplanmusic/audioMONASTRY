#!/usr/bin/env python3
"""Validate every entry of the A1 evidence registry, without modifying it."""
import datetime
import json
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "EVIDENCE_REGISTRY.json")
entries = json.loads(path.read_text())
fields = {"id", "task", "claim", "command", "output", "date", "source"}
assert isinstance(entries, list) and entries, "expected a nonempty array"
ids = set()
for index, entry in enumerate(entries):
    assert set(entry) == fields, f"entry {index}: unexpected/missing fields"
    assert all(isinstance(entry[key], str) and entry[key].strip() for key in fields), f"entry {index}: empty/non-string value"
    assert entry["id"] not in ids, f"entry {index}: duplicate id"
    ids.add(entry["id"])
    assert datetime.datetime.fromisoformat(entry["date"]).utcoffset() is not None, f"entry {index}: missing timezone"
print(f"PASS: {len(entries)} entries; exact schema, nonempty command/output/date, timezone, unique IDs")
