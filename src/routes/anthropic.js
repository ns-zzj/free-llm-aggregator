'use strict';

/**
 * 客户端面：**Anthropic Messages 方言**（挂在 `/anthropic`，地址里的 `/v1` 可有可无）
 *
 *   POST /anthropic/messages   ← Claude Code、Anthropic SDK 这类客户端
 *   GET  /anthropic/models
 *
 * 这个路由只做两件事：
 *   1. 把 Anthropic 的请求体翻成内部形状（OpenAI chat completions）——`face.parseBody`
 *   2. 把请求交给 `src/routes/v1.js` 里那套**协议无关**的 chatCompletions（选源/换源/限速/记账），
 *      靠 `req.face` 让它把响应按 Anthropic 的形状渲染出来
 *
 * 所以这里没有一行"选源"逻辑 —— 上游是 openai-compatible、anthropic、responses 还是 CF，
 * 都由既有适配器决定，跟客户端说哪种方言完全解耦（这正是 2.0.0 想要的任意组合）。
 */

const express = require('express');

const auth = require('../auth');
const face = require('../protocol/faces/anthropic');
const logger = require('../logger');
const v1Routes = require('./v1');

const router = express.Router();

/**
 * 指定方言的 chat 处理：换掉 `req.face`，把内部请求体放进去，剩下交给共享逻辑。
 * 解析失败（比如缺 max_tokens）按 Anthropic 的错误形状回 400。
 */
router.post('/messages', auth.requireAccessKey, (req, res, next) => {
  // 排查客户端兼容性问题时用：LOG_LEVEL=debug 才打，平时一声不吭
  logger.debug('客户端请求体（Anthropic 方言）', {
    body: JSON.stringify(req.body || {}).slice(0, 800),
  });
  const parsed = face.parseBody(req.body || {});
  if (parsed.error) {
    return face.sendError(res, parsed.error.status, parsed.error.message);
  }
  req.face = face;
  req.internalBody = parsed.body;
  return v1Routes.chatCompletions(req, res, next);
});

/**
 * 模型列表（Anthropic 的形状：`{ data:[{ type:'model', id, display_name, created_at }], has_more }`）。
 * 名字和我们发布的那套完全一样（`All` / `Free|Pay/…` / `ModelGroup/…`）—— 只有一套命名空间，
 * 不按协议区分，客户端里填什么、日志里就是什么。
 */
router.get('/models', auth.requireAccessKey, async (req, res, next) => {
  try {
    const payload = await v1Routes.buildModelList();
    const data = payload.data.map((model) => ({
      type: 'model',
      id: model.id,
      display_name: model.id,
      created_at: new Date((model.created || 0) * 1000).toISOString(),
    }));
    return res.json({
      data,
      has_more: false,
      first_id: data.length ? data[0].id : null,
      last_id: data.length ? data[data.length - 1].id : null,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
