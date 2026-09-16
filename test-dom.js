/* 真实 DOM 冒烟测试：启动页面，走完整 编辑→登记→签发→冲突→撤销→保存→导出→重开/导入 链路 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("/tmp/node_modules/jsdom");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.error("✗ " + m); } }

const errors = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://localhost/",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.URL.createObjectURL = () => "blob:fake";
    window.URL.revokeObjectURL = () => {};
    window.Element.prototype.scrollIntoView = function () {};
    window.prompt = () => "测试撤销原因";
    window.alert = m => errors.push("alert:" + m);
    window.confirm = () => true;
    window.addEventListener("error", e => errors.push("window.error:" + e.message));
  }
});
const { window } = dom;
const document = window.document;
const $ = s => document.querySelector(s);

function setVal(sel, val, evt = "input") {
  const el = $(sel); el.value = val; el.dispatchEvent(new window.Event(evt, { bubbles: true }));
}
function click(sel) { $(sel).click(); }

/* ---- 0. 启动无报错 ---- */
ok(!errors.length, "页面启动无未捕获错误：" + errors.join(";"));
ok($("#grid").children.length === 18 * 14, "初始网格 252 格，实际 " + $("#grid").children.length);
ok($("#stats").children.length === 8, "用色统计 8 行");
ok(/^[0-9A-Z]{10}$/.test($("#editorFingerprint").textContent), "启动即显示指纹");
const fpBlank = $("#editorFingerprint").textContent;

/* ---- 0b. 页签互斥：始终只显示当前页签，切换后各自状态保留 ---- */
const isShown = el => !el.hidden && el.ownerDocument.defaultView.getComputedStyle(el).display !== "none";
ok(isShown($("#editorView")), "初始仅编辑区显示");
ok(!isShown($("#ledgerView")), "初始台账区隐藏（display 也必须为 none）");
click("#tabLedger");
ok(isShown($("#ledgerView")) && !isShown($("#editorView")), "切到台账：台账显示、编辑隐藏");
ok($("#tabLedger").classList.contains("active") && !$("#tabEditor").classList.contains("active"), "台账页签高亮");
// 在台账填一半，切走再切回，输入必须保留
setVal("#regOwner", "留存测试合作社", "input");
click("#tabEditor");
ok(isShown($("#editorView")) && !isShown($("#ledgerView")), "切回编辑：编辑显示、台账隐藏");
click("#tabLedger");
ok($("#regOwner").value === "留存测试合作社", "切回台账后已填字段状态保留");
$("#regOwner").value = "";
click("#tabEditor");

/* ---- 1. 编辑：点一个格子填色，撤销可回退，指纹随之变化 ---- */
$("#grid").children[0].dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
$("#grid").children[0].style.background = $("#grid").children[0].style.background; // noop
ok($("#editorFingerprint").textContent !== fpBlank, "填色后指纹改变");
ok(JSON.parse(window.localStorage.getItem("zfl31Pattern")).version === 2, "绘制即自动保存 v2");
click("#undoBtn");
ok($("#editorFingerprint").textContent === fpBlank, "撤销后纹样与指纹还原");
click("#redoBtn");
ok($("#editorFingerprint").textContent !== fpBlank, "重做再次填色");

/* ---- 2. 登记 ---- */
click("#tabLedger");
ok(!$("#ledgerView").hidden, "切换到台账页");
setVal("#regOwner", "甲织造合作社", "input");
setVal("#regSeries", "山水系列", "input");
click("#registerBtn");
ok($("#regTable tbody").children.length === 1, "登记出现 1 行");
ok(/完成|成功/.test($("#regMsg").textContent), "登记成功提示");
const regNo = $("#regTable tbody tr td").textContent;
ok(/^ZB2026-/.test(regNo), "登记号格式正确：" + regNo);
// 同指纹再登记必须被拒
click("#registerBtn");
ok(/已登记/.test($("#regMsg").textContent), "同指纹重复登记被拦截：" + $("#regMsg").textContent);
ok($("#regTable tbody").children.length === 1, "重复登记未新增行");

