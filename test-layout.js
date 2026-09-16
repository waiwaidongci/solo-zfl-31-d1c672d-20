/* 响应式与可移植性静态回归：不依赖布局引擎，直接校验 index.html 内联 CSS 的关键约束。
   目标：窄屏台账表单不超出视口；桌面多列、手机单列；页签互斥规则在位。 */
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) { console.error("✗ 缺少 <style>"); process.exit(1); }
const css = styleMatch[1].replace(/\/\*[\s\S]*?\*\//g, ""); // 去注释

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error("✗ " + msg); } }

// 去掉 @media 块，仅在基础规则层按选择器取最后一条；media 内容单独用 media() 检查
const baseCss = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\}[^{}]*)*\}/g, "");
function rule(selectorText) {
  const norm = s => s.replace(/\s+/g, " ").trim();
  const reG = /([^{}]+)\{([^{}]*)\}/g;
  let m, out = null;
  while ((m = reG.exec(baseCss))) {
    if (m[1].split(",").some(part => norm(part) === norm(selectorText))) out = m[2];
  }
  return out;
}
// 取整条选择器列表（如 "input, select, textarea"）合并后的声明体
function ruleList(selectorText) {
  const norm = s => s.replace(/\s+/g, " ").trim();
  const reG = /([^{}]+)\{([^{}]*)\}/g;
  let m, out = null;
  while ((m = reG.exec(baseCss))) {
    if (norm(m[1]) === norm(selectorText)) out = m[2];
  }
  return out;
}
function media(maxWidth) {
  const m = css.match(new RegExp("@media\\s*\\(max-width:\\s*" + maxWidth + "px\\)\\s*\\{([\\s\\S]*)\\}\\s*(?=@|$)"));
  return m ? m[1] : "";
}

/* 页签互斥规则在位 */
ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css), "[hidden] 强制 display:none!important，保证页签互斥");
/* 必须有响应式 viewport，否则手机上媒体查询不生效 */
ok(/<meta[^>]*name=["']viewport["'][^>]*width=device-width/.test(html), "包含 width=device-width 的 viewport 元标签");

/* 桌面多列布局的列轨必须可收缩（不能用固定 300px 之类的硬性下限把窄屏撑破） */
const ledger = rule(".ledger");
ok(ledger && /grid-template-columns:[^;]*minmax\(\s*0\s*,/.test(ledger), ".ledger 列轨使用 minmax(0,…) 可收缩（无 300px 硬下限）");
ok(!/minmax\(\s*[1-9]\d*px/.test(ledger || ""), ".ledger 不存在正像素最小列宽");
ok(/grid-template-columns:[^;]*minmax\(\s*0\s*,\s*420px\)\s+minmax\(\s*0\s*,\s*1fr\s*\)/.test(ledger), "桌面台账为两列（左表单 + 右台账）");
const app = rule(".app");
ok(app && /minmax\(\s*0\s*,\s*1fr\s*\)/.test(app), ".app 中间列 minmax(0,1fr) 可收缩");
ok(/280px\s+minmax\(\s*0\s*,\s*1fr\s*\)\s+320px/.test(app), "桌面编辑区为三列（左控制 + 中画布 + 右统计）");
ok(!!rule(".panel") && /min-width:\s*0/.test(rule(".panel")), ".panel min-width:0");
ok(!!rule(".ledger > div") && /min-width:\s*0/.test(rule(".ledger > div")), ".ledger 直接子列 min-width:0");
ok(/min-width:\s*0/.test(ruleList("input, select, textarea") || ""), "表单控件 min-width:0");
const kv = rule(".kv");
ok(kv && /minmax\(\s*0\s*,\s*1fr\s*\)/.test(kv), ".kv 详情栅格列可收缩，长许可链不撑破");
ok(/overflow-wrap:\s*anywhere/.test(rule(".kv > *") || ""), ".kv 长串（许可链/登记号）可换行");

/* 横向溢出兜底与表格内部滚动（属性可分布在多条 .tablewrap 规则中） */
ok(/overflow-x:\s*hidden/.test(css), "页面 overflow-x:hidden 兜底");
const twRules = css.match(/\.tablewrap[^{]*\{[^}]*\}/g) || [];
const twAll = twRules.join("");
ok(/max-width:\s*100%/.test(twAll) && /overflow-x:\s*auto/.test(twAll), ".tablewrap 限宽(max-width:100%)并内部横向滚动(overflow-x:auto)");

/* ≤1000px：编辑区与台账都堆叠为单列 */
const m1000 = media(1000);
ok(/\.app[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(m1000) ||
   /\.app,\s*\.ledger[^{]*\{[^}]*grid-template-columns:\s*1fr/.test(m1000), "≤1000px 主栅格堆叠单列");

/* ≤640px 手机：表单单列（双列表单是窄屏横向溢出主因） */
const m640 = media(640);
ok(/\.formrow[^{]*\{[^}]*grid-template-columns:\s*1fr/.test(m640), "≤640px .formrow 单列，表单不横向溢出");
ok(/\.app,\s*\.ledger|\.app[^{]*\{[^}]*1fr/.test(m640) || m640.includes("1fr"), "≤640px 栅格保持单列");
ok(/padding/.test(m640), "≤640px 收紧外边距");

/* 可移植性：测试不依赖临时目录绝对路径，依赖由 package.json 声明 */
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
ok(pkg.devDependencies && pkg.devDependencies.jsdom, "package.json 声明 jsdom 依赖");
ok(/node test-ledger\.js && node test-dom\.js/.test(pkg.scripts.test), "npm test 串联两套测试");
const domTest = fs.readFileSync(path.join(__dirname, "test-dom.js"), "utf8");
ok(!/require\(["']\/(tmp|var|root)\//.test(domTest), "test-dom.js 不引用临时目录绝对路径（可换机运行）");
ok(/require\(["']jsdom["']\)/.test(domTest), "test-dom.js 通过包名 require('jsdom')");

console.log(`\n响应式/可移植性：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
