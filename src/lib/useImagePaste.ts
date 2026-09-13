import { useEffect, useRef, useState, type RefObject } from "react";
import * as api from "./api";

/** 与后端 IMAGE_MAX_BYTES 一致的单图上限 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * 容器级图片粘贴 / 拖入：paste/drop 事件会从编辑区（TipTap contenteditable）冒泡到容器，
 * 所以不用给 RichEditor 加 props——容器上监听即可覆盖所有输入区。
 *
 * 图片文件读成 base64 → api.addImage 入库 → 回调拿到 `![图片](image://id)` 引用，
 * 由调用方决定插到哪（RichEditor.insertImageRef 插成图片节点）。
 */
/**
 * 单张图片上传：读文件成 base64 → api.addImage 入库 → 返回 `![图片](image://id)` 引用。
 * 非图片文件返回 null；超限 / 读取失败 / 入库失败走 onError（返回 null）。
 * 粘贴 / 拖入（useImagePaste）和工具栏「插入图片」按钮共用这条链路。
 */
export async function uploadImageFile(
  file: File,
  onError?: (message: string) => void,
): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  if (file.size > IMAGE_MAX_BYTES) {
    onError?.(`图片「${file.name}」超过 10 MB 上限，请压缩后再试`);
    return null;
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`读取图片「${file.name}」失败`));
    reader.readAsDataURL(file);
  }).catch((e) => {
    onError?.(String(e.message ?? e));
    return null;
  });
  if (dataUrl === null) return null;
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  try {
    const info = await api.addImage(base64, file.type || "image/png");
    return `![图片](image://${info.id})`;
  } catch (e) {
    onError?.(`图片上传失败：${e}`);
    return null;
  }
}

export function useImagePaste(
  containerRef: RefObject<HTMLElement | null>,
  onImageRef: (token: string) => void,
  onError?: (message: string) => void,
): { uploading: boolean } {
  const [uploading, setUploading] = useState(false);
  // 回调放进 ref，避免依赖变化反复卸载/挂载事件监听
  const onImageRefRef = useRef(onImageRef);
  onImageRefRef.current = onImageRef;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const upload = (file: File) => {
      if (!file.type.startsWith("image/")) return;
      setUploading(true);
      uploadImageFile(file, (m) => onErrorRef.current?.(m))
        .then((token) => {
          if (token) onImageRefRef.current(token);
        })
        .finally(() => setUploading(false));
    };

    const onPaste = (e: Event) => {
      const ce = e as ClipboardEvent;
      const files = Array.from(ce.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      files.forEach(upload);
    };
    const onDrop = (e: Event) => {
      const de = e as DragEvent;
      const files = Array.from(de.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      files.forEach(upload);
    };
    // 拖着文件悬停时阻止浏览器默认「打开文件」，否则 drop 根本到不了我们这
    const onDragOver = (e: Event) => {
      const de = e as DragEvent;
      if (Array.from(de.dataTransfer?.types ?? []).includes("Files")) {
        e.preventDefault();
      }
    };

    el.addEventListener("paste", onPaste);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragover", onDragOver);
    return () => {
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragover", onDragOver);
    };
    // containerRef.current 挂载后不会变（编辑器容器常驻），依赖只留空
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { uploading };
}
