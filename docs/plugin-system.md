# 审核系统插件开发指南

本系统内置一个**轻量插件系统**，架构借鉴 [cordis](https://github.com/cordiverse/cordis)（Koishi 的底层插件框架），用于把审核流程做成**可插拔的扩展点**。WD14 动漫标签器就是它的第一个插件。

- 插件系统核心：`src/plugin-system.js`
- 插件注册中心：`src/plugin-registry.js`
- 示例插件：WD14 标签器（`src/wd14.js` + `wd14/wd14_service.py`）

---

## 一、核心概念

### 1. Context（上下文）

插件函数接收的唯一参数。插件通过 `ctx` 访问系统的所有能力：提供服务、注入依赖、注册钩子、创建作用域、注册清理函数。

```js
module.exports = function myPlugin(ctx) {
  // ctx 是你与系统交互的全部入口
};
```

### 2. Service（服务）

可注入的能力单元。一个插件通过 `ctx.provide` **提供**服务，其他插件通过 `ctx.inject` **注入**服务，实现插件间解耦协作。

```js
// 插件 A：提供服务
ctx.provide('wd14', { tag: async (img) => ({}) });

// 插件 B：注入服务（不关心 wd14 是谁提供的）
const wd14 = ctx.inject('wd14');
```

服务可带**生命周期**：

```js
ctx.provide('db', dbImpl, {
  start: async () => { /* 初始化：连接、加载模型 */ },
  stop: async () => { /* 清理：释放连接、卸载模型 */ },
});
```

### 3. Hook（钩子）

审核流程暴露的扩展点。插件通过 `ctx.on` 挂载处理器，主流程通过 `ctx.emit*` 触发。支持两种模式：

| 模式 | 方法 | 语义 | 适用场景 |
|------|------|------|---------|
| 收集 | `runCollect` / `emitCollect` | 并行执行所有处理器，收集非空返回值 | 多插件各自贡献结果（如标签） |
| 短路 | `runFirst` / `emitFirst` | 按优先级顺序执行，第一个非空值即返回 | 单一判定（如拦截） |

钩子支持**优先级**和**前置拦截**：

```js
ctx.on('event', handler, { order: 100 }); // order 越小越先执行（短路模式下）
ctx.before('event', async (...args) => {   // 前置钩子：返回非空值则短路后续
  if (shouldShortCircuit) return '短路结果';
});
```

### 4. Scope（作用域）

`ctx.scope(name)` 创建**子作用域**，子作用域的服务/钩子/插件与父作用域隔离，`dispose` 时只清理自身，不影响父作用域。

```js
ctx.scope('batch-scan-scope').plugin(batchPlugin);
```

### 5. Lifecycle（生命周期）

- 插件函数**返回 dispose 函数**，或调用 `ctx.onDispose(fn)` 注册清理。
- 卸载时按**注册的逆序**执行清理函数 + 停止本作用域的服务。

```js
module.exports = function myPlugin(ctx) {
  const timer = setInterval(...);
  ctx.onDispose(() => clearInterval(timer)); // 卸载时自动清理
};
```

### 6. 就绪度（readiness）× 启用态（enablement）：两轴正交

插件在控制台上有**两条互不替代**的轴。**不要把它们合并成一个「有问题」状态** —— 合并会同时产生「误报」（把用户没启用的东西标红）与「漏报」（把真故障涂灰）。

| 轴 | 语义 | 判据 | 视觉 |
|---|---|---|---|
| **通路轴**（`onPath`） | 该节点是否落在「输入 → 输出」的通路上 | 服务端 `annotateFlow()` 下发的**只读派生位**（★ 前端**不得自行推断**） | 在通路 ⇒ 正常；**未接入通路 ⇒ 中性**（灰显 `.f-orphan` + 「未接入通路」标），**不是错误** |
| **就绪轴**（`ready`） | 该插件/服务**此刻**是否真的可用 | manifest 的 `readinessRpc` 探测 + `notReadyReason` | 就绪 ⇒ 正常；**未就绪 ⇒ 「未启用」中性**（用户还没配好），**不是错误** |

**两轴相乘才是故障判定**：

| | 已就绪 | 未就绪 |
|---|---|---|
| **已接入通路** | 正常 | ★ **真故障** —— 红色告警（`GET /api/flow/faults` → 顶栏故障条 + 节点红标） |
| **未接入通路** | 正常（只是没接线） | **中性** —— 灰显，**不计故障**（用户没启用它，不是错误） |

三条必须记住的结论：

1. **未接入通路 ⇒ 中性**：节点在画布上存在但没连线，是**用户的编排选择**。它**即使未就绪也不算故障**。
2. **已接入通路 + 不可用 ⇒ 真故障**：用户明确把它接进了通路却连不通 ⇒ 该节点会被跳过 ⇒ **会漏审**。必须红色告警，并给出修复落点（`fixAction`：前往配置 / 复制安装命令）。
3. **判定只在服务端**：`src/flow/path-props.js#listFaults()`，判据 = `onPath ∧ !ready`，且只覆盖 `service` / `contribute` 两类节点（`merge` 无 `ref`，没有就绪概念）。派生位**只挂在响应副本**上，**绝不写进 `config` / 磁盘**（`PUT` 存盘前 `stripDerived()` 摘除）。

**命名对照**：`ready === false` 时 `notReadyReason ∈ { missing-deps, not-configured, service-unreachable, worddb-empty, probe-failed, not-registered }`；`fixAction` 的 `type ∈ { copy, goto }`。

> 常见误判（请避免）：
> - ❌ 用「未就绪」推断「没接入」——两轴互不蕴含，必须各自读取。
> - ❌ 用「未接入通路」触发红警——这是把中性当故障，会让用户被自己没启用的插件反复打扰。
> - ❌ 前端自行算通路（如按边集合自己推可达性）——违背「拓扑唯一真相」，服务端的 `onPath` 才是唯一权威。

---

## 二、快速开始：写第一个插件

在 `plugins/` 下新建 `my-plugin/index.js`：

```js
module.exports = function myPlugin(ctx) {
  // 1. 注入内置服务（logger 等，可省略）
  // 2. 提供服务
  ctx.provide('myService', {
    hello: (name) => `hello, ${name}`,
  });

  // 3. 挂载审核钩子（见「六、内置扩展点」）
  ctx.on('moderation:image:tag', async (imageBase64) => {
    // 你的处理逻辑
    return { source: 'myPlugin', result: '...' };
  });

  // 4. 生命周期清理
  ctx.onDispose(() => console.log('myPlugin 已卸载'));
};

// 5. 插件元数据（可选）
myPlugin.description = '我的第一个插件';
myPlugin.version = '1.0.0';
myPlugin.using = ['wd14'];   // 声明依赖（wd14 会先加载）
```

然后在 `src/plugin-registry.js` 的 `initPlugins()` 里注册：

```js
const myPlugin = require('../plugins/my-plugin/index.js');
pluginManager.plugin(myPlugin);
```

---

## 三、完整 API 参考

### Context

| 方法 | 说明 |
|------|------|
| `ctx.provide(key, impl, { start, stop }?)` | 提供服务（可带生命周期），返回 impl |
| `ctx.inject(key, required = true)` | 注入服务，沿作用域链向上查找；`required=false` 时缺失返回 `undefined` |
| `ctx.on(event, handler, { order }?)` | 注册钩子，`order` 数值越小越先执行（短路模式） |
| `ctx.before(event, handler)` | 注册前置钩子，返回非空值短路该事件 |
| `ctx.emitCollect(event, ...args)` | 触发钩子（收集模式） |
| `ctx.emitFirst(event, ...args)` | 触发钩子（短路模式） |
| `ctx.plugin(plugin)` | 加载子插件（随本作用域一起卸载） |
| `ctx.scope(name)` | 创建子作用域 |
| `ctx.config(schema)` | 注册插件配置，返回可读写配置对象（修改自动持久化） |
| `ctx.onDispose(fn)` | 注册清理函数（卸载时逆序执行） |
| `ctx.ready()` | 等待本作用域所有服务就绪 |
| `ctx.dispose()` | 卸载本作用域全部资源 |

### PluginManager

| 方法 | 说明 |
|------|------|
| `pluginManager.plugin(fn, parent?)` | 注册插件，自动解析 `.using` 依赖 |
| `pluginManager.disposePlugin(name)` | 卸载指定插件 |
| `pluginManager.disposeAll()` | 卸载所有插件 |
| `pluginManager.hook(name)` | 获取（或创建）钩子对象 |
| `pluginManager.listPlugins()` | 列出插件名 |
| `pluginManager.describePlugins()` | 列出插件详情（name/description/version/using） |
| `pluginManager.describeConfigs()` | 列出所有插件的配置 schema + 当前值 |
| `pluginManager.updateConfig(name, key, value)` | 更新插件配置（类型校验 + 范围钳制） |

### Hook

| 方法 | 说明 |
|------|------|
| `hook.runCollect(...args)` | 收集模式：并行执行，返回非空结果数组 |
| `hook.runFirst(...args)` | 短路模式：按 order 顺序执行，返回第一个非空值 |
| `hook.register(fn, order)` | 注册处理器，返回取消函数 |
| `hook.registerBefore(fn)` | 注册前置处理器，返回取消函数 |

### 插件函数约定

```js
function plugin(ctx) { ... }
plugin.name = 'my-plugin';        // 插件名（用于依赖引用和卸载）
plugin.description = '描述';        // 描述（显示在 describePlugins）
plugin.version = '1.0.0';         // 版本
plugin.using = ['wd14'];          // 依赖的插件名（先加载）
plugin.inject = ['logger'];       // 声明依赖的服务（文档用途）
```

---

## 四、插件配置（控制台可调项）

插件可声明**配置 schema**，前端据此自动渲染控件（开关/滑块/文本），改动即保存并持久化。**配置面板的归位**按 `contributes.ui.panel`（合法类目见 `src/plugin-ui-contract.js` 的 `VIEW_CATEGORIES`）→ 首个 `views[].category` → 保留在「插件管理」的顺序解析，以 `src/plugin-ui-contract.js` 为**唯一真相**：面板渲染到对应功能 Tab，「插件管理」Tab 只保留插件的开关 / 重载 / 卸载与一行「配置位置 → 跳转」。

```js
module.exports = function myPlugin(ctx) {
  // 声明配置 schema，返回可读写配置对象（Proxy，修改自动持久化）
  const config = ctx.config({
    name: 'my-plugin',
    title: '我的插件',
    fields: [
      { key: 'enabled', type: 'boolean', label: '启用', default: true },
      { key: 'threshold', type: 'slider', label: '拦截阈值', min: 0, max: 100, step: 1, default: 60, unit: '' },
      { key: 'scale', type: 'slider', label: '缩放', min: 0.5, max: 1.5, step: 0.1, default: 1.0, unit: '×' },
      { key: 'host', type: 'string', label: '服务地址', default: 'http://127.0.0.1:9898' },
    ],
  });

  // 使用配置（config 是活的，运行时读最新值）
  ctx.on('some-event', async () => {
    if (!config.enabled) return;
    const result = doSomething(config.threshold, config.scale);
    return result;
  });
};
```

**字段类型**：

| type | 前端控件 | 附加属性 |
|------|---------|---------|
| `boolean` | 开关（checkbox） | — |
| `slider` | 滑块（range） | `min` / `max` / `step` / `unit` |
| `number` | 数字输入 | `min` / `max` |
| `string` | 文本输入 | — |

**持久化**：配置写入 `data/plugin-config.json`，按插件名分组。后端 API：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/plugins/config` | 返回所有插件配置 schema + 当前值 |
| PUT | `/api/plugins/config/:name` | 更新某插件单个配置项（body: `{ key, value }`，自动类型校验 + 范围钳制） |

---

## 五、实战示例：WD14 标签器插件

真实案例。WD14 是独立的插件目录 `plugins/wd14-tagger/`，核心逻辑拆分为：
- `index.js`：插件入口（装配 + 配置 schema + 挂载钩子）
- `client.js`：HTTP 客户端（调用 Python 标签服务）
- `rules.js`：标签 → 风险映射规则

```js
// src/plugin-registry.js
const { PluginManager } = require('./plugin-system');

const pluginManager = new PluginManager();

function initPlugins() {
  const wd14 = require('./wd14'); // 独立模块：tagImage + mapTagsToRisk

  pluginManager.plugin(function wd14Tagger(ctx) {
    // 提供服务，供其他插件注入
    ctx.provide('wd14', wd14);

    // 挂载图片审核标签钩子（收集模式，返回标签 + 风险）
    ctx.on('moderation:image:tag', async (imageBase64) => {
      const result = await wd14.tagImage(imageBase64);   // 调 Python 服务
      const mapped = wd14.mapTagsToRisk(result);          // 映射到风险等级
      return {
        source: 'wd14',
        tags: result,
        risk: { level: mapped.suggestedLevel, score: mapped.suggestedScore, hits: mapped.hits },
      };
    });
  });

  return pluginManager;
}
```

主审核流程（`src/moderator.js`）触发钩子并合并结果：

```js
async function applyPluginTags(result, imageBase64) {
  const contributions = await pluginManager.hook('moderation:image:tag').runCollect(imageBase64);
  const wd14 = contributions.find((c) => c.source === 'wd14');
  if (!wd14 || !wd14.risk?.level) return result;
  // 插件风险更高则提升等级
  if (RISK_ORDER[wd14.risk.level] > RISK_ORDER[result.risk_level]) {
    result.risk_level = wd14.risk.level;
    result.plugin_override = true;
  }
}
```

---

## 六、内置扩展点（审核钩子）

| 钩子名 | 模式 | 参数 | 返回值约定 |
|--------|------|------|-----------|
| `moderation:image:tag` | 收集 | `imageBase64` | `{ source, tags, risk: { level, score, hits } }` |
| `moderation:health` | 收集 | — | `{ wd14: 'ok'\|'down' }` 等健康状态 |

> 新增审核流程的扩展点：在 `moderator.js` 里用 `pluginManager.hook('新事件').runCollect(...)` 触发即可，插件侧用 `ctx.on('新事件', ...)` 挂载。

---

## 七、最佳实践

1. **服务与逻辑分离**：核心逻辑写成独立模块（如 `src/wd14.js`），插件只是薄薄的适配层。方便单测、复用、替换。
2. **优雅降级**：插件依赖的外部服务（如 Python 标签服务）不可用时，返回错误信息而非抛异常，主流程静默降级、不阻断。
3. **作用域隔离**：临时性的插件用 `ctx.scope()` 挂载，用完 `dispose` 一次性清理。
4. **显式声明依赖**：用 `.using` 声明插件依赖，避免加载顺序问题。
5. **清理资源**：定时器、连接、文件句柄一律用 `ctx.onDispose` 注册清理，避免泄漏。
6. **bat 脚本纯 ASCII**：Windows 下 `.bat` 脚本不要写中文（cmd 按 GBK 解码会乱码），用英文提示。

---

## 八、与 cordis 的对照

| 能力 | 本系统 | cordis |
|------|--------|--------|
| 服务注入 | `ctx.provide` / `ctx.inject` | 同 |
| 钩子 | `ctx.on` / `ctx.emitCollect` / `ctx.emitFirst` | `ctx.on` / `ctx.emit` |
| 插件加载 | `pluginManager.plugin(fn)` | `ctx.plugin(fn)` |
| 依赖声明 | 插件 `.using` 属性 | `inject` 属性 |
| 作用域 | `ctx.scope(name)` | `ctx.scope()` / `isolate` / `fork` |
| 生命周期 | 返回 dispose 函数 / `onDispose` | 同 |
| 事件优先级 | `on(event, fn, { order })` | 同（`prepend`/`append`） |

本系统省略了 cordis 的 `isolate`（服务隔离）、`fork`（进程分叉）等重型特性，仅保留审核流程所需的核心范式，保持零依赖、轻量可读。
