/**
 * Panel-scoped error boundary. The top-level ErrorBoundary (App.tsx) already
 * stops any render error from blanking the entire app, but on a page like
 * SlabDetail that composes many independent panels (photos, identity,
 * valuation, comps, market intelligence, evidence, and -- for admins --
 * PriceCharting Marketplace listing and eBay publish), a single panel
 * throwing would otherwise take the WHOLE PAGE down to the generic
 * "Something went wrong" fallback, hiding every other panel that was
 * rendering fine.
 *
 * Wrap an individual panel in this so its failure is contained: the rest
 * of the page (including the other panels) stays usable, and only the
 * failed panel shows an inline "X failed to load" message. Deliberately
 * simpler than the top-level ErrorBoundary -- no chunk-load auto-reload
 * logic, since a panel already inside a loaded page is not itself a lazy
 * route chunk that could 404 after a deploy.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface PanelErrorBoundaryProps {
  /** Shown in the fallback message, e.g. "PriceCharting Marketplace". */
  panelName: string;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
}

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PanelErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(`Unhandled error in the ${this.props.panelName} panel`, error, info);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium text-destructive">{this.props.panelName} failed to load</p>
          <p className="mt-1 text-muted-foreground">
            The rest of this page is unaffected. Reload the page to try this section again.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
