# aliyun-content-safety · 阿里云内容安全插件

## 用途

把阿里云绿网内容安全（文本 + 图片）从核心迁出为**插件节点**：

| 节点 ref | 模态 | 能力 | 说明 |
|---|---|---|---|
| `plugin.aliyun-content-safety.text` | 文本 | `text.verdict`（call） | 云端文本审核，支持多服务并行（`comment_detection` / `chat_detection`） |
| `plugin.aliyun-content-safety.image` | 图像 | `image.verdict`（call） | 云端图片审核（Base64 直传，不落盘、不上传 OSS） |

两个节点各自产出标准 `ModerationVerdict`，可作为拓扑上的独立判定分支（默认合并策略下与本地/云端模型并行取最严重）。

## 可选依赖（0 依赖红线）

| 项 | 说明 |
|---|---|
| `@alicloud/green20220302` | **可选依赖**，惰性加载（`lib/green-client.js` 内按需 require） |

- 该包在 `manifest.json` 的 `optionalDependencies` 中声明，**未安装时宿主把插件置为 `missing-deps`**：插件不装载、不注册能力，核心冷启动与其它插件完全不受影响。
- 安装命令：`npm i @alicloud/green20220302`
- 核心侧 `src/content_safety.js` 已同步改造为惰性 SDK + 兼容垫片（T01），插件禁用后核心无残留调用路径。

## 状态与就绪度

| 状态 | 触发条件 | 界面表现 |
|---|---|---|
| `missing-deps` | 未安装 SDK | 显示安装命令 |
| `disabled` | `config.contentSafety.enabled=false` | 显示「到审核配置开启」 |
| `not-configured` | 未配置 `accessKeyId/accessKeySecret`（占位符也视为未配置） | 显示「到审核配置填写 AccessKey」 |
| `ready` | SDK 已装 + 已启用 + 已配置 AccessKey，且该模态通道未关闭 | 节点可用 |

就绪度自报 RPC：`aliyunContentSafety.status`（返回 `ready / notReadyReason / notReadyMessage / installHint / configHint / nodes[]`）。
两个节点在 manifest 中声明了 `readinessRpc: "aliyunContentSafety.status"`，供宿主把「未配置」的节点判为 `skipped`（**当前宿主尚未消费该字段**，见下文「已知限制」）。

## 配置归属（单一真相源）

**本插件不复制核心的 `contentSafety.*` 配置**，避免出现两份互相抵消的开关：

| 配置 | 唯一真相源 | 插件如何取得 |
|---|---|---|
| `enabled` / `textEnabled` / `imageEnabled` / `textServices` / `imageService` / `region` / `endpoint` / `timeout` | `config/default.json` → `contentSafety.*`（「审核配置 → 阿里云内容安全配置」） | 读宿主 config 脱敏投影（非密钥字段） |
| `accessKeyId` / `accessKeySecret` | 同上（**明文不随 config 注入**） | `ctx.secrets.get('contentSafety.accessKeyId')`，由宿主按 `SECRET_GRANTS` 白名单下发（决策 D-7 方案 C） |

插件自有配置仅两项（插件范围内、与核心不重叠）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `cacheEnabled` | boolean | `true` | 相同文本 24h 内复用上次云端结果，避免重复计费 |
| `logLabels` | boolean | `false` | 判定理由中是否列出命中的绿网标签 id（英文枚举） |

节点参数（画布参数抽屉）：`timeoutMs`、`maxChars`（仅文本）、`withCaption`（仅图片）、`levelMap`（服务建议 → 风险等级）。

## 失败语义（绝不把异常变成放行）

| 情形 | 行为 |
|---|---|
| 未装 SDK | 抛 `MISSING_DEPS`（正常路径下宿主已提前拦为 `missing-deps`） |
| 未启用 / 未配 AccessKey | 抛 `NOT_CONFIGURED`（消息含待修复的配置路径） |
| 该模态被开关关闭 | 抛 `CHANNEL_DISABLED` |
| 上游 code ≠ 200 / 全部服务失败 / 超时 | 抛 `UPSTREAM_ERROR` / `ALL_SERVICES_FAILED` / 超时错误 |

以上均由执行器按节点 `failed` → fail-closed 处理，**节点不会在出错时返回 `safe`**。
（更理想的语义是「未配置 → `skipped`」，这需要宿主把上面的 `readinessRpc` 接进节点就绪度——见下。）

## 已知限制（需宿主配合，非本插件可解）

宿主目前给插件节点固定 `ready: true`，不会消费 `readinessRpc`。因此当内容安全**未配置**时，若用户把该节点连进拓扑并执行，节点会以 `failed` 收场（fail-closed，安全但会整段拦截），而不是理想的 `skipped`。
建议宿主在 `src/plugin-scanner.js#buildPluginNodes` 里读取 `node.readinessRpc` 并转成注册表的 `readyFn`（已向宿主负责人反馈）。

## RPC

| 方法 | 说明 |
|---|---|
| `aliyunContentSafety.status` | 就绪度自报（含两个节点的模态就绪度） |
| `aliyunContentSafety.config` | 当前生效配置（**不含密钥**，密钥只回「是否已配置」） |
| `aliyunContentSafety.selfTest` | 用中性样本做连通性自检（不走缓存） |
| `aliyunContentSafety.clearCache` | 清空文本审核缓存 |
| `viewSchema` | 参数界面 schema（`contributes.views[].schemaResolver`） |

## 日志与隐私

只打印**服务名、suggestion、耗时、命中标签数**；**不打印 AccessKey、送审文本、图片二进制与完整路径**。

## 目录结构

```
plugins/aliyun-content-safety/
├── manifest.json          # 双模态能力声明 + 节点描述符 + optionalDependencies
├── index.js               # 插件装配：状态/就绪度、受控密钥、双模态钩子、RPC
├── lib/green-client.js    # 迁自 src/content_safety.js：惰性 SDK、客户端、归一化、MD5 缓存
└── lib/view-schema.js     # 参数界面 schema
```
