'use strict';

/**
 * 构建镜像 + 导出成一份**能直接发给别人的离线镜像包**（发布到 GitHub Release 用）。
 *
 *   npm run image          # 或者 node scripts/build-image.js
 *
 * 产出（dist/ 里）—— 就一个文件：
 *   nszzj-free-llm-aggregator_<版本>_<架构>.tar.gz    ← 镜像本体（对方 docker load 就能用，不用 build）
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
 * 架构提醒：在 x86-64 上构建的镜像只能在 x86-64 上跑（arm 同理）。
 * 要两种架构都有：用 buildx 构建多架构并 push 到 registry，或分别在两种机器上各跑一次。
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
// 架构名写给人看的：x64 → x86-64（文件名里统一用减号，别再混下划线）
const ARCH = process.arch === 'x64' ? 'x86-64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
// 镜像名：**改动时项目根 docker-compose.yml 里那两处 image: 要一起改**（compose 读不到这个文件）。
// 用带作者前缀的名字是为了避免跟网上别的同类聚合网关重名（推仓库时就是 <命名空间>/nszzj-free-llm-aggregator）
const IMAGE = `nszzj-free-llm-aggregator:${VERSION}`;
const BUNDLE = `nszzj-free-llm-aggregator_${VERSION}_${ARCH}.tar.gz`;

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

  console.log(`==> 构建镜像 ${IMAGE}`);
  const build = spawnSync('docker', ['build', '-t', IMAGE, '.'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('构建失败 —— 上面是 docker 的输出。');
    process.exitCode = build.status || 1;
    return;
  }

  // 先让 docker 自己把镜像写成 tar（不用 shell 管道，Windows 上也没有 sh），再在 Node 里压缩
  const tarPath = path.join(OUT_DIR, `nszzj-free-llm-aggregator_${VERSION}_${ARCH}.tar`);
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
