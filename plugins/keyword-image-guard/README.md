# keyword-image-guard · 关键词检测审图插件

## 用途与定位

对图片的**元信息侧**文本做敏感词 / 正则匹配，命中后映射为本系统风险等级，
输出标准 `ModerationVerdict`，作为图像拓扑上的**判定型审核节点**
（`role=judge`，能力 `image.verdict`，节点 ref `plugin.keyword-image-guard.image`）。

判定来源（可勾选）：

| 来源 | 内容 | 说明 |
|---|---|---|
| `filename` | 文件名（不含目录、不含扩展名） | 只取 basename，不读完整路径 |
| `exif` | EXIF / XMP / PNG tEXt / WebP / GIF 注释 | 零依赖自解析，见 `lib/exif.js` |
| `caption` | 调用方传入的附带文本 | `payload.caption` / `payload.text` / `payload.description` |
| `upstreamTags` | 上游标签 | 来自 `payload.upstreamTags` / `payload.tags` 或工作上下文 `work.tags` |

### 与 `wd14-tagger` 的关系：**互补，不重叠**

| 组件 | 输入 | 产出 | 关系 |
|---|---|---|---|
| `wd14-tagger` | 图片像素 | 标签集合 + 建议等级（`image.tag` / collect） | 负责「把图变成标签」 |
| **本插件** | 文件名 / EXIF / 附带文本 / **上游标签** | `ModerationVerdict` | 负责「把标签与元信息变成判定」 |
| 核心预检层 | 文本正文 | 是否命中 + 分类 + 等级（判定下限） | 文本模态；本插件不复制其词表，只经受控 API 调用 |

两者可各自单独使用，也可串联：`wd14-tagger`（contribute 节点打标）→ 本插件（判定上游标签）。
**本插件不实现任何打标能力。**

## 依赖

**无任何额外依赖，纯 JS 实现**（只用 Node 内置模块）。

## 配置项

插件级配置（「图片审核 → keyword-image-guard」）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否挂载审核钩子；关闭后需重载插件生效 |
| `levelFloor` | select | `medium` | 任一命中后最终等级不低于该值 |
| `ruleSource` | select | `both` | `plugin`（仅插件内规则）/ `precheck`（仅宿主预检 API）/ `both` |
| `criticalShortCircuit` | boolean | `true` | 命中最高级即停止后续匹配（仅省算力，等级一定原样输出） |
| `ignoreCase` | boolean | `true` | 忽略大小写 |
| `rulesText` | textarea | 空 | 规则表，每行一条 |
| `defaultCategoryId` | text | `illegal` | 规则未指定分类时使用，需与系统分类表一致 |
| `maxHits` | number | `50` | 最多记录命中数 |
| `sources` | checkbox-group | `filename, caption, upstreamTags` | 默认识别来源 |
| `maxTagCount` | number | `50` | 上游标签检查上限 |

节点参数（拓扑画布参数抽屉，由 `manifest.contributes.nodes[].params` 声明）：
`sources`、`ruleSource`、`criticalShortCircuit`、`levelFloor`、`maxTagCount`。节点参数优先于插件级配置。

### 规则表格式

```
# 等级|模式|类型|分类|说明       （# 开头为注释行）
high|示例关键词A|plain|pornographic|示例规则
critical|示例关键词B|plain|political|示例规则
medium|示例.*模式|regex|marketing|示例正则规则
```

- 等级：`low` / `medium` / `high` / `critical`（`safe` 不允许，`review` 是链路失效态、不参与内容判定）
- 类型：`plain`（默认，按纯文本匹配，元字符自动转义）或 `regex`
- 分类：可空，空则用「默认分类 id」
- 安全护栏：规则数 ≤ 500、模式长度 ≤ 200、单条文本 ≤ 4096 字符；对典型灾难性回溯形态的正则
  （括号内已有量词、括号外再叠量词）直接拒绝编译，避免拖死主流程。

> **规则表内请勿填写真实敏感词条**：该字段是业务自定义词表的容器，与核心词库无关。

## 判定与失败语义

- 命中：取**最高等级**；再与 `levelFloor` 取较严重者（`levelFloor` 只抬不降）。
- 未命中：`risk_level = safe`、`categories = []`、`confidence = 0`。
- `confidence` 是按等级给出的启发式值（`low .5 / medium .7 / high .85 / critical .95`），
  多命中略增，**不是模型分数**。
- `reason` 只包含「命中条数 + 来源分布 + 等级」，**不含命中词原文**。
- 失败语义（**绝不让异常变成放行**）：
  | 情形 | 行为 |
  |---|---|
  | `ruleSource` 含 `precheck` 但宿主未提供该服务 | **抛错**（fail-closed），不静默放行 |
  | 宿主预检 API 调用抛异常 | **抛错**（fail-closed） |
  | 规则表为空且宿主预检不可用 | 返回 `safe` + `confidence: 0` + `reason` 明写「未执行有效判定」，同时 `status.ready=false` 供执行器跳过 |
  | 正则运行时异常 | 该规则按「不命中」处理，不影响其它规则与主流程 |

## RPC

| 方法 | 说明 |
|---|---|
| `keywordImageGuard.status` | 就绪度自报：`{ready, notReadyReason, ruleCount, ruleErrors, precheckAvailable}` |
| `keywordImageGuard.reloadRules` | 重新编译规则表（配置改动后调用） |
| `keywordImageGuard.selfTest` | 用样例文本（文件名 / 附带文本 / 上游标签）跑通判定链路 |
| `keywordImageGuard.sources` | 支持的来源枚举 |
| `viewSchema` | 参数界面 schema（`contributes.views[].schemaResolver`） |

调用示例（不涉及任何真实敏感词）：

```bash
curl -X POST http://127.0.0.1:<port>/api/p/keyword-image-guard/rpc \
  -H 'Content-Type: application/json' \
  -d '{"method":"keywordImageGuard.selfTest","params":{"filename":"示例文件名.txt","upstreamTags":["示例关键词A"]}}'
```

## 日志与隐私

只打印**来源项数、命中数、等级、规则条数**；不打印待匹配文本、命中词原文与图片完整路径。

## 目录结构

```
plugins/keyword-image-guard/
├── manifest.json      # 能力声明 / 节点描述符 / 参数 schema（hostApi 1.1）
├── index.js           # 插件装配：规则编译、provide、钩子、RPC、视图 schema
├── lib/rules.js       # 规则解析/编译/匹配（含 ReDoS 形态拦截与上限）
├── lib/sources.js     # 四类来源的文本收集（不含完整路径）
└── lib/exif.js        # 零依赖元数据解析（JPEG Exif/XMP、PNG tEXt/zTXt/iTXt、WebP、GIF）
```
