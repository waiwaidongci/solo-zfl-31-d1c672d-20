/* 从 index.html 提取纯逻辑 Core 并校验全部业务规则 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const start = html.indexOf("const Core = (() => {");
const endMark = "  })();\n\n  /* =========================================================";
const end = html.indexOf(endMark, start);
if (start < 0 || end < 0) throw new Error("无法定位 Core 代码块");
const coreSrc = html.slice(start, end) + "  })();";
const sandbox = { BigInt, Math, JSON, Number, String, Date, parseInt };
vm.createContext(sandbox);
const Core = vm.runInContext(coreSrc + "\nCore;", sandbox);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error("✗ " + msg); }
}
function throws(fn, re, msg) {
  try { fn(); } catch (e) { if (re.test(e.message)) { pass++; return; } fail++; console.error(`✗ ${msg}（错误信息不匹配：${e.message}）`); return; }
  fail++; console.error("✗ " + msg + "（应当抛错但没有）");
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`); }

/* ---------- 测试夹具 ---------- */
const NOW = "2026-09-16 09:00", TODAY = "2026-09-16";
function newLedger(today = TODAY) {
  return {
    registrations: [], licenses: [], fees: [], events: [],
    seq: { registration: {}, license: {}, event: 0 },
    _today: () => today, _now: () => NOW
  };
}
function runTx(ledger, fn) {
  const r = Core.transaction(ledger, fn);
  Object.assign(ledger, r.state, { _today: ledger._today, _now: ledger._now });
  return r.result;
}
const cellsA = Array(18 * 14).fill(0).map((_, i) => i % 3 === 0 ? 1 : 0);
const cellsB = Array(18 * 14).fill(0).map((_, i) => i % 5 === 0 ? 2 : 0);
const tiers = [{ min: 0, rate: 0.08 }, { min: 50000, rate: 0.10 }, { min: 200000, rate: 0.12 }];
function regInput(cells) {
  return { cols: 18, rows: 14, cells, owner: "甲合作社", series: "山水", createdAt: "2026-01-10", status: "正常" };
}
function licInput(regId, over = {}) {
  return Object.assign({
    registrationId: regId, licensee: "乙公司", officer: "专员张三",
    purpose: "服饰面料", territory: "中国大陆", channel: "电商平台",
    exclusive: "non", startDate: "2026-10-01", endDate: "2027-09-30",
    base: 100000, minimum: 20000, cycle: "3m", tiers
  }, over);
}

/* ---------- 1. 指纹确定性与唯一性 ---------- */
const fp1 = Core.fingerprint(18, 14, cellsA);
eq(Core.fingerprint(18, 14, cellsA), fp1, "同纹样指纹稳定");
ok(Core.fingerprint(18, 14, cellsB) !== fp1, "改动纹样指纹改变");
ok(/^[0-9A-Z]{10}$/.test(fp1), "指纹为 10 位大写 base36");

/* ---------- 2. 登记号与同指纹唯一 ---------- */
let L = newLedger();
const reg1 = runTx(L, d => Core.register(d, regInput(cellsA)));
ok(/^ZB2026-/.test(reg1.no), "登记号含年份前缀：" + reg1.no);
ok(reg1.no.includes(fp1), "登记号内嵌指纹：" + reg1.no);
throws(() => runTx(L, d => Core.register(d, regInput(cellsA))), /已登记/, "同指纹不能重复登记");
const reg2 = runTx(L, d => Core.register(d, Object.assign(regInput(cellsB), { owner: "丙工坊", series: "花鸟" })));
ok(reg1.no !== reg2.no, "不同指纹登记号不同");
throws(() => runTx(L, d => Core.register(d, Object.assign(regInput(cellsB), { owner: "" }))), /已登记/, "同指纹校验优先于字段校验");
const cellsC = Array(18 * 14).fill(0).map((_, i) => i % 7 === 0 ? 3 : 0);
throws(() => runTx(L, d => Core.register(d, Object.assign(regInput(cellsC), { owner: "" }))), /不完整/, "登记字段校验");

/* 非正常状态不能签发 */
runTx(L, d => Core.changeRegStatus(d, reg2.id, "权属争议"));
throws(() => runTx(L, d => Core.issueLicense(d, licInput(reg2.id))), /权属争议/, "权属争议的登记不能签发");

