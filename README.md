# NSZZJ-Free-LLM-Aggregator

一个自用的 LLM API 聚合网关：**一个 API 调所有上游**。服务端持有各家上游的 key，客户端只用一道访问口令；上游被限流或报错时自动换源，不把错误抛给客户端。

---

## 免责声明

本项目仅供个人学习与研究使用。作者不提供任何 API Key，也不提供公共中转服务。

使用者需自行遵守各上游服务的条款与政策，并自行承担使用后果。

请不要把本项目部署成面向公众的 API 中转或售卖服务。

---

## 功能

**对外接口（两种客户端方言，地址按协议族分前缀）**

| 前缀 | 端点 | 给谁用 |
|---|---|---|
| `/openai` | `POST /openai/chat/completions`（含流式 SSE）、`POST /openai/responses`、`GET /openai/models`、`GET /openai/models/<名字>` | OpenAI SDK、新版 OpenAI SDK（默认走 Responses）、Cherry Studio 这类能填自定义 OpenAI 地址的工具 |
| `/anthropic` | `POST /anthropic/messages`、`GET /anthropic/models` | Claude Code、Anthropic SDK |
| 两个前缀都认 | 假数据端点 `GET /openai/usage`、`/openai/billing/subscription`、`/openai/credits`（后台可关）；`GET /healthz` | |

- 地址里的 `/v1` **可有可无**：`/openai/v1/models` = `/openai/models`（有些客户端会自己拼上去）
- **客户端说哪种方言，和上游是哪家协议无关** —— 由适配器负责翻译，任意组合都能用

**选源**

- 三种调用方式：`All` 自动选源、`Free|Pay/<来源id>/<模型名>` 指定来源、`ModelGroup/<组名>` 自定义兜底链
- `All` 的尝试顺序 = 后台「All模型顺序」页的拖拽顺序（免费在前、付费兜底）
- 上游失败自动换下一个；全都不行才回 `503`

**故障处理**

- 按 (来源, 模型) 独立记状态：可用 / 冷却 / 停用 / 额度耗尽 —— 同一家某个模型挂了，别的模型照常
- 拒绝策略三选一：`不停用` / `倒计时检测`（默认，到期自动探测恢复）/ `停用不检测`
- 倒计时检测的等待时长是一张**可编辑的退避表**（例如 15 / 60 / 300 秒，逐段拉长）
- 连续探测到上限还没恢复 → 转「故障（需人工）」，不再白打上游

**本地限速**

- 按提供商填写限速rpm，每次调用后按rpm冷却提供商下所有模型

**上游协议**（一个来源选一种，后台「提供商」页的下拉框里选）

- `openai-compatible`（绝大多数平台：ModelScope、NVIDIA NIM、DeepSeek、各家中转……）
- `openai-responses`（OpenAI 官方的 Responses API；`store` 恒等于关掉，不在上游留会话）
- `anthropic`（Claude / Anthropic 兼容地址，请求与响应自动翻成内部形状，流式也翻）
- `cloudflare-workers-ai`（模型名在 URL 路径里，两种返回方言都认）

> **任意组合都行**：客户端说 OpenAI 或 Anthropic 方言，上游是上面四种里的任何一种 ——
> 网关在协议边界做翻译，客户端看到的形状永远是它自己那套。

**图片（视觉）**

- 请求里带图时，只会走标了「支持图片理解」的模型；一个都没有就报 400（不会把图悄悄丢掉再发出去）
- 虚拟名字（`All` / 模型组）对下游一律声明"能收图"

**管理后台**（网页，7 个页签）

- 主页（概览 + 今日数据 + 最近调用）、All模型顺序、模型组、提供商、密码、日志、设置
- All模型 & 模型组支持拖拽排序
- 模型组可创建自定义组合，例如：ModelGroup/DeepSeek（deepseek-v4-flash-0731, deepseek-v4-flash-vision-exp……）
- 概览：今日请求数 / 失败数、免费与付费 token 分开计、可用模型数
- 一键「测试」和「立即探测」上游
- 后台登录和 `/openai` 都有**失败锁定**：同一个来源连续失败 5 次 → 锁 5 分钟，再失败翻倍（最多 1 小时），
  成功一次立刻解禁，24 小时没动静就忘掉（见「已知限制」最后一条）

