import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import Editor from "./components/Editor";
import MemoCard from "./components/MemoCard";
import ReviewModal from "./components/ReviewModal";
import SettingsModal from "./components/SettingsModal";
import Sidebar from "./components/Sidebar";
import TagManageModal from "./components/TagManageModal";
import TodoView from "./components/TodoView";
import * as api from "./lib/api";
import { dateHeaderLabel, toDateKey } from "./lib/format";
import { buildTagTree, countMemosWithTag, extractTags, tagMatchesPrefix } from "./lib/tags";
import { collectTodos, todoStats } from "./lib/todo";
import type { Memo, MemoFilter, SavedFilter, TagNode, ThemeMode } from "./lib/types";

/** 卡片流分页大小：滚动到底部附近自动加载下一页 */
const PAGE_SIZE = 50;

const THEME_KEY = "fmemos.theme";
/** 侧栏智能列表的持久化键 */
const SAVED_FILTERS_KEY = "fmemos.savedFilters";

/** 读侧栏保存的智能列表；解析失败按空处理，不让坏数据卡住启动 */
function loadSavedFilters(): SavedFilter[] {
  try {
    const raw = localStorage.getItem(SAVED_FILTERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SavedFilter =>
        !!x &&
        typeof x === "object" &&
        typeof (x as SavedFilter).id === "string" &&
        typeof (x as SavedFilter).name === "string",
    );
  } catch {
    return [];
  }
}

interface ToastState {
  text: string;
  actionLabel?: string;
  action?: () => void;
}

interface ReviewState {
  mode: "random" | "daily" | "history";
  memo: Memo;
  /** 「换一条」的候选池（随机=全部笔记，那年今日=同年同日历史） */
  candidates?: Memo[];
}

function pickRandom(memos: Memo[]): Memo {
  return memos[Math.floor(Math.random() * memos.length)];
}

/** 每日回顾：以日期字符串为种子的确定性选取，同一天刷新不变 */
function pickDaily(memos: Memo[]): Memo {
  const key = toDateKey(new Date());
  let hash = 0;
  for (const ch of key) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return memos[hash % memos.length];
}

