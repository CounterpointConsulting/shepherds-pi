---
name: summarize
description: Produce a structured summary of your architectural analysis and implementation plan. Call this when you have completed your analysis.
---

# Summarize Your Work

When you have finished your analysis, write a JSON file at /output/result.json
with this structure:

```json
{
  "status": "success",
  "summary": "Brief description of the architecture and plan",
  "plan": [
    {
      "id": "step-1",
      "description": "What this step should accomplish",
      "persona": "which persona to assign",
      "depends_on": [],
      "branch": "feature-branch-name"
    }
  ],
  "contracts": {
    "schema": "Description of database schema changes",
    "api": "Description of API endpoints and data types",
    "components": "Description of UI components needed"
  },
  "suggestions": ["Any additional suggestions for the coordinator"]
}
```

For "partial" status, explain what remains to be analyzed in the issues field.
For "failed" status, explain what went wrong.

IMPORTANT: Write the file using the write tool to /output/result.json.
