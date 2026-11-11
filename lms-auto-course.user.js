// ==UserScript==
// @name         国开学习网 LMS 学习助手（拟人化）
// @namespace    https://lms.ouchn.cn/
// @version      2.0.0
// @description  国开学习网（lms.ouchn.cn）课程学习辅助：默认真实播放视频、模拟人类观看节奏（随机倍速/微暂停/回看/鼠标活动/阅读停留），自动按顺序完成图文与视频活动；带折叠气泡面板、断点续刷。
// @author       DSH
// @match        https://lms.ouchn.cn/*
// @icon         https://lms.ouchn.cn/static/assets/images/favicon-ouchn-d8ff1235.ico
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 设计说明
 * --------
 * 1. 默认「真实播放」：视频静音 + 1.0~2.0 倍速区间内随机波动，配合微暂停、回看、
 *    鼠标移动、阅读停留等拟人化行为，不使用瞬时补进度接口。
 * 2. 「接口补齐」只是可选项：直接上报 0~时长 的观看区间，快但更容易被学习行为分析识别。
 * 3. 站点为 AngularJS 单页应用，全屏学习页路由：
 *      /course/{courseId}/learning-activity/full-screen#/{activityId}
 *    脚本改 location.hash 切换活动，不整页刷新。
 * 4. 视频进度最终仍由站点自己的播放器上报；脚本只在长时间没有进度变化时兜底补报
 *    （可关闭），且上报区间来自真实播放到的 currentTime。
 * 5. 测验、考试、作业一律跳过；讨论区只浏览不发帖。
 */