**凭据**

- 上游 apiKey 用 libsodium 加密入库，界面只回显掩码
- **管理密码**：和上游 key 同一套可逆加密，入库的不是哈希 —— 界面照旧只让"改"、不给看
- **下游访问口令**：加密存一份**可还原**的密文，所以后台能显示掩码、一键复制、随时更换

---

## 跑起来

**三条路任选一条**

### A. 使用者：下载镜像包（不用源码、不用联网）

前往 [Release 页面](../../releases/latest) 下载镜像包

```bash
# ① 导入镜像（文件名里的 <版本>/<架构> 照 Release 里那个附件写）
docker load < NSZZJ-FreeLlmAggregator_Docker_<版本>_<架构>.tar.gz

# ② 数据目录：把属主交给容器用户（镜像里跑的是非 root，uid 10001）
sudo chown -R 10001:10001 <此处填写宿主机软件数据存储路径>

# ③ 起服务
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
  -v <此处填写宿主机软件数据存储路径>:/app/data \
  nszzj-free-llm-aggregator:<版本>
```

> - 那个 `chown` 是必须的：镜像里跑的是非 root（uid 10001），宿主机上的数据目录得归它，否则容器写不进去、会反复重启。
> - **数据存哪儿由你决定**，写在上方 docker cli 的 `-v` 后面， `:/app/data` 前面。（容器里的挂载点固定是 `/app/data`，不用改）。
> - ⚠ 占位符**没改就 `run`** 的话，Docker 会真的建一个名字叫 `<此处填写宿主机软件数据存储路径>` 的目录，在`/var/lib/docker/volumes/`下。数据能跑，但目录名很难看、以后也难找。

### B. 开发者：下载 / 编辑源码，自己构建

如果是在本机直接运行：
```bash
cd nszzj-free-llm-aggregator

# ① 在 docker-compose.yml 里把 volumes.source 换成你自己的路径

# ② 数据目录：把属主交给容器用户（镜像里跑的是非 root，uid 10001）
sudo chown -R 10001:10001 <此处填写宿主机软件数据存储路径>

# ③ 构建并起服务（改了代码就再跑这一条，会重新构建）
sudo docker compose up -d --build
```

如果是编译成.tar.gz包：
```bash
cd nszzj-free-llm-aggregator

# 直接用npm run image，调用scripts/build-image.js，一键构建打包
npm run image

# 产物在./dist
```

> - 那个 `chown` 是必须的：镜像里跑的是非 root（uid 10001），宿主机上的数据目录得归它，否则容器写不进去、会反复重启。
> - **数据存哪儿由你决定**，写在 compose 的 `volumes.source:` 里。（容器里的挂载点固定是 `/app/data`，不用改）。
> - ⚠ 占位符**没改就 `up`** 的话，Docker 通常会启动失败，即使`create_host_path: true`。

### C. Node 运行（本机直接跑，开发用）

```bash
npm install
npm start
```
---

## 首次使用顺序

1. 打开 `http://<地址>:8787/admin` → 「首次设置」：设**管理密码** + **下游 apikey**（留空自动生成）
2. 「提供商」页添加上游：地址 + apiKey + 速率 + 拒绝策略
3. 在该提供商下「添加模型」（填上游真实的模型 id）
4. 客户端连 `http://<地址>:8787/openai`，用那个下游 apikey

---

## 客户端怎么用

按客户端说的**方言**挑一个地址填进去就行（和上游是哪家协议无关）：

| 客户端说什么 | base_url | 鉴权 |
|---|---|---|
| OpenAI 方言 | `http://<地址>:8787/openai` | `Authorization: Bearer <下游 apikey>` |
| Anthropic 方言 | `http://<地址>:8787/anthropic` | `x-api-key: <下游 apikey>`（或 `Authorization: Bearer`） |

