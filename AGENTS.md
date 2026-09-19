# NSZZJ-Free-LLM-Aggregator · 本项目的约定

> 通用偏好（沟通方式、沙箱/环境坑）在全局 `~/.dsh/AGENTS.md`，这里只写**本项目特有**的规矩。
> 这份是要提交的（对别人 fork / 接手也有用）。

## 文档各写什么

| 文件 | 只写 | 不写 |
|---|---|---|
| `README.md` | 半年后**仍然成立**的：功能、环境变量、安装方式、真正的取舍与限制（已知限制） | 这一版特有的临时状态、开发过程 |
| `docs/Release-<版本>.md` | **这一版特有**的：更新日志（含升级要动的配置）、这版包有哪些架构 | 重复 README 已有的长期限制（例如 Responses 无状态、Anthropic 不处理 thinking） |
| `docs/设计文档.md` | 现在这套设计**是什么、为什么**，含"故意不做 X"这类约束 | "曾经如何、后来删了"的历史叙事、开发流水账（谁在哪天完成了什么） |
| `docs/待办.md` | **只写还没做的事**；做完删掉整条 | 写作约定、设计理由、已完成记录 |

判断标准：**这句话半年后还成立吗？** 不成立 → 不进 README、进 Release 正文。

## 版本号怎么定

**看使用者要不要改东西，不看改动大小。**

- 必须改配置/命令才能继续用（例如客户端地址变了）→ **大版本**
- 加功能、行为变化（不改正则受影响，例如上游 baseUrl 拼接规则变了）→ **小版本**
- 用户完全不用动（换容器基底、内部重构）→ **不升号**

## 打包与发布的命名

- 产物：`NSZZJ-FreeLlmAggregator_Docker_<版本>_<架构>.tar.gz`（`scripts/build-image.js` 生成，前缀=作者+项目+Docker 运行方式）
- 架构名**只有四个**：`x86-64` / `x86-32` / `arm64` / `arm32`；脚本内部会把 Node 的 `x64` 和 Docker 的 `amd64` 翻译成 `x86-64`
- 镜像标签保持小写：`nszzj-free-llm-aggregator:<版本>`（Docker 仓库名必须小写）
- 目前**只出 x86-64 和 arm64**：32 位没有 —— Node 官方从 16 之后不再发 32 位 Linux 构建
- 跨架构构建：`node scripts/build-image.js --arch arm64`（Windows/本地走 QEMU；不要用 `npm run image`，见全局说明）

## 本地文件（不进 git，别当成项目文档）

- `nszzj-free-llm-aggregator/`：给 GitHub 的干净副本，**整个目录会被拷过去**（只排除 `.git`），
  所以**任何东西放进项目目录就等于会进仓库**——个人备忘一律别放。
- 它本身也是独立 git 仓库（remote 指向 GitHub），里面还有仓库专属的 `LICENSE` 和图标：
  **重新生成时只能覆盖拷贝，绝不能删目录**。
- `data/`、`dist/`、`.tmp/`、`normal.env`、`data-backup-*/` 都在 `.gitignore` 里。
