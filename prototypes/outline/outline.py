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
	addrs = [a for a in addrs if a in st.blocks]
	for a in addrs:
		reads[a] = st.blocks[a]["version"]
	path.write_text(json.dumps(reads, ensure_ascii=False), encoding="utf-8")
	# 泡外的读取不拦，只记录，上级能看到它看了范围外的什么（§10.3）
	outside = [st.page_of(a) for a in addrs if not in_scope(st, actor, a)]
	if outside:
		opath = outside_path(actor)
		seen = [x for x in load_json(opath, []) if x not in outside]
		opath.write_text(json.dumps((seen + list(dict.fromkeys(outside)))[-50:], ensure_ascii=False), encoding="utf-8")


def outside_path(actor: str) -> Path:
	return _local("outside-" + re.sub(r"[^A-Za-z0-9_.-]", "_", actor) + ".json")


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
	live = [a for a in hits if not st.blocks[a]["deleted"]]
	if len(live) == 1 or (not live and len(hits) == 1):
		return (live or hits)[0]
	if len(live) > 1:
		raise OutlineError(f"别名 {ref} 指向多个块：{', '.join(live)}")
	raise OutlineError(f"找不到块 {ref}")


def assign_alias(st: State, space: str, alias: str, addr: str | None = None, taken: set[str] | None = None) -> str:
	"""`Q?` 取下一个空号；其他别名要在空间内唯一（已删除的块不占用）。"""
	taken = taken or set()
	if alias.endswith("?"):
		prefix = alias[:-1]
		pat = re.compile(re.escape(prefix) + r"(\d+)")
		used = [b["props"].get("alias") or "" for b in st.blocks.values() if b["space"] == space] + list(taken)
		nums = [int(m.group(1)) for a in used if (m := pat.fullmatch(a))]
		return f"{prefix}{max(nums, default=0) + 1}"
	clash = [a for a, b in st.blocks.items() if b["space"] == space and not b["deleted"] and b["props"].get("alias") == alias and a != addr]
	if clash or alias in taken:
		raise OutlineError(f"别名 {alias} 已被 {clash[0] if clash else '同一批的另一条'} 使用")
	return alias


def is_block_target(target: str) -> bool:
	return not re.match(r"^(code|grep|url|msg|chat|tool|commit|file|report|human|agent|space|ws):", target)


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


CODE_SPAN = re.compile(r"(`+)(?:(?!\1).)+?\1", re.S)


def inline_targets(st: State, content: str, labels: dict | None = None) -> list[tuple[str, str]]:
	out = []
	for bang, ref in INLINE_LINK.findall(CODE_SPAN.sub("", content)):  # 行内代码里的 [[…]] 是字面文字
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
	if tx.kind in ("system", "scope"):
		return
	src = st.blocks.get(op.get("from") or "")
	if op["op"] == "link.add" and op["role"] == "touches" and src and src["props"].get("alias") == "范围":
		raise OutlineError("范围页上的泡用 scope 命令增减：扩大范围要上级批准（§10.4）")
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
			return
	# 注意范围（§10）：有范围的 agent 在泡外写入，转成扩大范围请求
	target = op.get("parent") if op["op"] == "block.create" else (op.get("from") if op["op"] == "link.add" else addr)
	where = target if target in st.blocks else (f"space:{op['space']}" if op["op"] == "block.create" and not target else None)
	if where and is_agent(actor) and not in_scope(st, actor, where, "修改"):
		bubble = st.page_of(where) if where in st.blocks else where  # 按整页纳入
		tx.divert.append((f"在范围外写入（{where}）", scope_decider(st, actor, bubble, "修改") | {"scope_actor": actor, "scope_target": bubble}))


# ---------------------------------------------------------------------------
# 注意范围（§10）：会话空间里的「范围」页，用「涉及」链接圈出几个泡


LEVELS = ("关注", "修改", "执行")


def creator_of(st: State, actor: str) -> str:
	return st.actors.get(actor, {}).get("creator") or "human:owner"


def session_space(actor: str) -> str:
	return "s." + actor.split(":", 1)[-1]


def scope_page(st: State, actor: str) -> str | None:
	space = session_space(actor)
	hits = [a for a, b in st.blocks.items() if b["space"] == space and b["props"].get("alias") == "范围" and not b["deleted"]]
	return hits[0] if hits else None


def now_iso() -> str:
	return time.strftime("%Y-%m-%dT%H:%M:%S")


