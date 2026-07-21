/**
 * Top-level error boundary. Without this, React 18 unmounts the ENTIRE tree
 * on any uncaught render error — a blank white page with no explanation,
 * even though the tab title (a prior DOM mutation) can survive the unmount.
 * That exact symptom is what a stale-deploy chunk-load failure looks like
 * (see chunk-error.ts): the tab was open across a production deploy, a
 * lazy-loaded route chunk 404s at its old content hash, and nothing catches
 * the rejection.
 *
 * This boundary:
 *   - auto-reloads ONCE for a detected chunk-load failure (the standard SPA
 *     fix — the reload picks up the current deployed bundle), guarded via
 *     sessionStorage so a genuinely broken chunk can't reload-loop forever;
 *   - shows an actionable fallback (not a blank page) for every other error.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError } from "@/lib/error-boundary/chunk-error";

export const CHUNK_RELOAD_GUARD_KEY = "gcv-chunk-reload-attempted";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** True only in the render right after we've triggered the auto-reload. */
  autoReloading: boolean;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, autoReloading: false };

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, "hasError" | "error"> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const alreadyAttemptedReload = sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) === "1";

    if (isChunkLoadError(error) && !alreadyAttemptedReload) {
      // First time hitting a chunk-load failure this session: reload once to
      // pick up the current deployed bundle. Guarded so a persistently broken
      // chunk (not just a stale one) falls through to the fallback UI instead
      // of reloading forever.
      sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
      this.setState({ autoReloading: true });
      window.location.reload();
      return;
    }

    // eslint-disable-next-line no-console
    console.error("Unhandled render error", error, info);
  }

  handleReload = (): void => {
    sessionStorage.removeItem(CHUNK_RELOAD_GUARD_KEY);
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.state.autoReloading) {
        // Reload is already in flight; avoid flashing an error the user can't
        // act on in the brief window before the page actually reloads.
        return null;
      }
      return (
        <div className="container flex min-h-[60vh] flex-col items-center justify-center gap-4 py-12 text-center">
          <h1 className="text-xl font-semibold">Something went wrong</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            An unexpected error occurred while rendering this page. Your data is safe — try reloading.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
