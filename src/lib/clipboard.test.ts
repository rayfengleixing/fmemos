import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("navigator.clipboard 可用时直接写入并成功", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("clipboard 写入被拒时退回 execCommand 兜底", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const exec = vi.fn().mockReturnValue(true);
    const remove = vi.fn();
    vi.stubGlobal("document", {
      createElement: () => ({ value: "", style: {}, select: vi.fn(), remove }),
      execCommand: exec,
      body: { appendChild: vi.fn() },
    });
    await expect(copyText("world")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(remove).toHaveBeenCalled();
  });

  it("没有 clipboard 且 execCommand 返回 false 时报失败", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      createElement: () => ({ value: "", style: {}, select: vi.fn(), remove: vi.fn() }),
      execCommand: vi.fn().mockReturnValue(false),
      body: { appendChild: vi.fn() },
    });
    await expect(copyText("x")).resolves.toBe(false);
  });

  it("兜底路径抛异常时也返回 false 而不是崩溃", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      createElement: () => {
        throw new Error("boom");
      },
      body: { appendChild: vi.fn() },
    });
    await expect(copyText("x")).resolves.toBe(false);
  });
});