/* ---------- 3. 阶梯费率 + 保底 + 结算周期 ---------- */
// 基数 100000：50000*8% + 50000*10% = 9000；保底 20000 取高 → 20000
let f = Core.computeFee({ base: 100000, minimum: 20000, tiers, cycle: "3m", startDate: "2026-10-01", endDate: "2027-09-30" });
eq(f.tieredAmount, 9000, "边际阶梯费 9000");
eq(f.totalAmount, 20000, "保底生效取 20000");
eq(f.cycleCount, 4, "一年季结共 4 期");
eq(Math.round(f.schedule.reduce((a, s) => a + s.amount, 0) * 100), 2000000, "分期合计=应收合计");
eq(f.perCycleAmount, 5000, "每期 5000");
eq(f.schedule[0].dueDate, "2026-12-31", "首期季末结算日");
eq(f.schedule[3].dueDate, "2027-09-30", "末期结算日不超过终止日");

// 基数 300000：50000*8% + 150000*10% + 100000*12% = 31000；保底 20000 → 31000
f = Core.computeFee({ base: 300000, minimum: 20000, tiers, cycle: "1m", startDate: "2026-10-01", endDate: "2027-09-30" });
eq(f.tieredAmount, 31000, "跨三档边际费 31000");
eq(f.totalAmount, 31000, "高于保底取阶梯费");
eq(f.cycleCount, 12, "一年月结共 12 期");
eq(Math.round(f.schedule.reduce((a, s) => a + s.amount, 0) * 100), 3100000, "12 期合计精确");
// 不足整档周期时的零头区间
f = Core.computeFee({ base: 100000, minimum: 20000, tiers, cycle: "6m", startDate: "2026-10-01", endDate: "2027-03-15" });
eq(f.cycleCount, 1, "整体落在一个半年周期内 → 1 期");
eq(f.schedule[0].periodEnd, "2027-03-15", "末期截止于终止日");
f = Core.computeFee({ base: 100000, minimum: 20000, tiers, cycle: "6m", startDate: "2026-10-01", endDate: "2027-09-30" });
eq(f.cycleCount, 2, "满一年半年结 → 2 期");

ok(/首档下限必须为 0/.test(Core.validateTiers([{ min: 100, rate: 0.1 }])), "费率首档须为 0");
ok(/递增/.test(Core.validateTiers([{ min: 0, rate: 0.1 }, { min: 0, rate: 0.2 }])), "下限不可重复");
ok(/0 到 1/.test(Core.validateTiers([{ min: 0, rate: 1.5 }])), "费率越界");
ok(Core.validateTiers(tiers) === null, "合法费率档通过");

/* ---------- 4. 排他冲突 / 重复签发 ---------- */
L = newLedger();
const R = runTx(L, d => Core.register(d, regInput(cellsA)));
const x1 = runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "exc", licensee: "乙公司" }))).license;
// 同范围日期重叠的其它有效许可（无论普通/排他）→ 排他冲突
throws(() => runTx(L, d => Core.issueLicense(d, licInput(R.id, { licensee: "丁公司" }))), /排他冲突/, "排他期内同范围不得再发普通许可");
throws(() => runTx(L, d => Core.issueLicense(d, licInput(R.id, { licensee: "丁公司", exclusive: "exc" }))), /排他冲突/, "排他不得重叠");
// 不同范围（渠道不同）可以签
runTx(L, d => Core.issueLicense(d, licInput(R.id, { licensee: "丁公司", exclusive: "exc", channel: "线下实体" })));
ok(true, "不同渠道可并行排他");
// 同范围普通许可：不同被授权方可以，相同被授权方重复签发不行
L = newLedger();
runTx(L, d => Core.register(d, regInput(cellsA)));
runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "non", licensee: "乙公司" })));
runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "non", licensee: "戊公司" })));
ok(true, "普通许可可对不同被授权方同范围签发");
throws(() => runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "non", licensee: "乙公司" }))), /重复签发/, "同方同范围重叠期重复签发被拒");
// 日期不重叠可再签给同方
runTx(L, d => Core.issueLicense(d, licInput(R.id, { licensee: "乙公司", startDate: "2028-01-01", endDate: "2028-12-31" })));
ok(true, "日期不重叠可再签");
// 拟签排他时，同范围已有普通有效许可也冲突
throws(() => runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "exc", licensee: "庚公司" }))), /排他冲突/, "新排他遇已有普通许可冲突");