(function () {
  'use strict';

  /* ============================== 常量与配置 ============================== */

  const VERSION = '2.0.0';
  const PANEL_ID = 'lmsauto-panel';
  const STYLE_ID = 'lmsauto-style';
  const CFG_KEY = 'lmsauto:cfg:v2';
  const RESUME_KEY = 'lmsauto:resume:v2';
  const POS_KEY = 'lmsauto:pos:v2';
  const UI_KEY = 'lmsauto:ui:v2';

  const DEFAULTS = {
    strategy: 'play', // play | api
    speed: 1.5,       // 真实播放的基准/固定倍速
    human: true,      // 拟人化行为
    keepAwake: true,  // 保持页面前台状态
    visitForum: true, // 浏览讨论区（不发帖）
    fallback: true,   // 长时间无进度时兜底上报
    pace: 'normal',   // slow | normal | fast
  };

  const PACE = {
    slow: { label: '慢', gap: [7, 15], read: [1.15, 1.7], restChance: 0.22 },
    normal: { label: '自然', gap: [4, 10], read: [0.9, 1.35], restChance: 0.12 },
    fast: { label: '快', gap: [2, 5], read: [0.55, 0.85], restChance: 0.05 },
  };

  const TYPE_LABEL = {
    page: '图文',
    online_video: '视频',
    video: '视频',
    audio: '音频',
    forum: '讨论区',
    exam: '测验',
    homework: '作业',
    scorm: 'SCORM',
    lesson: '课程',
    slide: '幻灯片',
    weblink: '链接',
    chatroom: '聊天室',
    virtual_classroom: '直播课堂',
    interaction: '互动教材',
  };

  const SPEED_OPTIONS = [1, 1.25, 1.5, 1.75, 2, 3, 4, 6, 8];

  /* ============================== 基础工具 ============================== */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const chance = (p) => Math.random() < p;
  const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

  function fmtTime(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function fmtSpan(sec) {
    sec = Math.max(0, Math.round(sec));
    if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分`;
    if (sec >= 60) return `${Math.round(sec / 60)} 分钟`;
    return `${sec} 秒`;
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。！？、：；（）()【】\[\]“”"'’‘·\-—_]/g, '')
      .toLowerCase();
  }

  function matchTitle(current, expected) {
    const a = normalizeText(current);
    const b = normalizeText(expected);
    if (!a || !b) return false;
    if (a === b) return true;
    return b.length >= 6 && a.includes(b);
  }

  // 可中断的等待：停止/跳过时立刻返回 false
  async function waitOrAbort(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!state.running || state.skipRequested) return false;
      await sleep(Math.min(250, Math.max(20, end - Date.now())));
    }
    return true;
  }

  async function waitFor(condition, timeout, interval) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (condition()) return true;
      } catch (err) {
        /* 轮询期间忽略异常 */
      }
      await sleep(interval || 250);
    }
    return false;
  }

  /* ============================== 存储 ============================== */

  const store = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const raw = GM_getValue(key);
          if (raw === undefined || raw === null || raw === '') return fallback;
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        }
      } catch (err) {
        /* 回退到 localStorage */
      }
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, raw);
          return;
        }
      } catch (err) {
        /* 回退到 localStorage */
      }
      try {
        localStorage.setItem(key, raw);
      } catch (err) {
        /* 忽略 */
      }
    },
  };

  const cfg = Object.assign({}, DEFAULTS, store.get(CFG_KEY, {}));
  if (!PACE[cfg.pace]) cfg.pace = 'normal';
  if (!SPEED_OPTIONS.includes(Number(cfg.speed))) cfg.speed = DEFAULTS.speed;
  if (cfg.strategy !== 'api') cfg.strategy = 'play';

  const saveCfg = () => store.set(CFG_KEY, cfg);

  /* ============================== 运行状态 ============================== */

  const state = {
    cid: 0,
    courseName: '',
    activities: [],
    reads: new Map(),
    running: false,
    paused: false,
    busy: false,
    index: 0,
    current: null,
    video: null,
    lastReadsAt: 0,
    skipRequested: false,
    cancelRequested: false,
    resumeHandled: false,
    runStartedAt: 0,
    lastEtaAt: 0,
    collapsed: !!((store.get(UI_KEY, {}) || {}).collapsed),
  };

  const ui = {};

  /* ============================== 接口层 ============================== */

  async function request(url, options) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const res = await fetch(url, Object.assign({
        credentials: 'include',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      }, options || {}));
      const text = await res.text();
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch (err) {
        return {};
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function apiGet(url, retries) {
    let left = retries === undefined ? 1 : retries;
    for (;;) {
      try {
        return await request(url, {
          headers: { Accept: 'application/json, text/plain, */*' },
        });
      } catch (err) {
        if (left <= 0) throw err;
        left -= 1;
        await sleep(rand(600, 1200));
      }
    }
  }

  function apiPost(url, body) {
    return request(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(body || {}),
    });
  }

  function getCourseId() {
    const matched = location.pathname.match(/^\/course\/(\d+)/);
    return matched ? Number(matched[1]) : 0;
  }

  const isFullScreenPage = () =>
    /\/course\/\d+\/learning-activity\/full-screen/.test(location.pathname);

  const isSupportedPage = () =>
    /^\/course\/\d+\/learning-activity\/full-screen/.test(location.pathname) ||
    /^\/course\/\d+\/ng(\/|$)/.test(location.pathname) ||
    /^\/course\/\d+\/?$/.test(location.pathname);

  /* ============================== 课程数据 ============================== */

  function normalizeActivity(raw, module, isExam) {
    const type = isExam ? 'exam' : raw.type || 'page';
    let kind = 'other';
    if (type === 'page') kind = 'page';
    else if (type === 'online_video' || type === 'audio') kind = 'video';
    else if (type === 'forum') kind = 'forum';
    else if (type === 'exam') kind = 'exam';
    else if (type === 'homework') kind = 'homework';

    const upload = Array.isArray(raw.uploads) && raw.uploads.length ? raw.uploads[0] : null;

    return {
      id: Number(raw.id),
      kind,
      type,
      title: raw.title || `活动 ${raw.id}`,
      moduleName: module ? module.name : '',
      sort: Number(raw.sort) || 0,
      criterionKey: raw.completion_criterion_key || '',
      criterionText: raw.completion_criterion || '',
      threshold: parseInt(raw.completion_criterion_value, 10) || 0,
      upload,
      raw,
    };
  }

  const activityLabel = (act) => `[${TYPE_LABEL[act.type] || act.type}] ${act.title}`;

  function getDuration(act) {
    const upload = act.upload || (act.raw && act.raw.uploads && act.raw.uploads[0]);
    const video = upload && upload.videos && upload.videos[0];
    const duration = video ? Number(video.duration) : 0;
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  function isDone(rec, act) {
    if (!rec) return false;
    if (rec.completeness === 'full') return true;
    if (act && act.threshold > 0 && rec.data && Number(rec.data.completeness) >= act.threshold) {
      return true;
    }
    // 讨论区没有完成判定，浏览过即视为处理完毕
    if (act && act.kind === 'forum' && rec.completeness === 'part') return true;
    return false;
  }

  function readPercent(rec) {
    if (!rec) return -1;
    if (rec.data && rec.data.completeness != null) {
      return clamp(Number(rec.data.completeness) || 0, 0, 100);
    }
    if (rec.completeness === 'full') return 100;
    return -1;
  }

  async function mapLimit(items, limit, task) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await task(items[index], index);
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function loadCourse() {
    const cid = state.cid || getCourseId();
    if (!cid) throw new Error('未识别到课程 ID，请在课程页面使用');
    state.cid = cid;

    setStatus('run', '读取中');
    setCurrentIdle('正在读取课程结构…', '请稍候');
    setStartLabel('读取课程…', true);

    const [course, modulesRes, readsRes] = await Promise.all([
      apiGet(`/api/courses/${cid}?fields=id,name,learning_mode`).catch(() => null),
      apiGet(`/api/courses/${cid}/modules`),
      apiGet(`/api/course/${cid}/activity-reads-for-user`).catch(() => ({ activity_reads: [] })),
    ]);

    state.courseName =
      (course && course.name) || document.title.split(' - ')[0] || '当前课程';

    state.reads = new Map(
      (readsRes.activity_reads || []).map((rec) => [rec.activity_id, rec])
    );
    state.lastReadsAt = Date.now();

    const modules = (modulesRes.modules || [])
      .filter((m) => !m.hidden && m.is_hidden !== 1)
      .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));

    log(`课程「${state.courseName}」· ${modules.length} 个模块`);

    const groups = await mapLimit(modules, 3, async (module) => {
      const moduleIds = encodeURIComponent(`[${module.id}]`);
      try {
        const res = await apiGet(
          `/api/course/${cid}/all-activities?module_ids=${moduleIds}` +
            '&activity_types=learning_activities,exams,classrooms'
        );
        const items = [];
        for (const raw of res.learning_activities || []) {
          if (!raw.hidden) items.push(normalizeActivity(raw, module, false));
        }
        for (const raw of res.exams || []) {
          if (!raw.hidden) items.push(normalizeActivity(raw, module, true));
        }
        items.sort(
          (a, b) =>
            a.sort - b.sort ||
            (a.kind === 'exam' ? 1 : 0) - (b.kind === 'exam' ? 1 : 0)
        );
        return items;
      } catch (err) {
        log(`模块「${module.name}」读取失败：${err.message}`, 'warn');
        return [];
      }
    });

    const seen = new Set();
    state.activities = [];
    for (const group of groups) {
      for (const act of group) {
        if (seen.has(act.id)) continue;
        seen.add(act.id);
        state.activities.push(act);
      }
    }

    if (ui.course) {
      ui.course.textContent = `${state.courseName}${modules.length ? ` · ${modules.length} 个模块` : ''}`;
    }

    refreshProgress();
    refreshEta(true);
    setStatus('idle', '待机');
    setStartLabel('开始学习', false);
    setCurrentIdle(
      state.activities.length ? '准备就绪' : '没有读取到活动',
      state.activities.length ? '点击「开始学习」按顺序完成' : '请刷新页面或手动打开课程'
    );

    const done = state.activities.filter((act) => isDone(state.reads.get(act.id), act)).length;
    log(`共 ${state.activities.length} 个活动，已完成 ${done} 个`, 'ok');
  }

  async function refreshReads(force) {
    const now = Date.now();
    if (!force && now - state.lastReadsAt < 2500) return;
    state.lastReadsAt = now;
    const data = await apiGet(`/api/course/${state.cid}/activity-reads-for-user`);
    for (const rec of data.activity_reads || []) {
      state.reads.set(rec.activity_id, rec);
    }
    refreshProgress();
  }

  function updateRead(rec) {
    if (rec && rec.activity_id) {
      state.reads.set(rec.activity_id, rec);
      refreshProgress();
    }
  }

  async function getRead(id, force) {
    try {
      await refreshReads(force);
    } catch (err) {
      /* 使用缓存 */
    }
    return state.reads.get(id) || null;
  }

  async function postRead(id, body) {
    const res = await apiPost(`/api/course/activities-read/${id}`, body || {});
    updateRead(res);
    return res;
  }

  /* ============================== 面板样式 ============================== */

  function addStyle(css) {
    if (document.getElementById(STYLE_ID)) return;
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
      return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  const CSS = `
#lmsauto-panel, #lmsauto-panel * { box-sizing: border-box; }
#lmsauto-panel {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #e6edf7; -webkit-font-smoothing: antialiased;
}
#lmsauto-panel button, #lmsauto-panel select, #lmsauto-panel input { font-family: inherit; }
#lmsauto-panel button { -webkit-appearance: none; appearance: none; }
#lmsauto-panel .la-card {
  display: flex; flex-direction: column; width: 372px; max-width: calc(100vw - 24px); max-height: calc(100vh - 40px);
  background: linear-gradient(180deg, rgba(17, 28, 48, 0.985), rgba(8, 13, 25, 0.995));
  border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 18px;
  box-shadow: 0 24px 70px rgba(2, 6, 23, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
  overflow: hidden; backdrop-filter: blur(16px);
  animation: la-pop 0.18s ease-out;
}
@keyframes la-pop {
  from { transform: translateY(6px) scale(0.98); opacity: 0.6; }
  to { transform: none; opacity: 1; }
}
#lmsauto-panel.collapsed .la-card { display: none; }

#lmsauto-panel .la-bubble {
  display: none; width: 58px; height: 58px; border-radius: 50%;
  background: rgba(15, 23, 42, 0.97); border: 1px solid rgba(148, 163, 184, 0.3);
  box-shadow: 0 14px 40px rgba(2, 6, 23, 0.5); cursor: pointer;
  align-items: center; justify-content: center; position: relative;
}
#lmsauto-panel.collapsed .la-bubble { display: flex; }
#lmsauto-panel .la-bubble svg { position: absolute; inset: 5px; width: 48px; height: 48px; transform: rotate(-90deg); }
#lmsauto-panel .la-ring-bg { fill: none; stroke: rgba(148, 163, 184, 0.18); stroke-width: 4; }
#lmsauto-panel .la-ring-fg {
  fill: none; stroke: #38bdf8; stroke-width: 4; stroke-linecap: round;
  stroke-dasharray: 125.66; stroke-dashoffset: 125.66; transition: stroke-dashoffset 0.4s ease;
}
#lmsauto-panel .la-bubble span { font-size: 11px; font-weight: 700; color: #e2e8f0; }
#lmsauto-panel .la-bubble[data-mode="run"] { border-color: rgba(52, 211, 153, 0.45); }
#lmsauto-panel .la-bubble[data-mode="run"] .la-ring-fg { stroke: #34d399; }
#lmsauto-panel .la-bubble[data-mode="pause"] { border-color: rgba(251, 191, 36, 0.5); }
#lmsauto-panel .la-bubble[data-mode="pause"] .la-ring-fg { stroke: #fbbf24; }
#lmsauto-panel .la-bubble[data-mode="err"] { border-color: rgba(248, 113, 113, 0.6); }
#lmsauto-panel .la-bubble[data-mode="err"] .la-ring-fg { stroke: #f87171; }

#lmsauto-panel .la-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 13px 14px 11px; cursor: move;
  background: linear-gradient(180deg, rgba(56, 189, 248, 0.14), rgba(56, 189, 248, 0));
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}
#lmsauto-panel .la-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
#lmsauto-panel .la-logo {
  flex: none; width: 32px; height: 32px; border-radius: 10px;
  background: linear-gradient(135deg, #38bdf8, #2563eb);
  display: grid; place-items: center; font-weight: 800; font-size: 15px; color: #fff;
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.4);
}
#lmsauto-panel .la-brand-text { min-width: 0; }
#lmsauto-panel .la-title { font-size: 13.5px; font-weight: 700; letter-spacing: 0.3px; }
#lmsauto-panel .la-title em { font-style: normal; font-size: 10px; font-weight: 500; color: #64748b; margin-left: 4px; }
#lmsauto-panel .la-course {
  font-size: 11px; color: #94a3b8; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; max-width: 220px;
}
#lmsauto-panel .la-head-tools { display: flex; gap: 4px; flex: none; }
#lmsauto-panel .la-ico {
  width: 26px; height: 26px; border: 0; border-radius: 8px; background: transparent;
  color: #94a3b8; font-size: 15px; line-height: 1; cursor: pointer;
}
#lmsauto-panel .la-ico:hover { color: #e2e8f0; background: rgba(148, 163, 184, 0.16); }

