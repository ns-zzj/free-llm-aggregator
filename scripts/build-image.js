'use strict';

/**
 * 构建镜像 + 导出成一份**能直接发给别人的离线镜像包**（发布到 GitHub Release 用）。
 *
 *   npm run image                    # 打当前机器的架构
 *   npm run image -- --arch arm64    # 指定架构（跨架构走 buildx + QEMU 仿真，慢）
 *
 * 产出（dist/ 里）—— 就一个文件：
 *   NSZZJ-FreeLlmAggregator_Docker_<版本>_<架构>.tar.gz   ← 镜像本体（对方 docker load 就能用，不用 build）
 *
 * 命名规矩（用户 2026-09-18 定）：
 *   - 前缀固定 `NSZZJ-FreeLlmAggregator_Docker_`：作者 + 项目名 + **给哪种运行方式**（以后可能有别的运行方式），
 *     再带版本和架构 —— 一眼看出这是谁的、干什么用的、哪一版、哪个架构。
 *   - 架构名只有四个：**x86-64 / x86-32 / arm64 / arm32**（见下面 ARCH_NAMES 的说明，别再混 amd64/aarch64）。
 *   - 镜像标签仍是 `nszzj-free-llm-aggregator:<版本>`（包名用大写前缀，标签保持小写，Docker 仓库名必须小写）。
 *
 * 版本号取自 package.json，文件名和镜像标签都自动带上它，不用手工同步。
 * 文件名用下划线分段（和 README 里 `docker load < ... >` 那一行保持一致）。
 * 配套的 compose / 起服务说明**不在这里生成** —— 都在 README.md 里。
 *
 * 两个设计选择：
 *   - **用 Node 而不是 bash**：这是个 Node 项目，Windows 上也跑得动（bash 只有 Linux/macOS 有）。
 *   - **配套文件的生成和 docker 命令分开**：没有 Docker 的机器也能产出"说明 + compose"，
 *     配合别人给的镜像包一起发出去。
 *
 * 架构提醒：一份包只装一种架构的镜像（docker save 导出的是单平台镜像）。要两种架构就分别打两次，
 * 两个包一起发出去，让对方按自己的机器选 —— 别指望一个 tar 里塞两种架构。
 * 要两种架构都有：见上面那条提醒（分别打两个包），或者用 buildx 构建多架构并 push 到 registry。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || 'dev';

/**
 * 架构名只认这四个（用户 2026-09-18 定）：**x86-64 / x86-32 / arm64 / arm32**。
 *
 * 为什么要在这里翻译一次：同一个架构有三套叫法 ——
 *   Node 的 `process.arch`：x64 / ia32 / arm64 / arm
 *   Docker 内部的 platform：amd64 / 386 / arm64 / arm（它自己有时候又写 x86_64，纯属历史）
 *   社区文件名：x86_64 / i386 / aarch64 / armv7l
 * 对外（**包文件名 + 镜像标签**）一律只出上面那四个，别再混；
 * 另外 `aarch64` 容易被误读成 Arch Linux，`amd64` 和 `arm64` 放一起也容易看错，
 * 所以不用这两个词，64 位统一写 `-64`（x86-64 也是 Docker 官方认的写法）。
 * Docker 那一侧要按 platform 传的映射留在下面 PLATFORM_FOR。
 */
const ARCH_NAMES = [
  { name: 'x86-64', node: ['x64'], platform: 'linux/amd64', dockerArch: ['amd64', 'x86_64'] },
  { name: 'x86-32', node: ['ia32', 'x86'], platform: 'linux/386', dockerArch: ['386', 'i386'] },
  { name: 'arm64', node: ['arm64'], platform: 'linux/arm64', dockerArch: ['arm64', 'aarch64'] },
  { name: 'arm32', node: ['arm'], platform: 'linux/arm/v7', dockerArch: ['arm', 'armv7l', 'armhf'] },
];

