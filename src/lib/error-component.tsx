import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

const FALLBACK_MESSAGE = "页面出错了。刷新一次通常就能恢复。";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-ink px-6 text-center text-paper">
      <span className="text-ember" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={1.75} />
      </span>
      <h1 className="font-display text-2xl">焰卫这边断了一下</h1>
      <p className="max-w-md text-sm break-words text-muted">{errorMessage(error)}</p>
    </main>
  );
}
