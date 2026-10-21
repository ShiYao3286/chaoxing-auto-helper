/**
 * UI · 设计令牌
 *
 * 结构借鉴大学搜题酱（12px 卡片圆角 / 左标签右控件 / Element 开关 / 32px 按钮），
 * 但配色、渐变、语义色是自有的一套，不复用它的 CSS/图标/类名。
 *
 * 三个产物共用这一份令牌：
 *   ① 悬浮面板（扩展 + 脚本）
 *   ② 脚本设置弹窗
 *   ③ 扩展设置页
 *
 * 加载顺序：在 core/ 之后、ui/panel.js 之前。
 */
(function (root) {
  'use strict';

  if (root.CSTheme) return;

  const THEME = {
    color: {
      primary: '#2d6cdf',        // 主色（搜题酱用 #2655fe）
      primaryDark: '#255bbd',    // 主色 hover
      primaryLight: '#4b8bf5',   // 渐变亮端（它用 #009bfb）

      ink: '#141414',            // 主文字
      ink2: '#626466',           // 次文字 / 标签
      ink3: '#8b949e',           // 更弱（提示）

      line: '#f0f1f3',           // 边框 / 分隔（它用更淡的 #f5f5f5）
      lineStrong: '#e1e5ea',     // 虚线分隔
      hover: '#f7f8fa',          // 悬停底色
      disabled: '#b9babd',       // 禁用
      switchOff: '#dcdfe6',      // 开关关态

      // 语义色：搜题酱整个面板只用蓝色，我们保留绿橙灰，一屏能分清进度
      ok: '#2da44e',
      okBg: '#e9f7ee',
      warn: '#b26a00',
      warnBg: '#fff5e6',
      off: '#8b949e',
      offBg: '#f5f5f5',

      danger: '#e5484d',
      dangerDark: '#cf3c41',

      brandBg: '#f3f5f8',        // 中性标签底色
      white: '#ffffff',

      /* 消息条配色（设置弹窗与设置页共用，避免各处硬编码） */
      msgOkFg: '#17603a',
      msgOkBg: '#e9f7ee',
      msgErrFg: '#a41919',
      msgErrBg: '#fff0f0',
      msgInfoFg: '#1c4faa',
      msgInfoBg: '#eef4ff',
      msgWarnFg: '#8a5300'
    },

    /** 渐变（135°，搜题酱用 270°） */
    grad: {
      brand: 'linear-gradient(135deg,#4b8bf5 0%,#2d6cdf 100%)',
      bar: 'linear-gradient(90deg,#2d6cdf,#4b8bf5)'
    },

    radius: { card: 12, sm: 8, pill: 14, dot: '50%' },

    size: {
      panel: 300,
      btn: 32,
      btnHeight: 32,
      switchW: 40,
      switchH: 24,
      thumb: 20,
      barH: 4,
      qdot: 6
    },

    shadow: '0 8px 24px rgba(15,23,42,.10)',
    shadowStrong: '0 18px 48px rgba(15,23,42,.18)',

    font: '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
    fontSize: '14px',

    /** CSS 变量前缀，注入样式表时用 */
    varPrefix: '--cs-'
  };

  /**
   * 把令牌渲染成 CSS 变量块（面板和设置页共用）
   * @param {string} selector 作用域选择器，如 '#cs-panel'
   */
  function cssVars(selector) {
    const c = THEME.color;
    const lines = [
      selector + '{',
      '  --cs-primary:' + c.primary + ';',
      '  --cs-primary-dark:' + c.primaryDark + ';',
      '  --cs-primary-light:' + c.primaryLight + ';',
      '  --cs-ink:' + c.ink + ';',
      '  --cs-ink2:' + c.ink2 + ';',
      '  --cs-ink3:' + c.ink3 + ';',
      '  --cs-line:' + c.line + ';',
      '  --cs-line-strong:' + c.lineStrong + ';',
      '  --cs-hover:' + c.hover + ';',
      '  --cs-disabled:' + c.disabled + ';',
      '  --cs-switch-off:' + c.switchOff + ';',
      '  --cs-ok:' + c.ok + ';',
      '  --cs-ok-bg:' + c.okBg + ';',
      '  --cs-warn:' + c.warn + ';',
      '  --cs-warn-bg:' + c.warnBg + ';',
      '  --cs-off:' + c.off + ';',
      '  --cs-off-bg:' + c.offBg + ';',
      '  --cs-danger:' + c.danger + ';',
      '  --cs-danger-dark:' + c.dangerDark + ';',
      '  --cs-msg-ok-fg:' + c.msgOkFg + ';',
      '  --cs-msg-ok-bg:' + c.msgOkBg + ';',
      '  --cs-msg-err-fg:' + c.msgErrFg + ';',
      '  --cs-msg-err-bg:' + c.msgErrBg + ';',
      '  --cs-msg-info-fg:' + c.msgInfoFg + ';',
      '  --cs-msg-info-bg:' + c.msgInfoBg + ';',
      '  --cs-msg-warn-fg:' + c.msgWarnFg + ';',
      '  --cs-r-card:' + THEME.radius.card + 'px;',
      '  --cs-r-sm:' + THEME.radius.sm + 'px;',
      '  --cs-shadow:' + THEME.shadow + ';',
      '  --cs-font:' + THEME.font + ';',
      '}'
    ];
    return lines.join('\n');
  }

  root.CSTheme = THEME;
  root.CSTheme.cssVars = cssVars;
})(typeof globalThis !== 'undefined' ? globalThis : self);