/* ---------- 5. 过期 / 撤销不占冲突、不可使用 ---------- */
L = newLedger();
runTx(L, d => Core.register(d, regInput(cellsA)));
runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "exc", startDate: "2025-01-01", endDate: "2025-12-31" })));
// 当前 2026-09-16，旧排他已过期，不影响新签发
const expired = L.licenses[0];
runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "exc", startDate: "2026-10-01", endDate: "2027-09-30" })));
let active2 = L.licenses[1];
ok(true, "过期许可不阻挡新许可");
eq(Core.licenseStatus(expired, TODAY), "已过期", "旧许可状态=已过期");
ok(!Core.isUsable(expired, TODAY), "过期不可继续使用");
ok(Core.isUsable(active2, TODAY) === false, "未生效许可当前不可使用");
ok(Core.isUsable(active2, "2026-10-15") === true, "生效期内可使用");
runTx(L, d => Core.revokeLicense(d, active2.no, "违约转售"));
active2 = L.licenses.find(x => x.no === active2.no); // 事务提交后重新取引用
eq(Core.licenseStatus(active2, "2026-11-01"), "已撤销", "撤销状态");
ok(!Core.isUsable(active2, "2026-11-01"), "撤销后不可继续使用");
throws(() => runTx(L, d => Core.revokeLicense(d, active2.no, "x")), /已撤销/, "不能重复撤销");
// 撤销后同范围可新发排他
runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "exc", licensee: "辛公司", startDate: "2026-11-01", endDate: "2027-08-31" })));
ok(true, "撤销后同范围可重新签发");
// 撤销终止了未来结算期
const feeRev = L.fees.find(f => f.licenseNo === active2.no);
ok(feeRev.schedule.some(s => s.terminated), "撤销后后续结算期标记终止");
ok(feeRev.schedule.filter(s => s.dueDate <= TODAY).every(s => !s.terminated), "撤销日之前结算期保留");

/* ---------- 6. 续签前后关联且不得重叠 ---------- */
L = newLedger();
runTx(L, d => Core.register(d, regInput(cellsA)));
const parent = runTx(L, d => Core.issueLicense(d, licInput(R.id))).license;
// 续签起始早于原终止 → 拒绝
throws(() => runTx(L, d => Core.issueLicense(d,
  licInput(R.id, { renewParentNo: parent.no, startDate: "2027-09-01", endDate: "2028-08-31" }))), /不得与原许可重叠|必须晚于/, "续签重叠被拒");
// 正常续签
const child = runTx(L, d => Core.issueLicense(d,
  licInput(R.id, { renewParentNo: parent.no, startDate: "2027-10-01", endDate: "2028-09-30" }))).license;
eq(child.renewParentNo, parent.no, "新许可指回原许可");
eq(L.licenses.find(x => x.no === parent.no).renewChildNo, child.no, "原许可指向续签");
ok(L.events.some(e => e.type === "签发" && e.detail.includes("续签自 " + parent.no)), "流水记录续签关联");
// 同一原许可不能续签两次（即使日期不重叠）
throws(() => runTx(L, d => Core.issueLicense(d,
  licInput(R.id, { renewParentNo: parent.no, startDate: "2028-10-01", endDate: "2029-09-30" }))), /不能重复续签/, "原许可不可重复续签");
// 撤过的不能续签
L = newLedger();
runTx(L, d => Core.register(d, regInput(cellsA)));
const p2 = runTx(L, d => Core.issueLicense(d, licInput(R.id, { startDate: "2026-01-01", endDate: "2027-01-31" }))).license;
runTx(L, d => Core.revokeLicense(d, p2.no, "违约"));
throws(() => runTx(L, d => Core.issueLicense(d,
  licInput(R.id, { renewParentNo: p2.no, startDate: "2026-10-01", endDate: "2027-09-30" }))), /不能续签/, "已撤销不能续签");

/* ---------- 7. 签发失败原子性：不留半条许可/费用 ---------- */
L = newLedger();
runTx(L, d => Core.register(d, regInput(cellsA)));
const beforeL = L.licenses.length, beforeF = L.fees.length;
// 先发一个排他，再试图发同范围许可：必然冲突
runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "exc" })));
const licAfterOk = L.licenses.length, feeAfterOk = L.fees.length, eventsAfterOk = L.events.length;
throws(() => runTx(L, d => Core.issueLicense(d, licInput(R.id, { exclusive: "non", licensee: "别家" }))), /排他冲突/, "冲突签发抛错");
eq(L.licenses.length, licAfterOk, "失败后许可数不增加");
eq(L.fees.length, feeAfterOk, "失败后费用数不增加");
eq(L.events.length, eventsAfterOk, "失败后流水不增加");
// 费用计算前的字段校验也不留痕
throws(() => runTx(L, d => Core.issueLicense(d, licInput(R.id, { licensee: "" }))), /不能为空/, "字段校验失败");
eq(L.licenses.length, beforeL + 1, "字段失败同样不留许可");
eq(L.fees.length, beforeF + 1, "字段失败同样不留费用");