- 地址里的 `/v1` 加不加都认（`.../openai/v1` = `.../openai`）—— 有些客户端会自己拼上去
- 走 OpenAI 那套的客户端，`chat/completions` 和 `responses` 两个端点都能用（新版 OpenAI SDK 默认走后者）
- 后台「密码」页会把你自己的这两个地址列出来，带复制按钮，不用手打

请求体里的 `model` 只有**四种**合法写法（`GET /openai/models` 返回的就是这些，Anthropic 方言同一套名字）：

| 写法 | 例子 | 行为 |
|---|---|---|
| `All` | `All` | **自动选源**，失败挨个换下一个。日常就填这个 |
| `Free/<来源id>/<模型名>` | `Free/modelscope-cn/Qwen3.8-Flash-Next` | 定死这个免费来源，**不换源** |
| `Pay/<来源id>/<模型名>` | `Pay/deepseek/deepseek-v4-flash` | 定死这个付费来源，**不换源** |
| `ModelGroup/<组名>` | `ModelGroup/额度多的` | 按你在「模型组」页排的顺序挨个试 |

- **不带类别前缀的名字一律 404**（比如直接写 `gpt-4o-mini`）。
- 前缀大小写不敏感（`pay/`、`PAY/` 都认）。
- 上游模型名里带斜杠没问题（`来源id/` 后面整串都算模型名）。
- 响应里的 `model` **不篡改**：指定来源时上游写啥就是啥；`All` / 模型组时保持你请求的那个名字。
- 指定来源时，上游的错误会**原样转发**给你；`All` / 模型组则只回统一的 503（不暴露内部细节）。

---

## 容器环境变量

compose 里现在默认只传 **3 个**（值是**写死的字面量**，要改就直接改 `environment:` 里那一行）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `ADMIN_TRUSTED_PEERS` | 空 | 额外信任的"管理端来源"白名单（反代 / Docker 网桥的地址）。逗号分隔；支持 IPv4 网段（`10.0.2.0/24`）；IPv6 只支持写完整地址。**一般留空** |
| `ALLOW_PUBLIC_INTERNET` | `false` | 后台能不能从公网直接访问。**只认 `true` / `false` （大小写不敏感）** |

程序还认、但 compose **默认不传**的（要用就自己在 `environment:` 里加一行）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` 调整日志等级 |
| `SESSION_TTL_MS` | `43200000` | 后台会话有效期（毫秒），默认 12 小时 |
| `BIND` | 空 | 监听地址，留空 / `0.0.0.0` 即为监听全部地址（ipv4 + v6）。

没事别乱加的（可能会有严重后果）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `APP_SECRET` | 不设 | 凭据加密主密钥。不设 = 首次启动自动生成到**数据目录**里的 `app-secret.key`（推荐）。**丢了它已存的上游 key 就解不开** |
| `ADMIN_PASSWORD` | 不设 | 只在首次启动、库里还没有管理密码时用来初始化 |
| `ACCESS_KEY` | 不设 | 同上，用来初始化下游口令 |

**取值规则**

- `ALLOW_PUBLIC_INTERNET` **只认 `true` / `false`**（大小写不敏感）。写别的（`yes`、`1`、乱写）= 没写，用内置默认 `false`（= 公网进不了后台）。**这是唯一能放开后台的开关，后台里没有对应的选项。**
- 任何一项**值不合法**（`PORT=abc`、`LOG_LEVEL=verbose`）→ 当作这一层没配，退到下一层。（例如环境变量值不合法，退到程序内部默认值）。
- **例外**：`BIND` 和 `APP_SECRET` 写错**直接启动失败**，不做兜底。
- **启动日志开头会打一张表**，逐项说明每个值来自「环境变量 / `normal.env` / 内置默认」，以及有没有不认的值、最后用了什么。改了配置不生效时看它即可。

> 不用 Docker（`npm start`）时，项目根目录可以放一个 `normal.env` 当"保底"（`npm run init` 从模板生成），\
> 优先级是 **环境变量 → `normal.env` → 内置默认**。\
> **Docker 里没有这一层**：镜像没打进这个文件、compose 也没挂它，所以容器里实际是「环境变量 → 内置默认」。

**这些不在环境变量里，在网页里改**：管理密码、下游口令、提供商、模型、模型组、选源顺序、速率、拒绝策略、时区、日志保留天数、探测次数上限、等待时长表、上下文长度、假数据端点开关。

**另外，数据存哪儿不是环境变量**，是 compose 的 `volumes:`：

```yaml
    volumes:
      - type: bind
        source: <此处填写宿主机软件数据存储路径>     # ← 改成你自己的路径
        target: /app/data
        bind:
          create_host_path: true