def bubbles(st: State, actor: str) -> list[dict] | None:
	"""这个 agent 的泡（过期的不算）；None 表示没有设范围，不受限制。"""
	page = scope_page(st, actor)
	if not page:
		return None
	now = now_iso()
	return [lk for lk in st.links_from(page, "touches") if (lk["data"].get("until") or "9999") > now]


def level_ok(bubble: dict, need: str) -> bool:
	return LEVELS.index(bubble["data"].get("level", "关注")) >= LEVELS.index(need)


def bubble_covers(st: State, root: str, where: str) -> bool:
	if root.startswith("space:"):
		return where == root or (where in st.blocks and st.blocks[where]["space"] == root[6:])
	if root in st.blocks:
		return where == root or (where in st.blocks and root in st.ancestors(where))
	# code:、ws: 按路径前缀；以 `:` 或 `/` 结尾表示整台设备、整个目录
	return where == root or where.startswith(root if root.endswith(("/", ":")) else root + "/")


def in_scope(st: State, actor: str, where: str, need: str = "关注") -> bool:
	bs = bubbles(st, actor)
	if bs is None:
		return True
	own = session_space(actor)
	if where == f"space:{own}" or (where in st.blocks and st.blocks[where]["space"] == own):
		return True  # 自己的会话空间永远在范围内
	return any(level_ok(b, need) and bubble_covers(st, b["target"], where) for b in bs)


def can_grant(st: State, granter: str, target: str, level: str) -> bool:
	"""能不能把这个泡给下级：人都能；agent 要自己的范围覆盖它。工作区的「执行」只能转授自己明确有的。"""
	if not is_agent(granter):
		return True
	if level == "执行" and target.startswith("ws:"):
		return any(level_ok(b, "执行") and bubble_covers(st, b["target"], target) for b in bubbles(st, granter) or [])
	return in_scope(st, granter, target, level)


def scope_decider(st: State, actor: str, bubble: str, level: str) -> dict:
	"""扩大范围找谁批：从派它的会话开始沿链往上，第一个能转授的批；都不能就由人批（§10.4）。"""
	cur = creator_of(st, actor)
	while is_agent(cur) and not can_grant(st, cur, bubble, level):
		cur = creator_of(st, cur)
	return {"kind": "agent" if is_agent(cur) else "human", "who": cur}


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
	if not tx.ops and not tx.divert:
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
		if decider.get("scope_target"):
			kind = "scope"
			data = {"level": decider.get("scope_level", "修改")}
			if decider.get("scope_until"):
				data["for"] = decider["scope_until"]  # 批准时再换算成截止时间
			page = scope_page(fresh, decider["scope_actor"])
			ops.append({"op": "link.add", "id": f"L{tx2.seq}-scope", "from": page, "role": "touches", "target": decider["scope_target"], "data": data})
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
		where = {"change_request": "变更请求", "scope": "扩大范围请求"}.get(kind, "提议")
		extra = ""
		if kind == "scope":
			extra = f"批准后 {decider['scope_target']} 以「{decider.get('scope_level', '修改')}」级别纳入范围" + ("，并执行这次写入。" if tx.ops else "。")
		print(f"已转成{where} {cid}：{reason}。决定者：{describe_decider(fresh, decider)}。{extra}")
		if blocked:
			print(f"受影响的任务已标为受阻：{', '.join(sorted(set(blocked)))}。先做不受影响的部分。")
		return seq
	seq = write_commit(tx)
	record_reads(tx.actor, tx.st, tx.touched)
	if not quiet:
		for n in tx.notices:
			print(n)
		recorder = os.environ.get("OUTLINE_RECORDED_BY")
		who = f"#{seq} 以 {tx.actor} 的身份写入" + (f"，由 {recorder} 代记" if recorder and recorder != tx.actor else "")
		print(who + (f"（责任人 {tx.st.responsible(tx.actor)}）" if is_agent(tx.actor) else ""))
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
		re.compile(rf"^(\s*)(async\s+)?def\s+{name}\b|^(\s*)class\s+{name}\b"),  # Python
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


