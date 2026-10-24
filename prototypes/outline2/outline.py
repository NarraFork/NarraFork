#!/usr/bin/env python3
"""大纲原型第二版：按 docs/OUTLINE_KNOWLEDGE-DESIGN.md 第二版的六个概念实现，跑第三轮试用。

- 真相源是 data/log.jsonl：只追加的提交日志；状态由回放得到，时间机器就是回放到第 N 个提交。
- 第一版（prototypes/outline/）的当前状态用 import-v1 导入成第一个提交，不带历史（设计文档 §8 的迁移方式）。
- data/.local/ 是本地缓存（读取记录、锚点检查结果、命令统计），不入库。

只用标准库。用法见同目录 README.md。
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
import signal
import string
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("OUTLINE_DATA") or ROOT / "data")
LOG = DATA / "log.jsonl"
LOCK = DATA / "log.lock"
LOCAL = DATA / ".local"
EXPORTS = Path(os.environ.get("OUTLINE_EXPORTS") or ROOT / "exports")

BOXES = {" ": "todo", "/": "doing", "x": "done", "X": "done", "-": "cancelled"}
BOX_OF = {"todo": " ", "doing": "/", "done": "x", "cancelled": "-"}
STATUS_ZH = {"todo": "待办", "doing": "进行中", "done": "完成", "cancelled": "取消"}
LINK_KINDS = ("link", "embed", "depends", "basis", "source")
LINK_ZH = {"link": "链接", "embed": "嵌入", "depends": "前置", "basis": "依据", "source": "出处"}
PROP_KEYS = ("depends", "due", "alias", "tags")  # 大纲里 `键:: 值` 能写的键
BULK = 50  # 一次删除或移动这么多别人写的已有块，转待确认
BASIS_MAX = 5
GIT_TIMEOUT = 15
MAX_BYTES = 8 * 1024 * 1024
SID_ALPHABET = string.ascii_letters + string.digits
INLINE_LINK = re.compile(r"(!?)\[\[([^\]\n]+)\]\]")
CODE_SPAN = re.compile(r"(`+)(?:(?!\1).)+?\1", re.S)
ASSIGN = re.compile(r"(?<![\w`])@((?:human|agent):[\w.-]+)")
CODE_POS = re.compile(r"((?:[\w.@-]+/)+[\w.@-]+\.[A-Za-z0-9]+)(?::(\d+)(?:[-–](\d+))?|#([A-Za-z_$][\w$]*))")


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
		self.locks: dict[str, dict] = {}
		self.pending: dict[str, dict] = {}
		self.traces: dict[str, dict] = {}
		self.commits: list[dict] = []
		self.seq = 0

	def children(self, key: str, include_deleted: bool = False) -> list[str]:
		out = [a for a in self.kids.get(key, []) if include_deleted or not self.blocks[a]["deleted"]]
		return sorted(out, key=lambda a: self.blocks[a]["order"])

	def parent_key(self, addr: str) -> str:
		b = self.blocks[addr]
		return b["parent"] or f"{b['space']}/"

	def ancestors(self, addr: str) -> list[str]:
		out, cur = [], self.blocks[addr]["parent"]
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

	def links_from(self, addr: str, kind: str | None = None) -> list[dict]:
		return [lk for lk in self.links.values() if lk["from"] == addr and not lk.get("removed") and (kind is None or lk["kind"] == kind)]

	def links_to(self, addr: str, kind: str | None = None) -> list[dict]:
		return [lk for lk in self.links.values() if lk["target"] == addr and not lk.get("removed") and (kind is None or lk["kind"] == kind)]

	def lock_for(self, addr: str) -> tuple[str, dict] | None:
		for a in [addr, *self.ancestors(addr)]:
			if a in self.locks:
				return a, self.locks[a]
		return None

	def is_task(self, addr: str) -> bool:
		return self.blocks[addr]["kind"] == "task"

	def responsible(self, actor: str) -> str:
		"""责任链：沿创建链上溯到人（§2.5）。"""
		cur, seen = actor, set()
		while cur.startswith("agent:") and cur not in seen:
			seen.add(cur)
			cur = self.actors.get(cur, {}).get("creator") or "human:owner"
		return cur

	def team_root(self, actor: str) -> str:
		cur, seen = actor, set()
		while cur.startswith("agent:") and cur not in seen:
			seen.add(cur)
			creator = self.actors.get(cur, {}).get("creator", "")
			if not creator.startswith("agent:"):
				return cur
			cur = creator
		return cur


def apply_op(st: State, op: dict, seq: int, actor: str) -> None:
	t = op["op"]
	if t == "space.create":
		st.spaces[op["space"]] = {k: op.get(k) for k in ("kind", "title", "owner")}
	elif t == "actor.register":
		st.actors[op["actor"]] = {k: op.get(k) for k in ("kind", "creator", "label")}
	elif t == "block.create":
		addr = op["addr"]
		st.blocks[addr] = {
			"addr": addr,
			"space": op["space"],
			"parent": op.get("parent"),
			"order": op["order"],
			"kind": op.get("kind", "note"),
			"content": op.get("content", ""),
			"props": dict(op.get("props") or {}),
			"author": op.get("author") or actor,
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
		st.kids[st.parent_key(addr)].remove(addr)
		b = st.blocks[addr]
		b["parent"], b["order"] = op.get("parent"), op["order"]
		st.kids.setdefault(st.parent_key(addr), []).append(addr)
		b["version"], b["updated_by"] = seq, actor
	elif t in ("block.delete", "block.restore"):
		b = st.blocks[op["addr"]]
		b["deleted"], b["version"], b["updated_by"] = t == "block.delete", seq, actor
	elif t == "link.add":
		st.links[op["id"]] = {"id": op["id"], "from": op["from"], "kind": op["kind"], "target": op["target"], "data": dict(op.get("data") or {}), "created_seq": seq, "author": actor}
	elif t == "link.remove":
		st.links[op["id"]]["removed"] = seq
	elif t == "lock.set":
		st.locks[op["root"]] = {"locker": op["locker"], "delegate": op.get("delegate"), "seq": seq, "skeleton": op["skeleton"]}
	elif t == "lock.clear":
		st.locks.pop(op["root"], None)
	elif t == "pending.create":
		st.pending[op["id"]] = {"id": op["id"], "kind": op["kind"], "reason": op["reason"], "ops": op["ops"], "decider": op["decider"], "requested_by": actor, "created_seq": seq, "status": "pending"}
	elif t == "pending.decide":
		st.pending[op["id"]].update(status=op["status"], decided_by=actor, decided_seq=seq, note=op.get("note", ""))
	elif t == "trace.add":
		st.traces[op["task"]] = {"agent": op["agent"], "calls": op["calls"], "seq": seq}
	else:
		raise OutlineError(f"未知操作 {t}")


def load_state(as_of: int | None = None) -> State:
	st = State()
	if not LOG.exists():
		return st
	with LOG.open(encoding="utf-8") as f:
		for line in f:
			if not line.strip():
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


def _local(name: str) -> Path:
	LOCAL.mkdir(parents=True, exist_ok=True)
	return LOCAL / name


def load_json(path: Path, default):
	try:
		return json.loads(path.read_text(encoding="utf-8"))
	except (FileNotFoundError, json.JSONDecodeError):
		return default


def safe(name: str) -> str:
	return re.sub(r"[^A-Za-z0-9_.-]", "_", name)


def record_reads(actor: str, st: State, addrs) -> None:
	path = _local(f"reads-{safe(actor)}.json")
	reads = load_json(path, {})
	for a in addrs:
		if a in st.blocks:
			reads[a] = st.blocks[a]["version"]
	path.write_text(json.dumps(reads, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# 事务：一个动作 = 一个提交


class Tx:
	def __init__(self, st: State, actor: str, summary: str, kind: str = "edit") -> None:
		self.st, self.actor, self.summary, self.kind = st, actor, summary, kind
		self.seq = st.seq + 1
		self.ops: list[dict] = []
		self.notices: list[str] = []
		self.divert: list[tuple[str, str, str]] = []  # (种类, 原因, 决定者)
		self.reads = load_json(_local(f"reads-{safe(actor)}.json"), {})
		self.created: list[str] = []
		self.force = False

	def push(self, op: dict) -> None:
		apply_op(self.st, op, self.seq, self.actor)
		self.ops.append(op)

	def link_id(self) -> str:
		return f"L{self.seq}-{sum(1 for o in self.ops if o['op'] == 'link.add') + 1}"

	def note(self, msg: str) -> None:
		if msg not in self.notices:
			self.notices.append(msg)


def is_agent(actor: str) -> bool:
	return actor.startswith("agent:")


def new_sid(st: State, space: str, taken: set[str] | None = None) -> str:
	while True:
		sid = "".join(secrets.choice(SID_ALPHABET) for _ in range(8))
		addr = f"{space}/{sid}"
		if addr not in st.blocks and addr not in (taken or set()):
			return sid


def first_line(text: str, limit: int = 0) -> str:
	line = text.split("\n", 1)[0]
	return line if not limit or len(line) <= limit else line[: limit - 1] + "…"


def title_of(b: dict) -> str:
	return first_line(b["content"]).strip()


def resolve(st: State, ref: str, extra_titles: dict[str, str] | None = None, prefer_space: str | None = None) -> str:
	"""地址：短 id、`空间/短id`、别名，或者标题（先找页，再找块）。"""
	ref = ref.strip()
	if ref.startswith("[[") and ref.endswith("]]"):
		ref = ref[2:-2].strip()
	if ref in st.blocks:
		return ref
	if re.fullmatch(r"[A-Za-z0-9]{8}", ref):
		hits = [f"{s}/{ref}" for s in st.spaces if f"{s}/{ref}" in st.blocks]
		if len(hits) == 1:
			return hits[0]
	space, key = (ref.split("/", 1) if "/" in ref and ref.split("/", 1)[0] in st.spaces else (None, ref))
	if space and f"{space}/{key}" in st.blocks:
		return f"{space}/{key}"
	if extra_titles and key in extra_titles:
		return extra_titles[key]

	def pick(cands: list[str], what: str) -> str | None:
		live = [a for a in cands if not st.blocks[a]["deleted"]]
		if prefer_space and len(live) > 1:
			live = [a for a in live if st.blocks[a]["space"] == prefer_space] or live
		if len(live) == 1:
			return live[0]
		if len(live) > 1:
			tops = [a for a in live if not st.blocks[a]["parent"]]
			if len(tops) == 1:
				return tops[0]
			raise OutlineError(f"{what}「{key}」对应多个块：{', '.join(live[:6])}；请用地址")
		return None

	pool = [a for a, b in st.blocks.items() if space is None or b["space"] == space]
	hit = pick([a for a in pool if st.blocks[a]["props"].get("alias") == key], "别名")
	if hit:
		return hit
	hit = pick([a for a in pool if title_of(st.blocks[a]) == key], "标题")
	if hit:
		return hit
	raise OutlineError(f"找不到「{ref}」（可以写短 id、空间/短id、别名或标题）")


def assign_alias(st: State, space: str, alias: str, addr: str | None = None, taken: set[str] | None = None) -> str:
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


def next_order(st: State, parent_key: str, after: str | None) -> float:
	sibs = st.children(parent_key, include_deleted=True)
	if not after or after not in sibs:
		return max((st.blocks[s]["order"] for s in sibs), default=0.0) + 1.0
	i = sibs.index(after)
	lo = st.blocks[after]["order"]
	hi = st.blocks[sibs[i + 1]]["order"] if i + 1 < len(sibs) else lo + 2.0
	return (lo + hi) / 2


# ---------------------------------------------------------------------------
# 大纲写法：列表项是块，复选框是任务，`键:: 值` 是属性


ITEM = re.compile(r"^- (?:\[([ /xX-])\]\s+)?(.*)$")
PROP_LINE = re.compile(r"^([a-z]+)::\s*(.*)$")


def parse_outline(text: str) -> list[dict]:
	roots: list[dict] = []
	stack: list[dict] = []
	blanks, fence = 0, None
	for raw in text.splitlines():
		expanded = raw.replace("\t", "  ")
		indent = len(expanded) - len(expanded.lstrip(" "))
		body = expanded.strip()
		if not body and fence is None:
			blanks += 1 if stack else 0
			continue
		m = ITEM.match(body) if fence is None else None
		if m:
			blanks = 0
			item = new_item(m.group(2), m.group(1))
			item["indent"] = indent
			while stack and stack[-1]["indent"] >= indent:
				stack.pop()
			(stack[-1]["children"] if stack else roots).append(item)
			stack.append(item)
			continue
		if not stack:
			raise OutlineError(f"这一行前面没有列表项：{raw}")
		pm = PROP_LINE.match(body) if fence is None else None
		if pm and indent > stack[-1]["indent"]:
			key, value = pm.group(1), pm.group(2).strip()
			if key not in PROP_KEYS:
				raise OutlineError(f"不认识的属性 {key}::（能写的有 {', '.join(PROP_KEYS)}）")
			stack[-1]["props"][key] = value
			continue
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


def new_item(text: str, box: str | None = None) -> dict:
	return {"content": text.strip(), "box": box, "props": {}, "children": [], "extra": {}}


def item_from_text(text: str) -> dict:
	items = parse_outline("- " + text if not text.startswith("- ") else text)
	if len(items) != 1:
		raise OutlineError("只能写一条；多条请用 --md")
	return items[0]


def code_positions(content: str) -> list[tuple[str, int | None, int | None, str | None]]:
	out = []
	for m in CODE_POS.finditer(content):
		path = m.group(1)[2:] if m.group(1).startswith("./") else m.group(1)
		if not (repo_root() / path).is_file():
			continue
		l1 = int(m.group(2)) if m.group(2) else None
		l2 = int(m.group(3)) if m.group(3) else l1
		out.append((path, l1, l2, m.group(4)))
	return list(dict.fromkeys(out))


def inline_targets(st: State, content: str, titles: dict | None, space: str) -> tuple[list[tuple[str, str]], list[str]]:
	out, missing = [], []
	for bang, ref in INLINE_LINK.findall(CODE_SPAN.sub("", content)):  # 行内代码里的 [[…]] 是字面文字
		try:
			out.append(("embed" if bang else "link", resolve(st, ref, titles, space)))
		except OutlineError:
			missing.append(ref)
	return out, missing


# ---------------------------------------------------------------------------
# 依据：运行记录、代码锚点、人的确认（§2.3）


@functools.cache
def repo_root() -> Path:
	out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=GIT_TIMEOUT)
	return Path(out.stdout.strip())


def git(*args: str) -> str | None:
	try:
		out = subprocess.run(["git", "-C", str(repo_root()), *args], capture_output=True, timeout=GIT_TIMEOUT)
	except subprocess.TimeoutExpired:
		return None
	if out.returncode != 0 or len(out.stdout) > MAX_BYTES:
		return None
	return out.stdout.decode("utf-8", errors="replace")


@functools.cache
def head_commit() -> str:
	return (git("rev-parse", "--short", "HEAD") or "?").strip()


def read_worktree(path: str) -> str | None:
	full = repo_root() / path
	if not full.is_file():
		return None
	with full.open("rb") as f:
		return f.read(MAX_BYTES).decode("utf-8", errors="replace")


DECLS = [
	re.compile(r"^(\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)"),
	re.compile(r"^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_][\w]*)"),
]
# 类方法：名字后面跟括号（参数可以跨行），这一行以 { 或 ( 结尾，并且缩进不深，免得把调用当成声明
METHOD = re.compile(r"^(\s*)(?:(?:public|private|protected|static|readonly|async|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(")


def segment_from(lines: list[str], start: int) -> tuple[int, int]:
	"""从声明那一行开始取范围：Python 按缩进，其余按括号配平。返回 [start, end)。"""
	first = lines[start]
	if re.match(r"^\s*(?:async\s+def|def|class)\s", first):
		indent, end = len(first) - len(first.lstrip()), start + 1
		while end < len(lines) and (not lines[end].strip() or len(lines[end]) - len(lines[end].lstrip()) > indent):
			end += 1
		return start, end
	depth, opened = 0, False
	for i in range(start, len(lines)):
		for ch in lines[i]:
			if ch in "({[":
				depth, opened = depth + 1, True
			elif ch in ")}]":
				depth -= 1
		if (opened and depth <= 0) or (not opened and lines[i].rstrip().endswith(";")):
			return start, i + 1
	return start, len(lines)


KEYWORDS = {"if", "for", "while", "switch", "catch", "with", "return", "function", "else", "do", "try"}


def decl_at(line: str, lenient: bool = False) -> str | None:
	for p in DECLS:
		m = p.match(line)
		if m and m.group(2) not in KEYWORDS:
			if re.match(r"\s*(?:export\s+)?(?:const|let|var)\s", line) and m.group(1) and not lenient:
				continue  # 函数里的局部变量太容易改名，不拿来当锚点
			return m.group(2)
	m = METHOD.match(line)
	if m and m.group(2) not in KEYWORDS and not line.rstrip().endswith(";"):
		indent = len(m.group(1).expandtabs(4))
		if lenient or (indent <= 4 and line.rstrip().endswith(("{", "("))):
			return m.group(2)
	return None


def find_symbol(text: str, symbol: str) -> tuple[int, int] | None:
	lines = text.splitlines()
	for i, ln in enumerate(lines):
		if decl_at(ln) == symbol:
			return segment_from(lines, i)
	for i, ln in enumerate(lines):  # 知道名字时放宽：方法的参数可以跨行
		if decl_at(ln, lenient=True) == symbol:
			return segment_from(lines, i)
	return None


def enclosing_symbol(text: str, line: int) -> tuple[str, int, int] | None:
	"""行号所在的最内层声明。"""
	lines = text.splitlines()
	for i in range(min(line, len(lines)) - 1, -1, -1):
		name = decl_at(lines[i])
		if name:
			s, e = segment_from(lines, i)
			if s < line <= e:
				return name, s, e
	return None


def fp_of(lines: list[str]) -> str:
	norm = "\n".join(ln.strip() for ln in lines if ln.strip())
	return hashlib.sha1(norm.encode()).hexdigest()[:16]


def make_anchor(path: str, l1: int | None, l2: int | None, symbol: str | None) -> tuple[str, dict] | None:
	"""代码位置 → 锚点：能落到符号就锚符号，否则锚行范围。指纹按工作区，记下 HEAD。"""
	text = read_worktree(path)
	if text is None:
		return None
	lines = text.splitlines()
	if symbol:
		rng = find_symbol(text, symbol)
		if not rng:
			return None
		return f"code:{path}#{symbol}", {"fp": fp_of(lines[rng[0] : rng[1]]), "commit": head_commit(), "lines": f"{rng[0] + 1}-{rng[1]}"}
	if l1 and 0 < l1 <= len(lines):
		enc = enclosing_symbol(text, l1)
		if enc:
			name, s, e = enc
			return f"code:{path}#{name}", {"fp": fp_of(lines[s:e]), "commit": head_commit(), "lines": f"{s + 1}-{e}", "cited": f"{l1}"}
		l2 = min(max(l2 or l1, l1), len(lines))
		snippet = "\n".join(ln.strip() for ln in lines[l1 - 1 : l2] if ln.strip())[:300]
		return f"code:{path}:{l1}-{l2}", {"fp": fp_of(lines[l1 - 1 : l2]), "commit": head_commit(), "lines": f"{l1}-{l2}", "snippet": snippet}
	return None


def anchor_fingerprint(target: str) -> tuple[str | None, str]:
	body = target[5:]
	if "#" in body:
		path, symbol = body.split("#", 1)
		text = read_worktree(path)
		if text is None:
			return None, "文件不存在"
		rng = find_symbol(text, symbol)
		if not rng:
			return None, f"找不到 {symbol}"
		return fp_of(text.splitlines()[rng[0] : rng[1]]), f"{rng[1] - rng[0]} 行"
	m = re.fullmatch(r"(.+):(\d+)(?:-(\d+))?", body)
	path = m.group(1) if m else body
	text = read_worktree(path)
	if text is None:
		return None, "文件不存在"
	lines = text.splitlines()
	if not m:  # 第一版留下的整文件锚点
		return fp_of(lines), f"整个文件 {len(lines)} 行"
	a, b = int(m.group(2)), int(m.group(3) or m.group(2))
	return fp_of(lines[a - 1 : b]), f"第 {a}-{b} 行"


def evidence_owner(st: State, addr: str) -> str | None:
	"""这个块是在哪个任务下面写的、那个任务有没有运行记录或报告（记子代理的结论时用）。"""
	for a in [addr, *st.ancestors(addr)]:
		if a in st.traces or any(st.blocks[c]["props"].get("report") for c in st.children(a)):
			return a
	return None


def sync_basis(tx: Tx, addr: str, fallback: bool = True) -> None:
	"""按正文里的代码位置挂锚点；在有运行记录的任务下面，再对上那次运行里碰过这个文件的调用。"""
	st = tx.st
	b = st.blocks[addr]
	have = {lk["target"]: lk for lk in st.links_from(addr, "basis")}
	want: dict[str, dict] = {}
	spans: list[tuple[str, int, int]] = []
	for path, l1, l2, sym in code_positions(b["content"]):
		got = make_anchor(path, l1, l2, sym)
		if not got:
			tx.note(f"提示：{path}{':' + str(l1) if l1 else '#' + sym if sym else ''} 没能定位，按普通文字保留")
			continue
		want[got[0]] = got[1]
		lo, _, hi = got[1]["lines"].partition("-")
		spans.append((path, l1 or int(lo), (l2 or l1) or int(hi or lo)))
	owner = evidence_owner(st, addr)
	if owner and owner in st.traces:
		# 只挂真的读到过这几行的调用，读得越窄越优先
		for path, a, z in spans:
			cands = []
			for c in st.traces[owner]["calls"]:
				hit = [r for r in c.get("ranges", {}).get(path, []) if r[0] <= z and r[1] >= a]
				if hit:
					cands.append((min(r[1] - r[0] for r in hit), c["n"], c))
			for _, _, c in sorted(cands)[:2]:
				want[f"trace:{owner}#{c['n']}"] = {"excerpt": c["excerpt"], "tool": c["tool"], "target": c["target"][:120]}
	in_report = any(st.blocks[x]["props"].get("report") for x in [addr, *st.ancestors(addr)])
	rep = next((c for c in st.children(owner) if st.blocks[c]["props"].get("report")), None) if owner and not in_report else None
	if rep and is_agent(tx.actor) and not any(lk["target"] == rep for lk in st.links_from(addr, "source")):
		tx.push({"op": "link.add", "id": tx.link_id(), "from": addr, "kind": "source", "target": rep})  # 从报告整理出来的，出处指回报告
	if not want and fallback and rep and is_agent(tx.actor):
		want[rep] = {"candidate": True}
	for target, lk in have.items():
		if target.startswith("code:") and target not in want:
			tx.push({"op": "link.remove", "id": lk["id"]})
	for target, data in list(want.items())[:BASIS_MAX]:
		if target not in have:
			tx.push({"op": "link.add", "id": tx.link_id(), "from": addr, "kind": "basis", "target": target, "data": data})


@functools.cache
def anchor_cache() -> dict:
	return load_json(_local("anchors.json"), {})


def anchor_state(st: State, addr: str) -> str | None:
	cache = anchor_cache()
	states = [cache.get(lk["id"], {}).get("state") for lk in st.links_from(addr, "basis") if lk["target"].startswith("code:")]
	if "gone" in states or "changed" in states:
		return "代码已变"
	return None


def has_basis(st: State, addr: str) -> bool:
	return bool(st.links_from(addr, "basis"))


# ---------------------------------------------------------------------------
# 待确认（§2.6）


def lock_change(st: State, op: dict) -> tuple[str, str] | None:
	"""这次操作是否在改一份锁定的计划。返回 (计划根, 原因)。"""
	t = op["op"]
	if t == "link.add" or t == "link.remove":
		frm = op.get("from") if t == "link.add" else st.links[op["id"]]["from"]
		kind = op.get("kind") if t == "link.add" else st.links[op["id"]]["kind"]
		if kind != "depends" or frm not in st.blocks:
			return None
		found = st.lock_for(frm)
		return (found[0], "改了锁定计划里的前置") if found and frm in found[1]["skeleton"] else None
	addr = op.get("addr")
	target = op.get("parent") if t == "block.create" else addr
	if not target or target not in st.blocks:
		return None
	found = st.lock_for(target)
	if not found:
		return None
	root, lk = found
	skel = lk["skeleton"]
	if t == "block.create":
		if op.get("kind") == "task" and target in skel and skel[target]:
			return root, "在锁定的计划里加步骤"
		return None
	if addr not in skel:
		return None
	b = st.blocks[addr]
	if t == "block.update":
		if "content" in op and op["content"] != b["content"] and b["kind"] == "task":
			return root, "改了锁定计划里的步骤"
		status = (op.get("props") or {}).get("status")
		if status == "cancelled":
			return root, "取消锁定计划里的步骤"
		if status == "done" and addr == root:
			return root, "完成锁定的计划"
		if "due" in (op.get("props") or {}):
			return root, "改了锁定计划里的截止日期"
		return None
	if t == "block.move":
		return root, "移动锁定计划里的步骤"
	if t == "block.delete" and b["kind"] == "task":
		return root, "删除锁定计划里的步骤"
	return None


def check_policy(tx: Tx, op: dict) -> None:
	st, actor = tx.st, tx.actor
	if tx.kind == "system":
		return
	addr = op.get("addr")
	space = op.get("space") or (st.blocks[addr]["space"] if addr in st.blocks else None)
	if space and st.spaces.get(space, {}).get("kind") == "personal" and is_agent(actor):
		owner = st.spaces[space].get("owner") or "human:owner"
		tx.divert.append(("personal", f"agent 写 {owner} 的个人空间", owner))
		return
	found = lock_change(st, op)
	if found:
		root, why = found
		lk = st.locks[root]
		if actor != lk["locker"]:
			tx.divert.append(("lock", f"{why}（{title_of(st.blocks[root])[:20]}）", root))


def guarded(tx: Tx, op: dict) -> None:
	check_policy(tx, op)
	if tx.divert:
		tx.ops.append(op)
	else:
		tx.push(op)


def decider_of(st: State, kind: str, ref: str) -> str:
	if kind == "lock":
		lk = st.locks.get(ref, {})
		return lk.get("locker", "human:owner") + (f"（或 {lk['delegate']}）" if lk.get("delegate") else "")
	return ref


def can_decide(st: State, actor: str, p: dict) -> bool:
	if actor == p["requested_by"]:
		return False
	if p["kind"] == "lock":
		lk = st.locks.get(p["decider"])
		if not lk:
			return not is_agent(actor)
		return actor in (lk["locker"], lk.get("delegate"))
	return actor == p["decider"] or actor == "human:owner"


def finish(tx: Tx, quiet: bool = False) -> int | None:
	st = tx.st
	if not tx.ops and not tx.divert:
		for n in tx.notices:
			print(n)
		return None
	if not tx.divert and is_agent(tx.actor) and tx.kind != "system":
		others = {
			o["addr"]
			for o in tx.ops
			if o["op"] in ("block.move", "block.delete")
			and o["addr"] in st.blocks
			and st.blocks[o["addr"]]["created_seq"] < tx.seq
			and st.team_root(st.blocks[o["addr"]]["author"]) != st.team_root(tx.actor)
		}
		if len(others) > BULK:
			tx.divert.append(("bulk", f"一次删除或移动 {len(others)} 个别人写的块", "human:owner"))
	if tx.divert:
		fresh = load_state()
		pid = f"P{len(fresh.pending) + 1}"
		kind, reason, ref = tx.divert[0]
		ops = []
		for o in tx.ops:
			if o.get("addr") in fresh.blocks:
				o = dict(o, base_version=fresh.blocks[o["addr"]]["version"])
			ops.append(o)
		tx2 = Tx(fresh, tx.actor, f"{tx.summary}（转成待确认 {pid}）", kind="system")
		tx2.push({"op": "pending.create", "id": pid, "kind": kind, "reason": reason, "ops": ops, "decider": ref})
		seq = write_commit(tx2)
		waiting = sorted({o["addr"] for o in ops if o["op"] in ("block.update", "block.move", "block.delete") and o["addr"] in fresh.blocks and fresh.is_task(o["addr"])})
		print(f"已交给 {decider_of(fresh, kind, ref)} 确认（待确认 {pid}）：{reason}。先做不受影响的部分。" + (f"等确认的任务：{', '.join(waiting)}" if waiting else ""))
		return seq
	seq = write_commit(tx)
	touched = {o.get("addr") for o in tx.ops if o.get("addr")} - {None}
	record_reads(tx.actor, st, touched)
	if not quiet:
		for n in tx.notices:
			print(n)
		print(f"#{seq} 已写入（{tx.actor}）")
	return seq


def write_commit(tx: Tx) -> int:
	commit = {
		"seq": tx.seq,
		"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
		"actor": tx.actor,
		"responsible": tx.st.responsible(tx.actor),
		"kind": tx.kind,
		"summary": tx.summary,
		"ops": tx.ops,
	}
	with LOG.open("a", encoding="utf-8") as f:
		f.write(json.dumps(commit, ensure_ascii=False) + "\n")
		f.flush()
		os.fsync(f.fileno())
	return tx.seq


# ---------------------------------------------------------------------------
# 写入


def create_items(tx: Tx, space: str, parent: str | None, items: list[dict], after: str | None = None, basis: bool = True) -> list[str]:
	st = tx.st
	plan: list[tuple[dict, str, str | None]] = []
	titles: dict[str, str] = {}
	taken: set[str] = set()

	def assign(its, par):
		for it in its:
			addr = f"{space}/{new_sid(st, space, taken)}"
			taken.add(addr)
			plan.append((it, addr, par))
			titles.setdefault(first_line(strip_assign(it["content"])).strip(), addr)
			assign(it["children"], addr)

	assign(items, parent)
	aliases: set[str] = set()
	anchor = after
	for it, addr, par in plan:
		props = dict(it["extra"])
		content = it["content"]
		kind = "note"
		if it["box"] is not None:
			kind = "task"
			props["status"] = BOXES[it["box"]]
			m = ASSIGN.search(first_line(content))
			if m:
				props["assignee"] = m.group(1)
				content = strip_assign(content)
			manager_from = next((x for x in ([par, *st.ancestors(par)] if par in st.blocks else []) if st.blocks[x]["props"].get("manager")), None)
			props["manager"] = st.blocks[manager_from]["props"]["manager"] if manager_from else tx.actor
		for k, v in it["props"].items():
			if k == "alias":
				v = assign_alias(st, space, v, taken=aliases)
				aliases.add(v)
				props["alias"] = v
			elif k == "tags":
				props["tags"] = [t.strip() for t in v.split(",") if t.strip()]
			elif k == "due":
				props["due"] = v
		top = par == parent
		op = {"op": "block.create", "addr": addr, "space": space, "parent": par, "kind": kind, "content": content, "props": props,
			  "order": next_order(st, par or f"{space}/", anchor if top else None) if not tx.divert else 0.0}
		guarded(tx, op)
		if tx.divert and top and anchor:
			op["after"] = anchor  # 转成待确认了：确认时照这个位置插
		if tx.divert and it["props"].get("depends"):
			op["depends"] = it["props"]["depends"]
		if top and anchor:
			anchor = addr
		tx.created.append(addr)
	if tx.divert:
		return [a for _, a, _ in plan]
	for it, addr, _ in plan:
		sync_links(tx, addr, titles)
		deps = it["props"].get("depends")
		for ref in re.findall(r"\[\[([^\]]+)\]\]", deps or "") or [r for r in (deps or "").split(",") if r.strip()]:
			try:
				target = resolve(st, ref, titles, space)
			except OutlineError as e:
				raise OutlineError(f"前置 {ref}：{e}") from None
			add_link(tx, addr, "depends", target)
		if basis:
			sync_basis(tx, addr)
	return [a for _, a, _ in plan]


def strip_assign(content: str) -> str:
	head, sep, rest = content.partition("\n")
	head = ASSIGN.sub("", head).rstrip()
	return head + sep + rest


def sync_links(tx: Tx, addr: str, titles: dict | None = None) -> None:
	st = tx.st
	b = st.blocks[addr]
	targets, missing = inline_targets(st, b["content"], titles, b["space"])
	for ref in missing:
		tx.note(f"提示：没找到「{ref}」，[[{ref}]] 按普通文字保留")
	want = set(targets)
	have = {(lk["kind"], lk["target"]): lk for lk in st.links_from(addr) if lk["kind"] in ("link", "embed")}
	for key, lk in have.items():
		if key not in want:
			tx.push({"op": "link.remove", "id": lk["id"]})
	for kind, target in sorted(want - set(have)):
		tx.push({"op": "link.add", "id": tx.link_id(), "from": addr, "kind": kind, "target": target})


def add_link(tx: Tx, frm: str, kind: str, target: str, data: dict | None = None) -> None:
	if kind == "depends" and target in tx.st.blocks and frm in [target, *dependency_chain(tx.st, target)]:
		raise OutlineError("前置不能成环")
	op = {"op": "link.add", "id": tx.link_id(), "from": frm, "kind": kind, "target": target, "data": data or {}}
	if not tx.divert:
		check_policy(tx, op)
	if tx.divert:
		tx.ops.append(op)
	else:
		tx.push(op)


def dependency_chain(st: State, addr: str, seen=None) -> list[str]:
	seen = seen or set()
	out = []
	for lk in st.links_from(addr, "depends"):
		t = lk["target"]
		if t not in seen:
			seen.add(t)
			out.append(t)
			out.extend(dependency_chain(st, t, seen))
	return out


def check_read(tx: Tx, addr: str) -> None:
	"""agent 按它读到的版本修改；别人在那之后改过就拒绝（§6.5）。"""
	b = tx.st.blocks[addr]
	if tx.force or not is_agent(tx.actor):
		return
	seen = tx.reads.get(addr)
	if seen is not None and b["version"] > seen and b["updated_by"] != tx.actor:
		raise OutlineError(f"{addr} 在你读取之后被 {b['updated_by']} 改过。现在的内容：\n{b['content']}\n重新读取后再改，或加 --force。")


# ---------------------------------------------------------------------------
# 渲染：只标例外


def waiting_on(st: State, addr: str) -> list[str]:
	return [lk["target"] for lk in st.links_from(addr, "depends") if st.blocks.get(lk["target"], {}).get("props", {}).get("status") not in ("done", "cancelled")]


def pending_on(st: State, addr: str) -> list[str]:
	return [pid for pid, p in st.pending.items() if p["status"] == "pending" and any(o.get("addr") == addr for o in p["ops"])]


def marks(st: State, addr: str, detail: bool = False) -> list[str]:
	b = st.blocks[addr]
	p = b["props"]
	out = []
	if b["kind"] == "task" and p.get("status") in ("todo", "doing"):
		w = waiting_on(st, addr)
		if w:
			out.append("等前置：" + ",".join(st.blocks[x]["props"].get("alias") or title_of(st.blocks[x])[:12] for x in w))
	if pending_on(st, addr):
		out.append("等确认：" + ",".join(pending_on(st, addr)))
	if p.get("invalid"):
		out.append("不成立：" + p["invalid"][:30])
	changed = anchor_state(st, addr)
	if changed:
		out.append(changed)
	if addr in st.locks:
		out.append("锁定")
	if p.get("archived"):
		out.append("归档")
	in_report = any(st.blocks[x]["props"].get("report") or st.blocks[x]["props"].get("attachment") for x in [addr, *st.ancestors(addr)])
	if detail and b["kind"] != "task" and is_agent(b["author"]) and not has_basis(st, addr) and not in_report and not (p.get("question") or p.get("bundle") or p.get("answer")):
		out.append("无依据")
	if b["deleted"]:
		out.append("已删除")
	return out


def render_line(st: State, addr: str, detail: bool = False) -> str:
	b = st.blocks[addr]
	p = b["props"]
	head, *rest = b["content"].split("\n") if b["content"] else [""]
	box = f"[{BOX_OF.get(p.get('status', 'todo'), ' ')}] " if b["kind"] == "task" else ""
	alias = f"{p['alias']} " if re.fullmatch(r"[A-Za-z]+\d+[a-z]?", p.get("alias") or "") else ""  # Q17、D5 这类编号才显示
	who = f" @{p['assignee']}" if p.get("assignee") else ""
	mk = marks(st, addr, detail)
	line = f"- [{addr}] {box}{alias}{head}{who}" + (f" ‹{'·'.join(mk)}›" if mk else "")
	return "\n".join([line, *[f"  {r}" for r in rest]])


def render_block(st: State, addr: str, depth: int, indent: int = 0, embeds: bool = True, seen=None) -> list[str]:
	seen = seen if seen is not None else set()
	pad = "  " * indent
	lines = [pad + ln for ln in render_line(st, addr).split("\n")]
	deps = [lk["target"] for lk in st.links_from(addr, "depends")]
	if deps:
		lines.append(pad + "  depends:: " + ", ".join(f"[[{st.blocks[d]['props'].get('alias') or title_of(st.blocks[d])[:24]}]]" for d in deps if d in st.blocks))
	if addr in st.traces:
		calls = st.traces[addr]["calls"]
		files = {f for c in calls for f in c["files"]}
		bad = sum(1 for c in calls if not c["ok"])
		lines.append(pad + f"  （运行记录：{st.traces[addr]['agent']} 的 {len(calls)} 次调用，碰过 {len(files)} 个文件，{bad} 次失败）")
	seen.add(addr)
	if embeds:
		for kind, target in inline_targets(st, st.blocks[addr]["content"], None, st.blocks[addr]["space"])[0]:
			if kind == "embed" and target in st.blocks and target not in seen:
				lines.extend(render_block(st, target, 1, indent + 1, False, seen))
	kids = [c for c in st.children(addr) if not st.blocks[c]["props"].get("archived")]
	if depth > 0:
		for c in kids:
			lines.extend(render_block(st, c, depth - 1, indent + 1, embeds, seen))
	elif kids:
		lines.append(f"{pad}  …（{len(kids)} 个子块未展开）")
	return lines


def shown(lines: list[str]) -> list[str]:
	return [m.group(1) for ln in lines if (m := re.match(r"\s*- \[([^\]]+)\]", ln))]


# ---------------------------------------------------------------------------
# 命令


def actor_of(args) -> str:
	return args.actor or os.environ.get("OUTLINE_ACTOR") or "agent:main"


def parent_and_space(st: State, ref: str) -> tuple[str, str | None]:
	ref = ref.strip()
	if ref.rstrip("/") in st.spaces:
		return ref.rstrip("/"), None
	addr = resolve(st, ref)
	return st.blocks[addr]["space"], addr


def cmd_read(args) -> None:
	st = load_state(args.as_of)
	addr = resolve(st, args.addr)
	anc = st.ancestors(addr)
	if anc:
		print("位置：" + " › ".join(title_of(st.blocks[a])[:40] for a in reversed(anc)))
	if args.as_of is not None:
		print(f"（时间机器：第 {args.as_of} 个提交时的样子）")
	lines = render_block(st, addr, args.depth)
	if args.basis:
		for a in shown(lines):
			for lk in st.links_from(a, "basis"):
				lines.append(f"    · {a} 的依据：{lk['target']}" + (f"（{first_line(lk['data'].get('excerpt', ''), 60)}）" if lk["data"].get("excerpt") else ""))
	print("\n".join(lines))
	if args.as_of is None:
		record_reads(actor_of(args), st, shown(lines))


def cmd_pages(args) -> None:
	st = load_state()
	for space in [args.space] if args.space else list(st.spaces):
		sp = st.spaces.get(space)
		if not sp:
			raise OutlineError(f"没有空间 {space}")
		print(f"## {space} · {sp['title']}")
		for a in st.children(f"{space}/"):
			if st.blocks[a]["props"].get("archived"):
				continue
			print(f"- [{a}] {title_of(st.blocks[a])[:50]}（{len(st.subtree(a)) - 1} 个子块）")


def cmd_add(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		space, parent = parent_and_space(st, args.parent)
		if args.md:
			items = parse_outline(sys.stdin.read() if args.md == "-" else Path(args.md).read_text(encoding="utf-8"))
		elif args.text:
			items = [item_from_text(args.text)]
		else:
			raise OutlineError("要么给出文本，要么用 --md")
		after = resolve(st, args.after) if args.after else None
		tx = Tx(st, actor, args.message or f"新增 {len(items)} 条")
		created = create_items(tx, space, parent, items, after)
		finish(tx)
	if not tx.divert:
		for a in created:
			print(f"+ {a}\t{title_of(tx.st.blocks[a])[:60]}")
		lks = [lk for a in created for lk in tx.st.links_from(a, "basis")]
		if lks:
			n_code = sum(1 for lk in lks if lk["target"].startswith("code:"))
			n_trace = sum(1 for lk in lks if lk["target"].startswith("trace:"))
			print(f"依据：代码锚点 {n_code} 处，运行记录 {n_trace} 处，其他 {len(lks) - n_code - n_trace} 处（read --basis 看详情）")


def cmd_edit(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		b = st.blocks[addr]
		tx = Tx(st, actor, args.message or f"修改 {addr}")
		tx.force = args.force
		check_read(tx, addr)
		op: dict = {"op": "block.update", "addr": addr}
		props: dict = {}
		if args.text is not None:
			item = item_from_text(args.text)
			content = item["content"]
			if item["box"] is not None or b["kind"] == "task":
				m = ASSIGN.search(first_line(content))
				if m:
					props["assignee"] = m.group(1)
					content = strip_assign(content)
				if item["box"] is not None:
					args.box = item["box"]
			op["content"] = content
		if args.box is not None:
			if args.box not in BOXES:
				raise OutlineError("--box 只能是 ' '、/、x、-")
			status = BOXES[args.box]
			if b["kind"] != "task":
				op["kind"] = "task"
				props.setdefault("manager", actor)
			if status == "doing":
				owner = b["props"].get("assignee")
				if owner and owner != actor and b["props"].get("status") == "doing" and not args.steal:
					raise OutlineError(f"{owner} 正在做这个任务；确实要接手就加 --steal")
				props.setdefault("assignee", owner or actor)
			props["status"] = status
			owner = b["props"].get("assignee")
			if status != "doing" and owner and owner != actor and b["props"].get("status") == "doing":
				tx.note(f"提示：这个任务原来是 {owner} 在做，已替它改成「{STATUS_ZH[status]}」")
			if status == "done" and is_agent(actor):
				open_kids = [a for a in st.subtree(addr)[1:] if st.is_task(a) and not st.blocks[a]["deleted"] and st.blocks[a]["props"].get("status") in ("todo", "doing")]
				if open_kids:
					tx.note(f"还有 {len(open_kids)} 个子任务没完成，结项时会成为遗留")
		if args.assign:
			props["assignee"] = None if args.assign == "-" else args.assign
		for kv in args.prop or []:
			k, _, v = kv.partition("=")
			if k not in PROP_KEYS or k == "depends":
				raise OutlineError("--prop 能设的有 alias、due、tags（前置写在大纲里：depends:: [[…]]）")
			props[k] = None if v == "" else (assign_alias(st, b["space"], v, addr) if k == "alias" else ([t for t in v.split(",") if t] if k == "tags" else v))
		if props:
			op["props"] = props
		if len(op) == 2:
			raise OutlineError("没有要改的：给出新正文，或 --box、--prop")
		guarded(tx, op)
		if not tx.divert and "content" in op:
			sync_links(tx, addr)
			sync_basis(tx, addr)
		finish(tx)


def cmd_mv(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		space, parent = parent_and_space(st, args.parent)
		if parent and (parent == addr or parent in st.subtree(addr)):
			raise OutlineError("不能把块移到它自己的子树里")
		if space != st.blocks[addr]["space"]:
			raise OutlineError("块不跨空间移动；跨空间请复制")
		after = resolve(st, args.after) if args.after else None
		tx = Tx(st, actor, args.message or f"移动 {addr}")
		guarded(tx, {"op": "block.move", "addr": addr, "parent": parent, "order": next_order(st, parent or f"{space}/", after)})
		finish(tx)


def cmd_rm(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		tx = Tx(st, actor, args.message or f"删除 {addr}")
		for a in reversed(st.subtree(addr)):
			guarded(tx, {"op": "block.delete", "addr": a})
		finish(tx)


def cmd_invalid(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		if not args.undo and not args.reason:
			raise OutlineError("写一句为什么不成立（--reason）")
		tx = Tx(st, actor, args.message or f"{'取消' if args.undo else '标为'}不成立 {addr}")
		guarded(tx, {"op": "block.update", "addr": addr, "props": {"invalid": None if args.undo else args.reason}})
		finish(tx)


def cmd_recheck(args) -> None:
	"""代码已变的块：仍成立就刷新锚点，不成立就标出来（§2.3）。"""
	actor = actor_of(args)
	with locked():
		st = load_state()
		addr = resolve(st, args.addr)
		tx = Tx(st, actor, args.message or f"核实 {addr}：{args.verdict}")
		if args.verdict == "ok":
			for lk in st.links_from(addr, "basis"):
				if lk["target"].startswith("code:"):
					fp, what = anchor_fingerprint(lk["target"])
					if fp is None:
						raise OutlineError(f"{lk['target']} 已经找不到了（{what}），请改写这一块或标为不成立")
					tx.push({"op": "link.remove", "id": lk["id"]})
					tx.push({"op": "link.add", "id": tx.link_id(), "from": addr, "kind": "basis", "target": lk["target"], "data": dict(lk["data"], fp=fp, commit=head_commit())})
		else:
			guarded(tx, {"op": "block.update", "addr": addr, "props": {"invalid": args.reason or "核实时发现不成立"}})
		finish(tx)


def cmd_ask(args) -> None:
	"""问人：问题、选项、建议和理由。结构写在属性里，不靠措辞（§3.3）。"""
	actor = actor_of(args)
	if not args.question:
		return add_recommendation(args, actor)
	with locked():
		st = load_state()
		space, parent = parent_and_space(st, args.parent)
		tx = Tx(st, actor, args.message or f"提问：{args.question[:30]}")
		under = parent
		if args.bundle:
			existing = [c for c in (st.children(parent) if parent else st.children(f"{space}/")) if st.blocks[c]["props"].get("bundle") and title_of(st.blocks[c]) == args.bundle]
			if existing:
				under = existing[0]
			else:
				[under] = create_items(tx, space, parent, [dict(new_item(args.bundle), extra={"bundle": True})], after=resolve(st, args.after) if args.after else None)
		q = dict(new_item(args.question, " "), extra={"question": True})
		q["content"] = args.question
		q["props"] = {"alias": "Q?"}
		children = [dict(new_item(opt), extra={"option": i + 1}) for i, opt in enumerate(args.option or [])]
		if args.recommend:
			rec_text = args.option[int(args.recommend) - 1] if args.recommend.isdigit() and args.option and 0 < int(args.recommend) <= len(args.option) else args.recommend
			rec = new_item(f"建议：{rec_text}" + (f"。{args.reason}" if args.reason else ""))
			rec["extra"] = {"rec": True} | ({"rec_option": int(args.recommend)} if args.recommend.isdigit() else {})
			children.append(rec)
		q["children"] = children
		addrs = create_items(tx, space, under, [q], after=resolve(st, args.after) if args.after and under == parent else None)
		if not tx.divert:
			qa = addrs[0]
			tx.push({"op": "block.update", "addr": qa, "props": {"assignee": args.to, "manager": actor}})
		finish(tx, quiet=True)
	if not tx.divert:
		print(f"已提问 {tx.st.blocks[addrs[0]]['props'].get('alias')}（{addrs[0]}）给 {args.to}" + (f"，放在决策包「{args.bundle}」里" if args.bundle else "") + "；回答回来时会唤醒你")


def add_recommendation(args, actor: str) -> None:
	"""给已有的提问补上选项和建议：`ask Q11 --recommend "…" --reason "…"`。"""
	if not args.recommend and not args.option:
		raise OutlineError("给已有的提问补建议：写 --recommend（可以再加 --option）")
	with locked():
		st = load_state()
		q = resolve(st, args.parent)
		if not st.blocks[q]["props"].get("question"):
			raise OutlineError(f"{args.parent} 不是提问；要新建提问，就在后面写上问题")
		tx = Tx(st, actor, args.message or f"给 {st.blocks[q]['props'].get('alias') or q} 补建议")
		start = len([c for c in st.children(q) if st.blocks[c]["props"].get("option")])
		items = [dict(new_item(opt), extra={"option": start + i + 1}) for i, opt in enumerate(args.option or [])]
		if args.recommend:
			opts = [title_of(st.blocks[c]) for c in st.children(q) if st.blocks[c]["props"].get("option")] + list(args.option or [])
			text = opts[int(args.recommend) - 1] if args.recommend.isdigit() and 0 < int(args.recommend) <= len(opts) else args.recommend
			items.append(dict(new_item(f"建议：{text}" + (f"。{args.reason}" if args.reason else "")), extra={"rec": True}))
		create_items(tx, st.blocks[q]["space"], q, items)
		finish(tx, quiet=True)
	print(f"已给 {st.blocks[q]['props'].get('alias') or q} 补上" + ("建议" if args.recommend else "选项") + "，它会带着建议出现在负责人的收件箱里")


def recommendation(st: State, q: str) -> str | None:
	recs = [c for c in st.children(q) if st.blocks[c]["props"].get("rec")]
	return recs[-1] if recs else None


def open_questions(st: State, who: str) -> list[str]:
	return [a for a, b in st.blocks.items() if b["props"].get("question") and not b["deleted"] and b["props"].get("assignee") == who and b["props"].get("status") in ("todo", "doing")]


def cmd_answer(args) -> None:
	actor = actor_of(args)
	if args.text and (len(args.questions) > 1 or args.bundle or args.tree):
		raise OutlineError("--text 只能回答一条")
	with locked():
		st = load_state()
		qs = [resolve(st, r) for r in args.questions]
		for tname in args.tree or []:
			root = resolve(st, tname)
			qs += [x for x in st.subtree(root) if st.blocks[x]["props"].get("question") and st.blocks[x]["props"].get("status") in ("todo", "doing")]
		for bname in args.bundle or []:
			bundle = resolve(st, bname)
			qs += [c for c in st.children(bundle) if st.blocks[c]["props"].get("question") and st.blocks[c]["props"].get("status") in ("todo", "doing")]
		if not qs:
			raise OutlineError("没有要回答的提问")
		tx = Tx(st, actor, args.message or f"回答 {'、'.join(st.blocks[q]['props'].get('alias') or q for q in qs)}")
		done = []
		for q in qs:
			b = st.blocks[q]
			name = b["props"].get("alias") or q
			if not b["props"].get("question"):
				raise OutlineError(f"{name} 不是提问")
			if b["props"].get("status") in ("done", "cancelled"):
				raise OutlineError(f"{name} 已经回答过了")
			owner = b["props"].get("assignee")
			if owner and not is_agent(owner) and actor != owner:
				raise OutlineError(f"{name} 要由 {owner} 回答；转述本人的回答时用 --as {owner}")
			rec = recommendation(st, q)
			if args.option:
				opts = [c for c in st.children(q) if st.blocks[c]["props"].get("option") == args.option]
				if not opts:
					raise OutlineError(f"{name} 没有第 {args.option} 个选项")
				text = f"回答：选 [[{opts[0]}]]"
			elif args.text:
				text = f"回答：{args.text}"
			elif rec:
				text = f"回答：采纳建议 [[{rec}]]"
			else:
				raise OutlineError(f"{name} 没有建议，用 --text 或 --option 回答")
			[ans] = create_items(tx, b["space"], q, [dict(new_item(text), extra={"answer": True})])
			tx.push({"op": "link.add", "id": tx.link_id(), "from": q, "kind": "basis", "target": ans, "data": {"human": actor}})
			guarded(tx, {"op": "block.update", "addr": q, "props": {"status": "done"}})
			if rec and not args.text and not args.option:
				tx.push({"op": "block.update", "addr": rec, "props": {"adopted": True}})
			done.append(name)
		finish(tx)
	print(f"已回答 {'、'.join(done)}")


def cmd_bundle(args) -> None:
	"""把几条相关的提问编成一个决策包，人可以一次回答一整包（§3.3）。"""
	actor = actor_of(args)
	with locked():
		st = load_state()
		qs = [resolve(st, r) for r in args.questions]
		for q in qs:
			if not st.blocks[q]["props"].get("question"):
				raise OutlineError(f"{q} 不是提问")
		parent = st.blocks[qs[0]]["parent"]
		space = st.blocks[qs[0]]["space"]
		tx = Tx(st, actor, args.message or f"编成决策包「{args.name}」")
		existing = [c for c in (st.children(parent) if parent else st.children(f"{space}/")) if st.blocks[c]["props"].get("bundle") and title_of(st.blocks[c]) == args.name]
		if existing:
			bundle = existing[0]
		else:
			[bundle] = create_items(tx, space, parent, [dict(new_item(args.name), extra={"bundle": True})], after=st.children(parent)[0] if parent and st.children(parent) else None)
		for q in qs:
			guarded(tx, {"op": "block.move", "addr": q, "parent": bundle, "order": next_order(st, bundle, None)})
		finish(tx)


def cmd_lock(args) -> None:
	actor = actor_of(args)
	with locked():
		st = load_state()
		root = resolve(st, args.addr)
		b = st.blocks[root]
		if b["kind"] != "task":
			raise OutlineError("只能锁定任务（计划的根）")
		if is_agent(actor) and actor not in (b["author"], b["props"].get("manager")):
			raise OutlineError("只有人、计划的作者或它的管理者能锁定")
		tx = Tx(st, actor, args.message or f"{'解锁' if args.unlock else '锁定'} {title_of(b)[:20]}", kind="lock")
		if args.unlock:
			lk = st.locks.get(root)
			if not lk:
				raise OutlineError("它没有被锁定")
			if is_agent(actor) and actor != lk["locker"]:
				raise OutlineError(f"只有锁定人 {lk['locker']} 能解锁")
			tx.push({"op": "lock.clear", "root": root})
		else:
			skeleton = {a: any(st.is_task(c) for c in st.children(a)) for a in st.subtree(root) if st.is_task(a)}
			tx.push({"op": "lock.set", "root": root, "locker": actor, "delegate": args.delegate, "skeleton": skeleton})
		finish(tx)
	print(f"{'已解锁' if args.unlock else '已锁定'} {root}" + ("" if args.unlock else f"（{sum(1 for _ in skeleton)} 个任务；改步骤会先交给 {actor}" + (f" 或 {args.delegate}" if args.delegate else "") + " 确认）"))


def cmd_pending(args) -> None:
	st = load_state()
	if args.id:
		p = st.pending.get(args.id)
		if not p:
			raise OutlineError(f"没有 {args.id}")
		print(f"{p['id']} [{p['status']}] {p['reason']}（{p['requested_by']} 提出，交给 {decider_of(st, p['kind'], p['decider'])}）")
		for op in p["ops"]:
			print("  · " + describe_op(st, op))
		return
	rows = [p for p in st.pending.values() if args.all or p["status"] == "pending"]
	for p in rows:
		print(f"- {p['id']} [{p['status']}] {p['reason']}（{p['requested_by']}，交给 {decider_of(st, p['kind'], p['decider'])}）")
	if not rows:
		print("没有待确认的改动")
	stats: dict[str, list[int]] = {}
	for p in st.pending.values():
		s = stats.setdefault(p["kind"], [0, 0])
		if p["status"] == "confirmed":
			s[0] += 1
		elif p["status"] == "rejected":
			s[1] += 1
	decided = {k: v for k, v in stats.items() if sum(v)}
	if decided:
		print("原样通过率：" + "；".join(f"{k} {a}/{a + r}" for k, (a, r) in decided.items()))


def describe_op(st: State, op: dict) -> str:
	t = op["op"]
	if t == "block.create":
		p = op.get("props") or {}
		box = f"[{BOX_OF.get(p.get('status'), ' ')}] " if op.get("kind") == "task" else ""
		where = f"，接在 {op['after']} 后面" if op.get("after") else ""
		return f"新增 {op['addr']} 于 {op.get('parent') or op['space'] + '/'}{where}：{box}{first_line(op.get('content', ''), 60)}" + (f" @{p['assignee']}" if p.get("assignee") else "")
	if t == "block.update":
		parts = []
		if "content" in op:
			parts.append(f"正文 → {first_line(op['content'], 60)}")
		if op.get("props"):
			parts.append("，".join(f"{k}={v}" for k, v in op["props"].items()))
		return f"修改 {op['addr']}：" + "；".join(parts)
	if t == "block.move":
		return f"移动 {op['addr']} → {op.get('parent') or '顶层'}"
	if t == "block.delete":
		return f"删除 {op['addr']}"
	if t == "link.add":
		return f"{LINK_ZH.get(op['kind'], op['kind'])} {op['from']} → {op['target']}"
	return t


def cmd_decide(args) -> None:
	actor = actor_of(args)
	confirm = args.cmd == "confirm"
	with locked():
		st = load_state()
		p = st.pending.get(args.id)
		if not p:
			raise OutlineError(f"没有 {args.id}")
		if p["status"] != "pending":
			raise OutlineError(f"{args.id} 已经是 {p['status']}")
		if not can_decide(st, actor, p):
			raise OutlineError(f"{actor} 不能决定 {args.id}：" + ("不能确认自己提的" if actor == p["requested_by"] else f"交给的是 {decider_of(st, p['kind'], p['decider'])}"))
		tx = Tx(st, actor, f"{'确认' if confirm else '退回'} {args.id}", kind="system")
		if confirm:
			for op in p["ops"]:
				base = op.get("base_version")
				if base is not None and op["addr"] in st.blocks and st.blocks[op["addr"]]["version"] != base:
					raise OutlineError(f"{op['addr']} 在提出之后又被改过，请重新提出")
			deps = []
			for op in p["ops"]:
				clean = {k: v for k, v in op.items() if k not in ("base_version", "depends")}
				if clean["op"] == "block.create":
					after = clean.pop("after", None)
					pkey = clean.get("parent") or f"{clean['space']}/"
					clean["order"] = next_order(st, pkey, after)
					if op.get("depends"):
						deps.append((clean["addr"], op["depends"]))
				tx.push(clean)
			for op in p["ops"]:
				if op["op"] in ("block.create", "block.update") and op["addr"] in st.blocks:
					sync_links(tx, op["addr"])
					sync_basis(tx, op["addr"])
			for addr, raw in deps:
				for ref in re.findall(r"\[\[([^\]]+)\]\]", raw) or [r for r in raw.split(",") if r.strip()]:
					add_link(tx, addr, "depends", resolve(st, ref, None, st.blocks[addr]["space"]))
		tx.push({"op": "pending.decide", "id": p["id"], "status": "confirmed" if confirm else "rejected", "note": args.note or ""})
		finish(tx, quiet=True)
	print(f"{args.id} 已{'确认' if confirm else '退回'}" + (f"（由 {actor} 确认，责任人 {st.responsible(actor)}）" if is_agent(actor) else ""))


def cmd_board(args) -> None:
	st = load_state()
	pool = st.subtree(resolve(st, args.under)) if args.under else list(st.blocks)
	tasks = [a for a in pool if st.is_task(a) and not st.blocks[a]["deleted"] and not st.blocks[a]["props"].get("question")]
	print("\n".join(board_lines(st, tasks)))


def board_lines(st: State, tasks: list[str]) -> list[str]:
	lines = []
	for status in ("doing", "todo", "done", "cancelled"):
		group = [a for a in tasks if st.blocks[a]["props"].get("status", "todo") == status]
		if not group:
			continue
		lines.append(f"### {STATUS_ZH[status]}（{len(group)}）")
		for a in group:
			par = st.blocks[a]["parent"]
			where = f" ← {st.blocks[par]['props'].get('alias') or title_of(st.blocks[par])[:16]}" if par else ""
			lines.append(render_line(st, a).split("\n")[0] + where)
		lines.append("")
	return lines or ["（没有任务）"]


def decision_groups(st: State, qs: list[str]) -> dict[str, list[str]]:
	"""每件事的根：最上层的未答提问，或决策包。挂在一条提问下面的细项和包都算这一件。"""
	groups: dict[str, list[str]] = {}
	for q in qs:
		anc = [x for x in st.ancestors(q) if st.blocks[x]["props"].get("question") and st.blocks[x]["props"].get("status") in ("todo", "doing")]
		if anc:
			key = anc[-1]
		else:
			par = st.blocks[q]["parent"]
			key = par if par and st.blocks[par]["props"].get("bundle") else q
		groups.setdefault(key, []).append(q)
	return groups


def inbox_lines(st: State, who: str) -> list[str]:
	lines = []
	pend = [p for p in st.pending.values() if p["status"] == "pending" and can_decide(st, who, p)]
	if pend:
		lines.append(f"### 待你确认的改动（{len(pend)}）")
		lines += [f"- {p['id']} {p['reason']}（{p['requested_by']} 提出，{len(p['ops'])} 个操作）" for p in pend]
		lines.append("")
	qs = open_questions(st, who)
	if qs:
		groups = decision_groups(st, qs)
		lines.append(f"### 等你决定（{len(groups)} 件）")
		for key, group in sorted(groups.items(), key=lambda kv: -len(kv[1])):
			kb = st.blocks[key]
			name = (kb["props"].get("alias") + " " if kb["props"].get("alias") else "") + title_of(kb)[:60]
			if len(group) == 1:
				rec = recommendation(st, key)
				lines.append(f"- {name}" + (f"\n  {title_of(st.blocks[rec])[:90]}" if rec else "（还没有建议）"))
				continue
			with_rec = sum(1 for q in group if recommendation(st, q))
			how = f"answer --tree {key}" if kb["props"].get("question") else f"answer --bundle {key}"
			lines.append(f"- {name}：{len(group)} 条，{with_rec} 条有建议 → 全部采纳：`outline.py --as {who} {how}`")
			for q in group:
				rec = recommendation(st, q)
				lines.append(f"  - {st.blocks[q]['props'].get('alias', '')} {title_of(st.blocks[q])[:60]}" + (f"\n    {title_of(st.blocks[rec])[:80]}" if rec else ""))
		lines.append("")
	return lines or ["收件箱是空的"]


def cmd_inbox(args) -> None:
	print("\n".join(inbox_lines(load_state(), args.who or actor_of(args))))


def digest_lines(st: State, since: int) -> list[str]:
	"""汇报：这段时间变了什么、什么在等你（§3.4）。"""
	old = load_state(since)
	new_blocks = [a for a, b in st.blocks.items() if a not in old.blocks and not b["deleted"]]
	by_page: dict[str, list[str]] = {}
	for a in new_blocks:
		by_page.setdefault(st.page_of(a), []).append(a)
	lines = [f"## 从第 {since} 个提交到第 {st.seq} 个", ""]
	if by_page:
		lines.append("**新内容**")
		for page, addrs in sorted(by_page.items(), key=lambda kv: -len(kv[1])):
			tops = [a for a in addrs if st.blocks[a]["parent"] not in addrs][:3]
			lines.append(f"- {title_of(st.blocks[page])[:30]}：{len(addrs)} 块，" + "；".join(f"[{a}] {title_of(st.blocks[a])[:40]}" for a in tops))
	done = [a for a, b in st.blocks.items() if b["kind"] == "task" and b["props"].get("status") == "done" and (a not in old.blocks or old.blocks[a]["props"].get("status") != "done") and not b["props"].get("question")]
	if done:
		lines.append("**完成的任务**")
		lines += [f"- [{a}] {title_of(st.blocks[a])[:60]}" + (f" @{st.blocks[a]['props']['assignee']}" if st.blocks[a]["props"].get("assignee") else "") for a in done]
	inval = [a for a, b in st.blocks.items() if b["props"].get("invalid") and not (a in old.blocks and old.blocks[a]["props"].get("invalid"))]
	if inval:
		lines.append("**标为不成立**")
		lines += [f"- [{a}] {title_of(st.blocks[a])[:50]}：{st.blocks[a]['props']['invalid'][:40]}" for a in inval]
	pend = [p for p in st.pending.values() if p["status"] == "pending"]
	groups = decision_groups(st, open_questions(st, "human:owner"))
	lines.append(f"**等你决定**：{len(pend)} 条待确认，{len(groups)} 件要回答的事（`outline.py inbox --who human:owner` 看详情）")
	return lines


def cmd_digest(args) -> None:
	st = load_state()
	print("\n".join(digest_lines(st, args.since if args.since is not None else max(0, st.seq - 20))))


def cmd_search(args) -> None:
	st = load_state()
	include = set((args.include or "").split(","))
	terms = [t.lower() for t in " ".join(args.query).split() if t]
	scored = []
	for a, b in st.blocks.items():
		if b["deleted"] or (b["props"].get("invalid") and "invalid" not in include):
			continue
		if any(st.blocks[x]["props"].get("archived") for x in [a, *st.ancestors(a)]) and "archived" not in include:
			continue
		text = b["content"].lower()
		crumbs = " ".join(st.blocks[x]["content"].lower() for x in st.ancestors(a))
		if not all(t in text or t in crumbs for t in terms):
			continue
		score = sum(text.count(t) * 2 + crumbs.count(t) * 0.5 for t in terms)
		if not score:
			continue
		if b["kind"] != "task" and is_agent(b["author"]) and not has_basis(st, a):
			score *= 0.6
		if anchor_state(st, a):
			score *= 0.7
		scored.append((score, a))
	scored.sort(reverse=True)
	for _, a in scored[: args.limit]:
		crumb = " › ".join(title_of(st.blocks[x])[:14] for x in reversed(st.ancestors(a)))
		print(render_line(st, a, detail=True).split("\n")[0] + (f"\n    在：{crumb}" if crumb else ""))
	if not scored:
		print("（没有结果）")
	record_reads(actor_of(args), st, [a for _, a in scored[: args.limit]])


def cmd_backlinks(args) -> None:
	st = load_state()
	addr = resolve(st, args.addr)
	rows = st.links_to(addr)
	for lk in rows:
		src = st.blocks.get(lk["from"])
		print(f"- [{lk['from']}] —{LINK_ZH[lk['kind']]}→ 本块：{title_of(src)[:60] if src else ''}")
	if not rows:
		print("（没有反链）")


def cmd_log(args) -> None:
	st = load_state()
	rows = [c for c in st.commits if c["seq"] >= args.since][: args.n] if args.since else st.commits[-args.n :]
	for c in rows:
		print(f"#{c['seq']} {c['ts'][:16]} {c['actor']}：{c['summary']}（{len(c['ops'])} 个操作）")


def cmd_diff(args) -> None:
	a_st, b_st = load_state(args.a), load_state(args.b)
	lines = []
	for addr, blk in b_st.blocks.items():
		old = a_st.blocks.get(addr)
		if old is None or (old["deleted"] and not blk["deleted"]):
			lines.append(f"+ [{addr}] {title_of(blk)[:70]}")
		elif blk["deleted"] and not old["deleted"]:
			lines.append(f"- [{addr}] {title_of(old)[:70]}")
		else:
			if old["content"] != blk["content"]:
				lines.append(f"~ [{addr}] {title_of(old)[:40]} → {title_of(blk)[:40]}")
			if old["parent"] != blk["parent"]:
				lines.append(f"↷ [{addr}] 移到 {blk['parent'] or '顶层'}")
			changed = {k for k in set(old["props"]) | set(blk["props"]) if old["props"].get(k) != blk["props"].get(k)}
			if changed:
				lines.append(f"• [{addr}] " + ", ".join(f"{k}: {old['props'].get(k)} → {blk['props'].get(k)}" for k in sorted(changed)))
	print(f"第 {args.a} → 第 {args.b} 个提交之间：")
	print("\n".join(lines) if lines else "（没有变化）")


def cmd_fresh(args) -> None:
	st = load_state()
	cache = {}
	changed: dict[str, list[str]] = {}
	n = 0
	for lk in st.links.values():
		if lk.get("removed") or lk["kind"] != "basis" or not lk["target"].startswith("code:"):
			continue
		n += 1
		fp, what = anchor_fingerprint(lk["target"])
		state = "gone" if fp is None else ("ok" if fp == lk["data"].get("fp") else "changed")
		if state == "changed" and lk["data"].get("snippet"):
			text = read_worktree(re.sub(r":\d+(?:-\d+)?$", "", lk["target"][5:])) or ""
			norm = "\n".join(ln.strip() for ln in text.splitlines() if ln.strip())
			if lk["data"]["snippet"] in norm:
				state, what = "ok", "原文还在，只是挪了位置"
		cache[lk["id"]] = {"state": state, "why": what}
		if state != "ok":
			changed.setdefault(lk["from"], []).append(f"{lk['target']}：{'找不到了' if state == 'gone' else '变了'}（{what}）")
	_local("anchors.json").write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
	print(f"检查了 {n} 处代码锚点（对照工作区，HEAD {head_commit()}）：" + ("全部没变" if not changed else f"{len(changed)} 个块的代码已变"))
	for addr, why in changed.items():
		print(f"- [{addr}] {title_of(st.blocks[addr])[:60]}")
		for w in why:
			print(f"    {w}")


# ---------------------------------------------------------------------------
# 系统命令：初始化、导入第一版、登记参与者、挂报告、导入运行记录、导出


def cmd_init(args) -> None:
	with locked():
		st = load_state()
		if st.commits:
			raise OutlineError("已经初始化过了")
		tx = Tx(st, "human:owner", "初始化", kind="system")
		tx.push({"op": "actor.register", "actor": "human:owner", "kind": "human", "label": "项目负责人"})
		tx.push({"op": "actor.register", "actor": "agent:main", "kind": "agent", "creator": "human:owner", "label": "主会话"})
		tx.push({"op": "space.create", "space": "p", "kind": "project", "title": "NarraFork", "owner": "human:owner"})
		tx.push({"op": "space.create", "space": "me", "kind": "personal", "title": "负责人的个人空间", "owner": "human:owner"})
		finish(tx)


def cmd_actor(args) -> None:
	with locked():
		st = load_state()
		if args.name in st.actors:
			raise OutlineError(f"{args.name} 已存在")
		tx = Tx(st, actor_of(args), f"登记 {args.name}", kind="system")
		tx.push({"op": "actor.register", "actor": args.name, "kind": "agent" if is_agent(args.name) else "human", "creator": args.creator, "label": args.label})
		finish(tx)


V1_STATUS = {"todo": "todo", "doing": "doing", "blocked": "todo", "submitted": "done", "done": "done", "cancelled": "cancelled"}
V1_LINK = {"evidence": "basis", "based_on": "basis", "source": "source", "blocked_by": "depends", "supersedes": "link", "same_as": "link"}


def cmd_import_v1(args) -> None:
	"""把第一版的当前状态导成一个提交：不带历史（设计文档 §8 的迁移方式）。"""
	sys.path.insert(0, str(Path(args.v1).resolve().parent.parent))
	os.environ["OUTLINE_DATA"] = str(Path(args.v1).resolve().parent)
	import importlib.util

	spec = importlib.util.spec_from_file_location("outline_v1", Path(args.v1).resolve().parent.parent / "outline.py")
	v1 = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(v1)
	old = v1.load_state()
	with locked():
		st = load_state()
		if st.commits:
			raise OutlineError("只能导入到空的日志")
		tx = Tx(st, "agent:main", f"从第一版导入当前状态（第一版第 {old.seq} 个提交，不带历史）", kind="system")
		for name, a in old.actors.items():
			tx.push({"op": "actor.register", "actor": name, "kind": a.get("kind"), "creator": a.get("creator"), "label": a.get("label")})
		scope_pages = {a for a, b in old.blocks.items() if b["props"].get("alias") == "范围"}
		for name, sp in old.spaces.items():
			if name.startswith("s."):
				continue  # 第一版的会话空间只放了范围页，第二版的关注范围不再是一页大纲
			tx.push({"op": "space.create", "space": name, "kind": sp.get("kind"), "title": sp.get("title"), "owner": sp.get("owner")})
		keep = [a for a, b in old.blocks.items() if not b["deleted"] and b["space"] in old.spaces and not b["space"].startswith("s.") and a not in scope_pages]
		keep.sort(key=lambda a: (len(old.ancestors(a)), old.blocks[a]["created_seq"]))
		for a in keep:
			b = old.blocks[a]
			p = b["props"]
			tags = list(p.get("tags") or [])
			props: dict = {}
			kind = "task" if b["kind"] == "task" else "note"
			if kind == "task":
				props["status"] = V1_STATUS.get(p.get("status", "todo"), "todo")
				for k_old, k_new in (("owner", "assignee"), ("manager", "manager")):
					if p.get(k_old):
						props[k_new] = p[k_old]
			for k in ("alias", "archived", "due"):
				if p.get(k):
					props[k] = p[k]
			if b["kind"] == "assertion" and p.get("stance") == "refuted":
				props["invalid"] = "第一版标为否定"
			for tag, flag in (("提问", "question"), ("建议", "rec"), ("回答", "answer"), ("报告", "report"), ("附件", "attachment")):
				if tag in tags:
					props[flag] = True
					tags.remove(tag)
			if tags:
				props["tags"] = tags
			if p.get("status") == "blocked" and p.get("blocked_reason"):
				props["waiting_note"] = p["blocked_reason"]
			tx.push({"op": "block.create", "addr": a, "space": b["space"], "parent": b["parent"], "order": b["order"], "kind": kind, "content": b["content"], "props": props, "author": b["author"]})
		for lk in old.links.values():
			if lk.get("removed") or lk["from"] not in tx.st.blocks:
				continue
			kind = V1_LINK.get(lk["role"])
			if not kind or (kind != "basis" and lk["target"] not in tx.st.blocks and not lk["target"].startswith(("code:", "url:", "file:"))):
				continue
			data = {k: v for k, v in lk["data"].items() if k in ("fp", "excerpt", "what", "sha1", "commit")}
			if lk["target"].startswith("code:"):
				fp, _ = anchor_fingerprint(lk["target"])
				if fp:
					data.update(fp=fp, commit=head_commit())
			tx.push({"op": "link.add", "id": tx.link_id(), "from": lk["from"], "kind": kind, "target": lk["target"], "data": data})
		for a in keep:
			sync_links(tx, a)
		for cr in old.crs.values():
			if cr["status"] != "pending":
				continue
			ops = []
			for op in cr["ops"]:
				op = dict(op)
				if op["op"] == "block.create":
					op["kind"] = "task" if op.get("kind") == "task" else "note"
					op["props"] = {k: v for k, v in (op.get("props") or {}).items() if k not in ("stance",)}
				if op["op"] == "link.add":
					op["kind"] = V1_LINK.get(op.pop("role", ""), "link")
				ops.append(op)
			kind = "personal" if cr["kind"] == "proposal" and any(o.get("space") == "me" for o in cr["ops"]) else "lock"
			tx.push({"op": "pending.create", "id": f"P{len(tx.st.pending) + 1}", "kind": kind, "reason": cr["reason"], "ops": ops, "decider": "human:owner" if kind == "personal" else cr["decider"].get("root", "human:owner")})
		finish(tx)
	print(f"导入了 {len(keep)} 个块、{sum(1 for o in tx.ops if o['op'] == 'link.add')} 条链接；丢掉第一版的范围页和会话空间（{len(scope_pages)} 页）")


def cmd_attach(args) -> None:
	"""系统动作：子代理结束时把报告原文挂到它的任务下，只按 markdown 语法转成子块（§4.4）。"""
	src = Path(args.file)
	raw = src.read_bytes()
	if len(raw) > 512 * 1024:
		raise OutlineError("报告超过 512KB")
	items = md_to_items(raw.decode("utf-8", errors="replace"))
	root = items[0] if len(items) == 1 and items[0]["children"] else dict(new_item(args.title or src.stem), children=items)
	root["extra"] = {"report": True}
	with locked():
		st = load_state()
		task = resolve(st, args.task)
		tx = Tx(st, args.author, f"挂上 {args.author} 的报告", kind="system")
		[addr, *rest] = create_items(tx, st.blocks[task]["space"], task, [root])
		finish(tx, quiet=True)
	print(f"已挂上 [{addr}] {title_of(tx.st.blocks[addr])[:50]}：{len(rest) + 1} 个块")


MD_FENCE = re.compile(r"^(\s*)(`{3,}|~{3,})")
MD_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
MD_LIST = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
MD_HR = re.compile(r"^([-*_])(\s*\1){2,}$")


def md_to_items(text: str) -> list[dict]:
	"""只按 markdown 语法转：标题成为父块，段落、表格、代码、引用各成一块，列表按缩进嵌套；
	紧跟段落（中间没有空行）的列表挂在那个段落下面。不看措辞。"""
	lines = text.splitlines()
	toks: list[dict] = []
	i, gap = 0, False

	def starts_block(ln: str) -> bool:
		s = ln.strip()
		return not s or bool(MD_FENCE.match(ln) or MD_HEADING.match(s) or MD_LIST.match(ln) or MD_HR.match(s) or s[0] in "|>")

	while i < len(lines):
		ln, s = lines[i], lines[i].strip()
		ind = len(ln) - len(ln.lstrip(" "))
		if not s:
			gap, i = True, i + 1
			continue
		tok = {"indent": ind, "gap": gap}
		if fm := MD_FENCE.match(ln):
			fence, j = fm.group(2), i + 1
			while j < len(lines) and not re.fullmatch(re.escape(fence[0]) + "{%d,}" % len(fence), lines[j].strip()):
				j += 1
			tok.update(type="code", content="\n".join(x[ind:] if x[:ind].strip() == "" else x.strip() for x in lines[i : j + 1]))
			i = j + 1
		elif (hm := MD_HEADING.match(s)) and ind < 4:
			tok.update(type="heading", level=len(hm.group(1)), content=hm.group(2))
			i += 1
		elif MD_HR.match(s):
			gap, i = False, i + 1
			continue
		elif s[0] in "|>":
			j = i
			while j < len(lines) and lines[j].strip()[:1] == s[0]:
				j += 1
			tok.update(type="table" if s[0] == "|" else "quote", content="\n".join(x.strip() for x in lines[i:j]))
			i = j
		else:
			lm = MD_LIST.match(ln)
			body, j = [lm.group(3) if lm else s], i + 1
			while j < len(lines) and not starts_block(lines[j]):
				body.append(lines[j].strip())
				j += 1
			tok.update(type="list" if lm else "para", content="\n".join(body))
			i = j
		toks.append(tok)
		gap = False

	roots: list[dict] = []
	heads: list[tuple[int, dict]] = []
	stack: list[tuple[int, dict]] = []
	label: dict | None = None
	list_parent: list | None = None
	for t in toks:
		section = heads[-1][1]["children"] if heads else roots
		if t["type"] == "heading":
			while heads and heads[-1][0] >= t["level"]:
				heads.pop()
			it = new_item(t["content"])
			(heads[-1][1]["children"] if heads else roots).append(it)
			heads.append((t["level"], it))
			stack, label, list_parent = [], None, None
			continue
		while stack and stack[-1][0] >= t["indent"]:
			stack.pop()
		it = new_item(t["content"])
		if t["type"] == "list":
			if stack:
				stack[-1][1]["children"].append(it)
			else:
				if list_parent is None:
					list_parent = label["children"] if label is not None and not t["gap"] else section
				list_parent.append(it)
			stack.append((t["indent"], it))
			continue
		if stack:
			stack[-1][1]["children"].append(it)
			continue
		section.append(it)
		list_parent = None
		label = it if t["type"] == "para" else None
	return roots


def parse_transcript(path: Path) -> list[dict]:
	"""把一次子代理运行的记录转成调用列表：工具、目标、碰过的文件、成败、结果摘录。"""
	uses: dict[str, tuple[str, dict]] = {}
	order: list[str] = []
	results: dict[str, tuple[str, bool]] = {}
	root = repo_root()
	with path.open(encoding="utf-8") as f:
		for line in f:
			try:
				ev = json.loads(line)
			except json.JSONDecodeError:
				continue
			content = (ev.get("message") or {}).get("content")
			if not isinstance(content, list):
				continue
			for c in content:
				if not isinstance(c, dict):
					continue
				if c.get("type") == "tool_use" and c.get("name") not in ("SubagentHandback", "TodoWrite", "TaskCreate", "TaskUpdate"):
					uses[c["id"]] = (c.get("name", "?"), c.get("input") or {})
					order.append(c["id"])
				elif c.get("type") == "tool_result":
					body = c.get("content")
					if isinstance(body, list):
						body = "\n".join(x.get("text", "") for x in body if isinstance(x, dict))
					results[c.get("tool_use_id", "")] = (str(body or ""), bool(c.get("is_error")))

	def repo_paths(text: str) -> set[str]:
		out = set()
		try:
			tokens = shlex.split(text)
		except ValueError:
			tokens = text.split()
		for tok in tokens:
			for part in re.split(r"[\s;|&><()]+", tok):
				part = part.strip("'\"`,").split(":")[0]
				if "/" not in part:
					continue
				p = Path(part)
				try:
					rel = (p if p.is_absolute() else root / p).resolve().relative_to(root)
				except (ValueError, OSError):
					continue
				if (root / rel).is_file():
					out.add(str(rel))
		return out

	calls = []
	for n, uid in enumerate(order, 1):
		name, inp = uses[uid]
		res, err = results.get(uid, ("", False))
		target = str(inp.get("file_path") or inp.get("command") or inp.get("pattern") or inp.get("path") or json.dumps(inp, ensure_ascii=False))
		files = repo_paths(target) if name == "Bash" else repo_paths(str(inp.get("file_path") or inp.get("path") or ""))
		calls.append({"n": n, "tool": name, "target": target[:300], "files": sorted(files)[:20], "ranges": read_ranges(name, inp, target, res, files, repo_paths), "ok": not err, "excerpt": res.strip()[:300]})
	return calls[:400]


WHOLE = 10**9


def read_ranges(name: str, inp: dict, cmd: str, res: str, files: set[str], repo_paths=None) -> dict[str, list[list[int]]]:
	"""这次调用读到了文件的哪些行：Read 的 offset/limit、sed -n、head、cat，以及 grep -n 输出里的行号。"""
	out: dict[str, list[list[int]]] = {}
	if not files:
		return out
	if name == "Read":
		off, lim = int(inp.get("offset") or 1), inp.get("limit")
		return {f: [[off, off + int(lim) - 1] if lim else [1, WHOLE]] for f in files}
	if name != "Bash":
		return out
	# 按 ; && || 换行切成几段，每段只碰一个文件时，段里的行号才能确定属于它
	segs = [x for x in re.split(r"\s*(?:;|&&|\|\||\n)\s*", cmd) if x.strip()]
	for f in files:
		rngs: list[list[int]] = []
		for seg in segs:
			if repo_paths is not None and repo_paths(seg) != {f}:
				continue
			rngs += [[int(a), int(b)] for a, b in re.findall(r"sed\s+-n\s+['\"]?(\d+),(\d+)p", seg)]
			rngs += [[int(a), int(b)] for a, b in re.findall(r"NR\s*>=\s*(\d+)\s*&&\s*NR\s*<=\s*(\d+)", seg)]
			if m := re.search(r"\bhead\s+-n?\s*(\d+)", seg):
				rngs.append([1, int(m.group(1))])
			if re.match(r"\s*(?:cat|nl|less)\s", seg) and not re.search(r"sed|head|tail|grep|awk", seg):
				rngs.append([1, WHOLE])
		if len(files) == 1 and len(segs) == 1:  # 输出里的行号只在单个文件、单段命令时可信
			rngs += [[int(x), int(x)] for x in re.findall(r"(?m)^\s*(\d+)[:-]", res)][:40]
		rngs += [[int(x), int(x)] for x in re.findall(rf"(?m)^(?:\./)?{re.escape(f)}[:-](\d+)[:-]", res)][:40]
		if rngs:
			out[f] = rngs[:60]
	return out


def cmd_trace(args) -> None:
	"""系统动作：把子代理这次运行的记录挂到它的任务上，作为依据的来源（§2.3）。"""
	calls = parse_transcript(Path(args.file))
	with locked():
		st = load_state()
		task = resolve(st, args.task)
		tx = Tx(st, args.agent, f"挂上 {args.agent} 的运行记录（{len(calls)} 次调用）", kind="system")
		tx.push({"op": "trace.add", "task": task, "agent": args.agent, "calls": calls})
		finish(tx, quiet=True)
	files = {f for c in calls for f in c["files"]}
	print(f"已挂上运行记录：{len(calls)} 次调用，碰过 {len(files)} 个仓库文件，{sum(1 for c in calls if not c['ok'])} 次失败")


def cmd_export(args) -> None:
	st = load_state()
	EXPORTS.mkdir(parents=True, exist_ok=True)
	header = f"<!-- 由 prototypes/outline2/outline.py export 生成（第 {st.seq} 个提交）。真相源是 data/log.jsonl，不要手改。 -->\n\n"
	ov = [header + "# 大纲总览\n"]
	for space, sp in st.spaces.items():
		ov.append(f"## {space} · {sp['title']}\n")
		for a in st.children(f"{space}/"):
			ov.append("\n".join(render_block(st, a, 50)) + "\n")
	(EXPORTS / "overview.md").write_text("\n".join(ov), encoding="utf-8")
	tasks = [a for a in st.blocks if st.is_task(a) and not st.blocks[a]["deleted"] and not st.blocks[a]["props"].get("question")]
	(EXPORTS / "board.md").write_text(header + "# 任务看板\n\n" + "\n".join(board_lines(st, tasks)) + "\n", encoding="utf-8")
	(EXPORTS / "inbox.md").write_text(header + "# 负责人的收件箱\n\n" + "\n".join(inbox_lines(st, "human:owner")) + "\n", encoding="utf-8")
	data = json.dumps({"commits": st.commits}, ensure_ascii=False).replace("</", "<\\/")
	page = (ROOT / "viewer.html").read_text(encoding="utf-8").replace("/*__OUTLINE_DATA__*/null", data, 1)
	(EXPORTS / "timeline.html").write_text(page, encoding="utf-8")
	print(f"已导出到 {EXPORTS}：overview.md、board.md、inbox.md、timeline.html")


# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
	ap = argparse.ArgumentParser(prog="outline.py", description="大纲原型第二版：块、任务、依据、空间、历史、待确认")
	ap.add_argument("--as", dest="actor", help="以谁的身份（默认取 OUTLINE_ACTOR）")
	sub = ap.add_subparsers(dest="cmd", required=True)

	def p(name, fn, help_):
		sp = sub.add_parser(name, help=help_)
		sp.set_defaults(fn=fn)
		return sp

	s = p("read", cmd_read, "读一页或一棵子树")
	s.add_argument("addr", help="短 id、空间/短id、别名或标题")
	s.add_argument("-d", "--depth", type=int, default=3)
	s.add_argument("--basis", action="store_true", help="列出每块的依据")
	s.add_argument("--as-of", type=int)
	s = p("search", cmd_search, "检索（默认不含不成立和归档）")
	s.add_argument("query", nargs="+")
	s.add_argument("--include", help="invalid,archived")
	s.add_argument("--limit", type=int, default=12)
	s = p("add", cmd_add, "用 markdown 大纲写：列表项是块，- [ ] 是任务，下一行写 键:: 值")
	s.add_argument("parent", help="父块，或 p/ 表示在空间顶层新建页")
	s.add_argument("text", nargs="?")
	s.add_argument("--md", help="从文件读大纲；- 表示标准输入")
	s.add_argument("--after", help="插在这个块后面（同一个父块下）；多条依次往后接")
	s.add_argument("-m", "--message")
	s = p("edit", cmd_edit, "改正文、勾复选框、改属性")
	s.add_argument("addr")
	s.add_argument("text", nargs="?", help="新正文（任务可以带 [ ] 和 @指派）")
	s.add_argument("--box", help="复选框：' ' 待办、/ 进行中（即领取）、x 完成、- 取消")
	s.add_argument("--prop", action="append", help="alias=…（Q? 自动编号）、due=…、tags=a,b；值留空表示删除")
	s.add_argument("--assign", help="指派给谁（agent:x 或 human:x；- 表示取消指派）")
	s.add_argument("--steal", action="store_true", help="接手别人正在做的任务")
	s.add_argument("--force", action="store_true")
	s.add_argument("-m", "--message")
	s = p("ask", cmd_ask, "问人：问题、选项、建议和理由；回答回来时唤醒你。只写已有提问的地址、不写问题，就是给它补建议")
	s.add_argument("parent", help="放在哪里；或者一条已有的提问（给它补建议）")
	s.add_argument("question", nargs="?")
	s.add_argument("--option", action="append", help="一个选项；可以写多次")
	s.add_argument("--recommend", help="建议：选项编号，或一句话")
	s.add_argument("--reason", help="建议的理由")
	s.add_argument("--bundle", help="放进同名的决策包（建在 parent 下面；parent 是一条提问时，包就挂在这条提问下面）")
	s.add_argument("--after", help="新提问或新决策包插在这个块后面")
	s.add_argument("--to", default="human:owner", help="交给谁回答（默认 human:owner）")
	s.add_argument("-m", "--message")
	s = p("invalid", cmd_invalid, "标为不成立（试过不行的方案、被推翻的结论）")
	s.add_argument("addr")
	s.add_argument("--reason")
	s.add_argument("--undo", action="store_true")
	s.add_argument("-m", "--message")
	s = p("pages", cmd_pages, "列出各空间的页")
	s.add_argument("space", nargs="?")
	s = p("board", cmd_board, "任务看板")
	s.add_argument("--under")
	s = p("inbox", cmd_inbox, "收件箱：待你确认的改动、等你回答的问题（默认看自己的，--who human:owner 看负责人的）")
	s.add_argument("--who")
	s = p("digest", cmd_digest, "汇报：这段时间变了什么、什么在等人")
	s.add_argument("--since", type=int, help="从第几个提交算起（默认最近 20 个）")
	s = p("log", cmd_log, "提交记录")
	s.add_argument("-n", type=int, default=20)
	s.add_argument("--since", type=int)
	s = p("diff", cmd_diff, "两个提交之间的变化")
	s.add_argument("a", type=int)
	s.add_argument("b", type=int)
	s = p("backlinks", cmd_backlinks, "反链")
	s.add_argument("addr")
	s = p("mv", cmd_mv, "移动块")
	s.add_argument("addr")
	s.add_argument("parent")
	s.add_argument("--after")
	s.add_argument("-m", "--message")
	s = p("rm", cmd_rm, "删除块及其子树")
	s.add_argument("addr")
	s.add_argument("-m", "--message")
	p("fresh", cmd_fresh, "检查代码锚点：代码变了的块会标「代码已变」")
	s = p("recheck", cmd_recheck, "核实代码已变的块：ok 仍成立（刷新锚点）/ invalid 不成立")
	s.add_argument("addr")
	s.add_argument("verdict", choices=["ok", "invalid"])
	s.add_argument("--reason")
	s.add_argument("-m", "--message")
	s = p("bundle", cmd_bundle, "把几条相关的提问编成决策包")
	s.add_argument("name")
	s.add_argument("questions", nargs="+")
	s.add_argument("-m", "--message")
	s = p("lock", cmd_lock, "锁定一份计划（人、计划的作者或管理者）；--unlock 解锁")
	s.add_argument("addr")
	s.add_argument("--delegate", help="替锁定人确认步骤调整的 agent")
	s.add_argument("--unlock", action="store_true")
	s.add_argument("-m", "--message")
	s = p("pending", cmd_pending, "待确认的改动；带 ID 看详情")
	s.add_argument("id", nargs="?")
	s.add_argument("--all", action="store_true")
	for name in ("confirm", "reject"):
		s = p(name, cmd_decide, "确认待确认的改动" if name == "confirm" else "退回待确认的改动")
		s.add_argument("id")
		s.add_argument("--note")
	s = p("answer", cmd_answer, "回答提问（人用）：不写 --text/--option 就采纳建议")
	s.add_argument("questions", nargs="*")
	s.add_argument("--bundle", action="append", help="一次回答一整个决策包")
	s.add_argument("--tree", action="append", help="一次回答一条提问和挂在它下面的全部细项")
	s.add_argument("--text")
	s.add_argument("--option", type=int)
	s.add_argument("-m", "--message")
	# 系统命令：不是给 agent 用的
	p("init", cmd_init, "（系统）初始化")
	s = p("import-v1", cmd_import_v1, "（系统）导入第一版的当前状态")
	s.add_argument("v1", help="第一版的 data/log.jsonl")
	s = p("actor", cmd_actor, "（系统）登记参与者")
	s.add_argument("name")
	s.add_argument("--creator")
	s.add_argument("--label")
	s = p("attach", cmd_attach, "（系统）把子代理的报告挂到它的任务下")
	s.add_argument("task")
	s.add_argument("file")
	s.add_argument("--author", required=True)
	s.add_argument("--title")
	s = p("trace", cmd_trace, "（系统）把子代理的运行记录挂到它的任务上")
	s.add_argument("task")
	s.add_argument("file")
	s.add_argument("--agent", required=True)
	p("export", cmd_export, "（系统）导出视图和时间轴")
	return ap


def log_command(argv: list[str], code: int) -> None:
	"""命令统计（试用的度量用，agent 看不到）。"""
	try:
		rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "actor": os.environ.get("OUTLINE_ACTOR", "?"), "cmd": next((a for a in argv if not a.startswith("-")), "?"), "help": "-h" in argv or "--help" in argv, "code": code}
		if "--as" in argv:
			rec["actor"] = argv[argv.index("--as") + 1]
		with _local("commands.jsonl").open("a", encoding="utf-8") as f:
			f.write(json.dumps(rec, ensure_ascii=False) + "\n")
	except OSError:
		pass


def main(argv=None) -> int:
	if hasattr(signal, "SIGPIPE"):
		signal.signal(signal.SIGPIPE, signal.SIG_DFL)
	argv = list(sys.argv[1:] if argv is None else argv)
	code = 0
	try:
		args = build_parser().parse_args(argv)
		args.fn(args)
	except SystemExit as e:
		code = int(e.code or 0)
		log_command(argv, code)
		raise
	except OutlineError as e:
		print(f"错误：{e}", file=sys.stderr)
		code = 1
	log_command(argv, code)
	return code


if __name__ == "__main__":
	sys.exit(main())
