# v2.1.0

## 更新日志

- **新增设置项：「探测 / 测试的超时」**（后台「设置」页，默认 **120 秒**，可填 5 ~ 600）。
  以前这个值是写死的 **30 秒**，比真实请求的超时（120 秒）短得多 —— 慢上游上会出现
  "客户端能正常用、后台「立即探测 / 测试」却说超时"这种自相矛盾的现象
  （实测某个推理模型经代理要 17~46 秒才出响应头，30 秒必然判死）。现在两边口径一致，慢源可以调更大。
- **上游 `baseUrl` 不再自动补 `/v1`**：四种上游协议统一成「**baseUrl 当完整前缀，我们只在后面拼端点**」
  （只吃掉结尾多余的 `/`）。以前只有 `anthropic` 和 `openai-responses` 会在结尾没有版本段时替你补 `/v1`，
  `openai-compatible` 又不补 —— 同样一件事两套规矩，填错了很难查。
- 后台「提供商」弹层里，**`baseUrl` 下面多一行小字「实际请求：…」**：按当前 baseUrl + 选的适配器
  把最终打出去的地址拼出来（Cloudflare 那种模型名在路径里的也会显示），填错一眼能看见。

## 安装方式

下载下方的 `NSZZJ-FreeLlmAggregator_Docker_2.1.0_<架构>.tar.gz`，然后：

```bash
# ① 导入镜像（<架构> 照附件写：x86-64 / x86-32 / arm64 / arm32）
docker load < NSZZJ-FreeLlmAggregator_Docker_2.1.0_<架构>.tar.gz

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
  nszzj-free-llm-aggregator:2.1.0
```

然后：

- 打开 `http://<地址>:8787/admin` 进行设置。
- **升级过来的**：数据库迁移在启动时自动跑，不用手动执行任何东西；但**要检查一下上游地址**
  （见下面「已知问题」的第一条）。后台那个新的「探测 / 测试的超时」不用管，默认值就是照真实请求设的。

## 已知问题

- **从 2.0.0 升级：`anthropic` / `openai-responses` 这两种上游的 baseUrl 要自己带上 `/v1`**。
  以前填 `https://api.anthropic.com` 也能跑（我们替你补），现在必须写成 `https://api.anthropic.com/v1`。
  改完点提供商弹层里那行「**实际请求：…**」核对一下就知道对不对。
  数据库不用动、数据目录不用动，直接换镜像即可（迁移会在启动时自动跑）。
- **镜像只有 x86-64（amd64）的**：ARM（arm64 / aarch64）等其它架构跑不了（load 得进去但会 `exec format error`），
  要自己重新编译一份 —— 见 README「跑起来 → B. 开发者」。
- **Responses 方言是无状态的**：`store` 恒等于关掉（不在上游留会话），`previous_response_id` 明确回 400
  并说明原因 —— 不会装作支持然后悄悄丢上下文。
- **Anthropic 方言不处理 `thinking` 块**：Anthropic 的思考块要服务端签名，我们给不出合法签名，
  所以既不接收也不返回（客户端传了会被忽略）。