def file_meta(path: str) -> tuple[dict, str | None]:
	"""file: 证据记下当时的版本：内容指纹，仓库内的文件再记提交号（原型发现）。"""
	full = Path(path) if Path(path).is_absolute() else repo_root() / path
	if not full.is_file():
		return {}, f"{path} 不存在，证据无法核对"
	with full.open("rb") as f:
		raw = f.read(GIT_MAX_BYTES)
	data = {"sha1": hashlib.sha1(raw).hexdigest()[:16], "bytes": full.stat().st_size}
	try:
		rel = str(full.resolve().relative_to(repo_root()))
	except ValueError:
		return data, f"{path} 在仓库之外，会话结束可能就没了；报告类文件请先用 attach 放进大纲"
	if git("ls-files", "--error-unmatch", "--", rel) is None:
		return data, f"{path} 没有纳入 git，只记下了内容指纹"
	data["commit"] = ref_commit("HEAD")
	if git("diff", "--quiet", "HEAD", "--", rel) is None:
		data["dirty"] = True  # 有未提交的改动：指纹对应的是工作区里的内容
	return data, None


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
		if p.get("manager") and p["manager"] != p.get("owner"):
			out.append("管理：" + p["manager"])
		if p.get("acceptance") == "required" and p.get("status", "todo") not in ("done", "cancelled"):
			out.append("需验收")
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
	blanks = 0  # 续行之间的空行要保留（原型发现）
	fence = None  # 续行里的代码块：块内的行原样保留，`- ` 开头也不算新条目
	for raw in text.splitlines():
		expanded = raw.replace("\t", "  ")
		indent = len(expanded) - len(expanded.lstrip(" "))
		body = expanded.strip()
		if not body and fence is None:
			blanks += 1 if stack else 0
			continue
		if body.startswith("- ") and fence is None:
			blanks = 0
			item = parse_item(body[2:])
			item["indent"] = indent
			while stack and stack[-1]["indent"] >= indent:
				stack.pop()
			(stack[-1]["children"] if stack else roots).append(item)
			stack.append(item)
			continue
		if not stack:
			raise OutlineError(f"续行前面没有条目：{raw}")
		base = stack[-1]["indent"] + 2
		cont = expanded[base:] if indent >= base else body
		stack[-1]["content"] += "\n" * (blanks + 1) + cont
		blanks = 0
		mark = re.match(r"(`{3,}|~{3,})", body)
		if mark and fence is None:
			fence = mark.group(1)
		elif fence and re.fullmatch(re.escape(fence[0]) + "{%d,}" % len(fence), body):
			fence = None
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
		# 有证据或「基于」的结论直接采纳，没有的记为假设；人写的默认采纳（§5.4、§9.6）
		has_basis = any(r in ("evidence", "based_on") for r, _ in links)
		stance = props.setdefault("stance", "accepted" if has_basis or not is_agent(actor) else "hypothesis")
		if stance not in STANCES:
			raise OutlineError(f"未知立场 {stance}")
		if stance == "accepted" and is_agent(actor) and not has_basis:
			props["stance"] = "hypothesis"
			notes.append("没有证据或基于，已记为「假设」（§5.4）")
	return props, notes