/* ---- 3. 签发 ---- */
setVal("#licLicensee", "乙服饰公司");
setVal("#licOfficer", "授权专员张三");
setVal("#licBase", "300000");
// 边界：默认一年区间按月结应恰为 12 期，无单日尾期（界面预览）
setVal("#licStart", "2026-09-16", "input");
setVal("#licEnd", "2027-09-16", "input");
setVal("#licCycle", "1m", "change");
ok(/× 12 期/.test($("#feePerCycle").value), "周年月结预览为 12 期：" + $("#feePerCycle").value);
ok(!/13 期/.test($("#feePerCycle").value), "不出现 13 期（无单日尾期）");
$("#issueBtn").click();
ok($("#licTable tbody").children.length === 1, "许可出现 1 行，实际 " + $("#licTable tbody").children.length);
ok($("#feeTable tbody").children.length === 1, "费用同步出现 1 行");
ok(/已签发/.test($("#licMsg").textContent), "签发成功提示");
const feeText = $("#feeTable tbody").textContent;
ok(/31,000\.00/.test(feeText), "阶梯费 31000 > 保底 20000，取 31000：" + feeText.replace(/\s+/g, " ").trim());
const firstLicNo = $("#licTable tbody tr .mono").textContent.trim();

/* ---- 4. 重复签发 / 排他冲突 ---- */
setVal("#licLicensee", "乙服饰公司"); // 同被授权方同范围
click("#issueBtn");
ok(/重复签发/.test($("#licMsg").textContent), "相同范围重复签发被拦截");
ok($("#licTable tbody").children.length === 1, "失败未留下许可，仍为 1 行");
ok($("#feeTable tbody").children.length === 1, "失败未留下费用，仍为 1 行");
setVal("#licLicensee", "丙公司");
setVal("#licExclusive", "exc", "change");
click("#issueBtn");
ok(/排他冲突/.test($("#licMsg").textContent), "同范围排他被已有普通许可拦截");
ok($("#licTable tbody").children.length === 1, "排他冲突未留痕");

/* ---- 5. 撤销：过期/撤销不可用 ---- */
// 第一个许可状态当前为“未生效”（起 2026-10-01，今天 2026-09-16），可以撤销
const revokeBtn = document.querySelector('[data-revoke="' + firstLicNo + '"]');
ok(revokeBtn && !revokeBtn.disabled, "撤销按钮可用");
revokeBtn.click();
ok(/已撤销/.test($("#licTable tbody").textContent), "表格显示已撤销");
ok(/不可继续使用/.test($("#licTable tbody").textContent), "标注不可继续使用");
ok($("#licTable tbody tr").classList.contains("dead"), "失效许可行置灰");
const feeRowAfter = $("#feeTable tbody").textContent;
ok(/已终止/.test($("#licDetail").textContent), "撤销终止后续结算期");
// 撤销后同范围排他可以新发
setVal("#licLicensee", "丁公司");
setVal("#licExclusive", "exc", "change");
click("#issueBtn");
ok($("#licTable tbody").children.length === 2, "撤销后同范围可重新排他签发，共 2 条");
ok(/已签发/.test($("#licMsg").textContent), "重新签发成功");

/* ---- 6. 续签链 ---- */
const secondNo = $("#licTable tbody tr:nth-child(2) .mono").textContent.trim();
document.querySelector('[data-renew="' + secondNo + '"]').click();
ok(!$("#renewBtn").hidden, "进入续签模式");
ok(/2027-/.test($("#licStart").value), "续签起始已自动顺延：" + $("#licStart").value);
click("#renewBtn");
ok($("#licTable tbody").children.length === 3, "续签生成第 3 条许可");
ok(/续自/.test($("#licTable tbody").textContent), "台账展示续签关联");
ok(/续签自/.test($("#eventLog").textContent), "流水保留续签记录");

/* ---- 7. 保存 + 关闭重开（全新窗口从 localStorage 自动还原） ---- */
click("#saveBtn");
const savedRaw = window.localStorage.getItem("zfl31Pattern");
const saved = JSON.parse(savedRaw);
ok(saved.pattern.cells.length === 252, "保存含纹样");
ok(saved.ledger.licenses.length === 3, "保存含 3 条许可");
ok(saved.ledger.fees.length === 3, "保存含 3 条费用");
ok(saved.ledger.registrations.length === 1, "保存含 1 条登记");
ok(saved.ledger.events.length >= 5, "保存含变更流水，实际 " + saved.ledger.events.length + " 条");

