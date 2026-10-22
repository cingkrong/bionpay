# GLOBAL ENGINEERING & DESIGN STANDARDS (ANTI-SLOP)

These instructions apply unconditionally to all software engineering, architecture, debugging, UI/UX development, and refactoring tasks within this repository.

---

## 1. Core Operating Principles

Resolve any potential conflict using this strict priority hierarchy:
1. **Security & Functional Correctness** (no data leaks, secure session tokens, idempotent payment claims).
2. **Explicit User Requirements**.
3. **Existing Project Architecture & Conventions**.
4. **Anti-Slop Engineering & Design Standards**.

---

## 2. Prohibited Commands in Production

Never propose or execute any command containing:
- `fresh`
- `reset`
- `truncate`
- `drop`
- `seed-demo`
- `seed-test`
- `fixture-load`

---

## 3. Mandatory Development Workflow

Every task must strictly proceed through these 5 phases:

```
AUDIT  ───>  PLAN  ───>  IMPLEMENT  ───>  VERIFY  ───>  FINAL AUDIT
```

### 1. AUDIT
- Inspect existing codebase, active dependencies, and runtime data before proposing or making any changes.
- Identify exact root causes rather than patching symptoms.

### 2. PLAN
- Enumerate affected files, concrete implementation steps, backwards compatibility risks, and verification strategy.
- Keep scope strictly minimal and relevant.

### 3. IMPLEMENT
- Write production-ready, minimal, maintainable code.
- Follow existing codebase idioms, parameter naming, and asynchronous patterns.

### 4. VERIFY
- Execute linting, syntax verification, server health checks, and visual layout inspection.
- Truthfully report actual test outputs without fabrication.

### 5. FINAL AUDIT
- Review for potential regressions, security leaks (especially `.env` and `.GOPAY_SESI_JANGAN_DIHAPUS.json`), unused code, and UI accessibility.

---

## 4. Anti-AI-Slop Engineering Standards

- **No Speculative Code or Hallucinated Logic:** Never invent mock API payloads or fabricate successful responses to conceal failures.
- **No Silent Error Swallowing:** Catch errors explicitly, log them with context, and surface meaningful feedback.
- **Zero Unnecessary Abstractions:** Avoid superfluous wrapper classes, redundant helpers, or heavy external dependencies when native JavaScript/Node.js suffices.
- **Idempotency & Business Logic Integrity:** Preserve core payment lifecycle invariants (claim scopes, CRC16 checksum verification, and dynamic TLV parsing).
- **Credentials & Privacy Protection:** Never log, expose, or commit session tokens, private keys, or passwords.

---

## 5. Anti-AI-Slop UI/UX Standards

Eliminate generic AI design tropes ("нейрослоп", template clichés, boilerplate styling):

- **No AI Dark-Mode Blobs:** Do not use purple/indigo blurred radial blobs in canvas corners. Use deep, deliberate monochrome surfaces (`#09090b`, `#121215`, `#18181c`) with crisp 1px hairline borders (`rgba(255, 255, 255, 0.08)`).
- **No Raw Emojis as Icons:** Use crisp, unified vector SVG icons with consistent stroke weights.
- **Typographic Precision:**
  - Display/Headings: `Plus Jakarta Sans` or system sans-serif.
  - Numbers, Currency, Timers, Hashes, and IDs: Always use monospace (`JetBrains Mono`) with `font-variant-numeric: tabular-nums`.
- **WCAG AA Contrast:** Ensure all body text and secondary metadata maintain at least 4.5:1 contrast against surface backgrounds.
- **8-State Interactive Primitives:** Every interactive element (buttons, tabs, inputs, chips) must explicitly implement:
  - Default
  - `:hover`
  - `:active` (subtle scale 0.98 or color shift)
  - `:focus-visible` (unambiguous 2px outline ring with offset)
  - `:disabled` (reduced opacity, `cursor: not-allowed`)
  - Loading / busy states
- **Single Source of Metric Truth:** No redundant card duplication or vanity metrics. Keep KPI summaries actionable and clear.

---

## 6. Completion Standard

Never declare a task or implementation complete without explicitly detailing:
1. Concrete changes made and files modified.
2. Verification commands and tests actually executed.
3. Exact test outputs and observed behavior.
4. Remaining limitations, known edge cases, or production considerations.
