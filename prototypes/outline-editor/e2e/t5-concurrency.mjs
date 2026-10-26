// 验收 5：并发。两人同时改同一个块；一人移动另一人正在改的块；agent 同时写入同一页。
import { Item, open } from "./lib.mjs";

async function converged(t, it, name) {
	const a = await t.viewOutline("A");
	const b = await t.viewOutline("B");
	const ca = await t.clientOutline("A", "P1");
	const cb = await t.clientOutline("B", "P1");
	const s = await t.serverOutline("P1");
	const ok = a === b && ca === s && cb === s;
	it.check(name, ok, ok ? undefined : { a, b, ca, cb, s });
	return ok;
}

export async function run() {
	const it = new Item(5, "并发");
	const t = await open();
	const kb = t.page.keyboard;
	try {
		// 5a 两人同时改同一个块（同一位置 + 不同位置），网络都暂停，放开后收敛
		await t.hold("A", true);
		await t.hold("B", true);
		await t.focus("A", "P1b9", 0);
		await kb.type("甲");
		await t.focus("B", "P1b9", 0);
		await kb.type("乙");
		await t.focus("B", "P1b9", 5);
		await kb.type("丙");
		await t.focus("A", "P1b9", 3);
		await kb.type("丁");
		await t.hold("A", false);
		await t.hold("B", false);
		await t.idle();
		const s5a = await t.serverText("P1b9");
		it.check(
			"5a 每个人的字都在、各一次",
			["甲", "乙", "丙", "丁"].every((c) => s5a.split(c).length === 2) &&
				s5a.replace(/[甲乙丙丁]/g, "") === "最后一块",
			s5a,
		);
		await converged(t, it, "5a 三方收敛（两个编辑器 + 服务端）");

		// 5b 一人移动另一人正在改的块（Alt+↑），同时对方继续打字
		await t.focus("B", "P1b3", 3);
		await kb.type("x");
		await t.idle();
		await t.hold("A", true);
		await t.hold("B", true);
		await t.focus("A", "P1b3", 0);
		await kb.press("Alt+ArrowUp");
		await t.focus("B", "P1b3", 4);
		await kb.type("yz");
		await t.hold("A", false);
		await t.hold("B", false);
		await t.idle();
		const o5b = await t.serverOutline("P1");
		it.check("5b 块移到了前面", o5b.indexOf("第三块") < o5b.indexOf("块模型是真相"), o5b);
		it.eq("5b 对方的输入在块里", await t.serverText("P1b3"), "第三块xyz：拼接视图里也会出现");
		it.eq("5b 对方光标还在这个块的原处", (await t.selection("B"))?.head, {
			blockId: "P1b3",
			offset: 6,
		});
		await kb.type("!");
		await t.idle();
		it.eq(
			"5b 对方继续打字落在光标处",
			await t.serverText("P1b3"),
			"第三块xyz!：拼接视图里也会出现",
		);
		await converged(t, it, "5b 三方收敛");

		// 5c 一人缩进另一人正在改的块（Tab）
		await t.focus("B", "P1b9", 2);
		await t.hold("A", true);
		await t.focus("A", "P1b9", 0);
		await kb.press("Tab");
		await t.focus("B", "P1b9", 2);
		await kb.type("嗯");
		await t.hold("A", false);
		await t.idle();
		const o5c = await t.serverOutline("P1");
		it.check("5c 块被缩进到上一块下面", /- !\[\[P1\/P1b3\]\]\n {2}- /.test(o5c), o5c);
		it.eq("5c 对方光标还在这个块", (await t.selection("B"))?.head.blockId, "P1b9");
		await converged(t, it, "5c 三方收敛");

		// 5d 并发移动成环：服务端拒绝后写的那个，被拒的一方丢弃本页本地状态重新同步
		await t.hold("A", true);
		await t.hold("B", true);
		// Alice 把代码块拖到表格下面，Bob 同时把表格拖到代码块下面
		await t.ev(() => window.proto.move("A", "P1b4", "P1b6"));
		await t.ev(() => window.proto.move("B", "P1b6", "P1b4"));
		await t.hold("A", false);
		await t.idle();
		await t.hold("B", false);
		await t.idle();
		const rejects = await t.ev(() => window.proto.clients.B.stats.rejects);
		it.check("5d 成环的那个事务被拒绝", rejects >= 1, {
			rejects,
			log: await t.ev(() => window.proto.server.log),
		});
		await converged(t, it, "5d 被拒后重新同步，三方收敛");

		// 5e agent 同时写入同一页（按「读取时的快照」三方合并）
		const read = await t.ev(() => window.proto.agentRead("agent1", "P1"));
		const base = Object.fromEntries(read.blocks.map((b) => [b.id, b.content]));
		// 读取之后，两个人继续改
		await t.focus("A", "P1b9", 0);
		await kb.type("人");
		await t.focus("B", "P1b5", 4); // 引用块「> 引用：远端…」，在「远」前插入
		await kb.type("（B）");
		await t.focus("A", "P1b2", 0);
		await kb.press("Alt+ArrowDown"); // Alice 移动了 P1b2：版本变了
		await t.focus("A", "P1b9", 1);
		await t.idle();
		const res = await t.ev(
			([b]) =>
				window.proto.agentWrite("agent1", "P1", [
					{ t: "text", id: "P1b9", content: `${b.P1b9}（agent 补充）` },
					{ t: "text", id: "P1b5", content: b.P1b5.replace("远端修改", "其他人的修改") },
					{ t: "move", id: "P1b2", parentId: "P1", after: "P1b9" },
					{ t: "insert", parentId: "P1", after: "P1b9", content: "总结\n- 要点一\n- 要点二" },
					{ t: "text", id: "P1b6", content: b.P1b6.replace("拆块", "拆成两块") },
				]),
			[base],
		);
		await t.idle();
		it.eq("5e 不重叠的正文修改合并", await t.serverText("P1b9"), `人${base.P1b9}（agent 补充）`);
		const rej = res.rejected.map((r) => `${r.t}:${r.id}`);
		it.check(
			"5e 和别人修改重叠的正文被拒绝，返回当前内容",
			rej.includes("text:P1b5") &&
				res.rejected.find((r) => r.id === "P1b5")?.current?.includes("（B）"),
			res,
		);
		it.check("5e 读取之后被移动过的块，结构修改被拒绝", rej.includes("move:P1b2"), res);
		it.check(
			"5e 方言外的列表拆成子块并在返回里说明",
			res.notes.some((n) => /列表拆成子块/.test(n)),
			res.notes,
		);
		it.check(
			"5e 没人打开过的块（表格）也写进去了",
			(await t.serverText("P1b6")).includes("拆成两块"),
			await t.serverText("P1b6"),
		);
		it.eq(
			"5e agent 的修改实时出现在 Alice 编辑器",
			await t.viewText("A", "P1b9"),
			`人${base.P1b9}（agent 补充）`.replace(/^\s+/, ""),
		);
		it.eq("5e Alice 的光标不受影响", (await t.selection("A"))?.head, {
			blockId: "P1b9",
			offset: 1,
		});
		const o5e = await t.viewOutline("B");
		it.check(
			"5e 新块和拆出的子块实时出现在 Bob 编辑器",
			o5e.includes("- 总结\n  - 要点一\n  - 要点二"),
			o5e,
		);
		await converged(t, it, "5e 三方收敛");

		// 5f 正在编辑的块被别人删除（设计要求提示「已被删除」并可一键恢复——原型未做提示，只验证不崩、能收敛）
		await t.focus("A", "P1b1", 2);
		await kb.type("Q");
		await t.ev(() => window.proto.deleteBlock("B", "P1b1"));
		await t.idle();
		await kb.type("R");
		await t.idle();
		it.note(
			`5f 正在编辑的块被删：Alice 光标落到 ${JSON.stringify((await t.selection("A"))?.head)}，「已被删除」提示与一键恢复未实现`,
		);
		await converged(t, it, "5f 删除后三方收敛");

		it.check("页面没有报错（5a–5f）", t.errors.length === 0, t.errors);
	} catch (e) {
		it.check("测试脚本异常", false, String(e?.stack ?? e));
	} finally {
		await t.close();
	}

	// 5g 随机并发压力：两人随机打字 / 拆块 / 合并 / 缩进 / 移动 / 撤销 / 重做，网络随机暂停，agent 穿插写入
	let rejects = 0;
	for (const seed of [20261026, 7, 42]) {
		const s = await open();
		try {
			const ops = await s.ev(async (seed0) => {
				const p = window.proto;
				let seed = seed0;
				const r = () => {
					seed = (seed * 1103515245 + 12345) & 0x7fffffff;
					return seed / 0x7fffffff;
				};
				const log = [];
				const names = ["moveUp", "moveDown", "indent", "outdent", "split", "join"];
				for (let i = 0; i < 300; i++) {
					const who = r() < 0.5 ? "A" : "B";
					if (r() < 0.1) p.net.hold(who, !p.net.isHeld(who));
					const ids = p.blockIds(who).filter((id) => p.clients[who].visible.alive(id));
					if (!ids.length) continue;
					const id = ids[Math.floor(r() * ids.length)];
					const text = p.viewBlockText(who, id) ?? "";
					const x = r();
					try {
						if (x < 0.45) {
							const off = Math.floor(r() * (text.length + 1));
							p.insertVia(who, id, off, String.fromCharCode(0x4e00 + Math.floor(r() * 500)));
							log.push(`${who} type ${id}@${off}`);
						} else if (x < 0.85) {
							const n = names[Math.floor(r() * names.length)];
							p.cmd(who, n, id, n === "split" ? Math.floor(r() * (text.length + 1)) : 0);
							log.push(`${who} ${n} ${id}`);
						} else if (x < 0.93) {
							if (r() < 0.6) p.undo(who);
							else p.redo(who);
							log.push(`${who} undo/redo`);
						} else {
							const rd = p.agentRead("stress", "P1");
							const b = rd.blocks[Math.floor(r() * rd.blocks.length)];
							if (b)
								p.agentWrite("stress", "P1", [{ t: "text", id: b.id, content: `${b.content}·` }]);
							log.push(`agent ${b?.id}`);
						}
					} catch (e) {
						log.push(`ERR ${String(e?.stack ?? e)}`);
					}
					if (i % 25 === 0) await p.idle();
				}
				p.net.hold("A", false);
				p.net.hold("B", false);
				await p.idle();
				return log;
			}, seed);
			await s.idle();
			const errs = ops.filter((l) => l.startsWith("ERR"));
			it.check(`5g 种子 ${seed}：300 个随机操作没有异常`, errs.length === 0, errs.slice(0, 3));
			await converged(s, it, `5g 种子 ${seed}：随机并发后三方收敛`);
			it.check(`5g 种子 ${seed}：页面没有报错`, s.errors.length === 0, s.errors.slice(0, 3));
			rejects += await s.ev(
				() => window.proto.clients.A.stats.rejects + window.proto.clients.B.stats.rejects,
			);
		} finally {
			await s.close();
		}
	}
	it.metrics.rejectsDuringStress = rejects;
	return it;
}
