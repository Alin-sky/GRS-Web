# GRS 通用审核系统

面向 QQ / Koishi 机器人的多通道 AI 内容审核（文本 + 图片）。本地 Ollama、云端大模型、阿里云内容安全均为可选通道，含提示词注入防御与敏感词预检兜底，支持基于 cordis 的插件扩展与可视化审核流程编排。

**版本 0.1.0**

## 运行

```bash
npm install && npm start
```

启动后访问 <http://localhost:11451>。零配置即可启动（此时仅执行敏感词预检）；
启用更多通道请复制 `config/default.example.json` 为 `config/default.json` 并填写。

> `config/default.json`、`prompts/` 正文、`data/` 运行数据均不入库，需本地自备。

## 文档

更多设计说明见 `docs/`。

## License

MIT
