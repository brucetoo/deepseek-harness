---
name: browser-research
description: Research current web information and produce a cited local report. Use when the user asks to investigate a topic, compare sources, or summarize webpages.
---

# Browser Research

1. Use `web_search` with focused, non-duplicated queries.
2. Use `web_fetch` on the strongest primary sources. Prefer official documentation, original announcements, standards, and first-party data.
3. Cross-check material claims against at least two independent sources when possible.
4. Write the result to a Markdown file in the current workspace with `write`. Include:
   - a direct answer or executive summary;
   - findings grouped by the user's decision;
   - inline Markdown links for every material external claim;
   - a short `Sources` section containing only sources actually used.
5. Mention the report path in the final response. The successful `write` call records it in the desktop Results view.

Do not claim to have clicked, logged in, submitted forms, or manipulated a browser UI. This workflow covers search, HTTP retrieval, synthesis, and a local cited deliverable.
