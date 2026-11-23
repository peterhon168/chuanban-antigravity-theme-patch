## Opus / Sonnet 真实锁模调度规则

1. **触发场景**：当用户在对话中要求「发一个 opus agent / sonnet agent 做某事」「让 opus / sonnet 子 agent 审阅/执行 xxx」时触发。
2. **严禁假调度铁律**：Antigravity 的 `invoke_subagent` 仅支持 4 个 Gemini 抽象档位（`inherit`/`flash`/`pro`/`flash_lite`）。只要当前主会话自身不是目标 Claude 模型，**严禁**使用 `invoke_subagent` 调用 `opus-agent` 或 `sonnet-agent`（否则 `inherit` 会静默退化为主会话模型）。
3. **标准真实锁模执行方式（默认走原生 `swarm` 精确点名，零外部依赖）**：
   - 直接调用内置 `swarm` 工具拉起单个精确锁模 Worker：
     - Opus 默认模型填 `claude-opus-5-5-high`；Sonnet 默认模型填 `claude-sonnet-5-5-high`（若未来版本升级报错，先调 `swarm{action:"models", all:true}` 刷新最新 ID）。
     - 调用示例：`swarm(action="add", name="opus-worker", model="claude-opus-5-5-high", brief="<完整交代任务目标、相关文件绝对路径、边界约束，并要求完成后通过 post_message 发送 '@coordinator [done] + 完整结论/报告'>")`（Sonnet 同理，将 `name` 设为 `sonnet-worker`、`model` 设为 `claude-sonnet-5-5-high`）。
     - 注意：同一会话内若已有处于 `waiting` 休眠态的同名 `opus-worker`（休眠 0 Token），可直接 `post_message` 点名 `@opus-worker` 继续派新活；若已被 `kill`，下次新建需递增命名（如 `opus-worker-2`）。派发后立即结束当前回合等待 Worker 唤醒回报，收到结果并向用户核实汇总后，按需 `kill` 清理。
   - **可选 CLI 方式**：若本机已安装并登录官方 `agy` CLI，也可通过终端执行 `agy --agent opus-agent --model claude-opus-5-5-high --dangerously-skip-permissions -p "<完整任务提示词>"`（或 `sonnet-agent` 配合 `claude-sonnet-5-5-high`）单次无头运行。
