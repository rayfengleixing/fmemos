import { useEffect, useState } from "react";
import { getImage } from "../lib/api";

/** 图片字节缓存（id → data URL）：同一张图在卡片流 / 待办清单里只取一次 */
const cache = new Map<number, string>();

interface Props {
  id: number;
  alt?: string;
}

/**
 * 正文里的 image:// 引用渲染：懒加载取字节（base64 → data URL），点击放大预览。
 * 缓存进程内共享，关闭放大镜、翻页回来都不再重复请求。
 */
export default function MemoImage({ id, alt }: Props) {
  const [src, setSrc] = useState<string | null>(() => cache.get(id) ?? null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    if (src) return;
    let alive = true;
    getImage(id)
      .then((img) => {
        const url = `data:${img.mime};base64,${img.data}`;
        cache.set(id, url);
        if (alive) setSrc(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [id, src]);

  if (failed) {
    return <span className="memo-img-fallback">[图片 #{id} 丢失]</span>;
  }
  if (!src) {
    return <span className="memo-img-loading">图片加载中…</span>;
  }
  return (
    <>
      <img
        className="memo-img"
        src={src}
        alt={alt || "图片"}
        loading="lazy"
        title="点击放大"
        onClick={() => setZoom(true)}
      />
      {zoom && (
        <div className="img-lightbox" onClick={() => setZoom(false)}>
          <img src={src} alt={alt || "图片"} />
        </div>
      )}
    </>
  );
}
