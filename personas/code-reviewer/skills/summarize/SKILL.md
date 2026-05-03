---
name: summarize
description: Produce a structured review summary. Call this when you have completed your review.
---

# Summarize Your Review

Write a JSON file at /output/result.json:

```json
{
  "status": "approved | changes_requested | concerns",
  "summary": "Brief overall assessment",
  "approved": true,
  "findings": [
    {
      "severity": "critical | warning | info | suggestion",
      "file": "path/to/file",
      "description": "What was found",
      "suggestion": "How to fix it"
    }
  ]
}
```

Set "approved" to false if there are any critical or warning findings.
Set "approved" to true only if all findings are info or suggestion level.

IMPORTANT: Write the file using the write tool to /output/result.json.