def create_items(tx: Tx, space: str, parent: str | None, items: list[dict], after: str | None = None, ref: str = DEFAULT_REF) -> list[tuple[str, dict]]:
	st = tx.st
	labels: dict[str, str] = {}
	plan: list[tuple[dict, str, str | None]] = []
	aliases: set[str] = set()

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
	anchor = after  # 给了 --after 时，顶层条目依次接在上一条后面
	for it, addr, par in plan:
		props = dict(it["props"])
		if props.get("alias"):
			props["alias"] = assign_alias(st, space, props["alias"], taken=aliases)
			aliases.add(props["alias"])
		if it["kind"] == "task" and "manager" not in props:
			# 管理者默认是创建者，子树继承（§8.4）
			up = next((x for x in ([par, *st.ancestors(par)] if par in st.blocks else []) if st.blocks[x]["props"].get("manager")), None)
			if up:
				props["manager"] = st.blocks[up]["props"]["manager"]
		props, notes = default_props(st, tx.actor, it["kind"], props, it["links"])
		for n in notes:
			tx.note(f"{addr}：{n}")
		pkey = par or f"{space}/"
		top = par == parent
		op = {
			"op": "block.create",
			"addr": addr,
			"space": space,
			"parent": par,
			"order": next_order(st, pkey, anchor if top else None) if not tx.divert else 0.0,
			"kind": it["kind"],
			"content": rewrite_labels(it["content"], labels),
			"props": props,
		}
		guarded(tx, op)
		if top and anchor and not tx.divert:
			anchor = addr
		it["props"] = props
		created.append((addr, it))
	for it, addr, _ in plan:
		if not tx.divert:
			sync_inline_links(tx, addr)
		for role, target in it["links"]:
			add_link(tx, addr, role, resolve_target(st, target, labels), ref=ref)
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
			raise OutlineError(f"锚点无效：{target}：{why}（还没合进 {ref} 的文件可以加 --ref HEAD）")
		data.update(fp=fp, ref=ref_commit(ref), what=why)
		if ref != DEFAULT_REF:
			data["ref_name"] = ref  # fresh 默认按各自的 ref 检查
	if target.startswith("file:"):
		meta, warn = file_meta(target[5:].split("#", 1)[0])
		data.update(meta)
		if warn:
			tx.note(f"提示：{warn}")
	if role == "blocked_by" and target in tx.st.blocks and frm in [target, *dependency_chain(tx.st, target)]:
		raise OutlineError("前置关系不能成环")
	op = {"op": "link.add", "id": tx.link_id(), "from": frm, "role": role, "target": target, "data": data}
	if not tx.divert:
		check_policy(tx, op)  # 比如从范围外的块往外连，也算在范围外写入
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
	actor = actor_of(args)
	if not in_scope(st, actor, addr):
		print(f"（范围外：{actor} 可以读，这里的内容不会自动注入；要在这里写，会转成扩大范围请求）")
	print("\n".join(lines))
	if args.as_of is None:
		record_reads(actor, st, shown(lines))


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
		created = create_items(tx, space, parent, items, after, ref=args.ref)
		finish(tx)
	if not tx.divert:
		for addr, it in created:
			label = f" #{it['label']}" if it["label"] else ""
			alias = f" {it['props']['alias']}" if it["props"].get("alias") else ""
			print(f"+ [{addr}]{label}{alias} {first_line(tx.st.blocks[addr]['content'], 60)}")


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
		if props.get("alias"):
			props["alias"] = assign_alias(st, st.blocks[addr]["space"], props["alias"], addr)
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
			par = b["parent"]
			if par and is_question(st, par) and not recommendation(st, par):
				q = st.blocks[par]["props"].get("alias") or par
				tx.note(f"{addr} 是提问 {q} 的调研：在 {q} 下写一条带 tags=建议 的块，提问才会带着建议进负责人的收件箱（§8.7）")
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
				if clean["op"] == "link.add" and clean["role"] == "touches" and clean["from"] in st.blocks and st.blocks[clean["from"]]["props"].get("alias") == "范围":
					data = dict(clean.get("data") or {})
					if "for" in data:  # 期限从批准时算起
						data["until"] = parse_until(data.pop("for"))
					clean["data"] = data
					olds = [lk for lk in st.links_from(clean["from"], "touches") if lk["target"] == clean["target"]]
					if any(not level_ok({"data": data}, lk["data"].get("level", "关注")) for lk in olds):
						continue  # 已经有更高的级别，不降级
					for lk in olds:
						tx.push({"op": "link.remove", "id": lk["id"]})
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
		if args.action == "approve" and cr["kind"] == "scope":
			# 只要范围的请求，范围已经满足了就由系统关掉，不留给人处理
			for other in list(st.crs.values()):
				d = other["decider"]
				if other["status"] == "pending" and other["kind"] == "scope" and len(other["ops"]) == 1 and in_scope(st, d["scope_actor"], d["scope_target"], d.get("scope_level", "修改")):
					tx.push({"op": "cr.decide", "id": other["id"], "status": "satisfied", "note": f"已由 {cr['id']} 满足"})
		for task in cr.get("blocked_tasks", []):
			prev = st.blocks[task]["props"].get("prev_status", "todo")
			tx.push({"op": "block.update", "addr": task, "props": {"status": prev, "prev_status": None, "blocked_reason": None}})
		if args.note:
			for task in cr.get("blocked_tasks", []) or []:
				create_items(tx, st.blocks[task]["space"], task, [parse_item(f"{cr['id']} 的决定：{args.note}")])
		finish(tx)
	who = f"（由 {actor} 决定，责任人 {st.responsible(actor)}）" if is_agent(actor) else ""
	print(f"{cr['id']} 已{'批准' if args.action == 'approve' else '驳回'}{who}")


def is_question(st: State, addr: str) -> bool:
	b = st.blocks[addr]
	return b["kind"] == "task" and "提问" in (b["props"].get("tags") or [])


def recommendation(st: State, q: str) -> str | None:
	"""提问下最新的一条建议（带 tags=建议 的子块）。"""
	recs = [c for c in st.children(q) if "建议" in (st.blocks[c]["props"].get("tags") or [])]
	return recs[-1] if recs else None


