---
name: summarize
description: Produce a structured summary of your implementation work. Call this when you have completed your task.
---

# Summarize Your Work

When you have finished your implementation or cannot proceed further, write a
JSON file at /output/result.json with this structure:

```json
{
  "status": "success | partial | failed",
  "summary": "Brief description of what you did",
  "files_created": ["path/to/file1"],
  "files_modified": ["path/to/file2"],
  "commits": ["commit message 1"],
  "issues": ["Any issues encountered or concerns"],
  "suggestions": ["Suggestions for the next agent"]
}
```

For "partial" status, explain what remains to be done in the issues field.
For "failed" status, explain what went wrong in the issues field.

IMPORTANT: Write the file using the write tool to /output/result.json.
Then commit and push any changes.
