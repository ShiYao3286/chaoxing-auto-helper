/**
 * 内核 · 默认配置与合并
 *
 * 零 chrome API：这里只有纯数据和纯函数。
 * 存取由宿主实现（扩展用 chrome.storage，脚本用 GM_setValue）。
 */
(function (root) {
  'use strict';

  const CSCore = root.CSCore;
  if (!CSCore) throw new Error('namespace.js 必须先加载');

  const DEFAULTS = {
    auto: {
      rate: 2.0,              // 视频倍速
      mute: true,             // 静音
      autoNext: true,         // 完成后自动下一节
      docAutoScroll: true,    // 文档/PPT 自动滚动
      docStep: 400,           // 单次滚动像素（兼容保留）
      docHumanLike: true,     // 拟人化滚动：1.5 秒一屏
      skipUnfinished: true,   // 任务点未完成时是否也跳下一节
      videoThreshold: 0.9,    // 视频完成门槛（页面明示 90%）
      videoWaitTimeout: 300,  // 视频最长等待秒数（超时跳过）
      minDwellSeconds: 5,     // 每节最低停留秒数（防刷太快）
      docInterval: 1200,      // 滚动间隔 ms
      loopInterval: 2500,     // 主循环间隔 ms
      antiPause: true,        // 防切屏暂停
      quizEnabled: true,      // 是否处理章节测验
      debug: true
    },
    quiz: {
      provider: 'openai',     // openai | custom
      endpoint: 'https://api.openai.com/v1/chat/completions',
      modelsUrl: '',          // 拉模型列表用，留空则从 endpoint 推导
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      extraHeaders: '',       // JSON 字符串，custom 模式追加请求头
      bodyTemplate: '',       // custom 模式：完整 body 模板，支持 {{prompt}} {{text}} {{model}}
      responsePath: '',       // custom 模式：响应中答案的 JSON 路径，如 data.answer
      autoFill: true,         // 自动把答案填进页面
      autoSubmit: false,      // 绝不默认自动提交
      prompt: '',             // 自定义提示词（留空用内置）
      modelList: []           // 上次拉取到的模型列表（缓存）
    },

    /* ---- 截图解题（视觉兜底）---- */
    vision: {
      enabled: true,          // 总开关
      mode: 'auto',           // auto | always | off
                              //   auto  : 脚本判断文本不可靠，或模型自评不确定时才截图
                              //   always: 每套题都先截图
                              //   off   : 从不截图
      useSameApi: true,       // 复用上面答题 API 的地址与 Key
      endpoint: '',           // 独立配置时使用
      apiKey: '',
      model: '',              // 视觉模型，如 gpt-4o / qwen-vl-max / glm-4v
      maxShots: 3,            // 最多截几张（长题目分屏）
      autoSubmitAfter: false  // 截图作答后是否自动提交（默认否）
    },

    ui: {
      collapsed: false,
      pos: null
    }
  };

  /** 深合并默认值（只合并一层，够用） */
  function mergeDefaults(saved) {
    const out = JSON.parse(JSON.stringify(DEFAULTS));
    if (!saved || typeof saved !== 'object') return out;
    for (const k of Object.keys(out)) {
      if (saved[k] && typeof saved[k] === 'object') Object.assign(out[k], saved[k]);
      else if (saved[k] !== undefined) out[k] = saved[k];
    }
    return out;
  }

  CSCore.config.DEFAULTS = DEFAULTS;
  CSCore.config.mergeDefaults = mergeDefaults;
})(typeof globalThis !== 'undefined' ? globalThis : self);
