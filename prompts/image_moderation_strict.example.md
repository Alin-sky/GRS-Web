<!--
  prompts/image_moderation_strict.example.md —— **骨架文件，不是可用的提示词**
  「暴露内容加严版」图片提示词骨架。请复制为 prompts/image_moderation_strict.md 后自行补全。
  正文属敏感内容，不得提交到公开仓库（已被 .gitignore 排除）。
-->

# 图片审核 System Prompt（暴露加严版 · 骨架 / PLACEHOLDER）

> ⚠️ 这是**占位骨架**。请在复制为真名 `image_moderation_strict.md` 后，填入更严的暴露/色情口径正文。

## 与标准版的差异（需要你补写）

- 降低 `pornographic` 类目的触发阈值（更小的暴露程度即判 `high`）。
- 泳装 / 比基尼 / 内衣 / 明显暴露的处置从「记录」升级为「拦截」。
- 明确「真人 / 动漫同等标准」，不因画风放宽。

## 输出契约（与标准版一致）

- 只输出**一个** JSON 对象；无 Markdown 围栏、无解释。
- 顶层字段白名单：`risk_level` / `categories` / `category_scores` / `confidence` /
  `reason` / `suggestion` / `image_description` / `policy_version` /
  `exposure_score` / `exposure_scene`。
- `policy_version` **必填**，恒为 `"grs-policy-1"`。

  ```json
  {
    "risk_level": "safe",
    "categories": [],
    "category_scores": {},
    "confidence": 0.9,
    "reason": "",
    "suggestion": "",
    "image_description": "",
    "policy_version": "grs-policy-1"
  }
  ```

> 缺少本文件对应的真名文件时，仅在你把 `imagePromptFile` 指到它时才会触发 `400 PROMPT_MISSING`。