```

容器里的挂载点固定是 `/app/data`。**那个目录的属主要交给容器用户（uid 10001）**，否则容器写不进去：

```bash
sudo mkdir -p /你的路径 && sudo chown -R 10001:10001 /你的路径
```

---

## 数据与备份

- 全部状态都在这一个目录里（**就是容器环境变量里的那个路径**，见「跑起来」）：
  - `app.db` —— SQLite 数据库。管理密码哈希、上游 apiKey 密文、提供商/模型配置、调用日志全在里面
  - `app-secret.key` —— 凭据加密主密钥（首次启动自动生成）
- **备份 = 打包那个目录**
- 换机器 / 重装：把那个目录拷过去就行
- `app-secret.key` 删了或换了 → 已存的上游 key **解不开**，得重新填一遍

---

## 已知限制

### 1. HTTP 不加密（不内置 TLS）

默认就是明文 HTTP。

**为什么不内置 TLS**：自签名证书会让客户端直接报 SSL 错误；申请受信任的证书又需要域名和续期管理，麻烦。这东西的设计前提是**内网 / 自有服务器**使用。

**所以不要把明文端口直接暴露到公网。** 明文 HTTP 下，同一网络的人可以抓到：
- 你登录后台时的管理密码
- 后台的会话 cookie（抓到就能直接冒充你进后台）
- 你发给上游的全部内容

**确实要公网访问**：自己套一层 **Cloudflare Tunnel**（推荐 —— 自带 HTTPS、零证书配置、不用开入站端口）或 Caddy / Nginx 反代做 TLS 终结。

> 管理端默认只收本机 / 内网直连，这个设计缓解了一部分风险，但它**不能替代 TLS**。

### 2. 客户端口令只做门禁

不做配额、不按口令统计用量。**拿到口令的人可以一直用你的上游额度。**
（后台的日志页和首页统计能看出异常调用；发现不对就去「密码」页一键更换口令。
唯一的自动保护是**连续失败锁定**：同一个来源连错 5 次会被锁一会儿，见「已知限制」最后一条。）

### 3. 管理后台默认只收本机 / 内网

从公网打开 `/admin` 会看到 403（**这是设计，不是坏了**）。两种解法：

- **SSH 隧道**（最省事）：`ssh -L 8787:127.0.0.1:8787 用户@服务器`，然后开 `http://localhost:8787/admin`
- 改容器环境变量，把 `ALLOW_PUBLIC_INTERNET` 设成 `"true"`，然后重新运行。 ⚠ 注意，程序没有https加密（见上文 1），公网访问需承担风险。这个开关**只在环境变量里**，后台设置页没有。
- `/openai/*` 客户端接口**不受这条限制**，一直是对外的。

### 4. 探测会真的打上游

「倒计时检测」的自动探测、后台的「测试」和「立即探测」都是**真实请求**，会占用上游额度（探测请求用的是 `max_tokens: 1`）。

**付费来源建议把拒绝策略设成「停用不检测」**，避免探测花钱。

### 5. 凭据都是"可逆加密"

上游 key、下游访问口令、**管理密码**都用 libsodium 加密入库（不是哈希 —— 后台需要能显示掩码、有的地方要能取回明文）。所以：
**`./data` 目录 + 主密钥一起泄露 = 这些凭据全是明文**。想更稳就把主密钥和数据库分开放（用 `APP_SECRET` 环境变量注入，而不是让它落在 `./data` 里）。

### 6. 源 IP 被 NAT / 代理抹掉时，后台会默认拒绝（仅限ALLOW_PUBLIC_INTERNET为false时）