/* ---------- 8. 项目文件校验 / 重开还原（往返） ---------- */
L = newLedger();
runTx(L, d => Core.register(d, regInput(cellsA)));
runTx(L, d => Core.issueLicense(d, licInput(R.id)));
const savedReg = L.registrations[0];
const project = {
  app: "brocade-pattern-ledger", version: 2,
  pattern: { cols: 18, rows: 14, cells: cellsA, fingerprint: Core.fingerprint(18, 14, cellsA) },
  ledger: { registrations: L.registrations, licenses: L.licenses, fees: L.fees, events: L.events, seq: L.seq }
};
ok(Core.validateProject(project) === true, "合法项目通过校验");
// 篡改登记快照 → 指纹不符
const tampered = JSON.parse(JSON.stringify(project));
tampered.ledger.registrations[0].snapshot.cells[0] = 7;
throws(() => Core.validateProject(tampered), /指纹不一致/, "快照被篡改可检出");
// 尺寸与格数不符
const badSize = JSON.parse(JSON.stringify(project)); badSize.pattern.cols = 19;
throws(() => Core.validateProject(badSize), /尺寸/, "格数尺寸不符可检出");
// 费用合计被改
const badFee = JSON.parse(JSON.stringify(project)); badFee.ledger.fees[0].totalAmount = 0.01;
throws(() => Core.validateProject(badFee), /分期合计/, "费用串改可检出");
// 缺登记的孤儿许可
const orphan = JSON.parse(JSON.stringify(project)); orphan.ledger.registrations = [];
throws(() => Core.validateProject(orphan), /缺少对应登记/, "孤儿许可可检出");
// 版本不符
throws(() => Core.validateProject(Object.assign({}, project, { version: 1 })), /版本/, "版本不符拒绝");
// JSON 往返（模拟关闭重开/导入导出）后所有关联完整
const roundtrip = JSON.parse(JSON.stringify(project));
Core.validateProject(roundtrip);
eq(roundtrip.ledger.licenses.length, 1, "重开后许可完整");
eq(roundtrip.ledger.fees.length, 1, "重开后费用完整");
eq(roundtrip.ledger.registrations[0].no, savedReg.no, "重开后登记号一致");
ok(roundtrip.ledger.fees[0].licenseNo === roundtrip.ledger.licenses[0].no, "重开后费用-许可关联完整");

/* ---------- 9. 自然周期切分：不产生单日尾期 ---------- */
function periodsOf(cycle, s, e, minimum = 0) {
  return Core.computeFee({ base: 120000, minimum, tiers, cycle, startDate: s, endDate: e });
}
const ANN_S = "2026-09-16", ANN_E = "2027-09-16";
const mFee = periodsOf("1m", ANN_S, ANN_E);
eq(mFee.cycleCount, 12, "月结周年区间恰为 12 期（无单日尾期）");
eq(mFee.schedule[11].periodStart, "2027-08-16", "末期起始为 2027-08-16");
eq(mFee.schedule[11].periodEnd, "2027-09-16", "末期收尾于周年日 2027-09-16");
ok(mFee.schedule.every(s => s.periodStart < s.periodEnd), "不存在单日尾期（每期起<止）");
eq(Math.round(mFee.schedule.reduce((a, s) => a + s.amount, 0) * 100), mFee.totalAmount * 100, "12 期金额合计仍等于应收");

