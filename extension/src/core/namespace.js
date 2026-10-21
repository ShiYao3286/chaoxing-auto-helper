/**
 * 内核命名空间
 *
 * 为什么用「挂全局对象」而不是 ESM：
 *   ① MV3 的 content script 必须是经典脚本（不能 import）
 *   ② background 的 importScripts() 也是经典脚本
 *   ③ 油猴脚本是单文件，没有模块系统
 *   三个宿主都是经典脚本环境，所以统一挂到 root.CSCore 上最省事，
 *   不需要引入打包器（这也让扩展保持「解压即加载」）。
 *
 * 加载顺序：本文件必须最先载入。
 */
(function (root) {
  'use strict';

  if (root.CSCore) return;   // 重复注入保护

  const CSCore = {
    /** 内核版本，跟 manifest 的 version 保持同一节奏 */
    VERSION: '1.4.0',

    /** 各子模块挂载点（config.js / prompt.js / api.js 往里填） */
    config: {},
    prompt: {},
    api: {},

    /** 调试日志：宿主可覆盖 */
    log: function () {}
  };

  root.CSCore = CSCore;
})(typeof globalThis !== 'undefined' ? globalThis : self);
