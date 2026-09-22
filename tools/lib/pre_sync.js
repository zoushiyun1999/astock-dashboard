#!/usr/bin/env node
'use strict';
/**
 * tools/lib/pre_sync.js —— 执行前「与远端对齐」（双环境共存的安全阀）
 *
 * 为什么需要
 * ──────────
 * 现在有**两个环境**都会写 `dashboard/`（本机 + 阿里云 ECS），而
 * `tools/gh_push_api.js` 是**按文件内容差异推送**的：只推「本地与远端不同」的文件。
 * ⇒ **落后的一侧一旦发布，就会把它手里的旧文件推回远端，静默撤销另一侧的成果。**
 *
 * 2026-09-22 已两次实证：
 *   ① ECS 克隆后文件停在克隆时刻 → 它的 publish 会回退 `llm.js` / `job_evening.js` 等修复；
 *   ② ECS 发布后本机 `data.js` 落后 → 本机当晚 21:00 晚报一发布就把 verify 标记抹掉。
 *
 * 所以：**任何会写 `dashboard/` 的任务，在写之前必须先取回远端最新版，再在其上追加。**
 *
 * 只同步任务会改写的两个文件
 * ──────────────────────────
 * `dashboard/data.js`（四个任务都写）与 `dashboard/screener.js`（只有 screener 写）。
 * **刻意不碰代码文件** —— 否则会把开发中未提交的本地改动冲掉。
 * 服务器侧的**代码**新鲜度由 `tools/cron.sh` 的入口预同步负责（那里跑全量同步是安全的）。
 *
 * 边界（重要）
 * ────────────
 * · **fail-open**：缺令牌 / 网络失败 / 远端没有该文件 → 一律只告警、**不阻断任务**。
 *   理由：任务失败是立刻可见的损失，而"可能被推回"还有机会下次修正 —— 两害相权取其轻。
 * · `--dry` 模式**跳过**（dry 不写盘，同步没意义，还会污染调试输出）。
 * · 幂等、轻量：1 次 git trees + 最多 2 次 content 请求，约 1 秒。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/** 任务会改写的 dashboard 文件（同步范围，勿随意扩大） */
const TARGETS = ['dashboard/data.js', 'dashboard/screener.js'];

/**
 * 与远端对齐。**永不抛异常**。
 * @param {string} tag 日志标签（如「早报」），仅用于输出区分
 * @returns {{ok:boolean, reason?:string}}
 */
function preSync(tag) {
  const label = tag ? '[' + tag + '] ' : '';

  if (process.argv.includes('--dry')) return { ok: false, reason: 'dry' };

  try {
    const hasToken = fs.existsSync(path.join(ROOT, '.gh-token')) || !!process.env.GITHUB_TOKEN;
    if (!hasToken) {
      // 单环境 / 未配置令牌时不值得惊动使用者，静默通过
      return { ok: false, reason: 'no-token' };
    }

    const args = ['tools/sync_from_api.js', '--apply', '--only'].concat(TARGETS);
    const r = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    const out = (r.stdout || '') + (r.stderr || '');

    if (r.status === 0) {
      // 直接取子进程的**最后一行结论**，不做字符串模式匹配
      //（匹配措辞会在改 sync_from_api 输出时静默失效 → 提示退化成"已完成"）
      const lines = out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
      const last = (lines[lines.length - 1] || '已完成').replace(/^[✔✓·]\s*/, '');
      console.log('· ' + label + '预同步：' + last);
      return { ok: true };
    }

    console.warn('⚠️ ' + label + '预同步未成功（退出码 ' + r.status + '）→ 继续执行；' +
      '本次发布有「把旧文件推回远端」的风险。最后一行：' +
      out.trim().split('\n').slice(-1)[0]);
    return { ok: false, reason: 'rc=' + r.status };
  } catch (e) {
    console.warn('⚠️ ' + label + '预同步异常（' + (e && e.message ? e.message : e) +
      '）→ 继续执行');
    return { ok: false, reason: String(e && e.message) };
  }
}

module.exports = { preSync, TARGETS };