def cmd_answer(args) -> None:
	"""负责人回答提问：不写 --text 就采纳提问下的建议，可以一次回答多条（§13）。"""
	actor = actor_of(args)
	if args.text and len(args.questions) > 1:
		raise OutlineError("--text 只能回答一条提问；采纳建议才能一次回答多条")
	with locked():
		st = load_state()
		tx = Tx(st, actor, args.message or f"回答 {'、'.join(args.questions)}")
		answered = []
		for ref in args.questions:
			q = resolve(st, ref)
			b = st.blocks[q]
			name = b["props"].get("alias") or q
			if not is_question(st, q):
				raise OutlineError(f"{ref} 不是提问")
			if b["props"].get("status") in ("done", "cancelled"):
				raise OutlineError(f"{name} 已经回答过了")
			owner = b["props"].get("owner")
			if owner and not is_agent(owner) and actor != owner:
				raise OutlineError(f"{name} 要由 {owner} 回答；转述本人的回答时用 --as {owner} --by {actor}")
			rec = recommendation(st, q)
			if not args.text and not rec:
				raise OutlineError(f"{name} 还没有建议，用 --text 写出回答")
			text = f"回答：{args.text}" if args.text else f"回答：采纳建议 [[{rec}]]"
			item = {"kind": "note", "content": text, "props": {"tags": ["回答"]}, "links": [], "label": None, "children": []}
			[(ans, _)] = create_items(tx, b["space"], q, [item])
			add_link(tx, q, "evidence", ans)
			guarded(tx, {"op": "block.update", "addr": q, "props": {"status": "done", "blocked_reason": None}})
			if rec and not args.text and st.blocks[rec]["kind"] == "assertion":
				guarded(tx, {"op": "block.update", "addr": rec, "props": {"stance": "accepted"}})
			answered.append(name)
		finish(tx)
	if not tx.divert:
		print(f"已回答 {'、'.join(answered)}" + ("（采纳建议）" if not args.text else ""))


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
	asks = [a for a, b in st.blocks.items() if is_question(st, a) and not b["deleted"] and b["props"].get("owner") == who and b["props"].get("status") in ("todo", "doing")]
	if asks:
		lines.append(f"### 等你回答的问题（{len(asks)}）")
		with_rec = []
		for a in asks:
			name = st.blocks[a]["props"].get("alias") or a
			lines.append(f"- [{a}] {name} {first_line(st.blocks[a]['content'], 70)}")
			rec = recommendation(st, a)
			if rec:
				with_rec.append(name)
				lines.append(f"  - 建议：{first_line(re.sub(r'^建议[：:]\s*', '', st.blocks[rec]['content']), 90)}")
		if with_rec:
			lines.append("")
			lines.append(f"全部采纳建议：`outline.py --as {who} answer {' '.join(with_rec)}`；个别不同意的去掉，再用 `answer Qn --text …` 单独回答")
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
	actor = actor_of(args)
	for _, a in scored[: args.limit]:
		crumb = " › ".join(first_line(st.blocks[x]["content"], 16) for x in reversed(st.ancestors(a)))
		bd = badges(st, a) + ([] if in_scope(st, actor, a) else ["范围外"])
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
		print(f"#{c['seq']} {c['ts'][:16]} {commit_who(c)}：{c['summary']}（{len(c['ops'])} 个操作）")


def commit_who(c: dict) -> str:
	"""谁写的、责任人是谁、谁代记的：三件事分开写，不再用一个「代」字（原型发现）。"""
	who = c["actor"]
	if c.get("recorded_by"):
		who += f"，由 {c['recorded_by']} 代记"
	if c.get("on_behalf_of"):
		who += f"（责任人 {c['on_behalf_of']}）"
	return who


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
	head = ref_commit(args.ref or DEFAULT_REF)
	report: dict[str, list[str]] = {}
	checked = 0
	for lk in st.links.values():
		if lk.get("removed") or lk["role"] != "based_on" or not re.match(r"^(code|grep):", lk["target"]):
			continue
		checked += 1
		fp, why = fingerprint(lk["target"], args.ref or lk["data"].get("ref_name") or DEFAULT_REF)
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
	against = f"{args.ref}（{head}）" if args.ref else f"各锚点自己的 ref（默认 {DEFAULT_REF}，{head}）"
	if not report:
		print(f"对照 {against}：{checked} 处锚点全部新鲜")
		return
	print(f"对照 {against}：检查了 {checked} 处锚点，{len(report)} 条断言需要复核")
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
				add_link(tx, addr, "based_on", lk["target"], lk["data"].get("excerpt"), args.ref or lk["data"].get("ref_name") or DEFAULT_REF)
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