#lmsauto-panel .la-main { padding: 12px 14px 0; overflow-y: auto; min-height: 0; }
#lmsauto-panel .la-main::-webkit-scrollbar { width: 6px; }
#lmsauto-panel .la-main::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.22); border-radius: 3px; }

#lmsauto-panel .la-progress-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; }
#lmsauto-panel .la-num { font-size: 24px; font-weight: 800; line-height: 1; letter-spacing: 0.5px; }
#lmsauto-panel .la-num b { color: #f8fafc; }
#lmsauto-panel .la-num i { font-style: normal; color: #475569; margin: 0 3px; font-size: 15px; }
#lmsauto-panel .la-num span { color: #94a3b8; font-size: 15px; font-weight: 600; }
#lmsauto-panel .la-status {
  display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #94a3b8;
  background: rgba(148, 163, 184, 0.1); border: 1px solid rgba(148, 163, 184, 0.14);
  padding: 3px 8px; border-radius: 999px; white-space: nowrap;
}
#lmsauto-panel .la-status i { width: 6px; height: 6px; border-radius: 50%; background: #64748b; }
#lmsauto-panel .la-status[data-mode="run"] { color: #86efac; background: rgba(52, 211, 153, 0.12); border-color: rgba(52, 211, 153, 0.22); }
#lmsauto-panel .la-status[data-mode="run"] i { background: #34d399; animation: la-pulse 1.5s infinite; }
#lmsauto-panel .la-status[data-mode="pause"] { color: #fcd34d; background: rgba(251, 191, 36, 0.12); border-color: rgba(251, 191, 36, 0.25); }
#lmsauto-panel .la-status[data-mode="pause"] i { background: #fbbf24; }
#lmsauto-panel .la-status[data-mode="err"] { color: #fca5a5; background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.25); }
#lmsauto-panel .la-status[data-mode="err"] i { background: #f87171; }
@keyframes la-pulse {
  0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); }
  70% { box-shadow: 0 0 0 6px rgba(52, 211, 153, 0); }
  100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
}

#lmsauto-panel .la-bar {
  height: 7px; border-radius: 999px; background: rgba(148, 163, 184, 0.14);
  margin: 9px 0 7px; overflow: hidden;
}
#lmsauto-panel .la-bar-fill {
  height: 100%; width: 0; border-radius: 999px;
  background: linear-gradient(90deg, #38bdf8, #34d399); transition: width 0.45s ease;
}
#lmsauto-panel .la-meta { display: flex; justify-content: space-between; font-size: 10.5px; color: #7c8aa0; }

#lmsauto-panel .la-current {
  display: flex; gap: 10px; align-items: flex-start; margin: 12px 0 10px;
  padding: 10px 11px; border-radius: 12px; min-height: 56px;
  background: rgba(148, 163, 184, 0.07); border: 1px solid rgba(148, 163, 184, 0.12);
}
#lmsauto-panel .la-kind {
  flex: none; margin-top: 1px; font-size: 10.5px; font-weight: 700;
  padding: 3px 7px; border-radius: 6px;
  background: rgba(148, 163, 184, 0.13); color: #94a3b8;
}
#lmsauto-panel .la-kind[data-kind="video"] { color: #7dd3fc; background: rgba(56, 189, 248, 0.14); }
#lmsauto-panel .la-kind[data-kind="page"] { color: #c4b5fd; background: rgba(167, 139, 250, 0.14); }
#lmsauto-panel .la-kind[data-kind="forum"] { color: #fcd34d; background: rgba(251, 191, 36, 0.14); }
#lmsauto-panel .la-kind[data-kind="exam"] { color: #fca5a5; background: rgba(248, 113, 113, 0.14); }
#lmsauto-panel .la-kind[data-kind="homework"] { color: #fdba74; background: rgba(251, 146, 60, 0.14); }
#lmsauto-panel .la-current-body { min-width: 0; }
#lmsauto-panel .la-current-title {
  font-size: 12.5px; font-weight: 600; color: #e2e8f0;
  line-height: 1.45; word-break: break-all;
}
#lmsauto-panel .la-current-sub { margin-top: 2px; font-size: 11px; color: #7c8aa0; }

#lmsauto-panel .la-actions { display: flex; gap: 8px; margin-bottom: 12px; }
#lmsauto-panel .la-btn {
  height: 34px; padding: 0 12px; border-radius: 9px;
  border: 1px solid rgba(148, 163, 184, 0.22); background: rgba(148, 163, 184, 0.1);
  color: #cbd5e1; font-size: 12px; cursor: pointer; transition: 0.15s;
}
#lmsauto-panel .la-btn:hover { background: rgba(148, 163, 184, 0.18); color: #fff; }
#lmsauto-panel .la-btn:disabled { opacity: 0.5; cursor: not-allowed; }
#lmsauto-panel .la-primary {
  flex: 1; border-color: transparent; color: #fff; font-weight: 700;
  background: linear-gradient(135deg, #2563eb, #3b82f6);
}
#lmsauto-panel .la-primary:hover { filter: brightness(1.08); background: linear-gradient(135deg, #2563eb, #3b82f6); }
#lmsauto-panel .la-primary.paused { background: linear-gradient(135deg, #d97706, #f59e0b); }
#lmsauto-panel .la-primary.paused:hover { background: linear-gradient(135deg, #d97706, #f59e0b); filter: brightness(1.05); }
#lmsauto-panel .la-danger:hover { color: #fca5a5; border-color: rgba(248, 113, 113, 0.4); background: rgba(248, 113, 113, 0.1); }

#lmsauto-panel .la-settings {
  display: flex; flex-direction: column; gap: 8px;
  padding-top: 10px; border-top: 1px solid rgba(148, 163, 184, 0.1);
}
#lmsauto-panel .la-row { display: flex; align-items: center; gap: 10px; }
#lmsauto-panel .la-key { flex: none; width: 34px; font-size: 11px; color: #7c8aa0; }
#lmsauto-panel .la-seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: rgba(148, 163, 184, 0.09); }
#lmsauto-panel .la-seg button {
  border: 0; background: transparent; color: #94a3b8; font-size: 11px;
  padding: 4px 10px; border-radius: 6px; cursor: pointer; transition: 0.15s;
}
#lmsauto-panel .la-seg button:hover { color: #e2e8f0; }
#lmsauto-panel .la-seg button.on { background: #1e40af; color: #fff; }
#lmsauto-panel .la-row select {
  background: rgba(15, 23, 42, 0.85); color: #e2e8f0;
  border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 7px;
  padding: 4px 8px; font-size: 11.5px; outline: none; cursor: pointer;
}
#lmsauto-panel .la-chips { display: flex; flex-wrap: wrap; gap: 6px; }
#lmsauto-panel .la-chips label {
  display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: #94a3b8;
  padding: 4px 8px; border-radius: 999px; cursor: pointer;
  background: rgba(148, 163, 184, 0.07); border: 1px solid rgba(148, 163, 184, 0.12);
  transition: 0.15s;
}
#lmsauto-panel .la-chips label:has(input:checked) {
  color: #bae6fd; background: rgba(56, 189, 248, 0.12); border-color: rgba(56, 189, 248, 0.3);
}
#lmsauto-panel .la-chips input { width: 11px; height: 11px; margin: 0; accent-color: #38bdf8; }

