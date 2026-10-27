# agent-crew 验收报告

状态：**PASS**

验收日期：2026-10-27  
验收角色：项目经理（Codex）  
实施员工：本地 Pi 1.4.0  
交付根目录：`D:\mu skill`  
安装目录：`C:\Users\Administrator\.codex\skills\agent-crew`
Hermes 安装目录：`C:\Users\Administrator\AppData\Local\hermes\skills\software-development\agent-crew`

## 交付物

```text
skill/agent-crew/
  SKILL.md
  agents/openai.yaml
  scripts/crew.js
  references/workflow.md
```

`agent-crew` 是一个零第三方依赖的 Node.js 20+ Skill。它提供：

- 可替换的项目经理身份与 `handoff` 交接快照
- 可替换、可扩展的员工 Agent 命令适配器
- 多员工并行执行
- 员工池查询与任务改派
- 任务 DAG 与循环依赖校验
- 写域冲突控制
- 运行日志、退出码和耗时记录
- 独立验收命令
- `accept` / `reject` / `rework` 门禁
- 持久化状态和机器可读 JSON 输出

## 冻结文件完整性

以下文件由项目经理维护，Pi 未修改：

| 文件 | SHA-256 |
| --- | --- |
| `docs/SPEC.md` | `D983D847CF5C15DE47D216B0B2905CEF19E494611AF3D53D131081D5D940F328` |
| `test/acceptance.test.js` | `47BF695282634557F61BAF119810B7C2B53BE7B7ED3AE4B01DD33EBDCBB4621A` |
| `package.json` | `0490BCCBCC8BB0B61A97997419567E3F08DB0B32BFEAEC3E1EB4C8FFC253A4E7` |

## 独立验收结果

| 项目 | 结果 |
| --- | --- |
| 独立临时副本 `node --test` | **14 / 14 PASS** |
| 真实本地 Pi 端到端 | **PASS** |
| 多员工并行 | **PASS** |
| 任务 DAG 依赖 | **PASS** |
| 写域冲突隔离 | **PASS** |
| 独立验收与签字 | **PASS** |
| 项目经理交接 | **PASS** |
| 员工池查询 | **PASS** |
| 失败任务改派 | **PASS** |
| 改派安全状态限制 | **PASS** |
| 安装副本快速验收 | **PASS** |
| `node --check` | **PASS** |
| Skill 结构等价校验 | **PASS** |

## 真实 Pi 端到端证据

项目经理使用 `agent-crew` 调度本机真实 Pi：

- Pi 入口：`node .../@earendil-works/pi-coding-agent/dist/bundle/cli.js`
- Pi 生成 `deliverable.txt`
- 内容精确为 `AGENT_CREW_PI_OK`
- 员工退出码 `0`，任务进入 `review`
- 独立验收命令退出码 `0`
- 项目经理执行 `accept`
- 最终任务状态 `accepted`

临时验收项目：

```text
D:\Temp\crew-real-pi2-9edbba46c8e446ab8334d0f2558db694
```

## 多员工与交接证据

三个员工并行处理不同任务：

- `worker-a` 执行任务 `a`
- `worker-b` 执行任务 `b` 和重叠写域任务 `d`
- `worker-c` 执行依赖任务 `c`

验证结果：

- `a` 和 `b` 并行
- `d` 与 `a` 的写域重叠，未在 `a` 运行时并发执行
- `c` 在依赖 `a` 被验收前保持 `pending`
- `a` 被接受后，`c` 才被调度
- 所有任务均进入 `review`，没有员工自签
- `codex` 成功交接给 `manager-pi`
- 交接快照成功生成

临时验收项目：

```text
D:\Temp\crew-crew-e2e-1640cf6900014476859793085867c456
```

## Hermes 与员工切换验收

Hermes 被安装为本地 Skill 后，独立完成了一次真实员工切换：

- 项目经理：`hermes`
- 初始员工：`pi-a`
- 第一次运行：真实 Pi 退出码 `1`，任务进入 `failed`
- 改派：`pi-a -> pi-b`，改派历史写入 `assignments`
- 第二次运行：真实 Pi 退出码 `0`，任务进入 `review`
- 独立验收：Hermes 运行验收命令，退出码 `0`
- 最终签字：Hermes `accept`
- 最终状态：`accepted`

项目目录：

```text
D:\hermes work\agent-crew-worker-switch
```

## 验收中发现并修复的缺陷

### 1. `validate --json` 无效状态退出码错误

修复前：输出 `{"valid":false}`，但进程退出码为 `0`。  
修复后：输出相同 JSON，退出码为 `1`。

### 2. 证据路径可通过符号链接逃逸

修复前：项目内符号链接指向项目外文件时，`accept --evidence` 会错误接受。  
修复后：对根目录和目标路径执行 `realpathSync` 规范化，外部目标被拒绝。

### 3. 顶层 falsy JSON 误报有效

修复前：`project.json` 为 `null`、`false`、`0`、空字符串时可能误报 `valid:true`。  
修复后：所有非对象顶层值均返回 `valid:false` 且退出码为 `1`。

### 4. 测试自身存在矛盾

项目经理在验收中修正了旧循环测试：它现在明确要求无效状态退出码为 `1`，避免与正确实现冲突。

## 已知限制

- 写域是提示词约束，不是操作系统级沙箱；证据边界在签字时校验。
- 符号链接逃逸已阻止，但项目内硬链接仍可能指向外部 inode。
- 没有跨进程文件锁；同一项目不要并发运行多个 `crew.js` 管理命令。
- 写域冲突是路径前缀判断，不是完整 glob 语义。
- 验收命令没有绑定交付物内容哈希。
- 中断的运行会标记失败，需要 `task reset` 后重试。
- 官方 `quick_validate.py` 因本机缺少 PyYAML 未执行；已执行零依赖等价结构校验。

## 项目经理结论

`agent-crew` 满足 MVP 规格，已通过独立测试、真实 Pi 调度、多员工分工、写域控制、独立验收和经理交接。批准发布并安装。

**Verdict: PASS**