export default function App() {
  const [allMemos, setAllMemos] = useState<Memo[]>([]);
  const [memos, setMemos] = useState<Memo[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const [untagged, setUntagged] = useState(false);
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<ReviewState | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [trashView, setTrashView] = useState(false);
  const [trashMemos, setTrashMemos] = useState<Memo[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 正在管理（重命名 / 合并 / 删除）的标签路径 */
  const [manageTag, setManageTag] = useState<string | null>(null);
  /** 待办清单视图（纯前端聚合，和卡片流互斥） */
  const [todoView, setTodoView] = useState(false);
  /** 从待办清单点「原文」后要滚动定位到的卡片 id */
  const [focusMemoId, setFocusMemoId] = useState<number | null>(null);
  /** 置顶区：独立于分页（后端按 pinned=true 单独查），跟随当前筛选 */
  const [pinnedMemos, setPinnedMemos] = useState<Memo[]>([]);
  /** 侧栏保存的智能列表（localStorage 持久化） */
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(() => loadSavedFilters());
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  /** 底部浮条：6 秒自动消失，可带一个操作按钮（如撤销） */
  const showToast = useCallback((text: string, actionLabel?: string, action?: () => void) => {
    setToast({ text, actionLabel, action });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  // 外观主题：浅色 / 深色 / 跟随系统（写 data-theme 属性，CSS 变量切换）
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // localStorage 不可用时忽略
    }
  }, [theme]);

  // 搜索防抖：停止输入 150ms 后才触发过滤查询
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  // 搜索结果高亮关键词（与后端查询同源：空白拆分多关键词）
  const searchTerms = useMemo(
    () => (debouncedQuery.trim() ? debouncedQuery.trim().split(/\s+/).filter(Boolean) : undefined),
    [debouncedQuery],
  );

  // 回调引用保持稳定的专用 ref：fetch/loadMore 从 ref 读最新值，
  // 避免回调身份随筛选变化，让 React.memo 在输入过程中持续生效
  const filtersRef = useRef({
    tag: activeTag,
    query: debouncedQuery,
    untagged,
    date: activeDate,
    trash: trashView,
  });
  const memosRef = useRef<Memo[]>([]);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);

  // 全量数据用于侧栏标签统计与热力图，只在笔记增删改后刷新，筛选条件变化不重拉
  const allReq = useRef(0);
  const fetchAll = useCallback(async () => {
    const id = ++allReq.current;
    try {
      const all = await api.listMemos();
      if (id === allReq.current) {
        setAllMemos(all);
        setError(null);
      }
    } catch (e) {
      if (id === allReq.current) setError(String(e));
    }
  }, []);

  // 过滤数据用于卡片流展示（分页拉取）；epoch 递增使旧响应作废
  const filterEpoch = useRef(0);
  const fetchFiltered = useCallback(async () => {
    const epoch = ++filterEpoch.current;
    try {
      const f = filtersRef.current;
      const page = await api.listMemos({
        tag: f.tag,
        query: f.query.trim() || null,
        untagged: f.untagged,
        date: f.date,
        trash: f.trash,
        // 置顶项由置顶区单独展示，主列表排除它们，避免两处重复
        pinned: false,
        limit: PAGE_SIZE,
      });
      if (epoch !== filterEpoch.current) return;
      memosRef.current = page;
      setMemos(page);
      hasMoreRef.current = page.length === PAGE_SIZE;
      setError(null);
    } catch (e) {
      if (epoch === filterEpoch.current) setError(String(e));
    }
  }, []);

  // 追加下一页：读当前 epoch 但不递增，筛选中途变化时本次结果自动丢弃
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    const f = filtersRef.current;
    const prev = memosRef.current;
    const last = prev[prev.length - 1];
    if (!last) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const epoch = filterEpoch.current;
    try {
      const page = await api.listMemos({
        tag: f.tag,
        query: f.query.trim() || null,
        untagged: f.untagged,
        date: f.date,
        trash: f.trash,
        pinned: false,
        limit: PAGE_SIZE,
        before: { createdAt: last.createdAt, id: last.id },
      });
      if (epoch !== filterEpoch.current) return;
      const next = [...prev, ...page];
      memosRef.current = next;
      setMemos(next);
      hasMoreRef.current = page.length === PAGE_SIZE;
      setError(null);
    } catch (e) {
      if (epoch === filterEpoch.current) setError(String(e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  // 增删改后两侧都要刷新；回收站计数随 refresh 一并更新
  const fetchTrash = useCallback(async () => {
    try {
      setTrashMemos(await api.listMemos({ trash: true }));
    } catch {
      // 回收站计数失败不打扰主流程
    }
  }, []);

  // 置顶区：跟随当前筛选（搜「周报」时只显示命中的置顶项），不分页
  const fetchPinned = useCallback(async () => {
    try {
      const f = filtersRef.current;
      setPinnedMemos(
        await api.listMemos({
          tag: f.tag,
          query: f.query.trim() || null,
          untagged: f.untagged,
          date: f.date,
          trash: f.trash,
          pinned: true,
        }),
      );
    } catch {
      // 置顶区拉取失败不打扰主流程
    }
  }, []);

  const refresh = useCallback(
    () => Promise.all([fetchAll(), fetchFiltered(), fetchTrash(), fetchPinned()]),
    [fetchAll, fetchFiltered, fetchTrash, fetchPinned],
  );

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    // 先同步 ref 再拉取：同一次提交里保证 fetch 读到最新筛选
    filtersRef.current = {
      tag: activeTag,
      query: debouncedQuery,
      untagged,
      date: activeDate,
      trash: trashView,
    };
    void fetchFiltered();
    void fetchPinned();
  }, [activeTag, debouncedQuery, untagged, activeDate, trashView, fetchFiltered, fetchPinned]);

  // 全局快捷键 Ctrl+Shift+M 呼出窗口时，后端发 quick-open，前端聚焦输入框
  useEffect(() => {
    const unlisten = listen("quick-open", () => setFocusSignal((s) => s + 1));
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // 增删改失败时展示错误横幅，并把异常抛回给调用方，以便保留输入/编辑状态
  const handleCreate = useCallback(
    async (content: string) => {
      try {
        await api.createMemo(content);
        await refresh();
      } catch (e) {
        setError(`记录失败：${e}`);
        throw e;
      }
    },
    [refresh],
  );

  const handleUpdate = useCallback(
    async (id: number, content: string) => {
      try {
        await api.updateMemo(id, content);
        await refresh();
      } catch (e) {
        setError(`保存失败：${e}`);
        throw e;
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      try {
        await api.deleteMemo(id);
        await refresh();
        showToast("已移入回收站", "撤销", () => {
          setToast(null);
          api
            .restoreMemo(id)
            .then(() => refresh())
            .catch((e) => setError(`恢复失败：${e}`));
        });
      } catch (e) {
        setError(`删除失败：${e}`);
        throw e;
      }
    },
    [refresh, showToast],
  );

  // 视图切换：卡片流 / 回收站 / 待办清单三者互斥，切换时都清空筛选回到「全部」语义
  const openTrash = useCallback(() => {
    setActiveTag(null);
    setActiveDate(null);
    setUntagged(false);
    setQuery("");
    setTodoView(false);
    setTrashView(true);
  }, []);

  const openTodo = useCallback(() => {
    setActiveTag(null);
    setActiveDate(null);
    setUntagged(false);
    setQuery("");
    setTrashView(false);
    setTodoView(true);
  }, []);

  // 待办清单点「原文」：回到卡片流并定位该卡片；
  // 卡片还没加载出来时由 focusMemoId 触发继续翻页（见下方 effect）
  const openMemo = useCallback((id: number) => {
    setTodoView(false);
    setTrashView(false);
    setActiveTag(null);
    setActiveDate(null);
    setUntagged(false);
    setQuery("");
    setFocusMemoId(id);
  }, []);

  const handleRestore = useCallback(
    (id: number) => {
      api
        .restoreMemo(id)
        .then(() => refresh())
        .then(() => showToast("已恢复"))
        .catch((e) => setError(`恢复失败：${e}`));
    },
    [refresh, showToast],
  );

  const handlePurge = useCallback(
    (id: number) => {
      api
        .purgeMemo(id)
        .then(() => refresh())
        .catch((e) => setError(`删除失败：${e}`));
    },
    [refresh],
  );

  const handleEmptyTrash = useCallback(() => {
    if (trashMemos.length === 0) return;
    if (!confirm(`清空回收站的 ${trashMemos.length} 条？不可恢复！`)) return;
    api
      .emptyTrash()
      .then((n) => refresh().then(() => showToast(`已清空 ${n} 条`)))
      .catch((e) => setError(`清空失败：${e}`));
  }, [trashMemos.length, refresh, showToast]);

  // 标签治理：失败时把异常抛回弹窗内联展示，不再顶一条全局横幅
  const handleRenameTag = useCallback(
    async (from: string, to: string) => {
      const n = await api.renameTag(from, to);
      await refresh();
      // 当前筛选的标签正好被改名 / 合并时，跟随到新路径，别停在已不存在的旧标签上
      setActiveTag((cur) =>
        cur && tagMatchesPrefix(cur, from) ? to + cur.slice(from.length) : cur,
      );
      showToast(`已更新 ${n} 条笔记的标签`);
    },
    [refresh, showToast],
  );

  const handleDeleteTag = useCallback(
    async (tag: string) => {
      const n = await api.deleteTag(tag);
      await refresh();
      setActiveTag((cur) => (cur && tagMatchesPrefix(cur, tag) ? null : cur));
      showToast(`已从 ${n} 条笔记里移除 #${tag}`);
    },
    [refresh, showToast],
  );

  // 置顶 / 取消置顶：置顶区要整块重排，所以走 refresh 而不是局部替换
  const handleTogglePin = useCallback(
    (id: number, pinned: boolean) => {
      api
        .setPin(id, pinned)
        .then(() => refresh())
        .then(() => showToast(pinned ? "已置顶" : "已取消置顶"))
        .catch((e) => setError(`置顶失败：${e}`));
    },
    [refresh, showToast],
  );

  // 智能列表：把当前筛选存成一个命名条目，下次一键切回
  const currentFilter: MemoFilter = useMemo(
    () => ({ tag: activeTag, query: query.trim() || null, untagged, date: activeDate }),
    [activeTag, query, untagged, activeDate],
  );
  const filterIsEmpty =
    currentFilter.tag === null &&
    currentFilter.query === null &&
    !currentFilter.untagged &&
    currentFilter.date === null;

  /** 当前筛选的可读描述，给设置页「只导出当前筛选」显示 */
  const filterLabel = useMemo(() => {
    const parts: string[] = [];
    if (activeTag) parts.push(`#${activeTag}`);
    if (query.trim()) parts.push(`搜索「${query.trim()}」`);
    if (activeDate) parts.push(activeDate);
    if (untagged) parts.push("无标签");
    return parts.join(" · ");
  }, [activeTag, query, activeDate, untagged]);

  const persistSavedFilters = useCallback((next: SavedFilter[]) => {
    setSavedFilters(next);
    try {
      localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(next));
    } catch {
      // localStorage 不可用时只在内存里生效
    }
  }, []);

  const saveCurrentFilter = useCallback(() => {
    if (filterIsEmpty) {
      showToast("当前没有筛选条件，先点个标签或搜索一下");
      return;
    }
    const name = prompt("给这个筛选起个名字（如「本周工作」）");
    if (!name?.trim()) return;
    persistSavedFilters([
      ...savedFilters,
      { id: String(Date.now()), name: name.trim(), filter: currentFilter },
    ]);
    showToast(`已保存到智能列表：${name.trim()}`);
  }, [filterIsEmpty, savedFilters, currentFilter, persistSavedFilters, showToast]);

  const applySavedFilter = useCallback((f: SavedFilter) => {
    setActiveTag(f.filter.tag);
    setQuery(f.filter.query ?? "");
    setUntagged(f.filter.untagged);
    setActiveDate(f.filter.date);
    setTrashView(false);
    setTodoView(false);
  }, []);

  const deleteSavedFilter = useCallback(
    (id: string) => {
      persistSavedFilters(savedFilters.filter((f) => f.id !== id));
    },
    [savedFilters, persistSavedFilters],
  );

  // 从备份恢复 / 批量导入后：数据整体换了，先回到「全部笔记」再刷新
  const handleDataReloaded = useCallback(async () => {
    setActiveTag(null);
    setActiveDate(null);
    setUntagged(false);
    setQuery("");
    setTrashView(false);
    setTodoView(false);
    await refresh();
  }, [refresh]);

  const selectAll = useCallback(() => {
    setActiveTag(null);
    setActiveDate(null);
    setUntagged(false);
    setTrashView(false);
    setTodoView(false);
  }, []);

  const selectTag = useCallback((tag: string) => {
    setActiveTag(tag);
    setActiveDate(null);
    setUntagged(false);
    setTrashView(false);
    setTodoView(false);
  }, []);

  const selectUntagged = useCallback(() => {
    setActiveTag(null);
    setActiveDate(null);
    setUntagged(true);
    setTrashView(false);
    setTodoView(false);
  }, []);

  const selectDate = useCallback((date: string | null) => {
    setActiveDate(date);
    setActiveTag(null);
    setUntagged(false);
    setTrashView(false);
    setTodoView(false);
  }, []);

  // 「那年今日」候选：往年同月同日创建的笔记（倒序）
  const historyCandidates = useMemo(() => {
    const now = new Date();
    const md = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const year = now.getFullYear();
    return allMemos
      .filter(
        (m) => m.createdAt.slice(5, 10) === md && Number(m.createdAt.slice(0, 4)) < year,
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }, [allMemos]);

  const openReview = useCallback(
    (mode: "random" | "daily" | "history") => {
      if (mode === "history") {
        if (historyCandidates.length === 0) return;
        setReview({ mode, memo: pickRandom(historyCandidates), candidates: historyCandidates });
        return;
      }
      if (allMemos.length === 0) return;
      setReview({
        mode,
        memo: mode === "random" ? pickRandom(allMemos) : pickDaily(allMemos),
        candidates: mode === "random" ? allMemos : undefined,
      });
    },
    [allMemos, historyCandidates],
  );

  const handleReviewTag = useCallback(
    (tag: string) => {
      setReview(null);
      selectTag(tag);
    },
    [selectTag],
  );

  // 回顾弹窗「编辑」：关闭弹窗，滚动到对应卡片并进入编辑
  const editFromReview = useCallback((id: number) => {
    setReview(null);
    setEditingId(id);
    setTimeout(() => {
      document
        .querySelector(`[data-memo-id="${id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }, []);

  const mainRef = useRef<HTMLElement>(null);
  const handleMainScroll = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) void loadMore();
  }, [loadMore]);

  // 从待办清单点「原文」跳过来：卡片已在列表里就滚过去；
  // 还在后面的分页里就继续翻页，翻到底仍未出现才提示（正常不会发生，跳转时已清空筛选）
  useEffect(() => {
    if (focusMemoId === null) return;
    const el = document.querySelector(`[data-memo-id="${focusMemoId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setFocusMemoId(null);
      return;
    }
    if (hasMoreRef.current) {
      void loadMore();
      return;
    }
    setFocusMemoId(null);
    showToast("没能在列表里找到这条笔记");
  }, [focusMemoId, memos, loadMore, showToast]);

  const tags = useMemo(() => buildTagTree(allMemos), [allMemos]);
  // 标签路径平铺（树序即热度序），供输入框 # 自动补全
  const allTags = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TagNode[]) => {
      for (const n of nodes) {
        out.push(n.path);
        walk(n.children);
      }
    };
    walk(tags);
    return out;
  }, [tags]);
  // 无标签的判定与后端一致：解析不出任何 #标签
  const untaggedCount = useMemo(
    () => allMemos.filter((m) => extractTags(m.content).length === 0).length,
    [allMemos],
  );
  // 待办统计：侧栏徽标只取未完成条数；清单数据由 TodoView 自行聚合
  const todoStat = useMemo(() => todoStats(collectTodos(allMemos)), [allMemos]);

  const heatCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of allMemos) {
      const key = m.createdAt.slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [allMemos]);

  // 标签管理弹窗：影响条数按全量 + 回收站算（后端改动也含回收站），
  // 合并候选排除自身、自己的子孙、以及自己的上级（都会造成自嵌套）
  const manageAffected = useMemo(
    () => (manageTag ? countMemosWithTag([...allMemos, ...trashMemos], manageTag) : 0),
    [manageTag, allMemos, trashMemos],
  );
  const mergeCandidates = useMemo(() => {
    if (!manageTag) return [];
    return allTags.filter(
      (t) => t !== manageTag && !t.startsWith(`${manageTag}/`) && !manageTag.startsWith(`${t}/`),
    );
  }, [allTags, manageTag]);

  // 回顾弹窗标题
  const reviewTitle = review
    ? review.mode === "daily"
      ? "每日回顾"
      : review.mode === "random"
        ? "随机回顾"
        : `${new Date().getFullYear() - Number(review.memo.createdAt.slice(0, 4))} 年前的今天`
    : "";

  // 卡片流按创建日期分组（list_memos 已按时间倒序，相邻即同组；分页追加的同日笔记也会合并）
  const groups = useMemo(() => {
    const out: { key: string; label: string; memos: Memo[] }[] = [];
    for (const m of memos) {
      const key = m.createdAt.slice(0, 10);
      const last = out[out.length - 1];
      if (last && last.key === key) {
        last.memos.push(m);
      } else {
        out.push({ key, label: dateHeaderLabel(key), memos: [m] });
      }
    }
    return out;
  }, [memos]);

  // 置顶区与日期分组共用同一套卡片渲染，避免两处 props 漂移
  const renderCard = (memo: Memo) => (
    <MemoCard
      key={memo.id}
      memo={memo}
      allTags={allTags}
      highlight={searchTerms}
      editing={editingId === memo.id}
      onSetEditing={setEditingId}
      trash={trashView}
      onRestore={handleRestore}
      onPurge={handlePurge}
      onTagClick={selectTag}
      onUpdate={handleUpdate}
      onDelete={handleDelete}
      onTogglePin={handleTogglePin}
    />
  );

  return (
    <div className="app">
      <Sidebar
        total={allMemos.length}
        tags={tags}
        activeTag={activeTag}
        untagged={untagged}
        untaggedCount={untaggedCount}
        heatCounts={heatCounts}
        activeDate={activeDate}
        onSelectAll={selectAll}
        onSelectTag={selectTag}
        onSelectUntagged={selectUntagged}
        onSelectDate={selectDate}
        onReview={openReview}
        historyCount={historyCandidates.length}
        trashCount={trashMemos.length}
        trashActive={trashView}
        onOpenTrash={openTrash}
        todoCount={todoStat.pending}
        todoTotal={todoStat.total}
        todoActive={todoView}
        onOpenTodo={openTodo}
        savedFilters={savedFilters}
        canSaveFilter={!filterIsEmpty}
        onApplySavedFilter={applySavedFilter}
        onSaveCurrentFilter={saveCurrentFilter}
        onDeleteSavedFilter={deleteSavedFilter}
        onOpenSettings={() => setSettingsOpen(true)}
        onManageTag={setManageTag}
      />
      <main className="main" ref={mainRef} onScroll={handleMainScroll}>
        <div className="main-inner">
          <div className="topbar">
            <input
              className="search"
              placeholder={todoView ? "搜索待办..." : "搜索笔记..."}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          {trashView && (
            <div className="trash-header">
              <span>
                回收站 · {trashMemos.length} 条
                <span className="trash-hint">（删除的笔记在这里保留，可恢复）</span>
              </span>
              {trashMemos.length > 0 && (
                <button className="btn-ghost" onClick={handleEmptyTrash}>
                  清空回收站
                </button>
              )}
            </div>
          )}

          {!trashView && !todoView && (
            <Editor onCreate={handleCreate} focusSignal={focusSignal} allTags={allTags} />
          )}

          {/* 置顶区：独立于分页，置于日期分组之上；与下方分组共用 renderCard */}
          {!trashView && !todoView && pinnedMemos.length > 0 && (
            <>
              <div className="date-header pinned-header">
                <span>置顶</span>
                <span className="date-count">{pinnedMemos.length} 条</span>
              </div>
              {pinnedMemos.map(renderCard)}
            </>
          )}

          {todoView ? (
            <TodoView
              memos={allMemos}
              searchTerms={searchTerms}
              onUpdate={handleUpdate}
              onTagClick={selectTag}
              onOpenMemo={openMemo}
            />
          ) : memos.length === 0 && pinnedMemos.length === 0 ? (
            <div className="empty-state">
              {trashView ? (
                "回收站是空的"
              ) : allMemos.length === 0 ? (
                <>
                  空空如也
                  <br />
                  在上面的输入框写下第一条 memo 吧
                </>
              ) : (
                "没有匹配的笔记"
              )}
            </div>
          ) : (
            groups.map((group) => (
              <Fragment key={group.key}>
                <div className="date-header">
                  <span>{group.label}</span>
                  <span className="date-count">{group.memos.length} 条</span>
                </div>
                {group.memos.map(renderCard)}
              </Fragment>
            ))
          )}

          {!todoView && loadingMore && <div className="loading-more">加载中...</div>}
        </div>
      </main>

      {toast && (
        <div className="toast">
          <span>{toast.text}</span>
          {toast.actionLabel && (
            <button
              onClick={() => {
                toast.action?.();
              }}
            >
              {toast.actionLabel}
            </button>
          )}
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          theme={theme}
          onThemeChange={setTheme}
          currentFilter={currentFilter}
          filterLabel={filterLabel}
          notify={showToast}
          onDataReloaded={handleDataReloaded}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {manageTag && (
        <TagManageModal
          tag={manageTag}
          affected={manageAffected}
          candidateTags={mergeCandidates}
          onRename={handleRenameTag}
          onDelete={handleDeleteTag}
          onClose={() => setManageTag(null)}
        />
      )}

      {review && (
        <ReviewModal
          title={reviewTitle}
          memo={review.memo}
          showAnother={review.mode !== "daily"}
          onClose={() => setReview(null)}
          onAnother={() =>
            setReview((r) =>
              r ? { ...r, memo: pickRandom(r.candidates ?? [r.memo]) } : null,
            )
          }
          onEdit={() => editFromReview(review.memo.id)}
          onTagClick={handleReviewTag}
        />
      )}
    </div>
  );
}
