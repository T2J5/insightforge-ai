"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

const commands = [
  {
    href: "/#create-run",
    label: "创建调研",
    description: "输入企业与关注方向",
  },
  {
    href: "/#workflow",
    label: "查看工作流",
    description: "了解 Agent 的执行节点",
  },
  { href: "/#examples", label: "使用示例", description: "从常见调研问题开始" },
];

export function SiteHeader() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const openDialog = () => dialogRef.current?.showModal();
  const closeDialog = () => dialogRef.current?.close();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openDialog();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <header className="site-nav">
        <div className="site-nav__inner">
          <Link className="wordmark" href="/" aria-label="InsightForge 首页">
            InsightForge<span className="wordmark__signal">/</span>
          </Link>
          <nav className="site-nav__links" aria-label="主导航">
            <Link className="site-nav__link" href="/#workflow">
              Agent 流程
            </Link>
            <Link className="site-nav__link" href="/#examples">
              调研示例
            </Link>
          </nav>
          <button
            className="site-nav__search"
            type="button"
            aria-label="打开页面导航"
            onClick={openDialog}
          >
            <span aria-hidden="true">⌕</span>
            <span className="site-nav__search-text">快速导航</span>
            <span className="site-nav__shortcut" aria-hidden="true">
              ⌘ K
            </span>
          </button>
        </div>
      </header>
      <dialog
        className="command-dialog"
        ref={dialogRef}
        aria-labelledby="command-dialog-title"
        onClick={(event) => {
          if (event.target === dialogRef.current) closeDialog();
        }}
      >
        <div className="command-dialog__header">
          <h2 id="command-dialog-title">前往</h2>
          <button
            className="command-dialog__close"
            type="button"
            aria-label="关闭页面导航"
            onClick={closeDialog}
          >
            ×
          </button>
        </div>
        <nav className="command-dialog__links" aria-label="快捷页面导航">
          {commands.map((command) => (
            <Link
              className="command-dialog__link"
              href={command.href}
              key={command.href}
              onClick={closeDialog}
            >
              <strong>{command.label}</strong>
              <span>{command.description}</span>
            </Link>
          ))}
        </nav>
      </dialog>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p className="site-footer__statement">让每个结论，都能回到它的证据。</p>
        <div className="site-footer__meta">
          <span>InsightForge · 企业调研 Agent</span>
          <span>作品集演示 · AI 生成内容需人工复核</span>
        </div>
      </div>
    </footer>
  );
}
