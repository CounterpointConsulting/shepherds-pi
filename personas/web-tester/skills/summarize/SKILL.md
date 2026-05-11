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
  "testsRun": 5,
  "testsPassed": 4,
  "testsFailed": 1,
  "findings": [
    {
      "severity": "bug | regression | ux_issue | suggestion",
      "description": "What was found",
      "stepsToReproduce": ["step 1", "step 2"],
      "suggestion": "How to fix it"
    }
  ],
  "approved": true
}
```

IMPORTANT: Write the file using the write tool to /output/result.json.
