#!/usr/bin/env python3
"""大纲原型：用来在动手做正式系统之前，先拿真实工作试用 docs/OUTLINE_KNOWLEDGE-DESIGN.md 的模型。

- 真相源是 data/log.jsonl：只追加的提交日志。所有状态都由回放日志得到；时间机器就是
  「回放到第 N 个提交为止」。
- exports/ 下的 markdown 只是视图，由 `export` 生成，不要手改。
- data/.local/ 是本地缓存（读取记录、新鲜度检查结果），不入库。

只用标准库。用法见同目录 README.md，或运行 `python3 outline.py -h`。
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import functools
import hashlib
import json
import os
import re
import secrets
import shlex
import string
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("OUTLINE_DATA") or ROOT / "data")  # 测试时可以指向别处
LOG = DATA / "log.jsonl"
LOCK = DATA / "log.lock"
LOCAL = DATA / ".local"
EXPORTS = Path(os.environ.get("OUTLINE_EXPORTS") or ROOT / "exports")

KINDS = {"note", "task", "assertion", "view"}
KIND_ALIASES = {"assert": "assertion", "q": "task"}
STATUSES = ("todo", "doing", "blocked", "submitted", "done", "cancelled")
STANCES = ("hypothesis", "accepted", "refuted")
ROLES = (
	"mention",
	"embed",
	"based_on",
	"evidence",
	"supersedes",
	"blocked_by",
	"touches",
	"same_as",
	"source",
)
INLINE_ROLES = {"mention", "embed"}
KIND_ZH = {"note": "笔记", "task": "任务", "assertion": "断言", "view": "视图"}
STATUS_ZH = {
	"todo": "待办",
	"doing": "进行中",
	"blocked": "受阻",
	"submitted": "待验收",
	"done": "完成",
	"cancelled": "取消",
}
STANCE_ZH = {"hypothesis": "假设", "accepted": "采纳", "refuted": "否定"}
ROLE_ZH = {
	"mention": "提及",
	"embed": "嵌入",
	"based_on": "基于",
	"evidence": "证据",
	"supersedes": "取代",
	"blocked_by": "前置",
	"touches": "涉及",
	"same_as": "同一",
	"source": "出处",
}
# 已批准的计划里，改这些属性属于「推进」而不是「改计划」（§9.3）。
PROGRESS_PROPS = {"status", "owner", "blocked_reason", "no_evidence", "prev_status", "archived", "archived_seq"}
BIG_CHANGE = 50  # D1：单次改动超过这么多块，转成提议
DEFAULT_REF = "origin/main"
GIT_TIMEOUT = 15
GIT_MAX_BYTES = 8 * 1024 * 1024
SID_ALPHABET = string.ascii_letters + string.digits
INLINE_LINK = re.compile(r"(!?)\[\[([^\]\n]+)\]\]")


class OutlineError(Exception):
	pass


# ---------------------------------------------------------------------------
# 状态与回放


class State:
	def __init__(self) -> None:
		self.spaces: dict[str, dict] = {}
		self.actors: dict[str, dict] = {}
		self.blocks: dict[str, dict] = {}
		self.kids: dict[str, list[str]] = {}
		self.links: dict[str, dict] = {}
		self.approvals: dict[str, dict] = {}
		self.crs: dict[str, dict] = {}
		self.commits: list[dict] = []
		self.seq = 0

	# -- 结构查询 --

	def children(self, parent_key: str, include_deleted: bool = False) -> list[str]:
		addrs = self.kids.get(parent_key, [])
		out = [a for a in addrs if include_deleted or not self.blocks[a]["deleted"]]
		return sorted(out, key=lambda a: self.blocks[a]["order"])

	def parent_key(self, addr: str) -> str:
		b = self.blocks[addr]
		return b["parent"] or f"{b['space']}/"

	def ancestors(self, addr: str) -> list[str]:
		out = []
		cur = self.blocks[addr]["parent"]
		while cur:
			out.append(cur)
			cur = self.blocks[cur]["parent"]
		return out

	def subtree(self, addr: str) -> list[str]:
		out = [addr]
		for c in self.children(addr):
			out.extend(self.subtree(c))
		return out

	def page_of(self, addr: str) -> str:
		anc = self.ancestors(addr)
		return anc[-1] if anc else addr

	# -- 链接 --

	def links_from(self, addr: str, role: str | None = None) -> list[dict]:
		return [
			lk
			for lk in self.links.values()
			if lk["from"] == addr and not lk.get("removed") and (role is None or lk["role"] == role)
		]

	def links_to(self, addr: str, role: str | None = None) -> list[dict]:
		return [
			lk
			for lk in self.links.values()
			if lk["target"] == addr and not lk.get("removed") and (role is None or lk["role"] == role)
		]

	def superseded_by(self, addr: str) -> list[str]:
		out = []
		for lk in self.links_to(addr, "supersedes"):
			src = self.blocks.get(lk["from"])
			if src and not src["deleted"] and src["props"].get("stance") == "accepted":
				out.append(lk["from"])
		return out

	def has_evidence(self, addr: str) -> bool:
		return bool(self.links_from(addr, "evidence"))

	def is_archived(self, addr: str) -> bool:
		return any(self.blocks[a]["props"].get("archived") for a in [addr, *self.ancestors(addr)])

	# -- 人与责任 --

	def responsible(self, actor: str) -> str:
		"""责任人：沿创建链上溯到人（§9.4）。"""
		cur, seen = actor, set()
		while cur.startswith("agent:") and cur not in seen:
			seen.add(cur)
			cur = self.actors.get(cur, {}).get("creator") or "human:owner"
		return cur

	def team_root(self, actor: str) -> str:
		"""团队：根会话及其子代理视为同一个作者组（§8.2）。"""
		cur, seen = actor, set()
		while cur.startswith("agent:") and cur not in seen:
			seen.add(cur)
			creator = self.actors.get(cur, {}).get("creator", "")
			if not creator.startswith("agent:"):
				return cur
			cur = creator
		return cur

	# -- 计划 --

	def approval_for(self, addr: str) -> tuple[str, dict] | None:
		for a in [addr, *self.ancestors(addr)]:
			if a in self.approvals:
				return a, self.approvals[a]
		return None

	def pending_crs_for(self, addr: str) -> list[str]:
		out = []
		for cid, cr in self.crs.items():
			if cr["status"] != "pending":
				continue
			if any(op.get("addr") == addr or op.get("parent") == addr for op in cr["ops"]):
				out.append(cid)
		return out


def apply_op(st: State, op: dict, seq: int, actor: str) -> None:
	t = op["op"]
	if t == "space.create":
		st.spaces[op["space"]] = {k: op.get(k) for k in ("kind", "title", "owner")}
	elif t == "actor.register":
		st.actors[op["actor"]] = {k: op.get(k) for k in ("kind", "creator", "label", "mode")}
	elif t == "block.create":
		addr = op["addr"]
		st.blocks[addr] = {
			"addr": addr,
			"space": op["space"],
			"parent": op.get("parent"),
			"order": op["order"],
			"kind": op["kind"],
			"content": op.get("content", ""),
			"props": dict(op.get("props") or {}),
			"author": actor,
			"created_seq": seq,
			"version": seq,
			"updated_by": actor,
			"deleted": False,
		}
		st.kids.setdefault(st.parent_key(addr), []).append(addr)
	elif t == "block.update":
		b = st.blocks[op["addr"]]
		if "content" in op:
			b["content"] = op["content"]
		for k, v in (op.get("props") or {}).items():
			if v is None:
				b["props"].pop(k, None)
			else:
				b["props"][k] = v
		if "kind" in op:
			b["kind"] = op["kind"]
		b["version"], b["updated_by"] = seq, actor
	elif t == "block.move":
		addr = op["addr"]
		old = st.parent_key(addr)
		st.kids[old].remove(addr)
		b = st.blocks[addr]
		b["parent"], b["order"] = op.get("parent"), op["order"]
		st.kids.setdefault(st.parent_key(addr), []).append(addr)
		b["version"], b["updated_by"] = seq, actor
	elif t == "block.delete":
		b = st.blocks[op["addr"]]
		b["deleted"], b["version"], b["updated_by"] = True, seq, actor
	elif t == "block.restore":
		b = st.blocks[op["addr"]]
		b["deleted"], b["version"], b["updated_by"] = False, seq, actor
	elif t == "link.add":
		st.links[op["id"]] = {
			"id": op["id"],
			"from": op["from"],
			"role": op["role"],
			"target": op["target"],
			"data": dict(op.get("data") or {}),
			"created_seq": seq,
			"author": actor,
		}
	elif t == "link.remove":
		st.links[op["id"]]["removed"] = seq
	elif t == "plan.approve":
		st.approvals[op["root"]] = {
			"approver": op["approver"],
			"delegates": list(op.get("delegates") or []),
			"seq": seq,
			"skeleton": op["skeleton"],
		}
	elif t == "plan.release":
		st.approvals.pop(op["root"], None)
	elif t == "cr.create":
		st.crs[op["id"]] = {
			"id": op["id"],
			"kind": op["kind"],
			"reason": op.get("reason", ""),
			"ops": op["ops"],
			"decider": op["decider"],
			"requested_by": actor,
			"created_seq": seq,
			"status": "pending",
			"blocked_tasks": op.get("blocked_tasks", []),
		}
	elif t == "cr.decide":
		cr = st.crs[op["id"]]
		cr.update(status=op["status"], decided_by=actor, decided_seq=seq, note=op.get("note", ""))
	else:
		raise OutlineError(f"未知操作 {t}")


def load_state(as_of: int | None = None) -> State:
	st = State()
	if not LOG.exists():
		return st
	with LOG.open(encoding="utf-8") as f:
		for line in f:
			line = line.strip()
			if not line:
				continue
			c = json.loads(line)
			if as_of is not None and c["seq"] > as_of:
				break
			for op in c["ops"]:
				apply_op(st, op, c["seq"], c["actor"])
			st.commits.append(c)
			st.seq = c["seq"]
	return st


@contextlib.contextmanager
def locked():
	DATA.mkdir(parents=True, exist_ok=True)
	with LOCK.open("w") as fh:
		fcntl.flock(fh, fcntl.LOCK_EX)
		try:
			yield
		finally:
			fcntl.flock(fh, fcntl.LOCK_UN)


# ---------------------------------------------------------------------------
# 本地缓存：读取记录（agent 看快照，§7.5）与新鲜度


def _local(name: str) -> Path:
	LOCAL.mkdir(parents=True, exist_ok=True)
	return LOCAL / name


def load_json(path: Path, default):
	try:
		return json.loads(path.read_text(encoding="utf-8"))
	except (FileNotFoundError, json.JSONDecodeError):
		return default


def reads_path(actor: str) -> Path:
	return _local("reads-" + re.sub(r"[^A-Za-z0-9_.-]", "_", actor) + ".json")


def record_reads(actor: str, st: State, addrs) -> None:
	path = reads_path(actor)
	reads = load_json(path, {})
	for a in addrs:
		if a in st.blocks:
			reads[a] = st.blocks[a]["version"]
	path.write_text(json.dumps(reads, ensure_ascii=False), encoding="utf-8")


def fresh_cache() -> dict:
	return load_json(_local("fresh.json"), {})


# ---------------------------------------------------------------------------
# 事务：一个用户动作 = 一组操作 = 一个提交（§7.4）


class Tx:
	def __init__(self, st: State, actor: str, summary: str, kind: str = "edit") -> None:
		self.st, self.actor, self.summary, self.kind = st, actor, summary, kind
		self.seq = st.seq + 1
		self.ops: list[dict] = []
		self.notices: list[str] = []
		self.divert: list[tuple[str, dict]] = []  # (原因, 决定者)
		self.touched: set[str] = set()
		self.reads = load_json(reads_path(actor), {})
		self.force = False

	def push(self, op: dict) -> None:
		apply_op(self.st, op, self.seq, self.actor)
		self.ops.append(op)
		if op.get("addr"):
			self.touched.add(op["addr"])

	def link_id(self) -> str:
		return f"L{self.seq}-{sum(1 for o in self.ops if o['op'] == 'link.add') + 1}"

	def note(self, msg: str) -> None:
		self.notices.append(msg)


def is_agent(actor: str) -> bool:
	return actor.startswith("agent:")


def new_sid(st: State, space: str) -> str:
	while True:
		sid = "".join(secrets.choice(SID_ALPHABET) for _ in range(8))
		if f"{space}/{sid}" not in st.blocks:
			return sid


def resolve(st: State, ref: str, labels: dict | None = None) -> str:
	"""地址：`空间/短id`、`空间/别名`，或批量插入时的 `#标签`。"""
	ref = ref.strip()
	if labels is not None and ref.startswith("#"):
		if ref[1:] not in labels:
			raise OutlineError(f"未定义的标签 {ref}")
		return labels[ref[1:]]
	if "/" not in ref:
		ref = "p/" + ref
	if ref in st.blocks:
		return ref
	space, key = ref.split("/", 1)
	hits = [a for a, b in st.blocks.items() if b["space"] == space and b["props"].get("alias") == key]
	if len(hits) == 1:
		return hits[0]
	raise OutlineError(f"找不到块 {ref}")


def is_block_target(target: str) -> bool:
	return not re.match(r"^(code|grep|url|msg|chat|tool|commit|file|report|human|agent):", target)


def resolve_target(st: State, target: str, labels: dict | None = None) -> str:
	if target.startswith("#") or is_block_target(target):
		return resolve(st, target, labels)
	return target


def next_order(st: State, parent_key: str, after: str | None) -> float:
	sibs = st.children(parent_key, include_deleted=True)
	if not after:
		return (max((st.blocks[s]["order"] for s in sibs), default=0.0)) + 1.0
	if after not in sibs:
		raise OutlineError(f"{after} 不是同一父节点下的块")
	i = sibs.index(after)
	lo = st.blocks[after]["order"]
	hi = st.blocks[sibs[i + 1]]["order"] if i + 1 < len(sibs) else lo + 2.0
	return (lo + hi) / 2


def inline_targets(st: State, content: str, labels: dict | None = None) -> list[tuple[str, str]]:
	out = []
	for bang, ref in INLINE_LINK.findall(content):
		try:
			out.append(("embed" if bang else "mention", resolve(st, ref, labels)))
		except OutlineError:
			continue
	return out


def rewrite_labels(content: str, labels: dict) -> str:
	def sub(m):
		ref = m.group(2).strip()
		if ref.startswith("#") and ref[1:] in labels:
			return f"{m.group(1)}[[{labels[ref[1:]]}]]"
		return m.group(0)

	return INLINE_LINK.sub(sub, content)


def sync_inline_links(tx: Tx, addr: str) -> None:
	st = tx.st
	want = set(inline_targets(st, st.blocks[addr]["content"]))
	have = {(lk["role"], lk["target"]): lk for lk in st.links_from(addr) if lk["role"] in INLINE_ROLES}
	for key, lk in have.items():
		if key not in want:
			tx.push({"op": "link.remove", "id": lk["id"]})
	for role, target in sorted(want - set(have)):
		tx.push({"op": "link.add", "id": tx.link_id(), "from": addr, "role": role, "target": target})


# ---------------------------------------------------------------------------
# 规则：什么时候直写，什么时候转成提议或变更请求


def plan_change_reason(st: State, op: dict) -> tuple[str, str, dict] | None:
	"""这次操作是否在改一份已批准的计划（§9.3）。返回 (计划根, 原因, 批准记录)。"""
	t = op["op"]
	addr = op.get("addr")
	target = addr if t != "block.create" else op.get("parent")
	if not target or target not in st.blocks:
		return None
	found = st.approval_for(target)
	if not found:
		return None
	root, ap = found
	skel = ap["skeleton"]
	# 只有任务才算「步骤」：在已批准的计划里写笔记、断言是记录进展，不是改计划。
	is_step = (op.get("kind") if t == "block.create" else st.blocks[addr]["kind"]) == "task"
	if t == "block.create":
		parent = op.get("parent")
		if is_step and parent in skel and skel[parent]["had_steps"]:
			return root, "在已批准的步骤之间加新步骤", ap
		return None
	if t == "block.update":
		if addr not in skel:
			return None
		if "content" in op and op["content"] != st.blocks[addr]["content"]:
			return root, "改了已批准步骤的内容", ap
		for k, v in (op.get("props") or {}).items():
			if k == "status" and v == "cancelled":
				return root, "取消已批准的步骤", ap
			if k not in PROGRESS_PROPS:
				return root, f"改了已批准步骤的属性 {k}", ap
		return None
	if t == "block.move":
		if addr in skel:
			return root, "移动已批准的步骤", ap
		parent = op.get("parent")
		if is_step and parent in skel and skel[parent]["had_steps"]:
			return root, "把任务移进已批准的步骤之间", ap
		return None
	if t == "block.delete":
		return (root, "删除已批准的步骤", ap) if addr in skel else None
	return None


def is_contract(st: State, root: str, addr: str) -> bool:
	"""契约 = 计划根，以及根下面直接挂着的非任务块（目标、验收、范围）。"""
	b = st.blocks.get(addr)
	return addr == root or bool(b and b["parent"] == root and b["kind"] != "task")


def can_approve_plan_change(st: State, actor: str, root: str, ap: dict, touches_contract: bool) -> bool:
	if actor == ap["approver"]:
		return True
	if touches_contract:  # 目标和验收只有批准人能改
		return False
	return actor in ap["delegates"]


def check_policy(tx: Tx, op: dict) -> None:
	"""在操作生效前判断是否需要转成提议；需要时记到 tx.divert，事务结束时整体转换。"""
	st, actor = tx.st, tx.actor
	if tx.kind == "system":
		return
	addr = op.get("addr")
	space = op.get("space") or (st.blocks[addr]["space"] if addr in st.blocks else None)
	if space and st.spaces.get(space, {}).get("kind") == "personal" and is_agent(actor):
		owner = st.spaces[space].get("owner")
		tx.divert.append((f"agent 写入个人空间 {space}，要本人确认", {"kind": "human", "who": owner}))
		return
	reason = plan_change_reason(st, op)
	if reason:
		root, why, ap = reason
		# 只有批准人自己能直接改；获授权的 agent 也要走变更请求，由别人来批（不能自批）。
		if actor != ap["approver"]:
			tx.divert.append((f"{why}（计划 {root} 已批准）", {"kind": "plan", "root": root}))
		return
	if op["op"] in ("block.delete", "block.move") and addr in st.blocks:
		author = st.blocks[addr]["author"]
		if is_agent(actor) and st.team_root(author) != st.team_root(actor):
			tx.divert.append(
				(f"删除或移动团队之外写的块（作者 {author}）", {"kind": "human", "who": st.responsible(author)})
			)


def check_read(tx: Tx, addr: str) -> None:
	"""agent 按它读到的版本修改；别人在那之后改过就拒绝（§7.5）。"""
	st = tx.st
	b = st.blocks[addr]
	if tx.force or not is_agent(tx.actor):
		return
	seen = tx.reads.get(addr)
	if seen is None:
		tx.note(f"提示：{addr} 本会话没读过，这次修改没有并发保护")
		return
	if b["version"] > seen and b["updated_by"] != tx.actor:
		raise OutlineError(
			f"{addr} 在你读取之后被 {b['updated_by']} 改过（读到 #{seen}，现在 #{b['version']}）。"
			f"现在的内容：\n{b['content']}\n重新读取后再改，或加 --force。"
		)


def guarded(tx: Tx, op: dict) -> None:
	check_policy(tx, op)
	if tx.divert:
		tx.ops.append(op)  # 先记下，提交时整体转成提议
		return
	tx.push(op)


def finish(tx: Tx, quiet: bool = False) -> int | None:
	"""写入提交。需要别人决定的改动整体转成提议 / 变更请求，不打断 agent。"""
	if not tx.ops:
		for n in tx.notices:
			print(n)
		return None
	# 只数改动已有的块；一次新建很多块不碰别人的内容，不算大改动。
	changed = {
		o["addr"]
		for o in tx.ops
		if o["op"] in ("block.update", "block.move", "block.delete")
		and o["addr"] in tx.st.blocks
		and tx.st.blocks[o["addr"]]["created_seq"] < tx.seq
	}
	if is_agent(tx.actor) and len(changed) > BIG_CHANGE and not tx.divert and tx.kind != "system":
		tx.divert.append((f"单次改动 {len(changed)} 个块，超过 {BIG_CHANGE}", {"kind": "human", "who": tx.st.responsible(tx.actor)}))
	if tx.divert:
		fresh = load_state()
		cid = f"CR{len(fresh.crs) + 1}"
		reason, decider = tx.divert[0]
		kind = "change_request" if decider["kind"] == "plan" else "proposal"
		blocked = set()
		if kind == "change_request":
			# 新增步骤不影响已有步骤；只有改、移、删已有的块，才让它所在的任务停下等决定。
			targets = {o["addr"] for o in tx.ops if o["op"] in ("block.update", "block.move", "block.delete")}
			for a in sorted(t for t in targets if t in fresh.blocks):
				task = next((x for x in [a, *fresh.ancestors(a)] if fresh.blocks[x]["kind"] == "task"), None)
				if task and fresh.blocks[task]["props"].get("status") not in ("done", "cancelled", "blocked"):
					blocked.add(task)
		tx2 = Tx(fresh, tx.actor, f"{tx.summary}（转成 {cid}）", kind="system")
		ops = []
		for o in tx.ops:
			if o.get("addr") in fresh.blocks:
				base = tx2.seq if o["addr"] in blocked else fresh.blocks[o["addr"]]["version"]
				o = dict(o, base_version=base)
			ops.append(o)
		tx2.push({"op": "cr.create", "id": cid, "kind": kind, "reason": reason, "ops": ops, "decider": decider, "blocked_tasks": sorted(blocked)})
		for task in sorted(blocked):
			prev = fresh.blocks[task]["props"].get("status", "todo")
			tx2.push({"op": "block.update", "addr": task, "props": {"status": "blocked", "prev_status": prev, "blocked_reason": f"等待 {cid}"}})
		seq = write_commit(tx2)
		where = "变更请求" if kind == "change_request" else "提议"
		print(f"已转成{where} {cid}：{reason}。决定者：{describe_decider(fresh, decider)}。")
		if blocked:
			print(f"受影响的任务已标为受阻：{', '.join(sorted(set(blocked)))}。先做不受影响的部分。")
		return seq
	seq = write_commit(tx)
	record_reads(tx.actor, tx.st, tx.touched)
	if not quiet:
		for n in tx.notices:
			print(n)
	return seq


def write_commit(tx: Tx) -> int:
	commit = {
		"seq": tx.seq,
		"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
		"actor": tx.actor,
		"on_behalf_of": tx.st.responsible(tx.actor) if is_agent(tx.actor) else None,
		"kind": tx.kind,
		"summary": tx.summary,
		"ops": tx.ops,
	}
	recorder = os.environ.get("OUTLINE_RECORDED_BY")
	if recorder and recorder != tx.actor:
		commit["recorded_by"] = recorder  # 协调者替专注 agent 代记（§8.14）
	with LOG.open("a", encoding="utf-8") as f:
		f.write(json.dumps(commit, ensure_ascii=False) + "\n")
		f.flush()
		os.fsync(f.fileno())
	return tx.seq


def describe_decider(st: State, d: dict) -> str:
	if d["kind"] == "plan":
		ap = st.approvals.get(d["root"], {})
		extra = f"，或获授权的 {', '.join(ap['delegates'])}" if ap.get("delegates") else ""
		return f"计划 {d['root']} 的批准人 {ap.get('approver', '?')}{extra}"
	return d.get("who") or "?"


def can_decide(st: State, actor: str, cr: dict) -> bool:
	d = cr["decider"]
	if actor == cr["requested_by"]:
		return False  # 不能自批
	if d["kind"] == "plan":
		ap = st.approvals.get(d["root"])
		if not ap:
			return not is_agent(actor)
		touches = any(is_contract(st, d["root"], o.get("addr") or o.get("parent") or "") for o in cr["ops"])
		return can_approve_plan_change(st, actor, d["root"], ap, touches)
	return actor == d.get("who") or actor == "human:owner"


# ---------------------------------------------------------------------------
# 代码锚点与新鲜度（§5.3）


@functools.cache
def repo_root() -> Path:
	out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=GIT_TIMEOUT)
	return Path(out.stdout.strip())


def git(*args: str) -> str | None:
	try:
		out = subprocess.run(["git", "-C", str(repo_root()), *args], capture_output=True, timeout=GIT_TIMEOUT)
	except subprocess.TimeoutExpired:
		return None
	if out.returncode != 0 or len(out.stdout) > GIT_MAX_BYTES:
		return None
	return out.stdout.decode("utf-8", errors="replace")


def symbol_segment(text: str, symbol: str) -> str | None:
	lines = text.splitlines()
	name = re.escape(symbol)
	patterns = [
		re.compile(rf"^\s*(export\s+)?(default\s+)?(declare\s+)?(async\s+)?(function\*?|const|let|var|class|interface|type|enum)\s+{name}\b"),
		re.compile(rf"^\s*(public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(async\s+)?{name}\s*[(<]"),
	]
	start = next((i for p in patterns for i, ln in enumerate(lines) if p.search(ln)), None)
	if start is None:
		return None
	depth, opened = 0, False
	for i in range(start, len(lines)):
		for ch in lines[i]:
			if ch in "({[":
				depth, opened = depth + 1, True
			elif ch in ")}]":
				depth -= 1
		if (opened and depth <= 0) or (not opened and lines[i].rstrip().endswith(";")):
			return "\n".join(lines[start : i + 1])
	return "\n".join(lines[start:])


def fingerprint(target: str, ref: str) -> tuple[str | None, str]:
	"""返回 (指纹, 说明)。指纹为 None 表示锚点已失效（过期）。"""
	if target.startswith("code:"):
		path, _, symbol = target[5:].partition("#")
		text = git("show", f"{ref}:{path}")
		if text is None:
			return None, "文件不存在"
		seg = text if not symbol else symbol_segment(text, symbol)
		if seg is None:
			return None, f"找不到符号 {symbol}"
		norm = "\n".join(ln.strip() for ln in seg.splitlines() if ln.strip())
		return hashlib.sha1(norm.encode()).hexdigest()[:16], f"{len(seg.splitlines())} 行"
	if target.startswith("grep:"):
		pattern, _, pathspec = target[5:].rpartition("@") if "@" in target else (target[5:], "", "")
		args = ["grep", "-l", "-E", pattern, ref]
		if pathspec:
			args += ["--", pathspec]
		try:
			out = subprocess.run(["git", "-C", str(repo_root()), *args], capture_output=True, timeout=GIT_TIMEOUT)
		except subprocess.TimeoutExpired:
			return None, "git grep 超时"
		if out.returncode > 1:
			return None, "git grep 出错：" + out.stderr.decode(errors="replace").strip()[:200]
		files = sorted({ln.split(":", 1)[-1] for ln in out.stdout.decode(errors="replace").splitlines() if ln})
		return hashlib.sha1("\n".join(files).encode()).hexdigest()[:16], f"{len(files)} 个文件匹配"
	return None, "不是代码锚点"


def ref_commit(ref: str) -> str:
	return (git("rev-parse", "--short", ref) or "?").strip()


def freshness(st: State, addr: str) -> tuple[str, list[str]]:
	cache = fresh_cache()
	state, why = "fresh", []
	for lk in st.links_from(addr, "based_on"):
		if not re.match(r"^(code|grep):", lk["target"]):
			tgt = st.blocks.get(lk["target"])
			if tgt and (tgt["deleted"] or tgt["version"] > lk["created_seq"] and tgt["version"] > lk["data"].get("checked_seq", 0)):
				state = "suspect" if state == "fresh" else state
				why.append(f"{lk['target']} 在 #{tgt['version']} 改过")
			continue
		c = cache.get(lk["id"])
		if c and c["state"] != "fresh":
			if c["state"] == "expired":
				state = "expired"
			elif state == "fresh":
				state = "suspect"
			why.append(f"{lk['target']}：{c['why']}")
	return state, why


# ---------------------------------------------------------------------------
# 渲染


def first_line(text: str, limit: int = 0) -> str:
	line = text.split("\n", 1)[0]
	return line if not limit or len(line) <= limit else line[: limit - 1] + "…"


def badges(st: State, addr: str) -> list[str]:
	b = st.blocks[addr]
	p = b["props"]
	out = []
	if p.get("alias"):
		out.append(p["alias"])
	if b["kind"] != "note":
		out.append(KIND_ZH[b["kind"]])
	if b["kind"] == "task":
		out.append(STATUS_ZH.get(p.get("status", "todo"), p.get("status", "")))
		if p.get("owner"):
			out.append("执行：" + p["owner"])
		if p.get("status", "todo") in ("todo", "doing"):
			waiting = [lk["target"] for lk in st.links_from(addr, "blocked_by") if st.blocks.get(lk["target"], {}).get("props", {}).get("status") not in ("done", "cancelled")]
			if waiting:  # 等前置是推导出来的，不写进状态（§0 规则 2）
				out.append("等前置：" + ",".join(st.blocks[w]["props"].get("alias") or w for w in waiting))
		if p.get("blocked_reason") and p.get("status") == "blocked":
			out.append("等：" + p["blocked_reason"])
		if p.get("no_evidence") and p.get("status") == "done":
			out.append("无依据")
	if b["kind"] == "assertion":
		out.append(STANCE_ZH.get(p.get("stance", "hypothesis"), ""))
		sup = st.superseded_by(addr)
		if sup:
			out.append("已被取代：" + ",".join(sup))
		fs, _ = freshness(st, addr)
		if fs != "fresh":
			out.append({"suspect": "存疑", "expired": "过期"}[fs])
	if p.get("tags"):
		out.append("#" + " #".join(p["tags"]))
	if addr in st.approvals:
		ap = st.approvals[addr]
		out.append(f"已批准：{ap['approver']}@#{ap['seq']}")
	if p.get("archived"):
		out.append("归档")
	crs = st.pending_crs_for(addr)
	if crs:
		out.append("待决定：" + ",".join(crs))
	if b["deleted"]:
		out.append("已删除")
	return out


def render_block(st: State, addr: str, depth: int, indent: int = 0, links: bool = True, embeds: bool = False, seen=None) -> list[str]:
	seen = seen if seen is not None else set()
	b = st.blocks[addr]
	pad = "  " * indent
	bd = badges(st, addr)
	head, *rest = b["content"].split("\n") if b["content"] else [""]
	lines = [f"{pad}- [{addr}] {head}" + (f" ‹{'·'.join(bd)}›" if bd else "")]
	for r in rest:
		lines.append(f"{pad}  {r}")
	if links:
		by_role: dict[str, list[str]] = {}
		for lk in st.links_from(addr):
			if lk["role"] in INLINE_ROLES:
				continue
			label = lk["target"]
			if lk["data"].get("excerpt"):
				label += f"（{first_line(lk['data']['excerpt'], 60)}）"
			by_role.setdefault(ROLE_ZH[lk["role"]], []).append(label)
		for role, targets in by_role.items():
			lines.append(f"{pad}  ↳ {role}：" + "；".join(targets))
	seen.add(addr)
	if embeds:
		for role, target in inline_targets(st, b["content"]):
			if role == "embed" and target in st.blocks and target not in seen:
				lines.append(f"{pad}  ⧉ 嵌入 {target}：")
				lines.extend(render_block(st, target, 1, indent + 2, links, False, seen))
	if depth > 0:
		for c in st.children(addr):
			lines.extend(render_block(st, c, depth - 1, indent + 1, links, embeds, seen))
	elif st.children(addr):
		lines.append(f"{pad}  …（{len(st.children(addr))} 个子块未展开）")
	return lines


def shown(lines: list[str]) -> list[str]:
	return [m.group(1) for ln in lines if (m := re.search(r"- \[([^\]]+)\]", ln))]


# ---------------------------------------------------------------------------
# 批量插入：一段 markdown 大纲 → 多个块


ITEM_HEAD = re.compile(r"^\[(\w+)(?::(\w+))?\]\s*")
ITEM_PROPS = re.compile(r"\s*\{([^{}]*)\}\s*$")


def parse_outline(text: str) -> list[dict]:
	roots: list[dict] = []
	stack: list[dict] = []
	for raw in text.splitlines():
		if not raw.strip():
			continue
		expanded = raw.replace("\t", "  ")
		indent = len(expanded) - len(expanded.lstrip(" "))
		body = expanded.strip()
		if body.startswith("- "):
			item = parse_item(body[2:])
			item["indent"] = indent
			while stack and stack[-1]["indent"] >= indent:
				stack.pop()
			(stack[-1]["children"] if stack else roots).append(item)
			stack.append(item)
		else:
			if not stack:
				raise OutlineError(f"续行前面没有条目：{raw}")
			base = stack[-1]["indent"] + 2
			cont = expanded[base:] if len(expanded) - len(expanded.lstrip(" ")) >= base else body
			stack[-1]["content"] += "\n" + cont
	return roots


def parse_item(body: str) -> dict:
	item = {"kind": "note", "content": "", "props": {}, "links": [], "label": None, "children": []}
	m = ITEM_HEAD.match(body)
	if m:
		kind = KIND_ALIASES.get(m.group(1), m.group(1))
		if kind not in KINDS:
			raise OutlineError(f"未知类型 {m.group(1)}")
		item["kind"] = kind
		if m.group(2):
			item["props"]["status" if kind == "task" else "stance"] = m.group(2)
		body = body[m.end() :]
	pm = ITEM_PROPS.search(body)
	if pm:
		for tok in shlex.split(pm.group(1)):
			if tok.startswith("#"):
				item["label"] = tok[1:]
				continue
			k, _, v = tok.partition("=")
			if k in ROLES:
				item["links"].append((k, v))
			elif k == "tags":
				item["props"]["tags"] = [t for t in v.split(",") if t]
			else:
				item["props"][k] = v
		body = body[: pm.start()]
	item["content"] = body.strip()
	return item


def default_props(st: State, actor: str, kind: str, props: dict, links: list) -> tuple[dict, list[str]]:
	notes = []
	props = dict(props)
	if kind == "task":
		props.setdefault("status", "todo")
		props.setdefault("manager", actor)
		if props["status"] not in STATUSES:
			raise OutlineError(f"未知任务状态 {props['status']}")
	if kind == "assertion":
		stance = props.setdefault("stance", "hypothesis" if is_agent(actor) else "accepted")
		if stance not in STANCES:
			raise OutlineError(f"未知立场 {stance}")
		has_basis = any(r in ("evidence", "based_on") for r, _ in links)
		if stance == "accepted" and is_agent(actor) and not has_basis:
			props["stance"] = "hypothesis"
			notes.append("没有证据或基于，已记为「假设」（§5.4）")
	return props, notes


def create_items(tx: Tx, space: str, parent: str | None, items: list[dict], after: str | None = None) -> list[tuple[str, dict]]:
	st = tx.st
	labels: dict[str, str] = {}
	plan: list[tuple[dict, str, str | None]] = []

	def assign(its, par):
		for it in its:
			addr = f"{space}/{new_sid(st, space)}"
			while any(addr == a for _, a, _ in plan):
				addr = f"{space}/{new_sid(st, space)}"
			if it["label"]:
				labels[it["label"]] = addr
			plan.append((it, addr, par))
			assign(it["children"], addr)

	assign(items, parent)
	created = []
	first = True
	for it, addr, par in plan:
		props = dict(it["props"])
		if it["kind"] == "task" and "manager" not in props:
			# 管理者默认是创建者，子树继承（§8.4）
			up = next((x for x in ([par, *st.ancestors(par)] if par in st.blocks else []) if st.blocks[x]["props"].get("manager")), None)
			if up:
				props["manager"] = st.blocks[up]["props"]["manager"]
		props, notes = default_props(st, tx.actor, it["kind"], props, it["links"])
		for n in notes:
			tx.note(f"{addr}：{n}")
		pkey = par or f"{space}/"
		op = {
			"op": "block.create",
			"addr": addr,
			"space": space,
			"parent": par,
			"order": next_order(st, pkey, after if (first and par == parent) else None) if not tx.divert else 0.0,
			"kind": it["kind"],
			"content": rewrite_labels(it["content"], labels),
			"props": props,
		}
		first = False
		guarded(tx, op)
		created.append((addr, it))
	for it, addr, _ in plan:
		if not tx.divert:
			sync_inline_links(tx, addr)
		for role, target in it["links"]:
			add_link(tx, addr, role, resolve_target(st, target, labels))
	return created


def add_link(tx: Tx, frm: str, role: str, target: str, excerpt: str | None = None, ref: str = DEFAULT_REF) -> None:
	if role not in ROLES:
		raise OutlineError(f"未知链接角色 {role}（可用：{', '.join(ROLES)}）")
	data = {}
	if excerpt:
		data["excerpt"] = excerpt
	if role == "based_on" and re.match(r"^(code|grep):", target):
		fp, why = fingerprint(target, ref)
		if fp is None:
			raise OutlineError(f"锚点无效：{target}：{why}")
		data.update(fp=fp, ref=ref_commit(ref), what=why)
	if role == "blocked_by" and target in tx.st.blocks and frm in [target, *dependency_chain(tx.st, target)]:
		raise OutlineError("前置关系不能成环")
	op = {"op": "link.add", "id": tx.link_id(), "from": frm, "role": role, "target": target, "data": data}
	if tx.divert:
		tx.ops.append(op)  # 跟着整个事务进提议
	else:
		tx.push(op)


def dependency_chain(st: State, addr: str, seen=None) -> list[str]:
	seen = seen or set()
	out = []
	for lk in st.links_from(addr, "blocked_by"):
		t = lk["target"]
		if t not in seen:
			seen.add(t)
			out.append(t)
			out.extend(dependency_chain(st, t, seen))
	return out


# ---------------------------------------------------------------------------
# 命令


def actor_of(args) -> str:
	return args.actor or os.environ.get("OUTLINE_ACTOR") or "agent:main"


def cmd_init(args) -> None:
	with locked():
		st = load_state()
		if st.commits:
			raise OutlineError("已经初始化过了")
		tx = Tx(st, "human:owner", "初始化：空间与参与者", kind="system")
		tx.push({"op": "actor.register", "actor": "human:owner", "kind": "human", "label": "项目负责人"})
		tx.push({"op": "actor.register", "actor": "agent:main", "kind": "agent", "creator": "human:owner", "label": "主会话"})
		tx.push({"op": "space.create", "space": "p", "kind": "project", "title": "NarraFork", "owner": "human:owner"})
		tx.push({"op": "space.create", "space": "me", "kind": "personal", "title": "负责人的个人空间", "owner": "human:owner"})
		finish(tx)
	print("已初始化：项目空间 p、个人空间 me；参与者 human:owner、agent:main。")


def cmd_actor(args) -> None:
	with locked():
		st = load_state()
		if args.name in st.actors:
			raise OutlineError(f"{args.name} 已存在")
		if args.name.startswith("agent:") and not args.creator:
			raise OutlineError("agent 必须有创建者（--creator）")
		tx = Tx(st, actor_of(args), f"登记参与者 {args.name}", kind="system")
		tx.push({"op": "actor.register", "actor": args.name, "kind": "agent" if args.name.startswith("agent:") else "human", "creator": args.creator, "label": args.label, "mode": args.mode})
		finish(tx)
	print(f"已登记 {args.name}，责任人 {load_state().responsible(args.name)}")


def cmd_read(args) -> None:
	st = load_state(args.as_of)
	try:
		addr = resolve(st, args.addr)
	except OutlineError:
		if args.as_of is not None and args.addr in load_state().blocks:
			raise OutlineError(f"{args.addr} 在第 {args.as_of} 个提交时还不存在") from None
		raise
	lines = render_block(st, addr, args.depth, links=not args.no_links, embeds=args.embeds)
	anc = st.ancestors(addr)
	if anc:
		print("位置：" + " › ".join(first_line(st.blocks[a]["content"], 30) for a in reversed(anc)))
	if args.as_of is not None:
		print(f"（时间机器：第 {args.as_of} 个提交时的样子）")
	print("\n".join(lines))
	if args.as_of is None:
		record_reads(actor_of(args), st, shown(lines))


def cmd_pages(args) -> None:
	st = load_state(args.as_of)
	for space in [args.space] if args.space else list(st.spaces):
		sp = st.spaces.get(space)
		if not sp:
			raise OutlineError(f"没有空间 {space}")
		print(f"## {space} · {sp['title']}（{sp['kind']}）")
		for a in st.children(f"{space}/"):
			n = len(st.subtree(a)) - 1
			bd = badges(st, a)
			print(f"- [{a}] {first_line(st.blocks[a]['content'], 50)}" + (f" ‹{'·'.join(bd)}›" if bd else "") + f"（{n} 个子块）")


def cmd_add(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		if args.parent.endswith("/") or args.parent in st.spaces:
			space, parent = args.parent.rstrip("/"), None
			if space not in st.spaces:
				raise OutlineError(f"没有空间 {space}")
		else:
			parent = resolve(st, args.parent)
			space = st.blocks[parent]["space"]
		if args.md:
			text = sys.stdin.read() if args.md == "-" else Path(args.md).read_text(encoding="utf-8")
			items = parse_outline(text)
		else:
			if not args.text:
				raise OutlineError("要么给出文本，要么用 --md")
			item = parse_item(args.text)
			if args.kind:
				item["kind"] = KIND_ALIASES.get(args.kind, args.kind)
			for kv in args.prop or []:
				k, _, v = kv.partition("=")
				item["props"][k] = [t for t in v.split(",") if t] if k == "tags" else v
			if args.status:
				item["props"]["status"] = args.status
			if args.stance:
				item["props"]["stance"] = args.stance
			for lk in args.link or []:
				role, _, target = lk.partition("=")
				item["links"].append((role, target))
			items = [item]
		after = resolve(st, args.after) if args.after else None
		tx = Tx(st, actor, args.message or f"新增 {len(items)} 个条目")
		created = create_items(tx, space, parent, items, after)
		finish(tx)
	if not tx.divert:
		for addr, it in created:
			label = f" #{it['label']}" if it["label"] else ""
			print(f"+ [{addr}]{label} {first_line(tx.st.blocks[addr]['content'], 60)}")


def cmd_edit(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		tx = Tx(st, actor, args.message or f"修改 {addr}")
		tx.force = args.force
		check_read(tx, addr)
		guarded(tx, {"op": "block.update", "addr": addr, "content": args.text})
		if not tx.divert:
			sync_inline_links(tx, addr)
		finish(tx)
	if not tx.divert:
		print(f"已修改 {addr}")


def cmd_set(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		props = {}
		kind = None
		for kv in args.pairs:
			k, _, v = kv.partition("=")
			if k == "kind":
				kind = KIND_ALIASES.get(v, v)
				continue
			props[k] = None if v == "" else ([t for t in v.split(",") if t] if k == "tags" else v)
		tx = Tx(st, actor, args.message or f"设置 {addr} 的属性")
		tx.force = args.force
		check_read(tx, addr)
		op = {"op": "block.update", "addr": addr, "props": props}
		if kind:
			op["kind"] = kind
		guarded(tx, op)
		finish(tx)
	if not tx.divert:
		print(f"已设置 {addr}")


def cmd_mv(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		if args.parent.endswith("/"):
			parent = None
			pkey = args.parent
		else:
			parent = resolve(st, args.parent)
			pkey = parent
			if parent == addr or parent in st.subtree(addr):
				raise OutlineError("不能把块移到它自己的子树里")
			if st.blocks[parent]["space"] != st.blocks[addr]["space"]:
				raise OutlineError("块不跨空间；请复制并加「出处」链接（§2.4）")
		after = resolve(st, args.after) if args.after else None
		tx = Tx(st, actor, args.message or f"移动 {addr}")
		guarded(tx, {"op": "block.move", "addr": addr, "parent": parent, "order": next_order(st, pkey, after)})
		finish(tx)
	if not tx.divert:
		print(f"已移动 {addr}")


def cmd_rm(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		tx = Tx(st, actor, args.message or f"删除 {addr}")
		for a in reversed(st.subtree(addr)):
			guarded(tx, {"op": "block.delete", "addr": a})
		finish(tx)
	if not tx.divert:
		print(f"已删除 {addr}（时间机器里仍可见）")


def cmd_link(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		frm = resolve(st, args.frm)
		target = resolve_target(st, args.target)
		tx = Tx(st, actor, args.message or f"{frm} {ROLE_ZH.get(args.role, args.role)} {target}")
		add_link(tx, frm, args.role, target, args.excerpt, args.ref)
		finish(tx)
	print(f"已链接 {frm} —{ROLE_ZH[args.role]}→ {target}")


def cmd_unlink(args) -> None:
	with locked():
		st = load_state()
		if args.id not in st.links or st.links[args.id].get("removed"):
			raise OutlineError(f"没有链接 {args.id}")
		tx = Tx(st, actor_of(args), f"移除链接 {args.id}")
		tx.push({"op": "link.remove", "id": args.id})
		finish(tx)
	print(f"已移除 {args.id}")


def cmd_task(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		b = st.blocks[addr]
		if b["kind"] != "task":
			raise OutlineError(f"{addr} 不是任务")
		p = b["props"]
		status = p.get("status", "todo")
		tx = Tx(st, actor, args.message or f"任务 {args.action} {addr}")
		props: dict = {}
		action = args.action
		if action == "start":
			owner = p.get("owner")
			if owner and owner != actor and not args.steal:
				raise OutlineError(f"{addr} 已指派给 {owner}（{STATUS_ZH.get(status, status)}）；确实要接手就加 --steal")
			props = {"status": "doing", "owner": actor, "blocked_reason": None}
		elif action == "block":
			if not args.reason:
				raise OutlineError("受阻时写一句在等什么（--reason）")
			props = {"status": "blocked", "blocked_reason": args.reason}
		elif action in ("done", "submit"):
			for ev in args.evidence or []:
				add_link(tx, addr, "evidence", resolve_target(st, ev), args.excerpt)
			found = st.approval_for(addr)
			needs_accept = p.get("acceptance") == "required" and actor != p.get("manager")
			if found and found[0] == addr and actor != found[1]["approver"]:
				needs_accept = True
				tx.note(f"{addr} 是已批准的计划，完成要批准人 {found[1]['approver']} 确认（§9.3）")
			if action == "submit" or needs_accept:
				props = {"status": "submitted"}
			else:
				props = {"status": "done", "blocked_reason": None}
			open_kids = [
				a
				for a in st.subtree(addr)[1:]
				if st.blocks[a]["kind"] == "task" and not st.blocks[a]["deleted"] and st.blocks[a]["props"].get("status") in ("todo", "doing", "blocked")
			]
			if open_kids:
				tx.note(f"还有 {len(open_kids)} 个子任务没完成：{', '.join(open_kids[:5])}{'…' if len(open_kids) > 5 else ''}。结项时它们会成为遗留。")
			if b["author"] != actor and not st.has_evidence(addr) and not args.evidence:
				props["no_evidence"] = True
				tx.note(f"{addr} 没有依据，看板上会标「无依据」")
		elif action == "accept":
			if status != "submitted":
				raise OutlineError(f"{addr} 不在待验收状态")
			found = st.approval_for(addr)
			allowed = {p.get("manager")} | ({found[1]["approver"]} if found else set())
			if actor not in allowed:
				raise OutlineError(f"只有管理者或批准人能验收（{', '.join(sorted(a for a in allowed if a))}）")
			props = {"status": "done"}
		elif action == "revise":
			props = {"status": "todo"}
			if args.reason:
				create_items(tx, b["space"], addr, [parse_item(f"打回意见：{args.reason}")])
		elif action == "cancel":
			props = {"status": "cancelled", "blocked_reason": args.reason}
		elif action == "reopen":
			props = {"status": "todo", "no_evidence": None}
		guarded(tx, {"op": "block.update", "addr": addr, "props": props})
		finish(tx)
	if not tx.divert:
		print(f"{addr}：{STATUS_ZH.get(status, status)} → {STATUS_ZH.get(props.get('status', status), '')}")


def cmd_plan(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		root = resolve(st, args.root)
		tx = Tx(st, actor, args.message or f"计划 {args.action} {root}", kind="approve")
		if args.action == "approve":
			if is_agent(actor) and st.blocks[root]["props"].get("manager") != actor:
				raise OutlineError("agent 只能批准自己管理的计划（§9.4）")
			outer = st.approval_for(st.blocks[root]["parent"]) if st.blocks[root]["parent"] else None
			if outer and is_agent(actor):
				raise OutlineError(f"它在已批准的计划 {outer[0]} 里面，由那份计划的批准人决定")
			skeleton = {}
			for a in st.subtree(root):
				blk = st.blocks[a]
				skeleton[a] = {
					"had_steps": any(st.blocks[c]["kind"] == "task" for c in st.children(a)),
					"content": hashlib.sha1(blk["content"].encode()).hexdigest()[:12],
				}
			delegates = args.delegate or []
			tx.push({"op": "plan.approve", "root": root, "approver": actor, "delegates": delegates, "skeleton": skeleton})
			msg = f"已批准 {root}（{len(skeleton)} 个块冻结为计划骨架）" + (f"；授权 {', '.join(delegates)} 代批步骤调整" if delegates else "")
		else:
			ap = st.approvals.get(root)
			if not ap:
				raise OutlineError(f"{root} 不是已批准的计划")
			if actor != ap["approver"] and is_agent(actor):
				raise OutlineError("只有批准人能把计划放开为草稿")
			tx.push({"op": "plan.release", "root": root})
			msg = f"{root} 已放开为草稿"
		finish(tx)
	print(msg)


def cmd_cr(args) -> None:
	actor = actor_of(args)
	if args.action == "list":
		st = load_state()
		rows = [cr for cr in st.crs.values() if args.all or cr["status"] == "pending"]
		if not rows:
			print("没有待决定的提议或变更请求")
		for cr in rows:
			print(f"- {cr['id']} [{cr['status']}] {cr['kind']}：{cr['reason']}（{cr['requested_by']}，{len(cr['ops'])} 个操作；决定者：{describe_decider(st, cr['decider'])}）")
		return
	with locked():
		st = load_state()
		cr = st.crs.get(args.id or "")
		if not cr:
			raise OutlineError(f"没有 {args.id}")
		if args.action == "show":
			print(f"{cr['id']} [{cr['status']}] {cr['kind']}：{cr['reason']}")
			print(f"提出：{cr['requested_by']} @#{cr['created_seq']}；决定者：{describe_decider(st, cr['decider'])}")
			for op in cr["ops"]:
				print("  · " + describe_op(st, op))
			return
		if cr["status"] != "pending":
			raise OutlineError(f"{cr['id']} 已经是 {cr['status']}")
		if not can_decide(st, actor, cr):
			if actor == cr["requested_by"]:
				why = "不能批准自己提出的请求"
			elif cr["decider"]["kind"] == "plan" and actor in st.approvals.get(cr["decider"]["root"], {}).get("delegates", []):
				why = "它改的是计划的目标或验收，只有批准人能决定"
			else:
				why = f"决定者是 {describe_decider(st, cr['decider'])}"
			raise OutlineError(f"{actor} 不能决定 {cr['id']}：{why}")
		tx = Tx(st, actor, f"{'批准' if args.action == 'approve' else '驳回'} {cr['id']}", kind="system")
		if args.action == "approve":
			for op in cr["ops"]:
				base = op.get("base_version")
				if base is not None and op["addr"] in st.blocks and st.blocks[op["addr"]]["version"] != base:
					raise OutlineError(f"{op['addr']} 在请求之后又被改过，请重新提出")
			for op in cr["ops"]:
				clean = {k: v for k, v in op.items() if k != "base_version"}
				if clean["op"] == "block.create":
					pkey = clean.get("parent") or f"{clean['space']}/"
					clean["order"] = next_order(st, pkey, None)
				if clean["op"] == "block.create" and clean["kind"] == "assertion" and not is_agent(actor) and cr["kind"] == "proposal":
					# 人确认本身就是证据：确认过的断言直接采纳（§5.4）
					clean["props"] = dict(clean.get("props") or {}, stance="accepted")
				tx.push(clean)
				if clean["op"] in ("block.create", "block.update") and clean.get("addr") in st.blocks:
					sync_inline_links(tx, clean["addr"])
				if clean["op"] == "block.create" and clean["kind"] == "assertion" and not is_agent(actor) and cr["kind"] == "proposal":
					add_link(tx, clean["addr"], "evidence", actor, f"{actor} 在 {cr['id']} 中确认")
		tx.push({"op": "cr.decide", "id": cr["id"], "status": "approved" if args.action == "approve" else "rejected", "note": args.note or ""})
		for task in cr.get("blocked_tasks", []):
			prev = st.blocks[task]["props"].get("prev_status", "todo")
			tx.push({"op": "block.update", "addr": task, "props": {"status": prev, "prev_status": None, "blocked_reason": None}})
		if args.note:
			for task in cr.get("blocked_tasks", []) or []:
				create_items(tx, st.blocks[task]["space"], task, [parse_item(f"{cr['id']} 的决定：{args.note}")])
		finish(tx)
	who = f"（{actor} 代 {st.responsible(actor)}）" if is_agent(actor) else ""
	print(f"{cr['id']} 已{'批准' if args.action == 'approve' else '驳回'}{who}")


def describe_op(st: State, op: dict) -> str:
	t = op["op"]
	if t == "block.create":
		return f"新增 [{op['addr']}] 于 {op.get('parent') or op['space'] + '/'}：{first_line(op.get('content', ''), 60)}"
	if t == "block.update":
		parts = []
		if "content" in op:
			parts.append(f"内容 → {first_line(op['content'], 60)}")
		if op.get("props"):
			parts.append("属性 " + ", ".join(f"{k}={v}" for k, v in op["props"].items()))
		return f"修改 [{op['addr']}] " + "；".join(parts)
	if t == "block.move":
		return f"移动 [{op['addr']}] → {op.get('parent') or '顶层'}"
	if t == "block.delete":
		return f"删除 [{op['addr']}]"
	if t == "link.add":
		return f"链接 {op['from']} —{ROLE_ZH.get(op['role'], op['role'])}→ {op['target']}"
	return t


def visible(st: State, addr: str, include: set[str]) -> bool:
	b = st.blocks[addr]
	if b["deleted"]:
		return False
	if "archived" not in include and st.is_archived(addr):
		return False
	if b["kind"] == "assertion":
		if b["props"].get("stance") == "refuted" and "refuted" not in include:
			return False
		if st.superseded_by(addr) and "superseded" not in include:
			return False
	return True


def cmd_ls(args) -> None:
	st = load_state(args.as_of)
	include = set((args.include or "").split(","))
	pool = st.subtree(resolve(st, args.under)) if args.under else list(st.blocks)
	rows = []
	for a in pool:
		b = st.blocks[a]
		p = b["props"]
		if args.space and b["space"] != args.space:
			continue
		if not visible(st, a, include | ({"refuted", "superseded"} if args.stance else set())):
			continue
		if args.kind and b["kind"] != KIND_ALIASES.get(args.kind, args.kind):
			continue
		if args.status and p.get("status") != args.status:
			continue
		if args.stance and p.get("stance") != args.stance:
			continue
		if args.tag and args.tag not in (p.get("tags") or []):
			continue
		if args.owner and p.get("owner") != args.owner:
			continue
		rows.append(a)
	for a in rows:
		bd = badges(st, a)
		print(f"- [{a}] {first_line(st.blocks[a]['content'], 70)}" + (f" ‹{'·'.join(bd)}›" if bd else ""))
	if not rows:
		print("（没有匹配的块）")


def board_lines(st: State, under: str | None) -> list[str]:
	pool = st.subtree(under) if under else [a for a in st.blocks]
	tasks = [a for a in pool if st.blocks[a]["kind"] == "task" and visible(st, a, set())]
	lines = []
	for status in STATUSES:
		group = [a for a in tasks if st.blocks[a]["props"].get("status", "todo") == status]
		if not group:
			continue
		lines.append(f"### {STATUS_ZH[status]}（{len(group)}）")
		for a in group:
			bd = [x for x in badges(st, a) if x not in (STATUS_ZH[status], "任务")]
			par = st.blocks[a]["parent"]
			where = (st.blocks[par]["props"].get("alias") or first_line(st.blocks[par]["content"], 16)) if par else ""
			lines.append(f"- [{a}] {first_line(st.blocks[a]['content'], 60)}" + (f" ‹{'·'.join(bd)}›" if bd else "") + (f" ← {where}" if where else ""))
		lines.append("")
	return lines or ["（没有任务）"]


def cmd_board(args) -> None:
	st = load_state(args.as_of)
	under = resolve(st, args.under) if args.under else None
	print("\n".join(board_lines(st, under)))


def inbox_lines(st: State, who: str) -> list[str]:
	lines = []
	crs = [cr for cr in st.crs.values() if cr["status"] == "pending" and (can_decide(st, who, cr))]
	if crs:
		lines.append(f"### 待你决定的提议和变更请求（{len(crs)}）")
		for cr in crs:
			lines.append(f"- {cr['id']} {cr['kind']}：{cr['reason']}（{cr['requested_by']} 提出，{len(cr['ops'])} 个操作）")
		lines.append("")
	accept = []
	for a, b in st.blocks.items():
		if b["kind"] != "task" or b["deleted"] or b["props"].get("status") != "submitted":
			continue
		found = st.approval_for(a)
		if b["props"].get("manager") == who or (found and found[1]["approver"] == who):
			accept.append(a)
	if accept:
		lines.append(f"### 待你验收（{len(accept)}）")
		lines += [f"- [{a}] {first_line(st.blocks[a]['content'], 60)}" for a in accept]
		lines.append("")
	asks = [a for a, b in st.blocks.items() if b["kind"] == "task" and not b["deleted"] and b["props"].get("owner") == who and b["props"].get("status") in ("todo", "doing") and "提问" in (b["props"].get("tags") or [])]
	if asks:
		lines.append(f"### 等你回答的问题（{len(asks)}）")
		lines += [f"- [{a}] {first_line(st.blocks[a]['content'], 70)}" for a in asks]
		lines.append("")
	noev = [a for a, b in st.blocks.items() if b["kind"] == "task" and not b["deleted"] and b["props"].get("no_evidence") and b["props"].get("status") == "done"]
	stale = [a for a, b in st.blocks.items() if b["kind"] == "assertion" and visible(st, a, set()) and freshness(st, a)[0] != "fresh"]
	if noev or stale:
		lines.append("### 值得看一眼")
		lines += [f"- [{a}] 无依据完成：{first_line(st.blocks[a]['content'], 50)}" for a in noev]
		lines += [f"- [{a}] {'过期' if freshness(st, a)[0] == 'expired' else '存疑'}：{first_line(st.blocks[a]['content'], 50)}" for a in stale]
		lines.append("")
	agent_approved = [c for c in st.commits if c["kind"] == "system" and c.get("on_behalf_of") == who and c["summary"].startswith("批准")]
	if agent_approved:
		lines.append(f"### 代你批准的变更（{len(agent_approved)}）")
		lines += [f"- #{c['seq']} {c['actor']}：{c['summary']}" for c in agent_approved[-10:]]
		lines.append("")
	return lines or ["收件箱是空的"]


def cmd_inbox(args) -> None:
	st = load_state()
	print("\n".join(inbox_lines(st, args.who or "human:owner")))


def cmd_search(args) -> None:
	st = load_state(args.as_of)
	include = set((args.include or "").split(","))
	terms = [t.lower() for t in " ".join(args.query).split() if t]
	scored = []
	for a, b in st.blocks.items():
		if not visible(st, a, include):
			continue
		text = b["content"].lower()
		crumbs = " ".join(st.blocks[x]["content"].lower() for x in st.ancestors(a))
		hits = sum(text.count(t) * 2 + crumbs.count(t) * 0.5 for t in terms)
		if not hits or not all(t in text or t in crumbs for t in terms):
			continue
		weight = 1.0
		if b["kind"] == "assertion":
			stance = b["props"].get("stance")
			weight = {"accepted": 1.0, "hypothesis": 0.6, "refuted": 0.3}.get(stance, 1.0)
			if freshness(st, a)[0] != "fresh":
				weight *= 0.7
		scored.append((hits * weight, a))
	scored.sort(reverse=True)
	lines = []
	for score, a in scored[: args.limit]:
		crumb = " › ".join(first_line(st.blocks[x]["content"], 16) for x in reversed(st.ancestors(a)))
		bd = badges(st, a)
		lines.append(f"- [{a}] {first_line(st.blocks[a]['content'], 70)}" + (f" ‹{'·'.join(bd)}›" if bd else "") + (f"\n    在：{crumb}" if crumb else ""))
	print("\n".join(lines) if lines else "（没有结果）")
	record_reads(actor_of(args), st, [a for _, a in scored[: args.limit]])


def cmd_backlinks(args) -> None:
	st = load_state(args.as_of)
	addr = resolve(st, args.addr)
	rows = st.links_to(addr)
	if not rows:
		print("（没有反链）")
	for lk in rows:
		src = st.blocks.get(lk["from"])
		print(f"- [{lk['from']}] —{ROLE_ZH[lk['role']]}→ 本块：{first_line(src['content'], 60) if src else ''}")


def cmd_log(args) -> None:
	st = load_state()
	under = set(st.subtree(resolve(st, args.under))) if args.under else None
	rows = []
	for c in st.commits:
		addrs = {o.get("addr") or o.get("from") or o.get("root") for o in c["ops"]} - {None}
		if under is not None and not (addrs & under):
			continue
		rows.append(c)
	for c in rows[-args.n :]:
		who = c["actor"] + (f"（代 {c['on_behalf_of']}）" if c.get("on_behalf_of") else "")
		print(f"#{c['seq']} {c['ts'][:16]} {who}：{c['summary']}（{len(c['ops'])} 个操作）")


def cmd_diff(args) -> None:
	a_st, b_st = load_state(args.a), load_state(args.b)
	under = set(b_st.subtree(resolve(b_st, args.under))) if args.under else None
	lines = []
	for addr, blk in b_st.blocks.items():
		if under is not None and addr not in under:
			continue
		old = a_st.blocks.get(addr)
		if old is None or (old["deleted"] and not blk["deleted"]):
			lines.append(f"+ [{addr}] {first_line(blk['content'], 70)}")
		elif blk["deleted"] and not old["deleted"]:
			lines.append(f"- [{addr}] {first_line(old['content'], 70)}")
		else:
			if old["content"] != blk["content"]:
				lines.append(f"~ [{addr}] {first_line(old['content'], 40)} → {first_line(blk['content'], 40)}")
			if old["parent"] != blk["parent"]:
				lines.append(f"↷ [{addr}] 移到 {blk['parent'] or '顶层'}")
			changed = {k for k in set(old["props"]) | set(blk["props"]) if old["props"].get(k) != blk["props"].get(k)}
			if changed:
				lines.append(f"• [{addr}] " + ", ".join(f"{k}: {old['props'].get(k)} → {blk['props'].get(k)}" for k in sorted(changed)))
	print(f"第 {args.a} → 第 {args.b} 个提交之间：")
	print("\n".join(lines) if lines else "（没有变化）")


def cmd_fresh(args) -> None:
	if args.fetch:
		git("fetch", "origin", "main")
	st = load_state()
	cache = fresh_cache()
	head = ref_commit(args.ref)
	report: dict[str, list[str]] = {}
	checked = 0
	for lk in st.links.values():
		if lk.get("removed") or lk["role"] != "based_on" or not re.match(r"^(code|grep):", lk["target"]):
			continue
		checked += 1
		fp, why = fingerprint(lk["target"], args.ref)
		if fp is None:
			state = "expired"
		elif fp != lk["data"].get("fp"):
			state, why = "suspect", f"自 {lk['data'].get('ref')} 以来变了"
		else:
			state = "fresh"
		cache[lk["id"]] = {"state": state, "why": why, "checked": head}
		if state != "fresh":
			report.setdefault(lk["from"], []).append(f"{lk['target']}：{why}")
	_local("fresh.json").write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
	if not report:
		print(f"对照 {args.ref}（{head}）：{checked} 处锚点全部新鲜")
		return
	print(f"对照 {args.ref}（{head}）：检查了 {checked} 处锚点，{len(report)} 条断言需要复核")
	for addr, why in report.items():
		print(f"- [{addr}] {first_line(st.blocks[addr]['content'], 60)}")
		for w in why:
			print(f"    {w}")


def cmd_verify(args) -> None:
	"""复核一条断言：写回结论和证据，并按现在的代码重新取指纹（§5.5）。"""
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		if st.blocks[addr]["kind"] != "assertion":
			raise OutlineError(f"{addr} 不是断言")
		tx = Tx(st, actor, args.message or f"复核 {addr}：{args.verdict}", kind="verify")
		for ev in args.evidence or []:
			add_link(tx, addr, "evidence", resolve_target(st, ev), args.excerpt)
		if args.verdict == "fresh":
			for lk in st.links_from(addr, "based_on"):
				tx.push({"op": "link.remove", "id": lk["id"]})
				add_link(tx, addr, "based_on", lk["target"], lk["data"].get("excerpt"), args.ref)
		elif args.verdict == "refuted":
			guarded(tx, {"op": "block.update", "addr": addr, "props": {"stance": "refuted"}})
		else:
			create_items(tx, st.blocks[addr]["space"], addr, [parse_item(f"复核：需要改写。{args.note or ''}".strip())])
		finish(tx)
	print(f"已复核 {addr}：{args.verdict}")


def cmd_candidates(args) -> None:
	st = load_state()
	root = resolve(st, args.root)
	cats: dict[str, list[str]] = {"结论": [], "负面知识": [], "遗留": [], "过程": []}
	for a in st.subtree(root)[1:]:
		b = st.blocks[a]
		if b["deleted"]:
			continue
		p = b["props"]
		if b["kind"] == "assertion":
			cats["负面知识" if p.get("stance") == "refuted" else "结论"].append(a)
		elif b["kind"] == "task":
			if p.get("status") in ("todo", "doing", "blocked"):
				cats["遗留"].append(a)
			elif p.get("status") == "cancelled":
				cats["负面知识"].append(a)
			else:
				cats["过程"].append(a)
		elif "可复用" in (p.get("tags") or []):
			cats["结论"].append(a)
		else:
			cats["过程"].append(a)
	for cat, rows in cats.items():
		print(f"### {cat}（{len(rows)}）")
		for a in rows:
			bd = badges(st, a)
			print(f"- [{a}] {first_line(st.blocks[a]['content'], 70)}" + (f" ‹{'·'.join(bd)}›" if bd else ""))
		print()


def cmd_archive(args) -> None:
	with locked():
		st = load_state()
		root = resolve(st, args.root)
		tx = Tx(st, actor_of(args), f"归档 {root}")
		tx.push({"op": "block.update", "addr": root, "props": {"archived": True, "archived_seq": st.seq + 1}})
		finish(tx)
	print(f"{root} 已归档：不进默认视图和搜索；read 时可加 --as-of {st.seq + 1} 看结项那一刻")


def cmd_export(args) -> None:
	st = load_state()
	EXPORTS.mkdir(parents=True, exist_ok=True)
	header = f"<!-- 由 prototypes/outline/outline.py export 生成（第 {st.seq} 个提交）。真相源是 data/log.jsonl，不要手改。 -->\n\n"
	ov = [header + "# 大纲总览\n"]
	for space, sp in st.spaces.items():
		ov.append(f"## {space} · {sp['title']}\n")
		for a in st.children(f"{space}/"):
			if st.is_archived(a):
				ov.append(f"- [{a}] {first_line(st.blocks[a]['content'])} ‹归档›\n")
				continue
			ov.append("\n".join(render_block(st, a, 50)) + "\n")
	(EXPORTS / "overview.md").write_text("\n".join(ov), encoding="utf-8")
	(EXPORTS / "board.md").write_text(header + "# 任务看板\n\n" + "\n".join(board_lines(st, None)) + "\n", encoding="utf-8")
	(EXPORTS / "inbox.md").write_text(header + "# 负责人的收件箱\n\n" + "\n".join(inbox_lines(st, "human:owner")) + "\n", encoding="utf-8")
	log_lines = [f"- #{c['seq']} {c['ts'][:16]} {c['actor']}" + (f"（代 {c['on_behalf_of']}）" if c.get("on_behalf_of") else "") + f"：{c['summary']}" for c in st.commits[-80:]]
	(EXPORTS / "log.md").write_text(header + "# 最近的提交\n\n" + "\n".join(reversed(log_lines)) + "\n", encoding="utf-8")
	# 时间机器：把提交日志嵌进静态页，由浏览器回放（§4）
	data = json.dumps({"commits": st.commits}, ensure_ascii=False).replace("</", "<\\/")
	page = (ROOT / "viewer.html").read_text(encoding="utf-8").replace("/*__OUTLINE_DATA__*/null", data, 1)
	(EXPORTS / "timeline.html").write_text(page, encoding="utf-8")
	where = EXPORTS.relative_to(repo_root()) if EXPORTS.is_relative_to(repo_root()) else EXPORTS
	print(f"已导出到 {where}/：overview.md、board.md、inbox.md、log.md、timeline.html")


# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
	ap = argparse.ArgumentParser(prog="outline.py", description="大纲原型：块、类型、链接、空间、提交、层")
	ap.add_argument("--as", dest="actor", help="以谁的身份操作（默认取 OUTLINE_ACTOR，否则 agent:main）")
	ap.add_argument("--by", dest="recorder", help="代记：协调者替别人记录时写自己的身份（也可用 OUTLINE_RECORDED_BY）")
	sub = ap.add_subparsers(dest="cmd", required=True)

	def p(name, fn, help_):
		sp = sub.add_parser(name, help=help_)
		sp.set_defaults(fn=fn)
		return sp

	p("init", cmd_init, "初始化空间与参与者")
	s = p("actor", cmd_actor, "登记参与者（agent 要写创建者）")
	s.add_argument("name")
	s.add_argument("--creator")
	s.add_argument("--label")
	s.add_argument("--mode", choices=["focus", "steward"], help="focus：专注攻坚，不碰大纲；steward：协调者，替别人记账")

	s = p("read", cmd_read, "读一棵子树")
	s.add_argument("addr")
	s.add_argument("-d", "--depth", type=int, default=3)
	s.add_argument("--embeds", action="store_true", help="展开嵌入")
	s.add_argument("--no-links", action="store_true")
	s.add_argument("--as-of", type=int)

	s = p("pages", cmd_pages, "列出各空间的页")
	s.add_argument("space", nargs="?")
	s.add_argument("--as-of", type=int)

	s = p("add", cmd_add, "新增块；用 --md 批量插入一段 markdown 大纲")
	s.add_argument("parent", help="父块地址，或 `p/` 表示在空间 p 顶层新建页")
	s.add_argument("text", nargs="?")
	s.add_argument("--md", help="从文件读大纲；`-` 表示标准输入")
	s.add_argument("--kind")
	s.add_argument("--status")
	s.add_argument("--stance")
	s.add_argument("--prop", action="append")
	s.add_argument("--link", action="append", help="role=target，例如 based_on=code:server/x.ts#fn")
	s.add_argument("--after")
	s.add_argument("-m", "--message")

	s = p("edit", cmd_edit, "改写块正文")
	s.add_argument("addr")
	s.add_argument("text")
	s.add_argument("--force", action="store_true")
	s.add_argument("-m", "--message")

	s = p("set", cmd_set, "设置属性：k=v（空值删除），kind=…")
	s.add_argument("addr")
	s.add_argument("pairs", nargs="+")
	s.add_argument("--force", action="store_true")
	s.add_argument("-m", "--message")

	s = p("mv", cmd_mv, "移动块")
	s.add_argument("addr")
	s.add_argument("parent")
	s.add_argument("--after")
	s.add_argument("-m", "--message")

	s = p("rm", cmd_rm, "删除块及其子树")
	s.add_argument("addr")
	s.add_argument("-m", "--message")

	s = p("link", cmd_link, "加链接：FROM ROLE TARGET")
	s.add_argument("frm")
	s.add_argument("role", choices=ROLES)
	s.add_argument("target")
	s.add_argument("--excerpt")
	s.add_argument("--ref", default=DEFAULT_REF)
	s.add_argument("-m", "--message")

	s = p("unlink", cmd_unlink, "移除链接")
	s.add_argument("id")

	s = p("task", cmd_task, "任务动作")
	s.add_argument("action", choices=["start", "block", "submit", "done", "accept", "revise", "cancel", "reopen"])
	s.add_argument("addr")
	s.add_argument("--reason")
	s.add_argument("--evidence", action="append")
	s.add_argument("--excerpt")
	s.add_argument("--steal", action="store_true")
	s.add_argument("-m", "--message")

	s = p("plan", cmd_plan, "批准计划 / 放开为草稿")
	s.add_argument("action", choices=["approve", "release"])
	s.add_argument("root")
	s.add_argument("--delegate", action="append", help="授权代批步骤调整的 agent")
	s.add_argument("-m", "--message")

	s = p("cr", cmd_cr, "提议与变更请求")
	s.add_argument("action", choices=["list", "show", "approve", "reject"])
	s.add_argument("id", nargs="?")
	s.add_argument("--note")
	s.add_argument("--all", action="store_true")

	s = p("ls", cmd_ls, "按条件列出块")
	for flag in ("--kind", "--status", "--stance", "--tag", "--owner", "--under", "--space", "--include"):
		s.add_argument(flag)
	s.add_argument("--as-of", type=int)

	s = p("board", cmd_board, "任务看板")
	s.add_argument("--under")
	s.add_argument("--as-of", type=int)

	s = p("inbox", cmd_inbox, "人的收件箱")
	s.add_argument("--who")

	s = p("search", cmd_search, "检索（状态加权；默认不含否定、已被取代、归档）")
	s.add_argument("query", nargs="+")
	s.add_argument("--include", help="refuted,superseded,archived")
	s.add_argument("--limit", type=int, default=12)
	s.add_argument("--as-of", type=int)

	s = p("backlinks", cmd_backlinks, "反链")
	s.add_argument("addr")
	s.add_argument("--as-of", type=int)

	s = p("log", cmd_log, "提交记录")
	s.add_argument("-n", type=int, default=20)
	s.add_argument("--under")

	s = p("diff", cmd_diff, "两个提交之间的变化")
	s.add_argument("a", type=int)
	s.add_argument("b", type=int)
	s.add_argument("--under")

	s = p("fresh", cmd_fresh, "对照代码检查锚点的新鲜度")
	s.add_argument("--ref", default=DEFAULT_REF)
	s.add_argument("--fetch", action="store_true")

	s = p("verify", cmd_verify, "复核断言：fresh（仍然成立）/ update（需要改写）/ refuted（不成立）")
	s.add_argument("addr")
	s.add_argument("verdict", choices=["fresh", "update", "refuted"])
	s.add_argument("--evidence", action="append")
	s.add_argument("--excerpt")
	s.add_argument("--note")
	s.add_argument("--ref", default=DEFAULT_REF)
	s.add_argument("-m", "--message")

	s = p("candidates", cmd_candidates, "结项时的提炼候选（§9.8）")
	s.add_argument("root")

	s = p("archive", cmd_archive, "归档一份计划")
	s.add_argument("root")

	p("export", cmd_export, "导出 markdown 视图")
	return ap


def main(argv=None) -> int:
	args = build_parser().parse_args(argv)
	if args.recorder:
		os.environ["OUTLINE_RECORDED_BY"] = args.recorder
	try:
		args.fn(args)
	except OutlineError as e:
		print(f"错误：{e}", file=sys.stderr)
		return 1
	return 0


if __name__ == "__main__":
	sys.exit(main())