const dom2 = new JSDOM(html, {
  runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true,
  beforeParse(w) {
    w.URL.createObjectURL = () => "blob:x"; w.URL.revokeObjectURL = () => {};
    w.Element.prototype.scrollIntoView = function () {};
    w.localStorage.setItem("zfl31Pattern", savedRaw); // 脚本启动前预置存档
  }
});
const w2 = dom2.window, d2 = w2.document;
ok(d2.querySelector("#grid").children.length === 252, "重开后网格还原 252 格");
ok(d2.querySelector("#regTable tbody").children.length === 1, "重开后登记还原");
ok(d2.querySelector("#licTable tbody").children.length === 3, "重开后 3 条许可还原");
ok(d2.querySelector("#feeTable tbody").children.length === 3, "重开后 3 条费用还原");
ok(/续签自/.test(d2.querySelector("#eventLog").textContent), "重开后续签流水还原");
ok(/已撤销/.test(d2.querySelector("#licTable tbody").textContent), "重开后撤销状态还原");

/* ---- 8/9. 文件导入：用桩 FileReader 驱动真实 change 处理 ---- */
window.__nextFileText = "";
window.FileReader = class {
  readAsText() { const self = this; setTimeout(() => { self.result = window.__nextFileText; self.onload && self.onload(); }, 5); }
};
Object.defineProperty($("#importFile"), "files", { value: [{ name: "x.json" }], configurable: true });
function importText(txt) {
  window.__nextFileText = txt;
  $("#importFile").dispatchEvent(new window.Event("change", { bubbles: true }));
}

/* 坏文件 1：快照被篡改（指纹不符） */
const tampered = JSON.parse(savedRaw);
tampered.ledger.registrations[0].snapshot.cells[0] = 7;
/* 坏文件 2：两个不同登记号绑定同一指纹（唯一性缺陷回归） */
const dupFpFile = JSON.parse(savedRaw);
const r0 = dupFpFile.ledger.registrations[0];
const clone = JSON.parse(JSON.stringify(r0));
clone.id = "R9999"; clone.no = "ZB2026-DUPLICATE-9999"; // 登记号不同，但指纹/快照与 r0 相同
dupFpFile.ledger.registrations.push(clone);
/* 坏文件 3：JSON 无法解析 */
const gibberish = "{这不是合法JSON";

let alerted = "";
window.alert = m => { alerted = m; };
importText(JSON.stringify(tampered));

setTimeout(() => {
  ok(/导入失败|指纹不一致/.test(alerted), "损坏快照文件导入被拒：" + alerted);
  ok($("#regTable tbody").children.length === 1, "失败导入未改动登记（仍 1 条）");
  ok($("#licTable tbody").children.length === 3, "失败导入未改动许可（仍 3 条）");

  alerted = "";
  importText(JSON.stringify(dupFpFile));
  setTimeout(() => {
    ok(/指纹重复/.test(alerted), "同指纹多登记号文件被拒：" + alerted);
    ok($("#regTable tbody").children.length === 1, "同指纹文件未覆盖现有登记（仍 1 条）");
    ok($("#licTable tbody").children.length === 3, "同指纹文件未覆盖现有许可（仍 3 条）");

    alerted = "";
    importText(gibberish);
    setTimeout(() => {
      ok(/导入失败/.test(alerted), "非法 JSON 被拒：" + alerted);
      ok($("#regTable tbody").children.length === 1, "非法 JSON 未覆盖数据");

      /* 合法文件完整还原（当前数据与文件一致，再验证不报错且编辑仍可用） */
      alerted = "";
      importText(savedRaw);
      setTimeout(finish, 60);
    }, 60);
  }, 60);
}, 60);

function finish() {
  ok($("#regTable tbody").children.length === 1, "导入后登记完整");
  ok($("#licTable tbody").children.length === 3, "导入后 3 条许可完整");
  ok($("#feeTable tbody").children.length === 3, "导入后 3 条费用完整");
  ok(/续签自/.test($("#eventLog").textContent), "导入后续签流水完整");
  ok(/已撤销/.test($("#licTable tbody").textContent), "导入后撤销状态还原");
  ok($("#grid").children.length === 252, "导入后编辑画布仍可用");
  // 原有编辑能力在导入后仍工作
  const before = $("#editorFingerprint").textContent;
  click("#tabEditor");
  $("#grid").children[5].dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  ok($("#editorFingerprint").textContent !== before, "导入后仍可继续绘制");
  click("#undoBtn");
  ok($("#editorFingerprint").textContent === before, "导入后撤销仍可用");
  console.log(`\nDOM 冒烟：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