/** 命令行的 --arch（或环境变量 IMAGE_ARCH）优先；不传就用跑构建这台机器的架构 */
function resolveTarget(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value) {
    // 命令行**只认我们那四个名字**（外加 Node 自己的 x64/ia32/arm 写法）——
    // 不是不接受 amd64/aarch64，是它俩正是我们要淘汰的叫法：让人用着用着就写回去了。
    const hit = ARCH_NAMES.find((a) => a.name === value || a.node.includes(value));
    if (!hit) {
      console.error(`不认识的架构「${raw}」。只支持：${ARCH_NAMES.map((a) => a.name).join(' / ')}`);
      process.exit(2);
    }
    return hit;
  }
  const host = ARCH_NAMES.find((a) => a.node.includes(process.arch));
  if (!host) {
    console.error(`构建机架构 ${process.arch} 不在支持列表里：${ARCH_NAMES.map((a) => a.name).join(' / ')}`);
    process.exit(2);
  }
  return host;
}

const archArg = (() => {
  const i = process.argv.indexOf('--arch');
  if (i >= 0) return process.argv[i + 1];
  return process.env.IMAGE_ARCH || null;
})();
const TARGET = resolveTarget(archArg);
const ARCH = TARGET.name;
// 镜像名：**改动时项目根 docker-compose.yml 里那两处 image: 要一起改**（compose 读不到这个文件）。
// 用带作者前缀的名字是为了避免跟网上别的同类聚合网关重名（推仓库时就是 <命名空间>/nszzj-free-llm-aggregator）
const IMAGE = `nszzj-free-llm-aggregator:${VERSION}`;
// 中文名 + Docker + 版本 + 架构：一眼看出这是「哪个项目的、给哪种运行方式的、哪一版、哪个架构」
const STEM = `NSZZJ-FreeLlmAggregator_Docker_${VERSION}_${ARCH}`;
const BUNDLE = `${STEM}.tar.gz`;

function hasDocker() {
  // stdio: ignore —— 不捕获子进程输出（某些受限环境不允许管道，也会在这里踩坑）
  const probe = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!hasDocker()) {
    console.log('==> 没找到 docker 命令，无法构建镜像。');
    console.log('    在有 Docker 的机器上跑（服务器 / 装了 Docker 的开发机）：npm run image');
    return;
  }

  const hostArch = ARCH_NAMES.find((a) => a.node.includes(process.arch));
  const cross = !hostArch || hostArch.name !== TARGET.name;
  if (cross) {
    console.log(`==> 目标架构 ${ARCH} 和构建机（${hostArch ? hostArch.name : process.arch}）不同，走 buildx + QEMU 仿真（会慢不少）`);
  }
  console.log(`==> 构建镜像 ${IMAGE}`);
  const buildArgs = cross
    ? ['buildx', 'build', '--platform', TARGET.platform, '--load', '-t', IMAGE, '.']
    : ['build', '-t', IMAGE, '.'];
  const build = spawnSync('docker', buildArgs, { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('构建失败 —— 上面是 docker 的输出。');
    if (cross) {
      console.error('（跨架构构建失败时先确认：buildx builder 支持这个平台、QEMU 仿真可用）');
    }
    process.exitCode = build.status || 1;
    return;
  }

  // 先让 docker 自己把镜像写成 tar（不用 shell 管道，Windows 上也没有 sh），再在 Node 里压缩
  const tarPath = path.join(OUT_DIR, `${STEM}.tar`);
  console.log('==> 导出镜像…');
  const save = spawnSync('docker', ['save', '-o', tarPath, IMAGE], { cwd: ROOT, stdio: 'inherit' });
  if (save.status !== 0) {
    console.error('导出失败：docker save 出错（上面有输出）。');
    process.exitCode = save.status || 1;
    return;
  }

  console.log('==> 压缩…');
  await pipeline(
    fs.createReadStream(tarPath),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(path.join(OUT_DIR, BUNDLE))
  );
  fs.rmSync(tarPath, { force: true });

  const size = fs.statSync(path.join(OUT_DIR, BUNDLE)).size;
  console.log(`==> 完成：dist/${BUNDLE}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  console.log('    发出去的就是这一个文件：对方 docker load 之后，按 README 里的 docker run / compose 起服务。');
}

main().catch((err) => {
  console.error(`打包失败：${err.message}`);
  process.exitCode = 1;
});
