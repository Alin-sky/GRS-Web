<!--
  prompts/safeguard_moderation.example.md —— **骨架文件，不是可用的提示词**
  当文本模型名包含 `safeguard` 时使用（英文、结构化输出）。请复制为
  prompts/safeguard_moderation.md 后自行补全正文。
  正文属敏感内容，不得提交到公开仓库（已被 .gitignore 排除）。
-->

# Safeguard Text Moderation System Prompt (skeleton / PLACEHOLDER)

> ⚠️ Placeholder only. Copy to `safeguard_moderation.md` and fill in your real prompt body.
> If `safeguard_moderation.md` is missing, text reviews that select a `safeguard` model
> return `400 PROMPT_MISSING`.

## What you should write

1. Role and duty as a content-safety classifier for a Chinese social platform.
2. The risk-level definitions for `safe` / `low` / `medium` / `high` / `critical`.
3. The category keys used by the backend
   (`political` / `pornographic` / `marketing` / `violence` / `gambling` / `privacy` / `illegal` / `abuse` / `grotesque`).
4. `category_scores`: each category scored `0..100` independently; safe content ⇒ empty
   `categories`, all scores `0`, `confidence` above `0.8`.

## Output contract (must follow)

- Emit exactly **one** JSON object; no Markdown fences, no prose.
- Allowed top-level fields (anything else is dropped):

  | field | type | constraint |
  | --- | --- | --- |
  | `risk_level` | string | `safe` \| `low` \| `medium` \| `high` \| `critical` |
  | `categories` | string[] | may be empty |
  | `category_scores` | object | category → `0..100` |
  | `confidence` | number | `0..1` |
  | `reason` | string | ≤ 200 chars |
  | `suggestion` | string | ≤ 200 chars |
  | `policy_version` | string | **required**, always `"grs-policy-1"` |

- Structural example (**not** a body to copy):

  ```json
  {
    "risk_level": "safe",
    "categories": [],
    "category_scores": {},
    "confidence": 0.9,
    "reason": "",
    "suggestion": "",
    "policy_version": "grs-policy-1"
  }
  ```

## Do NOT put here

- Delimiter / anti-injection rules (the system appends them as code **after** this file, highest priority).
- Any custom top-level field beyond `policy_version` (it will be dropped).
