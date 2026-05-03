---
name: summarize
description: Produce a structured merge result summary. Call this when you have completed the merge.
---

# Summarize Your Merge Result

Write a JSON file at /output/result.json:

```json
{
  "status": "success | conflicts | failed",
  "summary": "Brief description of merge result",
  "conflicts_resolved": ["path/to/conflicting/file"],
  "conflicts_remaining": [],
  "tests_passed": true
}
```

IMPORTANT: Write the file using the write tool to /output/result.json.
Then commit and push the merge.