const qFee = periodsOf("3m", ANN_S, ANN_E);
eq(qFee.cycleCount, 4, "季结周年区间恰为 4 期（原会多出一个单日尾期）");
ok(qFee.schedule.every(s => s.periodStart < s.periodEnd), "季结无单日尾期");
eq(periodsOf("6m", ANN_S, ANN_E).cycleCount, 2, "半年结周年区间恰为 2 期");
eq(periodsOf("12m", ANN_S, ANN_E).cycleCount, 1, "年结周年区间恰为 1 期");
// 终止日落在周期起点的其它对齐场景
const feeMonthAligned = periodsOf("1m", "2026-01-01", "2026-04-01");
eq(feeMonthAligned.cycleCount, 3, "01-01 至 04-01 月结为 3 期（不是 4 期）");
eq(feeMonthAligned.schedule[2].periodEnd, "2026-04-01", "末期止于 04-01");
// 不跨期边界：整体落在一个周期内，只 1 期，不凭空切分
const within = periodsOf("1m", "2026-09-16", "2026-09-20");
eq(within.cycleCount, 1, "周期内短区间只 1 期");
eq(within.schedule[0].periodStart, "2026-09-16", "短区间不跨期：起");
eq(within.schedule[0].periodEnd, "2026-09-20", "短区间不跨期：止");
const qWithin = periodsOf("3m", "2026-09-16", "2026-10-01");
eq(qWithin.cycleCount, 1, "季结下未跨满一季只 1 期");
// 起止同日（单日授权）合法地为 1 期，而不是 0 期或 2 期
const oneDay = periodsOf("1m", "2026-09-16", "2026-09-16");
eq(oneDay.cycleCount, 1, "单日授权为 1 期");
// 保底高于阶梯费时，合计仍一致
const minFee = periodsOf("1m", ANN_S, ANN_E, 90000);
eq(minFee.totalAmount, 90000, "保底取高 90000");
eq(Math.round(minFee.schedule.reduce((a, s) => a + s.amount, 0) * 100), 9000000, "保底场景各期合计一致");

/* ---------- 9b. 月末起始：按目标月自然月末收尾，覆盖长月/短月/闰年 ---------- */
// addMonths 短月钳制，不再溢出到次月
eq(Core.addMonths("2026-01-31", 1), "2026-02-28", "1/31 +1 月钳到 2/28（非闰年）");
eq(Core.addMonths("2026-01-31", 2), "2026-03-31", "1/31 +2 月 = 3/31");
eq(Core.addMonths("2024-01-31", 1), "2024-02-29", "闰年 1/31 +1 月 = 2/29");
eq(Core.addMonths("2026-03-31", 1), "2026-04-30", "3/31 +1 月钳到 4/30");
eq(Core.addMonths("2026-05-31", 1), "2026-06-30", "5/31 +1 月钳到 6/30");
eq(Core.addMonths("2026-12-31", 1), "2027-01-31", "12/31 +1 月跨年 = 1/31");

function monthEndCase(label, s, e) {
  const f = periodsOf("1m", s, e);
  eq(f.cycleCount, 12, label + "：月结周年 12 期");
  eq(f.schedule[0].periodStart, s, label + "：首期起于起始日 " + s);
  const firstExpectedEnd = Core.monthEndOf(Core.addMonths(s, 1));
  eq(f.schedule[0].periodEnd, firstExpectedEnd, label + "：首期止于目标月末 " + firstExpectedEnd + "（不溢出到次月）");
  eq(f.schedule[11].periodEnd, e, label + "：末期止于周年日 " + e);
  ok(f.schedule.every(x => x.periodStart < x.periodEnd), label + "：无单日尾期");
  // 除首期外，每期均为自然整月：起始=1 日、终止=该月最后一天
  for (let k = 1; k < f.schedule.length; k++) {
    const p = f.schedule[k];
    eq(p.periodStart.slice(8, 10), "01", label + "：第" + (k + 1) + "期起于 1 日");
    eq(p.periodEnd, Core.monthEndOf(p.periodStart), label + "：第" + (k + 1) + "期止于自然月末");
  }
  eq(Math.round(f.schedule.reduce((a, x) => a + x.amount, 0) * 100), f.totalAmount * 100, label + "：12 期金额合计一致");
  eq(Core.addDays(f.schedule[0].periodEnd, 1), f.schedule[1].periodStart, label + "：首期次日衔接次期初");
}
monthEndCase("长月31日", "2026-01-31", "2027-01-31");
monthEndCase("短月前31日", "2026-03-31", "2027-03-31");
monthEndCase("五月31日", "2026-05-31", "2027-05-31");
monthEndCase("八月31日", "2026-08-31", "2027-08-31");
monthEndCase("十月31日", "2026-10-31", "2027-10-31");
// 起始即 2 月最后一天（非闰年 28 日）：首期短月，其余整月
{
  const f = periodsOf("1m", "2026-02-28", "2027-02-28");
  eq(f.cycleCount, 12, "2/28 起始周年 12 期");
  eq(f.schedule[0].periodEnd, "2026-03-31", "首期 2/28~3/31 按目标月末");
  eq(f.schedule[11].periodEnd, "2027-02-28", "末期止于 2/28");
  eq(Math.round(f.schedule.reduce((a, x) => a + x.amount, 0) * 100), f.totalAmount * 100, "2/28 场景金额合计一致");
}
// 闰年 2/29 起始
{
  const f = periodsOf("1m", "2024-02-29", "2025-02-28");
  eq(f.cycleCount, 12, "闰年 2/29 起一年 12 期（次年 2 月仅 28 天）");
  eq(f.schedule[0].periodEnd, "2024-03-31", "首期止于 3/31");
  eq(f.schedule[11].periodEnd, "2025-02-28", "末期止于次年 2/28");
  ok(Math.abs(f.schedule.reduce((a, x) => a + x.amount, 0) - f.totalAmount) < 0.001, "闰年场景金额合计一致");
}
// 月末起始 + 季结/半年结/年结的期数仍与周年一致
eq(periodsOf("3m", "2026-01-31", "2027-01-31").cycleCount, 4, "31日起季结 4 期");
eq(periodsOf("6m", "2026-01-31", "2027-01-31").cycleCount, 2, "31日起半年结 2 期");
eq(periodsOf("12m", "2026-01-31", "2027-01-31").cycleCount, 1, "31日起年结 1 期");
{
  const q = periodsOf("3m", "2026-01-31", "2027-01-31");
  eq(q.schedule[0].periodEnd, "2026-04-30", "31日起季结首期止于 4/30");
  eq(q.schedule[3].periodEnd, "2027-01-31", "31日起季结末期止于周年日");
}

