/**
 * 内核 · 提示词
 *
 * 零 chrome API，纯字符串常量。宿主与 UI 都可以读，用于展示/自定义。
 */
(function (root) {
  'use strict';

  const CSCore = root.CSCore;
  if (!CSCore) throw new Error('namespace.js 必须先加载');

  const BUILTIN_PROMPT = `你是思政课教师，正在完成《毛泽东思想和中国特色社会主义理论体系概论》的章节测验。

给定题目（JSON），请逐题作答。要求：
1. 严格依据马克思主义理论/毛泽东思想的学术共识，不要臆造。
2. 单选题返回一个字母；多选题返回全部正确字母（按字母顺序）；判断题返回 "对" 或 "错"；填空题按空顺序返回原文。
3. 只输出 JSON，不要解释、不要 markdown 围栏。

输出格式：
{"answers":[{"num":1,"type":"single","answer":["B"]},{"num":2,"type":"multi","answer":["A","C"]},{"num":4,"type":"fill","answer":["帝国主义"]},{"num":5,"type":"judge","answer":["错"]}]}

其中 type 取值：single / multi / fill / judge。`;

  const VISION_PROMPT = `你是阅卷老师，正在看一张学习通章节测验的截图。

请完成两件事：

【1】逐题作答
- 单选题返回一个字母
- 多选题返回全部正确字母
- 判断题返回 "对" 或 "错"
- 填空题按空顺序返回原文

【2】自评置信度（这一步很重要）
对每道题给出 confidence（0~1）：
- 1.0  = 题干清晰、确定答案
- 0.7  = 大致确定，但有干扰项
- 0.4  = 题干模糊、被遮挡、或文字识别不清
- 0.1  = 完全看不清，只能猜

只要有一题 confidence < 0.6，或截图里有看不清/被截断的内容，
把 uncertain 设为 true 并说明原因（放在 note 里）。

只输出 JSON，不要 markdown 围栏，不要解释。格式：

{"answers":[{"num":1,"type":"single","answer":["B"],"confidence":1.0}],
 "uncertain":false,
 "note":""}`;

  CSCore.prompt.BUILTIN_PROMPT = BUILTIN_PROMPT;
  CSCore.prompt.VISION_PROMPT = VISION_PROMPT;
})(typeof globalThis !== 'undefined' ? globalThis : self);
