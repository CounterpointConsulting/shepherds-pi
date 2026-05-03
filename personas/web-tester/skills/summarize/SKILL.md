---
name: summarize
description: Produce a structured test result summary. Call this when you have completed testing.
---

# Summarize Your Test Results

Write a JSON file at /output/result.json:

```json
{
  "status": "passed | failed | blocked",
  "summary": "Brief overall test result",
  "tests_run": 5,
  "tests_passed": 4,
  "tests_failed": 1,
  "findings": [
    {
      "severity": "bug | regression | ux_issue | suggestion",
      "description": "What was found",
      "steps_to_reproduce": ["step 1", "step 2"],
      "suggestion": "How to fix it"
    }
  ],
  "approved": true
}
```

IMPORTANT: Write the file using the write tool to /output/result.json.