/* ---------- 10. 导入：登记标识 / 登记号 / 指纹唯一，许可标识唯一 ---------- */
L = newLedger();
runTx(L, d => Core.register(d, regInput(cellsA)));
runTx(L, d => Core.register(d, Object.assign(regInput(cellsB), { owner: "丙工坊", series: "花鸟" })));
const idA = L.registrations[0].id, idB = L.registrations[1].id;
runTx(L, d => Core.issueLicense(d, licInput(idA, { licensee: "司一" })));
runTx(L, d => Core.issueLicense(d, licInput(idB, { licensee: "司二", channel: "批发经销" })));
function projectOf(ledger) {
  return {
    app: "brocade-pattern-ledger", version: 2,
    pattern: { cols: 18, rows: 14, cells: cellsA, fingerprint: Core.fingerprint(18, 14, cellsA) },
    ledger: { registrations: ledger.registrations, licenses: ledger.licenses, fees: ledger.fees, events: ledger.events, seq: ledger.seq }
  };
}
ok(Core.validateProject(projectOf(L)) === true, "两条不同指纹登记合法通过");
// 同一指纹 + 两个不同登记号 → 拒绝
const dupFp = JSON.parse(JSON.stringify(projectOf(L)));
dupFp.ledger.registrations[1].fingerprint = dupFp.ledger.registrations[0].fingerprint;
dupFp.ledger.registrations[1].snapshot = JSON.parse(JSON.stringify(dupFp.ledger.registrations[0].snapshot));
dupFp.ledger.registrations[1].no = "ZB2026-OTHER1-0009";
dupFp.ledger.registrations[1].id = "R0009";
throws(() => Core.validateProject(dupFp), /指纹重复/, "不同登记号绑定同一指纹被拒");
// 登记标识 id 重复
const dupId = JSON.parse(JSON.stringify(projectOf(L)));
dupId.ledger.registrations[1].id = dupId.ledger.registrations[0].id;
throws(() => Core.validateProject(dupId), /登记标识重复/, "登记标识重复被拒");
// 登记号 no 重复（id 与指纹不同）
const dupNo = JSON.parse(JSON.stringify(projectOf(L)));
dupNo.ledger.registrations[1].no = dupNo.ledger.registrations[0].no;
throws(() => Core.validateProject(dupNo), /登记号重复/, "登记号重复被拒");
// 许可标识 id 重复（许可号不同）
const dupLicId = JSON.parse(JSON.stringify(projectOf(L)));
dupLicId.ledger.licenses[1].id = dupLicId.ledger.licenses[0].id;
throws(() => Core.validateProject(dupLicId), /许可标识重复/, "许可标识重复被拒");

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
