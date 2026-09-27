# nsfwjs-image-guard · nsfwjs 本地审图插件

## 用途

用 [nsfwjs](https://github.com/infinitered/nsfwjs) 在**本地**对图片做 NSFW 五分类
（`Drawing` / `Hentai` / `Neutral` / `Porn` / `Sexy`），并把分类分数按**可配置阈值**与
**类别 → 风险等级映射**转成本系统的标准 `ModerationVerdict`，作为图像拓扑上的一个
**判定型审核节点**（`role=judge`，能力 `image.verdict`，节点 ref `plugin.nsfwjs-image-guard.image`）。

零 API 费用、图片不出本机。

## 可选依赖（本插件的关键设计）

| 项 | 说明 |
|---|---|
| `nsfwjs` | **可选依赖**，必需 |
| `@tensorflow/tfjs-node` | **可选依赖**，默认推荐后端（原生，性能好，体积大） |
| `@tensorflow/tfjs` | 纯 JS 后端，体积小、较慢，作为回退 |

**这三个包绝不进主工程 `package.json` 的任何依赖区。** 它们只在 `manifest.json` 的
`optionalDependencies` 中声明，由用户按需安装：

```bash
# 推荐（原生后端）
npm i nsfwjs @tensorflow/tfjs-node

# 纯 JS 后端（体积小）
npm i nsfwjs @tensorflow/tfjs
```

### 未安装时的行为（红线要求）

1. 插件装载时**先探测依赖**；缺失则：
   - **不提供服务、不注册能力（`image.verdict`）、不挂载钩子**；
   - 记录 `warn` 日志并抛出带安装命令的明确错误，由宿主把插件置为
     `missing-deps`（宿主支持时）或 `disabled / error`（错误信息里含安装命令）；
   - **核心启动、其它插件、审核主流程完全不受影响**（插件系统整体关闭时更是逐字节一致）。
2. 安装依赖并重载插件即自动启用，无需改任何核心配置。

> 说明：`manifest.json` 中 `defaultEnabled` 取 `true`，目的是让「启动时探测 → 自动禁用 →
> 界面/日志给出安装指引」在**首次启动**就可见；依赖缺失不会带来任何行为副作用
> （没有依赖就没有节点，也没有判定）。

### 后端选择

- `backend = tfjs-node`（默认，推荐）：使用原生后端，自带图片解码。
- `backend = tfjs`（纯 JS 回退）：Node 环境下纯 JS 后端**没有图片解码器**，此时按以下顺序取输入：
  1. payload 直接提供原始像素 `pixels = { data, width, height }`（RGBA/RGB）；
  2. 宿主提供的 `sharp`（若可解析）做解码；
  3. 都不满足 → 明确报错（节点按 `failed` → fail-closed 处理，**绝不放行**）。
- 后端在参数切换后会重建模型（模型缓存 key 含后端与模型路径）。

## 配置项

插件级配置（「图片审核 → nsfwjs-image-guard」，也可被节点参数覆盖）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 是否挂载审核钩子；关闭后需重载插件生效（等价于该节点不存在） |
| `threshold` | slider 0~1 | `0.6` | 某类别分数达到该值才输出对应风险等级；全部低于阈值判定 `safe` |
| `topK` | number 1~5 | `3` | 写入 `reason` 的预测条数（仅影响可读性） |
| `backend` | select | `tfjs-node` | `tfjs-node` / `tfjs` |
| `modelPath` | text | 空 | 自定义模型目录或 URL，留空用 nsfwjs 自带模型 |
| `categoryId` | text | `pornographic` | 命中后写入 `categories` 的系统分类 id |
| `level.Porn` | select | `high` | 类别 → 风险等级 |
| `level.Hentai` | select | `high` | 同上 |
| `level.Sexy` | select | `medium` | 同上 |
| `level.Drawing` | select | `safe` | 同上 |
| `level.Neutral` | select | `safe` | 同上 |
| `concurrency` | number 1~8 | `2` | 批量并发上限 |
| `maxBatch` | number 1~64 | `16` | 单次批量最多处理张数 |
| `timeoutMs` | number | `20000` | 模型加载与单张推理超时 |

节点参数（拓扑画布参数抽屉，由 `manifest.contributes.nodes[].params` 声明）：
`threshold`、`topK`、`backend`、`levelMapping`。节点参数优先于插件级配置。

> 多个类别同时过阈值时取**最严重**者；`review` 是链路失效态、不是内容判定结果，
> 因此映射选项中不提供 `review`，误配时会回落到该类别的默认等级。

## 判定与失败语义

- 输出结构：`{ risk_level, categories, category_scores, confidence, reason, suggestion }`，
  会经宿主 `plugin-gate` 用 `validateVerdict` 强校验（与模型输出同一标准）。
- `confidence`：命中时取命中类别分数；未命中时取「被判为 safe 的类别」的最高分。
- **任何异常（缺依赖、模型加载失败、超时、解码失败、批量中任一张失败）一律向上抛出**，
  由执行器按节点 `failed` → fail-closed 处理。插件不会在出错时返回 `safe`。

## 批量调用

- 节点入参支持批量：`payload.images[]`（元素为 base64 / `{buffer}` / `{pixels}`），
  单张时用 `payload.base64` / `payload.imageBase64` / `payload.image` / `payload.buffer`。
- 批量语义：**任一张失败即整体失败**；全部成功时取最严重的一张作为结论。
- 另提供 RPC 供批量流程（如批量图片套件）直接复用：
  - `POST /api/p/nsfwjs-image-guard/rpc` body `{ "method": "nsfwjs.classifyBatch", "params": { "images": ["<base64>", …] } }`

## RPC

| 方法 | 说明 |
|---|---|
| `nsfwjs.status` | 就绪度自报：`{ready, notReadyReason, notReadyMessage, installHint, backends, cache}` |
| `nsfwjs.selfTest` | 用**合成图**（64×64 渐变，不读磁盘）跑通「加载模型 → 推理 → 映射」全链路 |
| `nsfwjs.classifyBatch` | 批量分类，返回每张的 verdict |
| `nsfwjs.config` | 插件配置只读快照（`modelPath` 只回显「已配置」，不回显路径） |
| `viewSchema` | 参数界面 schema（`contributes.views[].schemaResolver`） |

## 日志与隐私

只打印**张数、字节数、后端、耗时、命中类别**；**不打印图片二进制，不打印图片完整路径**。

## 目录结构

```
plugins/nsfwjs-image-guard/
├── manifest.json          # 能力声明 / 节点描述符 / 参数 schema / optionalDependencies
├── index.js               # 插件装配：依赖探测、provide、钩子、RPC、视图 schema
├── lib/deps.js            # 可选依赖探测（createRequire 惰性解析，永不抛异常）
├── lib/classifier.js      # 模型加载与缓存、解码、单张/批量推理
└── lib/mapping.js         # 阈值判定 + 类别映射 + ModerationVerdict 合成（纯函数）
```
