# Pi Continuity

**为长时间编码任务提供可追溯记忆、笔记式压缩和检查点恢复。**

[English](README.md) | 简体中文 · [MIT 许可证](LICENSE)

Pi Continuity 把任务目标、用户纠正、笔记及原始证据保存在本地 SQLite 中，为下一次模型请求生成有预算限制的上下文，并保留原始记录供按需读取。同一套核心可通过扩展和 SDK 宿主接入 [Pi](https://github.com/earendil-works/pi)。

## 主要能力

- **保留用户纠正。** 上下文裁剪会保留明确的用户输入、已确认笔记和必须携带的待办状态；必要内容装不下时会明确失败。
- **持续维护笔记。** 笔记带有稳定的条目键、证据链接、不可变版本和撤销记录。模型整理的观察保持待确认状态，不能覆盖已确认指令。
- **压缩后仍能追溯。** 压缩视图记录来源和省略项，原始文本、工具结果和归档图片可按需取回。
- **从固定检查点恢复。** 检查点保存笔记版本和任务状态；严格恢复会进入新的执行世代，不会悄悄混入检查点之后的修改。
- **在模型执行前检查请求。** SDK 包装层检查系统提示、消息、工具定义及 Continuity 上下文的完整输入，并预留输出空间。
- **管理记忆和操作状态。** 结构化记忆支持去重、快照和三方合并提案；操作记录区分已完成和结果不明的操作，供显式核对。

## 快速开始

需要 **Node.js 22.19+**。当前版本已在 **Node.js 24.19.0 / Windows**、Pi **0.85.1** 上验证，数据库使用 Node 内置的 `node:sqlite`。

```sh
git clone https://github.com/ninthcj/pi-continuity.git
cd pi-continuity
npm ci
npm run build
npm test
```

运行离线检查点与恢复演示：

```sh
npm run demo
```

演示数据写入 `.demo/`，无需模型凭据。

在当前仓库中启动 Pi 终端界面：

```sh
npx pi
```

Pi 会自动发现项目扩展，默认使用 `active` 模式。模型配置和凭据沿用 Pi 的 `~/.pi/agent` 目录。

## 接入另一个 Pi 项目

先在本仓库生成可安装的压缩包：

```sh
npm pack
```

然后在目标项目中安装。请把示例路径替换为压缩包的实际路径：

```sh
npm install ../pi-continuity/pi-continuity-0.1.1.tgz
```

在目标项目中创建 `.pi/extensions/continuity.mjs`：

```js
export { default } from 'pi-continuity/extension';
```

使用 `npx pi` 启动终端界面。需要在最终模型调用入口实施严格检查时，使用 SDK 宿主：

```sh
npx pi-continuity-pi "完成要求的功能" --runtime
```

这个命令处理一次提示后退出。需要常驻应用时，使用 `pi-continuity/pi-host` 中的 `createContinuityPiSession`，通过它管理会话、检查点、恢复和关闭。请保留扩展，以启用压缩和原生笔记工具。**仅启用扩展，不能保证检查失败时阻止最终模型调用。**

安装包包含编译后的 JavaScript，使用方不需要在 `node_modules` 内加载 TypeScript。

## 笔记工作流

默认笔记模式**不增加模型调用**。它增量保留用户原话，跳过“继续”等简单确认，并把带明确标签的观察整理为待确认笔记。

| 命令或工具 | 用途 |
| --- | --- |
| `/continuity` | 查看当前任务与恢复状态 |
| `/continuity notes` | 查看当前笔记 |
| `/continuity source <eventId>` | 读取原始证据 |
| `/continuity note <json>` | 由宿主创建、更新或撤销笔记 |
| `/continuity observe` | 使用当前 Pi 模型执行一批语义整理 |
| `continuity_note` | 供 Agent 维护待确认笔记的工具 |
| `continuity_recall` | 供 Agent 分页读取笔记和证据的工具 |

如果 Pi 配置限制了工具列表，需要显式允许 `continuity_note` 和 `continuity_recall`。

如需在压缩前执行可选的语义整理，设置 `PI_CONTINUITY_NOTEBOOK=semantic`。PowerShell 示例：

```powershell
$env:PI_CONTINUITY_NOTEBOOK = 'semantic'
npx pi
```

语义整理使用当前 Pi 模型，可能产生额外调用费用。整理器可以修改或撤销待确认观察，不能确认需求或替换已经确认的用户／宿主笔记。笔记更新、来源校验、自定义整理器和恢复行为详见[笔记接入指南](docs/continuity/NOTEBOOK.md)（英文）。

## 核心 API

核心可以脱离 Pi 会话单独使用。安装压缩包后：

```js
import { ContinuityStore } from 'pi-continuity';

const store = new ContinuityStore('./continuity.db', { mode: 'active' });
try {
  const task = store.createTask('my-project', 'main', '修复登录', {
    constraints: ['保留现有公共 API'],
  });
  store.recordEvent(task.task_id, 'user_input', {
    text: '先复现超时问题，不要修改计费模块。',
  });

  const manifest = store.buildManifest(task.task_id, { budget: 2000 });
  const compact = store.compressContext(task.task_id, { budget: 2000 });
  console.log(manifest.instructions, compact.viewId);
} finally {
  store.close();
}
```

公开入口包括：`pi-continuity`、`/adapter`、`/pi-sdk`、`/pi-host`、`/extension`、`/notebook-observer` 和 `/context-budget`。

## 运行模式与本地数据

Pi 扩展通过 `PI_CONTINUITY_MODE` 设置模式；核心和宿主通过 `mode` 参数设置：

| 模式 | 行为 |
| --- | --- |
| `off` | 保持原生模型请求，不注入 Continuity 上下文 |
| `record` | 记录证据，不修改调用方的模型消息 |
| `active` | 构建 Continuity 上下文，并执行当前接入方式支持的检查 |

Pi 接入将数据库和任务指针保存在项目的 `.pi/` 目录中，大体积数据使用按内容寻址的存储。Pi 原生 JSONL 会话仍由 Pi 管理。迁移或备份状态时，请同时保留数据库及其引用的数据块。

记忆快照与合并会保留历史。选定文件的快照提供可移植的字节存储，不负责恢复整个工作目录。可选的系统快照支持取决于文件系统与进程权限。

## 验证情况与限制

当前离线测试套件 **83 项全部通过**，覆盖中文用户纠正保留、长输入归档、预算拒绝、笔记更新与撤销、检查点恢复、整理器权限，以及使用模拟提供方的真实 Pi SDK 接入。另已通过全新项目中的独立安装验证。

- 尚未进行真实模型的语义质量基准测试。证据链接证明来源，不证明模型理解一定正确。
- 默认使用 `cl100k_base` 计量文本，并为完整请求增加余量。需要供应商专用计量时，可传入 `countRequestTokens(context, model)`；多模态内容及私有序列化格式不能保证统一精确计量。
- 多个独立宿主仍需进程协调或隔离；本库不提供文件系统沙箱。
- 检查点恢复不会自动回滚代码或整个工作目录，也不会自动重放结果不明的外部操作。

详细资料：[验证结果](docs/continuity/VALIDATION.md) · [审计边界](docs/continuity/AUDIT.md) · [压缩方案研究](docs/continuity/COMPRESSION_RESEARCH.md)（英文）。

## 许可证与致谢

Copyright © 2026 **ninthcj**。本项目采用 [MIT 许可证](LICENSE)，允许使用、修改、分发和商用；分发副本或软件的重要部分时，需要保留版权声明和许可声明。

Pi 接入使用官方 [Pi SDK](https://github.com/earendil-works/pi)，文本计量使用 [js-tiktoken](https://github.com/dqbd/tiktoken)。依赖保留各自的许可证。笔记设计参考资料见[笔记接入指南](docs/continuity/NOTEBOOK.md)。