# ---------------------------------------------------------------------------
# 报告挂回大纲（§9.6）：一份 markdown 文档 → 一棵子树


MD_FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})")
MD_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
MD_LIST = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
MD_HR = re.compile(r"^([-*_])(\s*\1){2,}$")


def md_tokens(text: str) -> list[dict]:
	"""切成块：标题、段落、列表项、代码块、表格、引用。分隔线丢掉。"""
	lines = text.splitlines()
	toks: list[dict] = []
	i, gap = 0, False

	def starts_block(ln: str) -> bool:
		s = ln.strip()
		return not s or bool(MD_FENCE.match(ln) or MD_HEADING.match(s) or MD_LIST.match(ln) or MD_HR.match(s) or s[0] in "|>")

	while i < len(lines):
		ln = lines[i]
		s = ln.strip()
		ind = len(ln) - len(ln.lstrip(" "))
		if not s:
			gap, i = True, i + 1
			continue
		tok = {"indent": ind, "gap": gap}
		if fm := MD_FENCE.match(ln):
			fence, j = fm.group(2), i + 1
			while j < len(lines) and not re.fullmatch(re.escape(fence[0]) + "{%d,}" % len(fence), lines[j].strip()):
				j += 1
			body = [x[ind:] if x[:ind].strip() == "" else x.strip() for x in lines[i : j + 1]]
			tok.update(type="code", content="\n".join(body))
			i = j + 1
		elif (hm := MD_HEADING.match(s)) and ind < 4:
			tok.update(type="heading", level=len(hm.group(1)), content=hm.group(2))
			i += 1
		elif MD_HR.match(s):
			i += 1
			gap = False
			continue
		elif s[0] in "|>":
			j = i
			while j < len(lines) and lines[j].strip()[:1] == s[0]:
				j += 1
			tok.update(type="table" if s[0] == "|" else "quote", content="\n".join(x.strip() for x in lines[i:j]))
			i = j
		elif lm := MD_LIST.match(ln):
			body, j = [lm.group(3)], i + 1
			while j < len(lines) and not starts_block(lines[j]):  # 紧跟的续行并进这一项
				body.append(lines[j].strip())
				j += 1
			tok.update(type="list", content="\n".join(body))
			i = j
		else:
			body, j = [s], i + 1
			while j < len(lines) and not starts_block(lines[j]):
				body.append(lines[j].strip())
				j += 1
			tok.update(type="para", content="\n".join(body))
			i = j
		toks.append(tok)
		gap = False
	return toks


def md_to_items(text: str) -> list[dict]:
	"""标题成为父块；段落、表格、代码块、引用各成一块；列表项按缩进嵌套。
	紧跟在段落后面（中间没有空行）的列表挂在那个段落下面，比如「**样本**」下面的几条。"""

	def new(content: str) -> dict:
		return {"kind": "note", "content": content, "props": {}, "links": [], "label": None, "children": []}

	roots: list[dict] = []
	heads: list[tuple[int, dict]] = []
	stack: list[tuple[int, dict]] = []  # 当前小节里打开的列表项
	label: dict | None = None
	list_parent: list | None = None
	for t in md_tokens(text):
		section = heads[-1][1]["children"] if heads else roots
		if t["type"] == "heading":
			while heads and heads[-1][0] >= t["level"]:
				heads.pop()
			it = new(t["content"])
			(heads[-1][1]["children"] if heads else roots).append(it)
			heads.append((t["level"], it))
			stack, label, list_parent = [], None, None
			continue
		while stack and stack[-1][0] >= t["indent"]:
			stack.pop()
		it = new(t["content"])
		if t["type"] == "list":
			if stack:
				stack[-1][1]["children"].append(it)
			else:
				if list_parent is None:
					list_parent = label["children"] if label is not None and not t["gap"] else section
				list_parent.append(it)
			stack.append((t["indent"], it))
			continue
		if stack:  # 缩进在列表项里面：那一项的子块
			stack[-1][1]["children"].append(it)
			continue
		section.append(it)
		list_parent = None
		label = it if t["type"] == "para" else None
	return roots


