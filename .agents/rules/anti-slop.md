# Anti-Slop Engineering & Design Guidelines

This project strictly adheres to Anti-AI-Slop standards for both code architecture and UI/UX design.

## 1. Coding & Security Rules
- Validate all incoming API and webhook requests at the system boundary.
- All monetary operations must be atomic, idempotent, and verified against GoBiz settlement records.
- Never hardcode API keys, merchant IDs, or authentication cookies. Always read dynamically via `.env` or session managers.
- Always handle API connection timeouts gracefully with appropriate HTTP 500/504 status codes.
- Do not commit `.env`, `.GOPAY_SESI_JANGAN_DIHAPUS.json`, `.gateway_store.json`, or any temporary transaction logs.

## 2. Design System & UI Principles
- **Color Palette:**
  - Base Canvas: `#09090b`
  - Base Surface: `#121215`
  - Elevated Surface: `#18181c`
  - Subtle Hairline Border: `rgba(255, 255, 255, 0.08)`
  - Hover Border: `rgba(255, 255, 255, 0.16)`
  - Primary Accent: `#00aed9` (GoPay Brand Cyan)
  - Text Primary: `#f4f4f5`
  - Text Secondary: `#a1a1aa`
  - Text Muted: `#94949e` (WCAG AA compliant)
- **Typography:**
  - Standard text: `Plus Jakarta Sans`, sans-serif.
  - Numbers, Currency, Timestamps, IDs: `JetBrains Mono`, monospace with `tabular-nums`.
- **Interactive States:**
  - Active button press: `transform: scale(0.98)`
  - Focus ring: `outline: 2px solid #00aed9; outline-offset: 2px;`
  - Disabled state: `opacity: 0.5; cursor: not-allowed;`
- **Zero AI Slop:**
  - No decorative gradients without semantic meaning.
  - No bloated CSS frameworks or excessive card shadows.
  - No raw emojis in UI buttons or navigation tabs.
