# v1.0.0

## 更新日志

1.0.0 是第一个版本，没有更新日志。完整说明见仓库主页的 README。

## 安装方式

下载下方的 `nszzj-free-llm-aggregator_1.0.0_<架构>.tar.gz`，然后：

```bash
# ① 导入镜像
docker load < nszzj-free-llm-aggregator_1.0.0_<架构>.tar.gz

# ② 建数据目录（镜像里跑的是非 root，uid 10001）
sudo mkdir -p <宿主机软件数据存储路径>
sudo chown -R 10001:10001 <刚才写的路径>

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
  -v <刚才写的路径>:/app/data \
  nszzj-free-llm-aggregator:1.0.0
```

然后：

- 打开 `http://<地址>:8787/admin` 进行设置。

## 已知问题

- **镜像只有 x86-64（amd64）的**：ARM（arm64 / aarch64）等其它架构跑不了（load 得进去但会 `exec format error`），要自己重新编译一份 —— 见 README「跑起来 → B. 开发者」。
- **首次设置页的文案**：下游 apikey 留空时，后端会自动生成一条并在弹窗里显示明文（也会自动复制到剪贴板），但文案写成了「**沿用原来的**」。**只是措辞不对，口令本身正常可用** —— 下一个版本修。
