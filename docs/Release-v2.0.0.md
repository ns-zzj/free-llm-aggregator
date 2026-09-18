# v2.0.0

## 更新日志

**2.0.0 是破坏性版本：客户端地址变了，旧的裸 `/v1/*` 不再支持。**（项目刚发布、当时还没有用户，所以没做兼容层。）

**客户端地址按"协议族"分前缀**（地址里再带一段 `/v1` 也认）：

| 客户端说什么 | base_url | 鉴权 |
|---|---|---|
| OpenAI 方言 | `http://<地址>:8787/openai` | `Authorization: Bearer <下游 apikey>` |
| Anthropic 方言 | `http://<地址>:8787/anthropic` | `x-api-key: <下游 apikey>`（或 Bearer） |

- **`/openai` 下面两个聊天端点都有**：`POST /openai/chat/completions` 与 **`POST /openai/responses`**
  （新版 OpenAI SDK、Codex CLI 那类默认走 Responses）；`models`、`usage` 等也都在它下面
- **`/anthropic` 下面是 `POST /anthropic/messages`**（Claude Code、Anthropic SDK），models 同样在它下面
- 新增上游协议 **`openai-responses`**（OpenAI 官方的 Responses API；`store` **恒等于关掉**，不替你在上游留会话）
- **任意组合都能用**：客户端说哪种方言，和上游是哪家协议无关 —— 2 种客户端方言 × 4 种上游协议随便搭
  （`openai-compatible` / `openai-responses` / `anthropic` / `cloudflare-workers-ai`）
- 模型名不变（`All` / `Free|Pay/<来源id>/<模型名>` / `ModelGroup/<组名>`），Anthropic 方言下是**同一套名字**
- 推理模型的**思考会透传**：chat 方言走 `reasoning_content`，Responses 方言走 `reasoning` 输出项 +
  `response.reasoning_text.delta`
- 后台：**右上角直接显示两个客户端地址**（点一下复制完整 URL），不用再去翻文档
- 「提供商」的上游协议下拉框改成从接口取（以后加协议不必再改前端）
- 首次设置页那句"沿用原来的"改正：新生成时会明说「已自动生成一条」

## 安装方式

下载下方的 `nszzj-free-llm-aggregator_2.0.0_<架构>.tar.gz`，然后：

```bash
# ① 导入镜像
docker load < nszzj-free-llm-aggregator_2.0.0_<架构>.tar.gz

# ② （全新安装跳过这一步）升级旧版本的话：先把旧容器删掉。数据不会丢失，它们存储在宿主机文件夹中。
sudo docker rm -f nszzj-free-llm-aggregator

# ③ （旧版本升级跳过这一步）建数据目录（镜像里跑的是非 root，uid 10001）
sudo mkdir -p <宿主机软件数据存储路径>
sudo chown -R 10001:10001 <刚才写的路径>

# ④ 起服务
sudo docker run -d \
  --name nszzj-free-llm-aggregator \
  --restart unless-stopped \
  --network host \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --memory 512m \
  --pids-limit 256 \
  -e PORT=8787 \
  -e ADMIN_TRUSTED_PEERS= \
  -e ALLOW_PUBLIC_INTERNET=false \
  -v <刚才写的 / 旧版本设置的 路径>:/app/data \
  nszzj-free-llm-aggregator:2.0.0
```

然后：

- 打开 `http://<地址>:8787/admin` 进行设置。
- **升级过来的**：数据库迁移在启动时自动跑，不用手动执行任何东西；但**客户端地址要改**
  （见上面「更新日志」的第一条和下面「已知问题」）。

## 已知问题

- **从 1.0.0 升级要改客户端地址**：`.../v1` 改成 `.../openai`（Anthropic 客户端用 `.../anthropic`）。
  数据库不用动、数据目录不用动，直接换镜像 + 改客户端地址即可（迁移会在启动时自动跑）。
- **镜像只有 x86-64（amd64）的**：ARM（arm64 / aarch64）等其它架构跑不了（load 得进去但会 `exec format error`）。
