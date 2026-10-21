// 检查 JS 文件括号平衡
//
// 注意：这是个**朴素**检查器，不是真正的 JS 解析器。
// 它必须能跳过正则字面量，否则 `/\/ananas\/modules\//` 里的 `//` 会被
// 当成行注释起点，把后面的括号全吞掉 → 假的"括号不匹配"。
// 权威校验仍是 `node --check`，这里只做辅助排查。
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const lines = src.split('\n');

let depth = 0;
let stack = [];
let inStr = false, strCh = '';
let inBlock = false;
// 跨行状态：正则可以跨行吗？JS 里不能，所以每行重置
let prevToken = '';   // 上一个有意义的字符，用来判断 '/' 是不是正则起点

// '/' 出现在这些字符之后时，按正则处理（而不是除号）
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '{', ';', '!', '&', '|', '?', '+', '-', '*', '%',
  '<', '>', '~', '^', ''
]);

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let j = 0;
  let inLineComment = false;
  prevToken = '';   // 每行开头等于表达式起始，视为可正则

  while (j < line.length) {
    const c = line[j], n = line[j + 1];

    if (inLineComment) { j++; continue; }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; j += 2; continue; }
      j++; continue;
    }
    if (inStr) {
      if (c === '\\') { j += 2; continue; }
      if (c === strCh) { inStr = false; }
      j++; continue;
    }
    if (c === '/' && n === '/') { inLineComment = true; j += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; j += 2; continue; }

    // 正则字面量：'/' 出现在表达式起始位置时，跳到配对的 '/'
    if (c === '/' && REGEX_PRECEDERS.has(prevToken)) {
      j++;
      let inClass = false;
      while (j < line.length) {
        const rc = line[j];
        if (rc === '\\') { j += 2; continue; }
        if (rc === '[') { inClass = true; j++; continue; }
        if (rc === ']') { inClass = false; j++; continue; }
        if (rc === '/' && !inClass) { j++; break; }
        j++;
      }
      // 跳过 flags
      while (j < line.length && /[a-z]/.test(line[j])) j++;
      prevToken = 'x';   // 正则结果算作操作数
      continue;
    }

    if (c === "'" || c === '"' || c === '`') { inStr = true; strCh = c; j++; continue; }

    if (c === '{' || c === '(' || c === '[') {
      depth++; stack.push({ c, line: i + 1 });
      prevToken = c;
    } else if (c === '}' || c === ')' || c === ']') {
      depth--;
      const open = stack.pop();
      if (depth < 0) {
        console.log('第 ' + (i + 1) + ' 行出现多余闭合: ' + c);
        break;
      }
      // 检查配对
      const pair = { '}': '{', ')': '(', ']': '[' }[c];
      if (open && open.c !== pair) {
        console.log('第 ' + (i + 1) + ' 行括号不匹配: 期望 ' + open.c + '（第' + open.line + '行） 实得 ' + c);
      }
      prevToken = c;
    } else if (!/\s/.test(c)) {
      prevToken = c;
    }
    j++;
  }
}

console.log('最终深度: ' + depth);
if (stack.length) {
  console.log('未闭合（共 ' + stack.length + ' 个），最内层:');
  stack.slice(-5).forEach(s => console.log('  第 ' + s.line + ' 行: ' + s.c));
}
