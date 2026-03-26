# 技能开发指南 (Skill Development Guide)

本指南详细介绍如何理解、定制和扩展 Subconscious 代理的技能——包括记忆块、工具和代理行为。

## 目录

- [概述](#概述)
- [记忆块架构](#记忆块架构)
  - [默认记忆块](#默认记忆块)
  - [记忆块限制](#记忆块限制)
  - [自定义记忆块](#自定义记忆块)
- [工具系统](#工具系统)
  - [记忆管理工具](#记忆管理工具)
  - [搜索工具](#搜索工具)
  - [客户端工具（SDK）](#客户端工具sdk)
- [创建自定义代理](#创建自定义代理)
  - [修改现有代理](#修改现有代理)
  - [从头创建新代理](#从头创建新代理)
- [最佳实践](#最佳实践)
- [故障排除](#故障排除)

## 概述

Subconscious 代理的"技能"由三个核心组件构成：

```
┌─────────────────────────────────────────────────────────────┐
│                    Subconscious Agent                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │   Memory Blocks  │  │      Tools       │                │
│  │   (记忆块)        │  │     (工具)       │                │
│  │                  │  │                  │                │
│  │  • core_directives│  │  • memory        │                │
│  │  • guidance       │  │  • memory_*      │                │
│  │  • user_prefs     │  │  • web_search    │                │
│  │  • project_ctx    │  │  • conversation  │                │
│  │  • ...            │  │  • Read/Glob/Grep│                │
│  └──────────────────┘  └──────────────────┘                │
│           │                    │                            │
│           └────────┬───────────┘                            │
│                    ▼                                        │
│         ┌──────────────────────┐                           │
│         │   System Prompt      │                           │
│         │   (系统提示词)        │                           │
│         └──────────────────────┘                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## 记忆块架构

记忆块是 Subconscious 代理持久化知识的核心机制。每个记忆块都是一个文件，存储在 git 支持的内存文件系统中（memfs）。

### 默认记忆块

Subconscious 代理默认包含 8 个记忆块：

| 记忆块 | 描述 | 字符限制 | 用途 |
|--------|------|----------|------|
| `core_directives` | 核心行为指南 | 5,000 | 定义代理的角色、行为模式和通信风格 |
| `guidance` | 活动指导 | 3,000 | 存储为下一次会话准备的指导内容 |
| `pending_items` | 待办事项 | 3,000 | 跟踪未完成的工作和后续事项 |
| `project_context` | 项目上下文 | 3,000 | 存储代码库知识和架构决策 |
| `self_improvement` | 自我改进指南 | 5,000 | 记忆架构演化和学习程序的指南 |
| `session_patterns` | 会话模式 | 3,000 | 记录重复行为和常见问题模式 |
| `tool_guidelines` | 工具使用指南 | 5,000 | 工具能力说明和最佳使用方法 |
| `user_preferences` | 用户偏好 | 3,000 | 学习到的编码风格和工具偏好 |

#### 记忆块详解

**1. core_directives（核心指令）**

这是代理的"大脑"，定义了：
- 角色定位："你是一个持续观察 Claude Code 会话的代理"
- 观察规则：如何从转录中提取信息
- 通信风格：观察性、简洁、技术性
- 与 Claude Code 的关系：双向对话，而非单向观察

**2. guidance（指导）**

```
用途：为下一次 Claude Code 会话准备的建议
生命周期：
  - 写入：代理发现有价值的指导时
  - 读取：每次会话开始时注入 Claude Code 上下文
  - 清理：指导过时或已被处理后
```

**3. user_preferences（用户偏好）**

记录用户的学习偏好：
```
示例内容：
- 偏好显式类型注解
- 使用 pnpm 而非 npm
- 偏好函数式编程风格
- 避免使用 any 类型
```

**4. project_context（项目上下文）**

存储代码库相关信息：
```
示例内容：
- 项目：claude-subconscious 插件
- 技术栈：TypeScript, ESM 模块
- 架构决策：使用 Letta Code SDK 实现异步传输
- 已知问题：Windows 上的 tmpfs 问题
```

### 记忆块限制

**关键限制（CRITICAL）：**

```
┌─────────────────────────────────────────────┐
│  ⚠️  硬性限制                                 │
├─────────────────────────────────────────────┤
│  • 最多 12 个记忆文件                        │
│  • 所有文件总计不超过 30,000 字符            │
│  • 默认已有 8 个文件，可创建最多 4 个新文件   │
│  • 单个文件建议不超过 3,000 字符             │
└─────────────────────────────────────────────┘
```

**为什么有限制？**
- 大型系统提示词会挤压消息历史空间
- 可能导致上下文窗口错误
- 影响代理响应质量

### 自定义记忆块

#### 创建新记忆块

使用 `memory` 工具的 `create` 命令：

```typescript
// 示例：创建项目特定的记忆块
memory(
  command: "create",
  path: "/memories/api_design",
  description: "API 设计决策和模式",
  file_text: "RESTful API 设计原则：\n- 使用名词复数作为资源路径\n- 版本控制通过 URL 前缀实现"
)
```

#### 编辑记忆块

**精确编辑（推荐）**：使用 `memory_replace` 或 `memory_insert`

```typescript
// 替换特定文本
memory_replace(
  label: "user_preferences",
  old_str: "使用 npm",
  new_str: "使用 pnpm"
)

// 在末尾添加内容
memory_insert(
  label: "project_context",
  new_str: "\n- 新发现的模式：用户偏好测试驱动开发"
)
```

**大规模重写**：使用 `memory_rethink`

```typescript
// 完全重写记忆块内容
memory_rethink(
  label: "session_patterns",
  new_memory: "观察到的模式：\n1. 每周一倾向于进行代码审查\n2. 下午时段更多调试工作\n3. 用户喜欢逐文件提交而非批量提交"
)
```

#### 记忆块设计原则

1. **单一职责**：每个块只关注一个主题
2. **可读性优先**：内容应一目了然
3. **精简至上**：每行内容都要有价值
4. **定期清理**：删除过时信息

```
✅ 好的设计：
  project_context    → 当前项目的架构决策
  testing_patterns   → 测试相关模式（独立块）
  
❌ 避免：
  project_everything → 所有项目相关信息堆在一起
```

## 工具系统

Subconscious 代理拥有三类工具：

### 记忆管理工具

| 工具 | 用途 | 使用场景 |
|------|------|----------|
| `memory` | 完整的记忆块管理 | 创建、删除、重命名记忆块 |
| `memory_replace` | 精确替换文本 | 修改特定内容 |
| `memory_insert` | 插入文本 | 添加新内容 |
| `memory_rethink` | 完全重写 | 大规模重构记忆内容 |

#### memory 工具详解

```typescript
// 创建新记忆块
memory(command: "create", path: "/memories/label", 
       description: "描述", file_text: "初始内容")

// 删除记忆块
memory(command: "delete", path: "/memories/old_block")

// 重命名记忆块
memory(command: "rename", old_path: "/memories/old", 
       new_path: "/memories/new")

// 更新描述
memory(command: "rename", path: "/memories/block", 
       description: "新的描述")
```

### 搜索工具

| 工具 | 用途 | 参数示例 |
|------|------|----------|
| `conversation_search` | 搜索历史消息 | `query`, `roles`, `start_date`, `end_date` |
| `web_search` | 网络搜索 | `query`, `num_results`, `category` |
| `fetch_webpage` | 获取网页内容 | `url` |

#### conversation_search 使用示例

```typescript
// 搜索所有消息
conversation_search(query: "错误处理")

// 只搜索助手消息
conversation_search(query: "API 设计", roles: ["assistant"])

// 按日期范围搜索
conversation_search(
  query: "部署问题",
  start_date: "2024-01-15",
  end_date: "2024-01-20"
)

// 搜索特定日期的所有消息
conversation_search(
  start_date: "2024-09-04",
  end_date: "2024-09-04"
)
```

#### web_search 使用示例

```typescript
// 基本搜索
web_search(query: "TypeScript 最佳实践")

// 分类搜索
web_search(
  query: "LLM 最新研究",
  category: "research paper",
  include_domains: ["arxiv.org"]
)

// 限制域名
web_search(
  query: "React 文档",
  include_domains: ["react.dev", "github.com"]
)

// 按时间过滤
web_search(
  query: "最新 AI 新闻",
  start_published_date: "2024-01-01"
)
```

**支持的类别**：
- `company` - 公司信息
- `research paper` - 研究论文
- `news` - 新闻
- `pdf` - PDF 文档
- `github` - GitHub 仓库
- `tweet` - 推文
- `financial report` - 财务报告

### 客户端工具（SDK）

通过 Letta Code SDK，Subconscious 代理可以在用户机器上执行文件操作：

| 工具 | 用途 | 配置模式 |
|------|------|----------|
| `Read` | 读取文件 | `read-only` / `full` |
| `Glob` | 查找文件 | `read-only` / `full` |
| `Grep` | 搜索文件内容 | `read-only` / `full` |

**SDK 工具配置**：

```bash
# 只读模式（默认）- 只能读取文件
export LETTA_SDK_TOOLS="read-only"

# 完整模式 - 可以执行所有操作包括 Bash、Edit、Write
export LETTA_SDK_TOOLS="full"

# 关闭客户端工具
export LETTA_SDK_TOOLS="off"
```

#### Read 工具示例

```typescript
// 读取特定文件
Read(path: "/Users/project/src/main.ts")

// 读取配置文件
Read(path: "/Users/project/tsconfig.json")
```

#### Glob 工具示例

```typescript
// 查找所有 TypeScript 文件
Glob(pattern: "**/*.ts")

// 查找特定目录下的文件
Glob(pattern: "src/components/**/*.tsx")
```

#### Grep 工具示例

```typescript
// 搜索包含特定文本的文件
Grep(pattern: "TODO", path: "/Users/project")

// 使用正则表达式搜索
Grep(pattern: "function\\s+\\w+", path: "/Users/project/src")
```

## 创建自定义代理

### 修改现有代理

#### 方法一：通过环境变量

```bash
# 使用自定义代理 ID
export LETTA_AGENT_ID="agent-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

#### 方法二：通过 Letta ADE（Agent Development Environment）

1. 访问 [app.letta.com](https://app.letta.com)
2. 选择你的代理
3. 在 ADE 中修改：
   - 记忆块内容
   - 工具配置
   - 系统提示词

#### 方法三：修改 Subconscious.af 文件

`Subconscious.af` 是代理的定义文件（JSON 格式）：

```json
{
  "agents": [{
    "name": "Subconscious",
    "memory_blocks": [...],
    "tools": [...],
    "system": "你是一个...",
    "llm_config": {
      "model": "zai/glm-5",
      "context_window": 90000
    }
  }]
}
```

### 从头创建新代理

#### 步骤 1：定义代理目标

明确你的代理需要：
- 观察什么类型的信息？
- 提供什么类型的指导？
- 需要哪些工具？

#### 步骤 2：设计记忆架构

```
示例：代码审查代理

记忆块设计：
├── review_guidelines     # 审查标准和规则
├── common_issues        # 常见问题模式
├── author_patterns      # 作者特定的编码模式
├── pending_reviews      # 待处理的审查
└── feedback_history     # 反馈历史记录
```

#### 步骤 3：编写系统提示词

```
你是一个代码审查助手。

角色：持续观察代码变更，提供审查建议。

观察规则：
- 关注代码风格一致性
- 识别潜在的 bug 模式
- 记录常见问题和解决方案

通信风格：
- 简洁、具体、有建设性
- 提供修复建议而非只指出问题
```

#### 步骤 4：选择工具

根据代理需求选择工具：

```
最小配置：
- memory
- memory_replace
- memory_insert

增强配置（推荐）：
- 上述 +
- conversation_search
- web_search

完整配置：
- 上述 +
- Read
- Glob
- Grep
```

#### 步骤 5：创建代理定义文件

```json
{
  "agents": [{
    "name": "CodeReviewer",
    "description": "代码审查代理",
    "system": "你的系统提示词...",
    "llm_config": {
      "model": "anthropic/claude-sonnet-4-5",
      "context_window": 200000
    },
    "blocks": [...],
    "tools": [...]
  }]
}
```

#### 步骤 6：导入代理

```bash
# 使用 Letta CLI 导入
letta agent create --agent-file your-agent.af

# 或通过 API
curl -X POST https://api.letta.com/v1/agents \
  -H "Authorization: Bearer $LETTA_API_KEY" \
  -d @your-agent.af
```

## 最佳实践

### 记忆管理最佳实践

1. **定期清理**
   ```
   每隔 10+ 会话检查一次：
   - 删除过时信息
   - 合并重复内容
   - 精简冗长段落
   ```

2. **渐进式学习**
   ```
   ✅ 好的做法：
   - 明确陈述（"我想要..."）→ 直接添加
   - 用户修正 → 记录模式
   - 隐式模式 → 等待确认
   
   ❌ 避免：
   - 猜测用户偏好
   - 过早下结论
   ```

3. **记忆块粒度**
   ```
   原则：可读性 > 完整性
   
   ✅ 好的设计：
   3-5 行简洁描述关键信息
   
   ❌ 避免：
   50 行详细日志
   ```

### 工具使用最佳实践

1. **记忆操作优先级**
   ```
   小改动 → memory_replace / memory_insert
   大改动 → memory_rethink
   新主题 → memory create
   ```

2. **搜索策略**
   ```
   查找信息流程：
   1. conversation_search（检查是否讨论过）
   2. web_search（需要外部信息时）
   3. fetch_webpage（深入了解特定页面）
   ```

3. **文件探索**
   ```
   理解代码库：
   1. Glob（找到相关文件）
   2. Read（阅读关键文件）
   3. Grep（搜索特定模式）
   ```

### 性能优化

1. **控制记忆块大小**
   ```bash
   # 监控记忆使用情况
   # 理想：总计 < 25,000 字符
   # 警告：总计 > 28,000 字符
   # 危险：总计 > 30,000 字符（会导致错误）
   ```

2. **并行工具调用**
   ```
   ✅ 可并行的工具：
   - web_search
   - conversation_search
   - fetch_webpage
   
   ❌ 不能并行的工具：
   - memory 系列（会冲突）
   ```

3. **模型选择**
   ```
   性能推荐：
   - zai/glm-5：免费，适合基础任务
   - anthropic/claude-sonnet-4-5：最佳工具使用
   - openai/gpt-4.1-mini：平衡性价比
   ```

## 故障排除

### 常见问题

**问题：记忆块无法更新**

```
可能原因：
1. 超过字符限制（检查总计是否超过 30,000）
2. 达到文件数量上限（检查是否超过 12 个文件）
3. old_str 不匹配（memory_replace 需要精确匹配）

解决方案：
# 检查记忆使用情况
letta agent get --agent-id $LETTA_AGENT_ID

# 清理记忆
memory_replace(label: "stale_block", old_str: "旧内容", new_str: "")
```

**问题：工具调用失败**

```
可能原因：
1. SDK 工具未启用（检查 LETTA_SDK_TOOLS）
2. 模型不支持工具调用（切换到更强的模型）
3. 权限问题（检查文件路径是否正确）

解决方案：
export LETTA_SDK_TOOLS="read-only"
export LETTA_MODEL="anthropic/claude-sonnet-4-5"
```

**问题：代理响应缓慢**

```
可能原因：
1. 记忆块过大
2. 消息历史过长
3. 模型响应慢

解决方案：
1. 精简记忆块内容
2. 使用更快的小模型：export LETTA_MODEL="anthropic/claude-haiku-4-5"
3. 检查 Letta 服务状态
```

### 调试日志

```bash
# 查看日志文件
tail -f /tmp/letta-claude-sync-$(id -u)/*.log

# 主要日志文件：
# - session_start.log    # 会话初始化
# - sync_letta_memory.log # 记忆同步
# - send_messages.log    # 消息发送
# - send_worker_sdk.log  # SDK 后台工作
```

### 获取帮助

- **GitHub Issues**: [letta-ai/claude-subconscious/issues](https://github.com/letta-ai/claude-subconscious/issues)
- **Letta 文档**: [docs.letta.com](https://docs.letta.com)
- **Letta Discord**: [discord.gg/letta](https://discord.gg/letta)

---

## 附录

### A. 记忆块完整参考

```json
{
  "core_directives": {
    "limit": 5000,
    "description": "主要角色、行为指南和处理逻辑"
  },
  "guidance": {
    "limit": 3000,
    "description": "活动指导，写入有价值的内容供下次会话使用"
  },
  "pending_items": {
    "limit": 3000,
    "description": "未完成工作、明确 TODO、后续事项"
  },
  "project_context": {
    "limit": 3000,
    "description": "代码库知识、架构决策、已知问题"
  },
  "self_improvement": {
    "limit": 5000,
    "description": "记忆架构演化指南和学习程序"
  },
  "session_patterns": {
    "limit": 3000,
    "description": "重复行为、时间模式、常见问题"
  },
  "tool_guidelines": {
    "limit": 5000,
    "description": "工具使用说明和最佳实践"
  },
  "user_preferences": {
    "limit": 3000,
    "description": "编码风格、工具偏好、通信风格"
  }
}
```

### B. 工具参数速查表

| 工具 | 必需参数 | 可选参数 |
|------|----------|----------|
| `memory` | `command` | `path`, `file_text`, `description`, `old_string`, `new_string`, `insert_line`, `insert_text`, `old_path`, `new_path` |
| `memory_replace` | `label`, `old_str`, `new_str` | - |
| `memory_insert` | `label`, `new_str` | `insert_line` |
| `memory_rethink` | `label`, `new_memory` | - |
| `conversation_search` | - | `query`, `roles`, `limit`, `start_date`, `end_date` |
| `web_search` | `query` | `num_results`, `category`, `include_domains`, `exclude_domains`, `start_published_date`, `end_published_date` |
| `fetch_webpage` | `url` | - |

### C. 环境变量完整列表

```bash
# 必需
export LETTA_API_KEY="your-api-key"

# 可选
export LETTA_MODE="whisper"           # whisper | full | off
export LETTA_AGENT_ID="agent-xxx"     # 自定义代理 ID
export LETTA_BASE_URL="..."           # 自托管服务器
export LETTA_MODEL="..."              # 模型覆盖
export LETTA_CONTEXT_WINDOW="1048576" # 上下文窗口大小
export LETTA_SDK_TOOLS="read-only"    # read-only | full | off
export LETTA_HOME="$HOME"             # 状态文件目录
```

---

*本指南基于 claude-subconscious v2.0.2 编写*

*最后更新：2026-03-26*