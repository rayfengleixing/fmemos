import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import Editor from "./components/Editor";
import MemoCard from "./components/MemoCard";
import ReviewModal from "./components/ReviewModal";
import Sidebar from "./components/Sidebar";
import * as api from "./lib/api";
import { dateHeaderLabel, toDateKey } from "./lib/format";
import { buildTagTree, extractTags } from "./lib/tags";
import type { Memo, TagNode } from "./lib/types";

/** 卡片流分页大小：滚动到底部附近自动加载下一页 */
const PAGE_SIZE = 50;

interface ReviewState {
  mode: "random" | "daily";
  memo: Memo;
}

/** 随机：真随机；每日：以日期字符串为种子的确定性选取，同一天刷新不变 */
function pickReview(memos: Memo[], mode: "random" | "daily"): Memo {
  if (mode === "random") {
    return memos[Math.floor(Math.random() * memos.length)];
  }
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

  // 搜索防抖：停止输入 150ms 后才触发过滤查询
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  // 回调引用保持稳定的专用 ref：fetch/loadMore 从 ref 读最新值，
  // 避免回调身份随筛选变化，让 React.memo 在输入过程中持续生效
  const filtersRef = useRef({ tag: activeTag, query: debouncedQuery, untagged, date: activeDate });
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

  // 增删改后两侧都要刷新
  const refresh = useCallback(
    () => Promise.all([fetchAll(), fetchFiltered()]),
    [fetchAll, fetchFiltered],
  );

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    // 先同步 ref 再拉取：同一次提交里保证 fetch 读到最新筛选
    filtersRef.current = { tag: activeTag, query: debouncedQuery, untagged, date: activeDate };
    void fetchFiltered();
  }, [activeTag, debouncedQuery, untagged, activeDate, fetchFiltered]);

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
      } catch (e) {
        setError(`删除失败：${e}`);
        throw e;
      }
    },
    [refresh],
  );

  const selectAll = useCallback(() => {
    setActiveTag(null);
    setUntagged(false);
    setActiveDate(null);
  }, []);

  const selectTag = useCallback((tag: string) => {
    setActiveTag(tag);
    setUntagged(false);
    setActiveDate(null);
  }, []);

  const selectUntagged = useCallback(() => {
    setActiveTag(null);
    setUntagged(true);
    setActiveDate(null);
  }, []);

  const selectDate = useCallback((date: string | null) => {
    setActiveDate(date);
    setActiveTag(null);
    setUntagged(false);
  }, []);

  const openReview = useCallback(
    (mode: "random" | "daily") => {
      if (allMemos.length === 0) return;
      setReview({ mode, memo: pickReview(allMemos, mode) });
    },
    [allMemos],
  );

  const handleReviewTag = useCallback(
    (tag: string) => {
      setReview(null);
      selectTag(tag);
    },
    [selectTag],
  );

  const mainRef = useRef<HTMLElement>(null);
  const handleMainScroll = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) void loadMore();
  }, [loadMore]);

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

  const heatCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of allMemos) {
      const key = m.createdAt.slice(0, 10);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [allMemos]);

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
      />
      <main className="main" ref={mainRef} onScroll={handleMainScroll}>
        <div className="main-inner">
          <div className="topbar">
            <input
              className="search"
              placeholder="搜索笔记..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <Editor onCreate={handleCreate} focusSignal={focusSignal} allTags={allTags} />

          {memos.length === 0 ? (
            <div className="empty-state">
              {allMemos.length === 0 ? (
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
                {group.memos.map((memo) => (
                  <MemoCard
                    key={memo.id}
                    memo={memo}
                    allTags={allTags}
                    onTagClick={selectTag}
                    onUpdate={handleUpdate}
                    onDelete={handleDelete}
                  />
                ))}
              </Fragment>
            ))
          )}

          {loadingMore && <div className="loading-more">加载中...</div>}
        </div>
      </main>

      {review && (
        <ReviewModal
          mode={review.mode}
          memo={review.memo}
          onClose={() => setReview(null)}
          onAnother={() => setReview({ mode: "random", memo: pickReview(allMemos, "random") })}
          onTagClick={handleReviewTag}
        />
      )}
    </div>
  );
}
