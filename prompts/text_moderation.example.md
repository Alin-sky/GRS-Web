<!--
  prompts/text_moderation.example.md —— **骨架文件，不是可用的提示词**
  仅描述 JSON 输出契约与结构。请复制为 prompts/text_moderation.md 后，自行补全正文。
  正文属敏感内容，不得提交到公开仓库（已被 .gitignore 排除）。
-->

# 文本审核 System Prompt（骨架 / PLACEHOLDER）

> ⚠️ 这是**占位骨架**。请替换本段为你的真实文本审核提示词正文。
> 缺少本文件（真名 `text_moderation.md`）时，文本审核请求会返回 `400 PROMPT_MISSING`。

## 你应当补写的内容（清单）

1. **角色与职责**：这是一个文本内容安全审核器，目标是准确、可解释、可复核，避免误判正常交流。
2. **风险等级口径**：`safe` / `low` / `medium` / `high` / `critical` 的判定标准。
3. **类目键**：与后端一致的类目键（如 `political` / `pornographic` / `marketing` / `violence` / `gambling` / `privacy` / `illegal` / `abuse` / `grotesque`）。
4. **保守性**：正常日常交流（问候、学习、天气、游戏、情感）应判 `safe`；不要因敏感词预检提示就放弃独立判断。

## 输出契约（必须遵守）

- 只输出**一个** JSON 对象；不要 Markdown 代码围栏、不要解释文字。
- 顶层字段白名单（多余字段会被静默丢弃）：

  | 字段 | 类型 | 约束 |
  | --- | --- | --- |
  | `risk_level` | string | `safe` \| `low` \| `medium` \| `high` \| `critical` |
  | `categories` | string[] | 可为空 |
  | `category_scores` | object | 类目 → `0..100` |
  | `confidence` | number | `0..1` |
  | `reason` | string | ≤ 200 字 |
  | `suggestion` | string | ≤ 200 字 |
  | `policy_version` | string | **必填**，恒为 `"grs-policy-1"` |

- 结构示例（**不是**要照抄的正文）：

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

## 不要在本文件里写

- 定界/防注入规则（系统会在本文件之后以代码追加，且优先级最高）
- `policy_version` 之外的任何自定义顶层字段（会被丢弃）