容器用 bridge 网络、rootless Docker、或反代装在**别的**机器上时，真实客户端 IP 会被抹成网关地址。这时管理端的来源闸会**默认拒绝**（fail-closed，宁可错杀），错误信息里会告诉你怎么配 `ADMIN_TRUSTED_PEERS`。

自查：从公网 `curl http://<地址>:8787/api/admin/setup/status`，看返回的 `clientIp` 是不是你的真实地址。

### 7. 同一个来源连续失败会被锁（防的是客户端死循环）

规矩（后台登录和 `/openai/*` 各算各的，参数一样）：

- 同一个来源 IP **连续失败 5 次** → 锁 **5 分钟**
- 之后每再失败一次**翻倍**：10 → 20 → 40 分钟，**1 小时封顶**
- **成功一次立刻解禁**（计数清零）；**24 小时**没有新的失败就忘掉这个人
- `/openai/*` 里什么算失败：响应是 4xx/5xx（口令不对、模型名写错、来源全挂了、上游报错……）；2xx 算成功

被锁时拿到的是 `429` + `Retry-After`（秒），`error.code` 是 `too_many_failures`，直接说还要等多少秒。
撞上基本只有一个原因：客户端配置写错了（模型名 / 口令），改对之后等 `Retry-After` 秒自动恢复。

> 故意**没有**"全局封锁"（那种"只要全局失败够多就把所有人都锁上"的机制）：会不计成本换一堆 IP 来打的人，代价已经高到离谱，真碰上就让他用 —— 与其为这种场景加一层会误伤正常用户的机制，不如不加。

### 8. Responses 方言是无状态的

服务端不留会话：请求里的 `store` 一律按关闭发给上游（不会替你在上游留下会话记录），`previous_response_id` **明确回 400**（`stateless_gateway`）并说明原因，而不是装作支持、然后悄悄丢掉上下文。**多轮对话的历史要由客户端自己带上。**

### 9. Anthropic 方言不处理 thinking 块

Anthropic 的思考块要服务端签名，我们给不出合法签名，所以**既不接收也不返回**（客户端传了会被忽略）。要思考内容就用 OpenAI 方言，那边给 `reasoning_content` / `reasoning` 项。

---

## 常见问题

| 问题 | 处理 |
|---|---|
| 忘了管理密码 | `docker exec nszzj-free-llm-aggregator node scripts/reset-credentials.js`（不用重启，刷新 `/admin` 就是「首次设置」）。加 `--keep-key` 只清管理密码、保留下游口令 |
| 客户端拿到 429 `too_many_failures` | 同来源连续失败 5 次被锁了，看 `Retry-After` 秒后自动恢复；先把客户端的模型名/口令改对（见「已知限制 · 同一个来源连续失败会被锁」） |
| 容器起不来 / 写不进去 | 数据目录的属主不对 → 对它做 `sudo chown -R 10001:10001 /你的数据目录`（**写绝对路径**，别写光秃秃的 `data`） |
| 改端口 | 改容器环境变量里的 `PORT` |
| 看日志 | `sudo docker compose logs -f` |
| 代理/公网进不了后台 | 见「已知限制 · 管理后台默认只收本机 / 内网」 |
| 改了配置没生效 | 看启动日志开头那张「配置来源表」，以及"不认"的告警 |
| 客户端的 `model` 报 404 | 名字要写全：`All` 或 `Free/<来源id>/<模型名>` 或 `Pay/<来源id>/<模型名>` 或 `ModelGroup/<组名>` |
| 客户端只显示 tokens、没有正文 | 上游是**推理模型**时，「思考」和正文**共享** `max_tokens` / `max_output_tokens`。预算给太小（几十~几百 token）会全花在思考上，一个字正文都没生成（收尾是 `incomplete` 而不是 `completed`，思考文本会作为 `reasoning_content` / `reasoning` 项一起给你）。**把上限调大**，或者关掉思考（DeepSeek 等支持 `reasoning_effort: "none"`，Responses 方言用 `reasoning: {"effort":"none"}`） |
