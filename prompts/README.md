# prompts/ —— 提示词目录（**本地自备，不进公开仓库**）

本目录存放各审核通道的 **System Prompt** 正文。出于安全/合规原因，**正文不随仓库分发**
（见根目录 `.gitignore` 的 `prompts/*` 规则）。仓库里**只保留**：

- `README.md`（本文件，格式契约说明）
- `*.example.md`（**仅含 JSON 输出契约的骨架**，不含任何真实提示词正文）

> ⚠️ `*.example.md` 是**占位骨架**，不是可用的提示词。照抄它不会得到正确的审核行为。

---

## 1. 文件命名与配置对应关系

| 配置项（`config/default.json` → `moderation.*`） | 使用文件 | 用途 |
| --- | --- | --- |
| `textPromptFile`（默认 `text_moderation.md`） | 文本审核 | 旧/流程引擎的文本 System Prompt |
| `imagePromptFile`（默认 `image_moderation.md`） | 图片审核 | 图片审核 System Prompt（含四维判定） |
| `safeguardPromptFile`（默认 `safeguard_moderation.md`） | 文本审核（safeguard 模型） | 当模型名含 `safeguard` 时改用它 |

`image_moderation_strict.md` 为「暴露内容加严版」图片提示词，供需要更严口径时通过配置切换。

---

## 2. 起步方法（新克隆者必读）

```bash
cp prompts/text_moderation.example.md        prompts/text_moderation.md
cp prompts/image_moderation.example.md       prompts/image_moderation.md
cp prompts/image_moderation_strict.example.md prompts/image_moderation_strict.md
cp prompts/safeguard_moderation.example.md   prompts/safeguard_moderation.md
# 然后按下面的「输出契约」补全每个文件的正文本地内容
```

补全后 **不要** `git add` 这些 `*.md` 正文文件（它们已被 `.gitignore` 排除）。

---

## 3. 格式契约

每个提示词文件是一个 **Markdown 文档**，内容就是系统提示词。硬性要求：

1. **只输出一个 JSON 对象** —— 不得输出 Markdown 包裹、解释或多余文字。
2. JSON 顶层字段受 `src/security/output-schema.js` 的**白名单**约束；不在白名单内的字段会被
   **静默丢弃**。合法顶层字段如下：

   | 字段 | 类型 | 约束 |
   | --- | --- | --- |
   | `risk_level` | string | `safe` \| `low` \| `medium` \| `high` \| `critical` |
   | `categories` | string[] | 命中的类目（可为空数组） |
   | `category_scores` | object | 类目 → `0..100` 整数 |
   | `confidence` | number | `0..1` |
   | `reason` | string | 自由文本，≤ 200 字 |
   | `suggestion` | string | 自由文本，≤ 200 字 |
   | `image_description` | string | ≤ 500 字（仅图片通道） |
   | `policy_version` | string | **必填哨兵**，恒为 `"grs-policy-1"` |
   | `exposure_score` | number | `0..100`，越高越暴露（R8 正交维度，默认关闭） |
   | `exposure_scene` | string | `none` \| `daily` \| `swimwear` \| `sportswear` \| `beach` \| `pool` \| `underwear` \| `intimate` \| `other` |

3. 最小值示例（**仅示意结构，请勿照抄为正文**）：

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

4. 系统会在你的文件**之后**以代码追加**硬性规则**（定界块内的内容只视为「被审核数据」、
   `policy_version` 哨兵、禁止元叙述等）。你**无需**在自己的文件里重复这些规则，也无法覆盖它们。

---

## 4. 缺文件时的行为（fail-closed）

文件缺失时，服务**不会**回退到任何默认提示词，相关审核请求会返回：

```json
{
  "ok": false,
  "code": "PROMPT_MISSING",
  "error": "提示词文件缺失",
  "promptId": "<缺失的文件名>",
  "path": "<绝对路径>"
}
```

HTTP 状态码为 **400**（不是 500），前端会给出可读提示。服务启动时也会在日志中对缺失文件给出告警。