def cmd_attach(args) -> None:
	"""把一份报告挂到大纲上，并把指向这个文件的链接改指到挂好的块（§9.6）。"""
	actor = actor_of(args)
	src = Path(args.file)
	raw = src.read_bytes()
	if len(raw) > 512 * 1024:
		raise OutlineError("报告超过 512KB，先拆分或摘要")
	items = md_to_items(raw.decode("utf-8"))
	if len(items) == 1 and items[0]["children"]:
		root = items[0]
	else:
		root = {"kind": "note", "content": args.title or src.stem, "props": {}, "links": [], "label": None, "children": items}
	if args.title:
		root["content"] = args.title
	root["props"]["tags"] = ["报告"]
	full = str(src.resolve())
	with locked():
		st = load_state()
		parent = resolve(st, args.parent)
		tx = Tx(st, actor, args.message or f"挂上报告 {src.name}")
		[(addr, _), *rest] = create_items(tx, st.blocks[parent]["space"], parent, [root])
		moved = 0
		if not tx.divert:
			# 出处记下原文件和它当时的指纹；原文件以后没了也没关系，内容已经在大纲里
			tx.push({"op": "link.add", "id": tx.link_id(), "from": addr, "role": "source", "target": f"file:{full}", "data": file_meta(full)[0]})
			olds = {f"file:{full}", f"file:{args.file}"}
			try:
				olds.add(f"file:{src.resolve().relative_to(repo_root())}")
			except ValueError:
				pass
			for lk in list(st.links.values()):
				if lk.get("removed") or lk["target"] not in olds or lk["from"] == addr:
					continue
				tx.push({"op": "link.remove", "id": lk["id"]})
				tx.push({"op": "link.add", "id": tx.link_id(), "from": lk["from"], "role": lk["role"], "target": addr, "data": dict(lk["data"], was=lk["target"])})
				moved += 1
		finish(tx)
	if not tx.divert:
		print(f"已挂上 [{addr}] {first_line(root['content'], 50)}：{len(rest) + 1} 个块" + (f"；{moved} 条指向原文件的链接改指到它" if moved else ""))


# ---------------------------------------------------------------------------
# 范围命令（§10.4）


def parse_until(v: str | None) -> str | None:
	if not v:
		return None
	m = re.fullmatch(r"(\d+)([mhd])", v)
	if m:
		secs = int(m.group(1)) * {"m": 60, "h": 3600, "d": 86400}[m.group(2)]
		return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() + secs))
	if re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?", v):
		return v if len(v) == 19 else v + ":00"
	raise OutlineError("--until 写成 30m、2h、1d，或 2026-10-24T18:00")


def scope_lines(st: State, who: str) -> list[str]:
	bs = bubbles(st, who)
	if bs is None:
		return [f"{who} 没有设范围：不受限制"]
	page = scope_page(st, who)
	lines = [f"{who} 的注意范围（{page}）：" + ("" if bs else "还没有泡，只能写自己的会话空间")]
	for b in bs:
		tgt = b["target"]
		title = f" {first_line(st.blocks[tgt]['content'], 40)}" if tgt in st.blocks else ""
		until = f"，到 {b['data']['until']}" if b["data"].get("until") else ""
		lines.append(f"- {tgt}{title} · {b['data'].get('level', '关注')}（{b['author']} 加于 #{b['created_seq']}{until}）")
	outside = load_json(outside_path(who), [])
	if outside:
		lines.append("最近读过的范围外内容：" + "、".join(outside[-10:]))
	return lines


