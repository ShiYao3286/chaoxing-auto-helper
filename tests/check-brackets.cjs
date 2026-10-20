// 检查 JS 文件括号平衡
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const lines = src.split('\n');

let depth = 0;
let stack = [];
let inStr = false, strCh = '';
let inBlock = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let j = 0;
  let inLineComment = false;

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
    if (c === "'" || c === '"' || c === '`') { inStr = true; strCh = c; j++; continue; }

    if (c === '{' || c === '(' || c === '[') {
      depth++; stack.push({ c, line: i + 1 });
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
    }
    j++;
  }
}

console.log('最终深度: ' + depth);
if (stack.length) {
  console.log('未闭合（共 ' + stack.length + ' 个），最内层:');
  stack.slice(-5).forEach(s => console.log('  第 ' + s.line + ' 行: ' + s.c));
}
