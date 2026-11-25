# Agent Guidelines & Token Efficiency Protocol

This document defines operational rules and token efficiency guidelines for AI agents operating within this workspace.

---

## 1. Context & Token Economy Management

In long-running conversations, the cached context is re-read on every turn. As conversations grow beyond 100k+ tokens, every subsequent tool call incurs significant cached-token overhead. Follow these rules to keep token consumption efficient:

### A. Phase Boundaries & Compaction
* **Segment Lifecycles**: Do not carry a single conversation across all phases of a project (e.g., brainstorming, spec drafting, multi-round reviews, implementation, and post-launch debugging).
* **Recommend Compaction**: When transitioning from design/review into implementation, recommend the user start a fresh conversation with the finalized specification file or trigger `/compact` to reset the context window.
* **Minimal State Handoff**: When resuming in a new turn or phase, anchor on the design artifact or specification document rather than re-reading the entire prior trajectory.

### B. Subagent Offloading for Bulky Reads
* **Isolate High-Volume Reads**: Delegate broad codebase surveys, log analysis, repository-wide searches, and large document exploration to subagents (e.g., `research` or domain subagents).
* **Return Concise Summaries**: Subagents absorb raw file outputs into their own context and return concise, actionable summaries to the coordinator, preventing the main conversation context from bloating.

### C. Targeted File Reading
* **No Full-Document Loops**: Never read multi-thousand-line specification documents (e.g., `design_draft.md`, large design docs) in full repeatedly.
* **Precise Windows**: Always use `StartLine` and `EndLine` with `read_file`, or use `grep` / targeted scripts to inspect only the relevant code sections.
* **Avoid Micro-Read Chains Late in Sessions**: Avoid sequential 50-line reads across dozens of files when context is large. Plan inspections or use batch grep/ast tools.

---

## 2. External Resource & Rate-Limit Protocols

### A. Fail Fast on Blocked Endpoints
* **Max 2 Probes**: If an external resource, download endpoint, or API returns a rate-limit error, quota block (e.g., Google Drive `Quota exceeded`, HTTP 429/403), or auth failure, attempt at most **1–2 diagnostic probes**.
* **Do Not Loop**: Never run repetitive curl, probe, or scraping loops against blocked resources in late-stage sessions.
* **Immediate Escalation**: Clearly report the block, explain why it occurred, and present the user with actionable next steps (e.g., requesting local files, plugin authentication, or browser downloads).

### B. Data Integrity & Provenance Truthfulness
* **Honest Provenance**: Never badge synthetic or simulated placeholder data as `OCR_MEASURED`, `GATE_CALIBRATED`, or sensor-grounded.
* **Explicit Demo Tagging**: When real assets are unavailable due to quotas or access limits, clearly mark all generated fixtures, manifests, and UI views as **Synthetic / Simulated Demo Data** in the UI, code, and documentation.
* **Preserve Integrity**: Do not declare a goal complete if core data dependencies rely on unverified placeholders without explicit user sign-off.

---

## 3. Verification & Objective Review

* **Fresh-Context Auditing**: Run final goal audits and critique steps with a fresh reviewer context or dedicated auditor subagent to prevent confirmation bias.
* **Validate Against Ground Truth**: Confirm all metrics, file boundaries, and acceptance criteria against the original specification before declaring completion.