def cmd_scope(args) -> None:
	actor = actor_of(args)
	who = args.agent or actor
	if args.action == "show":
		print("\n".join(scope_lines(load_state(), who)))
		return
	if not args.agent or not args.target:
		raise OutlineError(f"用法：scope {args.action} AGENT TARGET")
	if args.level not in LEVELS:
		raise OutlineError(f"级别只有 {'、'.join(LEVELS)}")
	with locked():
		st = load_state()
		if who not in st.actors or not is_agent(who):
			raise OutlineError(f"{who} 不是登记过的 agent")
		target = resolve_target(st, args.target)
		chain = []
		cur = who
		while is_agent(cur):
			cur = creator_of(st, cur)
			chain.append(cur)
		if actor != who and actor not in chain and is_agent(actor):
			raise OutlineError(f"只有 {who} 自己、它的上级（{'、'.join(chain)}）或人能改它的范围")
		page = scope_page(st, who)
		mine = [lk for lk in (st.links_from(page, "touches") if page else []) if lk["target"] == target]
		tx = Tx(st, actor, args.message or f"{who} 的范围：{args.action} {target}", kind="scope")
		if args.action == "rm":
			if not mine:
				raise OutlineError(f"{target} 不在 {who} 的范围里")
			for lk in mine:  # 缩小范围不需要批准（§10.3）
				tx.push({"op": "link.remove", "id": lk["id"]})
			finish(tx)
			print(f"已把 {target} 移出 {who} 的范围")
			return
		until = parse_until(args.until)
		first = bubbles(st, who) is None
		exec_ws = args.level == "执行" and target.startswith("ws:")
		# 人加的直接生效。第一个泡是在收窄（原来不受限），直接生效；自己加「关注」只影响注入和路由，
		# 也直接生效；自己加「修改」「执行」要上级批。上级在自己能转授的范围内直接给，否则继续往上请求。
		# 工作区的「执行」例外：只有人，或自己就有这一级的上级能给（§10.4）。
		if not is_agent(actor):
			direct = True
		elif exec_ws:
			direct = actor != who and can_grant(st, actor, target, args.level)
		elif first:
			direct = True
		elif actor == who:
			direct = args.level == "关注"
		else:
			direct = can_grant(st, actor, target, args.level)
		if not direct and not page:
			raise OutlineError(f"{who} 还没有范围：先用 scope add 圈出它工作的泡，再申请工作区的「执行」")
		if not direct:
			base = who if actor == who else actor
			decider = scope_decider(st, base, target, args.level) | {"scope_actor": who, "scope_target": target, "scope_level": args.level, "scope_until": args.until}
			tx.kind = "edit"
			tx.divert.append((f"扩大 {who} 的范围：{target}（{args.level}）", decider))
			finish(tx)
			return
		if not page:
			space = session_space(who)
			if space not in st.spaces:
				tx.push({"op": "space.create", "space": space, "kind": "session", "title": f"{who} 的会话空间", "owner": who})
			page = f"{space}/{new_sid(st, space)}"
			tx.push({"op": "block.create", "addr": page, "space": space, "parent": None, "order": next_order(st, f"{space}/", None), "kind": "note", "content": "注意范围", "props": {"alias": "范围"}})
		for lk in mine:
			tx.push({"op": "link.remove", "id": lk["id"]})
		data = {"level": args.level} | ({"until": until} if until else {})
		tx.push({"op": "link.add", "id": tx.link_id(), "from": page, "role": "touches", "target": target, "data": data})
		finish(tx)
	note = "（这是第一个泡：从此它只能在泡内和自己的会话空间里直接写）" if first else ""
	print(f"{who} 的范围加上 {target} · {args.level}" + (f"，到 {until}" if until else "") + note)


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
	log_lines = [f"- #{c['seq']} {c['ts'][:16]} {commit_who(c)}：{c['summary']}" for c in st.commits[-80:]]
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
	s.add_argument("--after", help="插在这个块后面；--md 的多个顶层条目依次往后接")
	s.add_argument("--ref", default=DEFAULT_REF, help="代码锚点对照的 git ref；还没合进 main 的文件用 HEAD")
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
	s.add_argument("--ref", help="统一对照这个 ref；不写就按每个锚点建立时的 ref（默认 origin/main）")
	s.add_argument("--fetch", action="store_true")

	s = p("verify", cmd_verify, "复核断言：fresh（仍然成立）/ update（需要改写）/ refuted（不成立）")
	s.add_argument("addr")
	s.add_argument("verdict", choices=["fresh", "update", "refuted"])
	s.add_argument("--evidence", action="append")
	s.add_argument("--excerpt")
	s.add_argument("--note")
	s.add_argument("--ref")
	s.add_argument("-m", "--message")

	s = p("answer", cmd_answer, "回答提问：不写 --text 就采纳建议，可以一次回答多条")
	s.add_argument("questions", nargs="+")
	s.add_argument("--text", help="自己的回答（只能回答一条）")
	s.add_argument("-m", "--message")

	s = p("attach", cmd_attach, "把一份 markdown 报告挂到某个块下面，并把指向这个文件的链接改指过来")
	s.add_argument("parent")
	s.add_argument("file")
	s.add_argument("--title")
	s.add_argument("-m", "--message")

	s = p("scope", cmd_scope, "注意范围：show [AGENT] / add AGENT TARGET / rm AGENT TARGET")
	s.add_argument("action", choices=["show", "add", "rm"])
	s.add_argument("agent", nargs="?")
	s.add_argument("target", nargs="?", help="块地址、space:p、code:路径前缀、ws:设备:目录")
	s.add_argument("--level", default="修改", help="关注 / 修改 / 执行")
	s.add_argument("--until", help="期限：30m、2h、1d，或 2026-10-24T18:00")
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
