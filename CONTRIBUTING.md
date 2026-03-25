# Contributing to claude-subconscious

感谢你对 claude-subconscious 感兴趣！这是一个为 Claude Code 提供"潜意识"能力的 Letta 代理插件。我们欢迎所有形式的贡献。

## 目录

- [行为准则](#行为准则)
- [如何贡献](#如何贡献)
  - [报告 Bug](#报告-bug)
  - [提出新功能](#提出新功能)
  - [提交 Pull Request](#提交-pull-request)
- [开发环境设置](#开发环境设置)
- [代码风格指南](#代码风格指南)
- [测试要求](#测试要求)
- [项目结构](#项目结构)
- [提交信息规范](#提交信息规范)
- [许可证](#许可证)

## 行为准则

本项目采用贡献者公约作为行为准则。参与本项目即表示你同意遵守其条款。请阅读 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)（如适用）了解更多详情。

## 如何贡献

### 报告 Bug

如果你发现了 bug，请通过 [GitHub Issues](https://github.com/letta-ai/claude-subconscious/issues) 提交。提交前请：

1. **搜索现有 issues** - 确保该问题尚未被报告
2. **收集信息** - 准备以下细节：
   - 操作系统及版本（如 macOS 14.3, Ubuntu 22.04, Windows 11）
   - Node.js 版本（运行 `node --version`）
   - Claude Code 版本
   - Letta API 版本或自托管版本

**Bug 报告模板：**

```markdown
## 描述
简要描述遇到的问题。

## 复现步骤
1. 设置环境变量 `export LETTA_API_KEY="..."`
2. 运行 `claude` 并启用插件
3. 执行命令 '...'
4. 看到错误

## 预期行为
描述你期望发生什么。

## 实际行为
描述实际发生了什么。

## 环境信息
- OS: [如 macOS 14.3]
- Node.js: [如 v22.0.0]
- Claude Code: [如 v1.0.0]
- Letta: [云服务 或 自托管版本]

## 日志输出
如果适用，请附上相关日志：
```bash
tail -f /tmp/letta-claude-sync-$(id -u)/*.log
```

## 截图
如果适用，添加截图帮助解释问题。
```

### 提出新功能

我们欢迎新功能建议！请通过 [GitHub Issues](https://github.com/letta-ai/claude-subconscious/issues) 提交，并使用以下模板：

```markdown
## 功能描述
清晰描述你希望添加的功能。

## 使用场景
描述这个功能如何帮助你或其他人：
- 作为用户，我希望...
- 这样我就可以...

## 可能的实现方案
如果你有实现思路，请简要描述。

## 替代方案
你是否考虑过其他替代方案？

## 附加信息
任何其他相关信息、截图或参考链接。
```

**功能请求标签：** 请为 issue 添加 `enhancement` 标签。

### 提交 Pull Request

#### 准备工作

1. **Fork 本仓库**
   ```bash
   # 在 GitHub 上点击 Fork 按钮
   ```

2. **Clone 你的 fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/claude-subconscious.git
   cd claude-subconscious
   ```

3. **安装依赖**
   ```bash
   npm install
   ```

4. **设置上游仓库**
   ```bash
   git remote add upstream https://github.com/letta-ai/claude-subconscious.git
   ```

#### 开发流程

1. **创建功能分支**
   ```bash
   git checkout -b feature/your-feature-name
   # 或修复分支
   git checkout -b fix/issue-description
   ```

2. **进行更改**
   - 遵循 [代码风格指南](#代码风格指南)
   - 添加必要的测试
   - 更新相关文档

3. **运行测试**
   ```bash
   npm test
   ```

4. **提交更改**
   ```bash
   git add .
   git commit -m "type: 简短描述"
   ```
   遵循 [提交信息规范](#提交信息规范)

5. **同步上游更改**
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

6. **推送到你的 fork**
   ```bash
   git push origin feature/your-feature-name
   ```

7. **创建 Pull Request**
   - 在 GitHub 上打开你的 fork
   - 点击 "Compare & pull request"
   - 填写 PR 模板（见下方）

#### Pull Request 模板

```markdown
## 更改描述
简要描述此 PR 的更改内容。

## 相关 Issue
Fixes #issue_number（如有）

## 更改类型
- [ ] Bug 修复（非破坏性更改，修复问题）
- [ ] 新功能（非破坏性更改，添加功能）
- [ ] 破坏性更改（会导致现有功能无法正常工作的修复或功能）
- [ ] 文档更新

## 测试
描述你如何测试这些更改：
1. 运行单元测试
2. 手动测试场景
3. ...

## 检查清单
- [ ] 代码遵循项目的代码风格
- [ ] 已进行自我代码审查
- [ ] 代码有适当的注释
- [ ] 文档已更新（如适用）
- [ ] 测试已添加/更新并通过
- [ ] 无新的警告
```

## 开发环境设置

### 系统要求

- **Node.js**: >= 18.0.0
- **npm**: 随 Node.js 安装

### 安装步骤

```bash
# Clone 仓库
git clone https://github.com/letta-ai/claude-subconscious.git
cd claude-subconscious

# 安装依赖
npm install

# 设置环境变量（用于测试）
export LETTA_API_KEY="your-api-key"
```

### Linux 特别说明

如果你的 `/tmp` 目录在不同的文件系统上（Ubuntu、Fedora、Arch 常见），可能需要设置 `TMPDIR`：

```bash
mkdir -p ~/.claude/tmp
export TMPDIR="$HOME/.claude/tmp"
```

### 本地测试

1. **运行测试套件**
   ```bash
   npm test
   ```

2. **监视模式**
   ```bash
   npm run test:watch
   ```

3. **在 Claude Code 中测试插件**
   ```bash
   # 从项目目录
   /plugin enable .
   ```

## 代码风格指南

### TypeScript 规范

本项目使用 TypeScript 并采用 ES 模块格式（`"type": "module"`）。

**基本规则：**

- 使用 **ES 模块语法**（`import`/`export`），而非 CommonJS（`require`）
- 为所有函数和变量添加 **类型注解**
- 使用 **`async/await`** 而非 `.then()` 链
- 优先使用 **`const`**，必要时使用 `let`，避免 `var`

**示例：**

```typescript
// ✅ 推荐
import { readFileSync } from 'fs';

export async function processTranscript(
  transcript: string,
  options?: ProcessOptions
): Promise<TranscriptResult> {
  const lines = transcript.split('\n');
  // ...
  return result;
}

// ❌ 避免
const fs = require('fs');

function processTranscript(transcript, options) {
  // 无类型注解
  // ...
}
```

### 命名约定

| 类型 | 约定 | 示例 |
|------|------|------|
| 文件名 | camelCase | `agent_config.ts` |
| 类/接口 | PascalCase | `AgentDetails`, `LlmConfig` |
| 函数/方法 | camelCase | `buildLlmConfig()` |
| 常量 | UPPER_SNAKE_CASE | `CONFIG_DIR`, `DEFAULT_AGENT_FILE` |
| 私有属性 | _前缀 camelCase | `_cachedAgent` |

### 注释规范

- **导出的函数** 必须有 JSDoc 注释
- **复杂逻辑** 必须有行内注释解释
- 注释使用 **英文**（与代码库一致）

```typescript
/**
 * Validate agent ID format
 * 
 * @param agentId - The agent ID to validate
 * @returns true if valid, false otherwise
 */
export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_REGEX.test(agentId);
}

// Check if the agent's model is available on the server
// If not, fall back to auto-selection
const isModelAvailable = availableModels.some(
  m => m.handle === requestedModel
);
```

### 文件组织

```
scripts/
├── agent_config.ts          # 主要逻辑
├── agent_config.test.ts     # 对应测试
├── conversation_utils.ts    # 工具函数
└── ...
```

每个模块应有对应的测试文件：`module.ts` → `module.test.ts`

## 测试要求

### 测试框架

本项目使用 **Vitest** 进行测试。

### 测试命名

测试描述应清晰表达测试目的：

```typescript
describe('isValidAgentId', () => {
  describe('valid agent IDs', () => {
    it('should accept a properly formatted agent ID', () => {
      expect(isValidAgentId('agent-a1b2c3d4-...')).toBe(true);
    });
  });

  describe('invalid agent IDs - missing prefix', () => {
    it('should reject UUID without "agent-" prefix', () => {
      expect(isValidAgentId('a1b2c3d4-...')).toBe(false);
    });
  });
});
```

### 测试覆盖率

- **新功能** 必须有相应的测试
- **Bug 修复** 应包含回归测试
- 目标覆盖率：**80%+**

### 运行测试

```bash
# 运行所有测试
npm test

# 监视模式
npm run test:watch

# 查看覆盖率
npm test -- --coverage
```

### 测试最佳实践

1. **独立性** - 每个测试应独立运行，不依赖其他测试
2. **清理** - 使用 `afterEach` 清理状态
3. **描述性** - 测试名称应描述预期行为
4. **边界情况** - 测试边界和异常情况

```typescript
describe('buildLlmConfig', () => {
  afterEach(() => {
    delete process.env.LETTA_CONTEXT_WINDOW;
  });

  it('should override context_window from LETTA_CONTEXT_WINDOW env var', () => {
    process.env.LETTA_CONTEXT_WINDOW = '1048576';
    const config = buildLlmConfig('openai/gpt-5.2', SAMPLE_MODELS, undefined);
    expect(config.context_window).toBe(1048576);
  });
});
```

## 项目结构

```
claude-subconscious/
├── .github/
│   └── workflows/
│       └── letta.yml          # Letta Code GitHub Action
├── assets/                    # 文档图片资源
├── hooks/                     # Claude Code hooks 相关文件
│   ├── hooks.json             # Hooks 配置
│   ├── silent-launcher.exe    # Windows 静默启动器
│   ├── silent-npx.cjs         # NPX 静默包装器
│   └── stdio-preload.cjs      # stdio 预加载
├── scripts/                   # 核心 TypeScript 脚本
│   ├── agent_config.ts        # 代理配置管理
│   ├── agent_config.test.ts   # 代理配置测试
│   ├── conversation_utils.ts  # 对话工具函数
│   ├── pretool_sync.ts        # PreToolUse hook
│   ├── send_messages_to_letta.ts  # Stop hook
│   ├── send_worker_sdk.ts     # SDK 后台 worker
│   ├── session_start.ts       # SessionStart hook
│   └── sync_letta_memory.ts   # UserPromptSubmit hook
├── Subconscious.af            # 默认代理定义文件
├── package.json               # 项目配置
├── README.md                  # 项目说明
├── CHANGELOG.md               # 变更日志
├── LICENSE                    # MIT 许可证
└── CONTRIBUTING.md            # 本文件
```

### Hooks 说明

| Hook | 脚本 | 超时 | 用途 |
|------|------|------|------|
| `SessionStart` | `session_start.ts` | 5s | 通知代理会话开始 |
| `UserPromptSubmit` | `sync_letta_memory.ts` | 10s | 注入记忆和消息 |
| `PreToolUse` | `pretool_sync.ts` | 5s | 工具使用前更新 |
| `Stop` | `send_messages_to_letta.ts` | 120s | 异步发送转录 |

## 提交信息规范

我们采用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

### 格式

```
<type>(<scope>): <subject>

<body>

<footer>
```

### 类型 (type)

| 类型 | 描述 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构（不是新功能也不是修复） |
| `test` | 添加或修改测试 |
| `chore` | 构建过程或辅助工具变更 |
| `perf` | 性能优化 |

### 示例

```bash
# 新功能
git commit -m "feat: add support for custom agent memory blocks"

# Bug 修复
git commit -m "fix: resolve conversation ID caching issue"

# 文档更新
git commit -m "docs: update installation instructions for Windows"

# 带范围
git commit -m "fix(hooks): correct timeout handling in PreToolUse"
```

## 许可证

本项目采用 **MIT 许可证**。提交贡献即表示你同意你的代码将在同一许可证下发布。

```
MIT License

Copyright (c) 2026 Letta, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

---

## 联系方式

- **问题与讨论**: [GitHub Issues](https://github.com/letta-ai/claude-subconscious/issues)
- **功能请求**: [GitHub Issues](https://github.com/letta-ai/claude-subconscious/issues/new?labels=enhancement)
- **安全问题**: 请私下联系维护者

---

再次感谢你对 claude-subconscious 的关注和贡献！ 🎉