#lmsauto-panel .la-log-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 0 5px; font-size: 10.5px; color: #64748b;
}
#lmsauto-panel .la-log-head button { border: 0; background: none; color: #64748b; font-size: 10.5px; cursor: pointer; padding: 0; }
#lmsauto-panel .la-log-head button:hover { color: #cbd5e1; }
#lmsauto-panel .la-log {
  height: 112px; overflow-y: auto; padding: 7px 9px;
  background: rgba(2, 6, 23, 0.5); border: 1px solid rgba(148, 163, 184, 0.1);
  border-radius: 10px; font: 10.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace;
  color: #94a3b8; word-break: break-all;
}
#lmsauto-panel .la-log::-webkit-scrollbar { width: 6px; }
#lmsauto-panel .la-log::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.22); border-radius: 3px; }
#lmsauto-panel .la-line { white-space: pre-wrap; }
#lmsauto-panel .la-line.dim { color: #64748b; }
#lmsauto-panel .la-line.ok { color: #4ade80; }
#lmsauto-panel .la-line.warn { color: #fbbf24; }
#lmsauto-panel .la-line.err { color: #f87171; }
#lmsauto-panel .la-foot { padding: 8px 0 10px; text-align: center; font-size: 10px; color: #475569; }
`;

  /* ============================== 面板结构 ============================== */

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.className = state.collapsed ? 'collapsed' : '';
    root.innerHTML = `
      <div class="la-bubble" id="la-bubble" title="展开学习助手">
        <svg viewBox="0 0 48 48">
          <circle class="la-ring-bg" cx="24" cy="24" r="20"></circle>
          <circle class="la-ring-fg" id="la-ring" cx="24" cy="24" r="20"></circle>
        </svg>
        <span id="la-bubble-pct">0%</span>
      </div>
      <div class="la-card" id="la-card">
        <header class="la-head" id="la-head">
          <div class="la-brand">
            <span class="la-logo">L</span>
            <div class="la-brand-text">
              <div class="la-title">学习助手 <em>v${VERSION}</em></div>
              <div class="la-course" id="la-course">识别课程中…</div>
            </div>
          </div>
          <div class="la-head-tools">
            <button class="la-ico" id="la-refresh" title="重新读取课程">⟳</button>
            <button class="la-ico" id="la-min" title="收起面板">−</button>
          </div>
        </header>
        <div class="la-main">
          <div class="la-progress">
            <div class="la-progress-head">
              <span class="la-num"><b id="la-done">0</b><i>/</i><span id="la-total">0</span></span>
              <span class="la-status" id="la-status" data-mode="idle"><i></i><b>待机</b></span>
            </div>
            <div class="la-bar"><div class="la-bar-fill" id="la-bar"></div></div>
            <div class="la-meta"><span id="la-elapsed">已用 0:00</span><span id="la-eta">预计 --</span></div>
          </div>
          <div class="la-current">
            <span class="la-kind" id="la-kind" data-kind="none">待机</span>
            <div class="la-current-body">
              <div class="la-current-title" id="la-current-title">等待开始</div>
              <div class="la-current-sub" id="la-current-sub">选择模式后点击「开始学习」</div>
            </div>
          </div>
          <div class="la-actions">
            <button class="la-btn la-primary" id="la-start"><span id="la-start-label">开始学习</span></button>
            <button class="la-btn" id="la-skip" title="跳过当前活动">跳过</button>
            <button class="la-btn la-danger" id="la-stop" title="停止任务">停止</button>
          </div>
          <div class="la-settings">
            <div class="la-row">
              <span class="la-key">策略</span>
              <div class="la-seg" id="la-strategy">
                <button data-v="play">真实播放</button>
                <button data-v="api">接口补齐</button>
              </div>
            </div>
            <div class="la-row">
              <span class="la-key">节奏</span>
              <div class="la-seg" id="la-pace">
                <button data-v="slow">慢</button>
                <button data-v="normal">自然</button>
                <button data-v="fast">快</button>
              </div>
            </div>
            <div class="la-row">
              <span class="la-key">倍速</span>
              <select id="la-speed">
                ${SPEED_OPTIONS.map((v) => `<option value="${v}">${v}x</option>`).join('')}
              </select>
            </div>
            <div class="la-chips">
              <label title="随机倍速、微暂停、回看、鼠标活动、阅读停留"><input type="checkbox" id="la-human" />拟人化</label>
              <label title="让页面认为始终在前台，避免切走后暂停"><input type="checkbox" id="la-keep" />保持前台</label>
              <label title="长时间没有进度回报时，用真实播放位置补报一次"><input type="checkbox" id="la-fallback" />兜底上报</label>
              <label title="进入讨论区浏览（不发帖）"><input type="checkbox" id="la-forum" />讨论区</label>
            </div>
          </div>
          <div class="la-log-head"><span>运行日志</span><button id="la-clear">清空</button></div>
          <div class="la-log" id="la-log"></div>
          <footer class="la-foot">模拟人类学习节奏 · 测验 / 作业请自行完成</footer>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    ui.root = root;
    ui.bubble = root.querySelector('#la-bubble');
    ui.ring = root.querySelector('#la-ring');
    ui.bubblePct = root.querySelector('#la-bubble-pct');
    ui.card = root.querySelector('#la-card');
    ui.head = root.querySelector('#la-head');
    ui.course = root.querySelector('#la-course');
    ui.refresh = root.querySelector('#la-refresh');
    ui.min = root.querySelector('#la-min');
    ui.done = root.querySelector('#la-done');
    ui.total = root.querySelector('#la-total');
    ui.status = root.querySelector('#la-status');
    ui.statusText = ui.status.querySelector('b');
    ui.bar = root.querySelector('#la-bar');
    ui.elapsed = root.querySelector('#la-elapsed');
    ui.eta = root.querySelector('#la-eta');
    ui.kind = root.querySelector('#la-kind');
    ui.currentTitle = root.querySelector('#la-current-title');
    ui.currentSub = root.querySelector('#la-current-sub');
    ui.start = root.querySelector('#la-start');
    ui.startLabel = root.querySelector('#la-start-label');
    ui.skip = root.querySelector('#la-skip');
    ui.stop = root.querySelector('#la-stop');
    ui.strategy = root.querySelector('#la-strategy');
    ui.pace = root.querySelector('#la-pace');
    ui.speed = root.querySelector('#la-speed');
    ui.human = root.querySelector('#la-human');
    ui.keep = root.querySelector('#la-keep');
    ui.fallback = root.querySelector('#la-fallback');
    ui.forum = root.querySelector('#la-forum');
    ui.log = root.querySelector('#la-log');
    ui.clear = root.querySelector('#la-clear');

    ui.bubble.addEventListener('click', () => setCollapsed(false));
    ui.min.addEventListener('click', () => setCollapsed(true));
    ui.start.addEventListener('click', () => {
      if (state.running) togglePause();
      else startFlow(false);
    });
    ui.skip.addEventListener('click', skipCurrent);
    ui.stop.addEventListener('click', stopAll);
    ui.refresh.addEventListener('click', refreshCourse);
    ui.clear.addEventListener('click', () => {
      if (ui.log) ui.log.textContent = '';
    });

    ui.strategy.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-v]');
      if (!btn || state.running) return;
      cfg.strategy = btn.dataset.v;
      saveCfg();
      syncSeg(ui.strategy, cfg.strategy);
      log(cfg.strategy === 'play' ? '视频策略：真实播放' : '视频策略：接口补齐（更快，但更易被识别）', 'warn');
    });
    ui.pace.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-v]');
      if (!btn) return;
      cfg.pace = btn.dataset.v;
      saveCfg();
      syncSeg(ui.pace, cfg.pace);
      refreshEta(true);
    });

    ui.speed.addEventListener('change', () => {
      cfg.speed = Number(ui.speed.value) || DEFAULTS.speed;
      saveCfg();
      if (cfg.human) {
        human.rate = clamp(cfg.speed, 1, 2);
        if (state.video) {
          try {
            state.video.playbackRate = human.rate;
          } catch (err) {
            /* 忽略 */
          }
        }
      } else if (state.video) {
        try {
          state.video.playbackRate = cfg.speed;
        } catch (err) {
          /* 忽略 */
        }
      }
      if (cfg.human && cfg.speed > 2) {
        log('拟人化模式下倍速上限按 2x 执行', 'dim');
      }
      refreshEta(true);
    });

    ui.human.addEventListener('change', () => {
      cfg.human = ui.human.checked;
      saveCfg();
      if (!cfg.human && state.video) {
        try {
          state.video.playbackRate = cfg.speed;
        } catch (err) {
          /* 忽略 */
        }
      }
      refreshEta(true);
      log(cfg.human ? '已开启拟人化行为' : '已关闭拟人化行为', 'dim');
    });
    ui.keep.addEventListener('change', () => {
      cfg.keepAwake = ui.keep.checked;
      saveCfg();
      if (cfg.keepAwake) installStealth();
      else uninstallStealth();
    });
    ui.fallback.addEventListener('change', () => {
      cfg.fallback = ui.fallback.checked;
      saveCfg();
    });
    ui.forum.addEventListener('change', () => {
      cfg.visitForum = ui.forum.checked;
      saveCfg();
    });

    syncSettings();
    makeDraggable(root, ui.head);
    restorePosition(root);
  }

  function syncSeg(container, value) {
    if (!container) return;
    container.querySelectorAll('button[data-v]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.v === value);
    });
  }

  function syncSettings() {
    syncSeg(ui.strategy, cfg.strategy);
    syncSeg(ui.pace, cfg.pace);
    if (ui.speed) ui.speed.value = String(cfg.speed);
    if (ui.human) ui.human.checked = !!cfg.human;
    if (ui.keep) ui.keep.checked = !!cfg.keepAwake;
    if (ui.fallback) ui.fallback.checked = !!cfg.fallback;
    if (ui.forum) ui.forum.checked = !!cfg.visitForum;
  }

  function setCollapsed(value) {
    state.collapsed = !!value;
    if (ui.root) ui.root.classList.toggle('collapsed', state.collapsed);
    let uiState = store.get(UI_KEY, {});
    if (!uiState || typeof uiState !== 'object') uiState = {};
    uiState.collapsed = state.collapsed;
    store.set(UI_KEY, uiState);
  }

  function restorePosition(root) {
    const pos = store.get(POS_KEY, null);
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    if (pos.left < -200 || pos.top < -200) return;
    root.style.left = `${clamp(pos.left, 4, Math.max(4, window.innerWidth - 80))}px`;
    root.style.top = `${clamp(pos.top, 4, Math.max(4, window.innerHeight - 80))}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function makeDraggable(root, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    handle.addEventListener('mousedown', (event) => {
      if (event.target.closest('button')) return;
      const rect = root.getBoundingClientRect();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      event.preventDefault();
    });

    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      const left = clamp(originLeft + event.clientX - startX, 4, window.innerWidth - 80);
      const top = clamp(originTop + event.clientY - startY, 4, window.innerHeight - 60);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const rect = root.getBoundingClientRect();
      store.set(POS_KEY, { left: rect.left, top: rect.top });
    });
  }

  /* ============================== 面板更新 ============================== */

  function log(message, level) {
    const text = String(message);
    console.log('[LMS-AUTO]', text);
    if (!ui.log) return;
    const line = document.createElement('div');
    line.className = `la-line ${level || ''}`;
    line.textContent = `${nowStr()}  ${text}`;
    ui.log.appendChild(line);
    while (ui.log.childElementCount > 140) {
      ui.log.removeChild(ui.log.firstChild);
    }
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function setStatus(mode, text) {
    if (ui.status) {
      ui.status.dataset.mode = mode || 'idle';
      if (ui.statusText) ui.statusText.textContent = text || '待机';
    }
    if (ui.bubble) ui.bubble.dataset.mode = mode || 'idle';
  }

  function setCurrentIdle(title, sub) {
    if (ui.kind) {
      ui.kind.textContent = '待机';
      ui.kind.dataset.kind = 'none';
    }
    if (ui.currentTitle) ui.currentTitle.textContent = title;
    if (ui.currentSub) ui.currentSub.textContent = sub || '';
  }

  function setCurrent(act, sub) {
    if (!ui.kind) return;
    const kind = act.kind === 'video' ? 'video' : act.kind;
    ui.kind.textContent = TYPE_LABEL[act.type] || act.type || '活动';
    ui.kind.dataset.kind = kind;
    if (ui.currentTitle) ui.currentTitle.textContent = act.title;
    if (ui.currentSub) ui.currentSub.textContent = sub || '';
  }

  function setCurrentSub(sub) {
    if (ui.currentSub) ui.currentSub.textContent = sub;
  }

  function setStartLabel(text, disabled) {
    if (ui.startLabel) ui.startLabel.textContent = text;
    if (ui.start) ui.start.disabled = !!disabled;
  }

  function refreshProgress() {
    const total = state.activities.length;
    let done = 0;
    for (const act of state.activities) {
      if (isDone(state.reads.get(act.id), act)) done += 1;
    }
    const pct = total ? done / total : 0;

    if (ui.done) ui.done.textContent = String(done);
    if (ui.total) ui.total.textContent = String(total);
    if (ui.bar) ui.bar.style.width = `${(pct * 100).toFixed(1)}%`;
    if (ui.bubblePct) ui.bubblePct.textContent = `${Math.round(pct * 100)}%`;
    if (ui.ring) {
      const circumference = 125.66;
      ui.ring.style.strokeDashoffset = String(circumference * (1 - pct));
    }
  }

  function effectiveSpeed() {
    if (!cfg.human) return Math.max(1, cfg.speed);
    return clamp(cfg.speed, 1, 2);
  }

  function estimateRemaining() {
    const pace = PACE[cfg.pace];
    const gapAvg = (pace.gap[0] + pace.gap[1]) / 2;
    let seconds = 0;
    for (const act of state.activities) {
      if (isDone(state.reads.get(act.id), act)) continue;
      if (act.kind === 'exam' || act.kind === 'homework') continue;
      if (act.kind === 'forum' && !cfg.visitForum) continue;
      if (act.kind === 'video') {
        const duration = getDuration(act);
        seconds += duration ? duration / effectiveSpeed() : 180;
      } else if (act.kind === 'page') {
        seconds += 12;
      } else if (act.kind === 'forum') {
        seconds += 10;
      } else {
        seconds += 5;
      }
      seconds += gapAvg;
    }
    return seconds;
  }

  function refreshEta(force) {
    const now = Date.now();
    if (!force && now - state.lastEtaAt < 8000) return;
    state.lastEtaAt = now;
    if (!ui.eta) return;
    const left = estimateRemaining();
    ui.eta.textContent = left > 0 ? `预计 ${fmtSpan(left)}` : '预计 --';
  }

  function setRunningUI() {
    if (!ui.start) return;
    ui.start.disabled = false;
    ui.start.classList.toggle('paused', state.running && state.paused);
    if (ui.skip) ui.skip.disabled = !state.running;
    if (state.running) {
      ui.startLabel.textContent = state.paused ? '继续' : '暂停';
      setStatus(state.paused ? 'pause' : 'run', state.paused ? '已暂停' : '运行中');
    } else {
      ui.startLabel.textContent = '开始学习';
      setStatus('idle', '待机');
    }
  }

  function tickUi() {
    if (!state.running || !state.runStartedAt) return;
    if (ui.elapsed) ui.elapsed.textContent = `已用 ${fmtClock(Date.now() - state.runStartedAt)}`;
    refreshEta(false);
  }

  /* ============================== 拟人化行为 ============================== */

  const human = {
    ambientTimer: null,
    nextMouseAt: 0,
    nextRateAt: 0,
    nextPauseAt: 0,
    nextRewindAt: 0,
    holdUntil: 0,
    rate: 1.5,

    startAmbient() {
      if (this.ambientTimer) return;
      this.nextMouseAt = Date.now() + randInt(4000, 12000);
      this.ambientTimer = setInterval(() => this.ambient(), 2500);
    },

    stopAmbient() {
      if (this.ambientTimer) {
        clearInterval(this.ambientTimer);
        this.ambientTimer = null;
      }
    },

    ambient() {
      if (!state.running || !cfg.human) return;
      const now = Date.now();
      if (now > this.nextMouseAt) {
        const x = randInt(40, Math.max(60, window.innerWidth - 40));
        const y = randInt(40, Math.max(60, window.innerHeight - 40));
        try {
          document.dispatchEvent(
            new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true })
          );
          if (typeof PointerEvent === 'function') {
            document.dispatchEvent(
              new PointerEvent('pointermove', {
                clientX: x,
                clientY: y,
                bubbles: true,
                pointerId: 1,
                pointerType: 'mouse',
              })
            );
          }
        } catch (err) {
          /* 忽略 */
        }
        this.nextMouseAt = now + randInt(12000, 38000);
      }
    },

    resetVideo() {
      const now = Date.now();
      this.nextRateAt = now + randInt(20000, 45000);
      this.nextPauseAt = now + randInt(70000, 150000);
      this.nextRewindAt = now + randInt(120000, 240000);
      this.holdUntil = 0;
      this.rate = clamp(cfg.speed, 1, 2);
    },

    tick(video) {
      if (!cfg.human || !video) return;
      const now = Date.now();

      if (now > this.nextRateAt) {
        const base = clamp(cfg.speed, 1, 2);
        const rate = clamp(base + rand(-0.15, 0.15), 1, 2);
        this.rate = Math.round(rate * 100) / 100;
        try {
          video.playbackRate = this.rate;
        } catch (err) {
          /* 忽略 */
        }
        this.nextRateAt = now + randInt(30000, 70000);
      }

      if (now > this.nextPauseAt) {
        this.holdUntil = now + randInt(1500, 4000);
        try {
          video.pause();
        } catch (err) {
          /* 忽略 */
        }
        this.nextPauseAt = now + randInt(90000, 220000);
      }

      if (now > this.nextRewindAt) {
        if (video.currentTime > 20 && Number.isFinite(video.duration)) {
          try {
            video.currentTime = Math.max(0, video.currentTime - rand(2, 5));
          } catch (err) {
            /* 忽略 */
          }
        }
        this.nextRewindAt = now + randInt(150000, 300000);
      }
    },
  };

  let stealthInstalled = false;
  let originalHasFocus = null;

  function installStealth() {
    if (stealthInstalled) return;
    stealthInstalled = true;
    try {
      originalHasFocus = document.hasFocus;
    } catch (err) {
      originalHasFocus = null;
    }
    try {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    } catch (err) {
      /* 忽略 */
    }
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    } catch (err) {
      /* 忽略 */
    }
    try {
      document.hasFocus = () => true;
    } catch (err) {
      /* 忽略 */
    }
  }

  function uninstallStealth() {
    if (!stealthInstalled) return;
    stealthInstalled = false;
    try {
      delete document.hidden;
    } catch (err) {
      /* 忽略 */
    }
    try {
      delete document.visibilityState;
    } catch (err) {
      /* 忽略 */
    }
    try {
      if (originalHasFocus) document.hasFocus = originalHasFocus;
    } catch (err) {
      /* 忽略 */
    }
  }

  // 图文页面：按正文长度模拟阅读停留，并做渐进滚动
  async function humanReadPage() {
    const box = document.querySelector('.activity-content-box');
    const text = box ? String(box.innerText || box.textContent || '') : '';
    const length = text.length;
    const pace = PACE[cfg.pace];
    const base = clamp(4 + length / 140, 4, 24);
    const total = base * rand(pace.read[0], pace.read[1]) * 1000;
    const steps = randInt(2, 4);
    const per = total / steps;

    for (let i = 0; i < steps; i += 1) {
      if (!state.running || state.skipRequested) return false;
      const dy = randInt(120, 340);
      try {
        window.scrollBy({ top: dy, behavior: 'smooth' });
      } catch (err) {
        window.scrollBy(0, dy);
      }
      await waitOrAbort(per * rand(0.75, 1.25));
    }

    await waitOrAbort(rand(600, 1600));
    return state.running && !state.skipRequested;
  }

  /* ============================== 主流程 ============================== */

  function saveResume(nextId) {
    store.set(RESUME_KEY, {
      cid: state.cid,
      nextId: nextId || '',
      ts: Date.now(),
    });
  }

  function clearResume() {
    store.set(RESUME_KEY, null);
  }

  function nextActivityId() {
    const next = state.activities[state.index + 1];
    return next ? next.id : '';
  }

  async function maybeResume() {
    const resume = store.get(RESUME_KEY, null);
    if (!resume || !resume.ts || !resume.nextId) return;
    if (Date.now() - resume.ts > 20 * 60 * 1000) return;
    if (!isFullScreenPage()) return;
    if (resume.cid && Number(resume.cid) !== getCourseId()) return;

    setStatus('pause', '即将继续');
    log('发现未完成的学习任务，3 秒后自动继续…', 'ok');
    await sleep(3000);

    // 3 秒内用户可能点了「停止」，这里再确认一次
    const latest = store.get(RESUME_KEY, null);
    if (!latest || !latest.nextId) {
      if (!state.running && !state.busy) setStatus('idle', '待机');
      return;
    }
    if (state.running || state.busy || state.resumeHandled) return;
    startFlow(true, latest.nextId);
  }

  async function startFlow(auto, nextId) {
    if (state.busy || state.running) return;
    state.resumeHandled = true;
    state.busy = true;
    state.cancelRequested = false;
    setStartLabel('读取课程…', true);

    try {
      state.cid = state.cid || getCourseId();
      if (!state.cid) {
        log('未识别到课程 ID，请在课程页面打开本面板', 'err');
        setStatus('err', '未识别课程');
        setCurrentIdle('未识别到课程', '请在 /course/课程ID/… 页面使用');
        return;
      }

      if (!state.activities.length) {
        await loadCourse();
      } else if (!auto) {
        state.index = 0;
        try {
          await refreshReads(true);
        } catch (err) {
          /* 使用缓存 */
        }
      }

      if (state.cancelRequested) {
        log('已取消本次启动', 'warn');
        return;
      }

      if (!state.activities.length) {
        log('没有读取到课程活动，请刷新页面后重试', 'err');
        setStatus('err', '无活动');
        return;
      }

      if (nextId) {
        const index = state.activities.findIndex((act) => act.id === Number(nextId));
        if (index >= 0) state.index = index;
      }

      if (!auto && !isFullScreenPage()) {
        const target =
          state.activities.find(
            (act) =>
              act.kind !== 'exam' &&
              act.kind !== 'homework' &&
              !isDone(state.reads.get(act.id), act)
          ) ||
          state.activities.find((act) => !isDone(state.reads.get(act.id), act)) ||
          state.activities[0];
        saveResume(target ? target.id : '');
        log('正在进入全屏学习页面…');
        hardNavigate(
          `${location.origin}/course/${state.cid}/learning-activity/full-screen#/${target ? target.id : ''}`
        );
        return;
      }

      const ready = await waitFor(() => !!document.querySelector('.activity-content-box'), 15000, 300);
      if (!ready) log('学习页面结构未就绪，仍尝试继续', 'warn');
      if (state.cancelRequested) {
        log('已取消本次启动', 'warn');
        return;
      }

      setStartLabel('准备页面…', true);
      await sleep(rand(200, 500));
      if (state.cancelRequested) {
        log('已取消本次启动', 'warn');
        return;
      }

      state.running = true;
      state.paused = false;
      state.skipRequested = false;
      state.runStartedAt = Date.now();
      state.lastEtaAt = 0;

      if (cfg.keepAwake) installStealth();
      human.startAmbient();
      setRunningUI();
      setStatus('run', '运行中');
      log('开始学习', 'ok');

      await runLoop();
    } catch (err) {
      log(`启动失败：${err.message}`, 'err');
      setStatus('err', '出错');
      state.running = false;
      human.stopAmbient();
      setRunningUI();
    } finally {
      state.busy = false;
      state.cancelRequested = false;
      if (!state.running) setStartLabel('开始学习', false);
    }
  }

  async function runLoop() {
    log(`共 ${state.activities.length} 个活动，从第 ${state.index + 1} 个开始`, 'dim');

    let failures = 0;

    for (let i = state.index; i < state.activities.length; i += 1) {
      if (!state.running) break;
      if (state.paused) await waitWhilePaused();
      if (!state.running) break;

      state.index = i;
      state.skipRequested = false;
      const act = state.activities[i];
      state.current = act;

      setCurrent(act, '准备中…');
      let result = 'unknown';
      try {
        result = await processActivity(act);
      } catch (err) {
        log(`处理失败：${err.message}`, 'err');
        result = 'failed';
      }

      if (result === 'redirect') return;
      if (result === 'skipped') log(`已跳过：${act.title}`, 'warn');

      if (result === 'failed' || result === 'unknown') failures += 1;
      else failures = 0;

      if (failures >= 8) {
        log('连续多个活动处理失败，可能被前置条件锁住，已自动停止', 'err');
        state.running = false;
        clearResume();
        human.stopAmbient();
        setRunningUI();
        setStatus('err', '已停止');
        break;
      }

      refreshProgress();
      refreshEta(true);

      if (state.running && i < state.activities.length - 1) {
        saveResume(state.activities[i + 1].id);

        // 已完成/跳过/测验作业这类不需要停留的活动，快速略过，避免空耗时间
        if (result === 'skip' || result === 'skipped') {
          await sleep(rand(80, 220));
        } else {
          // 每 6 个活动有概率休息一下，模拟真人节奏
          const pace = PACE[cfg.pace];
          if (i > 0 && i % 6 === 0 && chance(pace.restChance)) {
            const rest = randInt(15, 35);
            log(`连续学习了一段时间，休息 ${rest} 秒…`, 'dim');
            await waitOrAbort(rest * 1000);
          } else {
            const gap = randInt(pace.gap[0], pace.gap[1]);
            await waitOrAbort(gap * 1000 + randInt(0, 1200));
          }
        }
      }
    }

    if (!state.running) return;

    state.running = false;
    state.current = null;
    clearResume();
    human.stopAmbient();
    setRunningUI();

    const total = state.activities.length;
    const done = state.activities.filter((act) => isDone(state.reads.get(act.id), act)).length;
    const left = total - done;

    refreshProgress();
    refreshEta(true);

    if (left > 0) {
      setStatus('idle', '已完成');
      setCurrentIdle(
        `已完成 ${done} / ${total}`,
        `剩余 ${left} 个（多为测验、作业或讨论区）`
      );
      log(`处理结束：完成 ${done} / ${total}，剩余 ${left} 个`, 'warn');
    } else {
      setStatus('idle', '全部完成');
      setCurrentIdle(`全部完成 ${done} / ${total}`, '可以关闭页面了');
      log(`全部完成：${done} / ${total} 🎉`, 'ok');
    }
  }

  async function waitWhilePaused() {
    while (state.running && state.paused) {
      await sleep(350);
    }
  }

  function togglePause() {
    if (!state.running) return;
    state.paused = !state.paused;

    if (state.paused) {
      if (state.video) {
        try {
          state.video.pause();
        } catch (err) {
          /* 忽略 */
        }
      }
      human.stopAmbient();
      log('已暂停', 'warn');
    } else {
      human.startAmbient();
      log('继续学习', 'ok');
    }
    setRunningUI();
  }

  function skipCurrent() {
    if (!state.running) return;
    state.skipRequested = true;
    if (state.video) {
      try {
        state.video.pause();
      } catch (err) {
        /* 忽略 */
      }
    }
    log('已请求跳过当前活动', 'warn');
  }

  function stopAll() {
    const wasRunning = state.running;
    state.running = false;
    state.paused = false;
    state.skipRequested = false;
    if (state.busy) state.cancelRequested = true;

    if (state.video) {
      try {
        state.video.pause();
      } catch (err) {
        /* 忽略 */
      }
    }

    human.stopAmbient();
    clearResume();
    setRunningUI();
    setStartLabel('开始学习', false);

    if (wasRunning) {
      setStatus('idle', '已停止');
      setCurrentIdle('已停止', '已完成的进度会保留，可随时重新开始');
      log('已停止', 'warn');
    }
  }

  /* ============================== 单个活动 ============================== */

  async function processActivity(act) {
    const rec = state.reads.get(act.id);
    if (isDone(rec, act)) {
      log(`已完成，跳过：${act.title}`, 'dim');
      return 'skip';
    }

    if (act.kind === 'exam') {
      log(`测验/考试需手动完成，跳过：${act.title}`, 'warn');
      return 'skip';
    }
    if (act.kind === 'homework') {
      log(`作业需手动提交，跳过：${act.title}`, 'warn');
      return 'skip';
    }
    if (act.kind === 'forum' && !cfg.visitForum) {
      log(`讨论区已跳过：${act.title}`, 'dim');
      return 'skip';
    }

    log(`处理：${activityLabel(act)}`);
    setCurrent(act, '打开页面…');

    const nav = await gotoActivity(act);
    if (nav === 'redirect') return 'redirect';
    if (nav === 'aborted') return state.running ? 'skipped' : 'stopped';

    await waitOrAbort(rand(500, 1200));
    if (!state.running || state.skipRequested) return 'skipped';

    if (act.kind === 'video') {
      return handleVideo(act, nav === 'missing');
    }

    setCurrent(act, '阅读中…');
    const readOk = await humanReadPage();
    if (!readOk || !state.running || state.skipRequested) return 'skipped';

    let read = await getRead(act.id, true);
    if (!read) {
      log('站点未自动标记，补一次已读', 'dim');
      try {
        updateRead(await postRead(act.id, {}));
      } catch (err) {
        log(`补已读失败：${err.message}`, 'warn');
      }
      read = await getRead(act.id, true);
    }

    if (act.kind === 'forum' && read) {
      if (read.completeness === 'full') {
        log('讨论区已完成 ✅', 'ok');
        return 'done';
      }
      log('讨论区已浏览（未发帖，平台可能显示“未参与”）', 'warn');
      return 'part';
    }

    if (isDone(read, act)) {
      log('已标记完成 ✅', 'ok');
      return 'done';
    }

    log('未确认完成状态，请在页面手动检查', 'warn');
    return 'unknown';
  }

  function currentActivityTitle() {
    const el =
      document.querySelector('.activity-content-box .activity-title .title') ||
      document.querySelector('.activity-content-box .activity-title');
    return el ? el.textContent.trim() : '';
  }

  function hardNavigate(url) {
    if (location.href === url) location.reload();
    else location.href = url;
  }

  function hasReloadFlag(actId) {
    try {
      const raw = sessionStorage.getItem('lmsauto:reload');
      if (!raw) return false;
      const info = JSON.parse(raw);
      if (Number(info.id) !== Number(actId)) return false;
      if (Date.now() - Number(info.ts) > 10 * 60 * 1000) return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  function setReloadFlag(actId) {
    try {
      sessionStorage.setItem('lmsauto:reload', JSON.stringify({ id: actId, ts: Date.now() }));
    } catch (err) {
      /* 忽略 */
    }
  }

  function clearReloadFlag() {
    try {
      sessionStorage.removeItem('lmsauto:reload');
    } catch (err) {
      /* 忽略 */
    }
  }

  async function gotoActivity(act) {
    if (!isFullScreenPage()) {
      saveResume(act.id);
      log('正在跳转到全屏学习页…');
      state.running = false;
      setRunningUI();
      human.stopAmbient();
      hardNavigate(
        `${location.origin}/course/${state.cid}/learning-activity/full-screen#/${act.id}`
      );
      return 'redirect';
    }

    const target = `#/${act.id}`;
    if (location.hash !== target) location.hash = target;

    const ok = await waitFor(
      () =>
        matchTitle(currentActivityTitle(), act.title) ||
        !state.running ||
        state.skipRequested,
      20000,
      300
    );

    if (!state.running || state.skipRequested) return 'aborted';

    if (!ok) {
      if (hasReloadFlag(act.id)) {
        log(
          cfg.strategy === 'api'
            ? '页面切换超时，改用接口补齐'
            : '页面切换超时，该活动将跳过真实播放',
          'warn'
        );
        return 'missing';
      }
      setReloadFlag(act.id);
      saveResume(act.id);
      log('页面未切换成功，正在重新加载…', 'warn');
      state.running = false;
      setRunningUI();
      human.stopAmbient();
      hardNavigate(
        `${location.origin}/course/${state.cid}/learning-activity/full-screen#/${act.id}`
      );
      return 'redirect';
    }

    clearReloadFlag();
    try {
      window.scrollTo({ top: 0, behavior: 'auto' });
    } catch (err) {
      /* 忽略 */
    }
    return 'ok';
  }

  /* ============================== 视频播放 ============================== */

  async function handleVideo(act, locked) {
    if (cfg.strategy === 'api') {
      const duration = getDuration(act);
      if (duration > 0) {
        try {
          log('按接口补齐视频进度…', 'dim');
          const res = await postRead(act.id, {
            start: 0,
            end: Math.max(1, Math.floor(duration)),
          });
          if (isDone(res, act)) {
            log('视频进度已补齐（接口模式）', 'ok');
            return 'done';
          }
          log('接口未接受整段进度，切换为真实播放', 'warn');
        } catch (err) {
          log(`接口补进度失败：${err.message}，切换为真实播放`, 'warn');
        }
      }
    }

    if (locked) {
      log('页面没有真正切换到该视频，跳过真实播放以免播错视频', 'warn');
      return 'failed';
    }

    return playVideo(act);
  }

  function pickMedia() {
    const scoped = document.querySelector('.online-video-activity');
    const pool = scoped
      ? Array.from(scoped.querySelectorAll('video, audio'))
      : Array.from(document.querySelectorAll('video, audio'));
    if (!pool.length) return null;
    const visible = pool.filter((media) => {
      const rect = media.getBoundingClientRect();
      return rect.width > 40 && rect.height > 30;
    });
    return visible[0] || pool[0];
  }

  async function waitForMedia(timeout) {
    const start = Date.now();
    let nextClickAt = 8000;
    while (Date.now() - start < timeout && state.running && !state.skipRequested) {
      const media = pickMedia();
      if (media && (media.readyState >= 1 || (Number.isFinite(media.duration) && media.duration > 0))) {
        return media;
      }

      // 有些播放器需要先点一下才会挂载 <video>，模拟用户点开播放器
      if (!media && nextClickAt && Date.now() - start > nextClickAt) {
        nextClickAt = nextClickAt === 8000 ? 20000 : 0;
        const box = document.querySelector(
          '#vue-multi-player, .online-video-activity .video-player, .online-video-activity'
        );
        if (box) {
          try {
            box.click();
          } catch (err) {
            /* 忽略 */
          }
        }
      }

      await waitOrAbort(500);
    }
    if (!state.running || state.skipRequested) return null;
    return pickMedia();
  }

  async function tryPlay(media) {
    try {
      await media.play();
    } catch (err) {
      const button = document.querySelector(
        '.online-video-activity .vjs-big-play-button,' +
          '.online-video-activity [class*="play"],' +
          '.online-video-activity .prism-big-play-btn'
      );
      if (button) {
        try {
          button.click();
        } catch (clickErr) {
          /* 忽略 */
        }
      }
      await sleep(rand(600, 1100));
      try {
        await media.play();
      } catch (playErr) {
        log('浏览器拦截了自动播放，请先手动点一次播放', 'warn');
      }
    }
  }

  function enforcePlay(media) {
    if (!media) return;
    if (cfg.human && Date.now() < human.holdUntil) {
      if (!media.paused) {
        try {
          media.pause();
        } catch (err) {
          /* 忽略 */
        }
      }
      return;
    }
    if (cfg.human) {
      try {
        if (Math.abs(Number(media.playbackRate) - human.rate) > 0.01) {
          media.playbackRate = human.rate;
        }
      } catch (err) {
        /* 忽略 */
      }
    } else {
      try {
        if (Math.abs(media.playbackRate - cfg.speed) > 0.01) media.playbackRate = cfg.speed;
      } catch (err) {
        /* 忽略 */
      }
    }
    if (media.paused && !media.ended) media.play().catch(() => {});
  }

  async function waitDone(act, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const rec = await getRead(act.id, true);
      if (isDone(rec, act)) return true;
      await sleep(1500);
    }
    return false;
  }

  async function playVideo(act) {
    if (!state.running || state.skipRequested) return 'skipped';

    setCurrent(act, '等待播放器…');
    const media = await waitForMedia(60000);
    if (!state.running || state.skipRequested) return 'skipped';
    if (!media) {
      log('没有找到视频播放器（页面可能未解锁或加载失败）', 'err');
      return 'failed';
    }

    state.video = media;
    if (cfg.keepAwake) installStealth();

    // 像真人一样，先看一眼页面再开始播放
    await waitOrAbort(rand(800, 2400));
    if (!state.running || state.skipRequested) {
      state.video = null;
      return 'skipped';
    }

    media.muted = true;
    media.volume = 0;
    if (cfg.human) {
      media.playbackRate = clamp(cfg.speed, 1, 2);
      human.resetVideo();
    } else {
      media.playbackRate = cfg.speed;
    }
    await tryPlay(media);
    setCurrent(act, '播放中…');

    const duration =
      Number.isFinite(media.duration) && media.duration > 0
        ? media.duration
        : getDuration(act) || 0;
    const expected = duration ? (duration * 1000) / effectiveSpeed() : 15 * 60 * 1000;
    let deadline = Date.now() + Math.max(180000, Math.min(90 * 60 * 1000, expected * 1.6 + 180000));

    log(
      `开始播放：${duration ? fmtTime(duration) : '未知时长'}，` +
        `${effectiveSpeed()}x${cfg.human ? '（拟人波动）' : ''}`
    );

    let lastPoll = 0;
    let lastProgressAt = Date.now();
    let lastPct = -1;
    let selfReporting = false;
    let lastSelfReport = 0;
    let retried = false;

    while (state.running && !state.skipRequested && Date.now() < deadline) {
      if (state.paused) {
        try {
          media.pause();
        } catch (err) {
          /* 忽略 */
        }
        const pausedAt = Date.now();
        await sleep(400);
        // 用户暂停的时间不计入超时
        deadline += Date.now() - pausedAt;
        setCurrentSub('已暂停 · 点「继续」恢复');
        continue;
      }

      if (cfg.human) human.tick(media);
      enforcePlay(media);

      if (media.ended) {
        log('播放结束，等待站点结算…', 'dim');
        const done = await waitDone(act, 15000);
        if (done) {
          log('视频播放完成 ✅', 'ok');
          break;
        }

        // 视频确实播完了，如果站点没有记录进度，按实际观看区间补一次
        if (cfg.fallback && duration > 0) {
          try {
            const res = await postRead(act.id, {
              start: 0,
              end: Math.max(1, Math.ceil(duration)),
            });
            if (isDone(res, act)) {
              log('播放结束后兜底上报完成 ✅', 'ok');
              break;
            }
          } catch (err) {
            /* 忽略，后面再重试一段 */
          }
        }

        if (!retried && duration > 0) {
          retried = true;
          log('进度未达标，重播最后一段补齐', 'warn');
          try {
            media.currentTime = Math.max(0, duration * 0.7);
            await tryPlay(media);
          } catch (err) {
            /* 忽略 */
          }
          continue;
        }
        break;
      }

      const now = Date.now();
      if (now - lastPoll > 3000) {
        lastPoll = now;
        const rec = await getRead(act.id);
        if (isDone(rec, act)) {
          log('视频观看达标 ✅', 'ok');
          break;
        }

        const pct = readPercent(rec);
        if (pct >= 0 && pct !== lastPct) {
          lastPct = pct;
          lastProgressAt = now;
        }

        const rate = Number(media.playbackRate) || effectiveSpeed();
        const pctText = pct >= 0 ? `${pct}%` : '播放中';
        setCurrentSub(
          `${rate.toFixed(2)}x · ${pctText} · 已看 ${fmtTime(media.currentTime)}` +
            (duration ? ` / ${fmtTime(duration)}` : '')
        );

        if (
          cfg.fallback &&
          !selfReporting &&
          now - lastProgressAt > 90000 &&
          media.currentTime > 5
        ) {
          selfReporting = true;
          log('长时间没有进度回报，启用兜底上报（区间来自实际播放位置）', 'warn');
        }
        if (selfReporting && now - lastSelfReport > 30000) {
          lastSelfReport = now;
          try {
            const res = await postRead(act.id, {
              start: 0,
              end: Math.ceil(media.currentTime),
            });
            if (isDone(res, act)) {
              log('兜底上报后进度达标 ✅', 'ok');
              break;
            }
          } catch (err) {
            /* 下一轮再试 */
          }
        }
      }

      await sleep(400);
    }

    const completed = isDone(state.reads.get(act.id), act);
    state.video = null;

    if (state.skipRequested) return 'skipped';
    if (!state.running) return 'stopped';
    if (completed) return 'done';

    log('视频未在限时内达标：播放器可能限制了倍速或需要手动确认', 'err');
    return 'failed';
  }

  /* ============================== 其他操作 ============================== */

  async function refreshCourse() {
    if (state.running || state.busy) {
      log('运行中不能刷新，请先停止', 'warn');
      return;
    }
    state.busy = true;
    setStartLabel('读取课程…', true);
    try {
      await loadCourse();
    } catch (err) {
      log(`刷新失败：${err.message}`, 'err');
      setStatus('err', '刷新失败');
    } finally {
      state.busy = false;
      if (!state.running) setStartLabel('开始学习', false);
    }
  }

  /* ============================== 调试入口 ============================== */

  try {
    window.__LMS_AUTO__ = {
      state,
      cfg,
      human,
      loadCourse,
      refreshReads,
      isDone,
      readPercent,
      estimateRemaining,
      matchTitle,
      startFlow,
      stopAll,
      skipCurrent,
      syncSettings,
      playVideo,
    };
  } catch (err) {
    /* 某些沙箱下 window 不可写 */
  }

  /* ============================== 初始化 ============================== */

  function init() {
    if (!isSupportedPage()) return;
    if (document.getElementById(PANEL_ID)) return;

    addStyle(CSS);
    injectPanel();

    state.cid = getCourseId();
    if (ui.course && !state.courseName) {
      ui.course.textContent = document.title.split(' - ')[0] || '识别课程中…';
    }

    if (cfg.keepAwake) installStealth();

    refreshProgress();
    setRunningUI();

    setInterval(tickUi, 1000);

    window.addEventListener('beforeunload', () => {
      if (!state.running) return;
      // 关闭/刷新时保存“当前活动”，下次从它继续（已完成的会自动跳过）
      saveResume(state.current ? state.current.id : nextActivityId());
    });

    maybeResume();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
