import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/i18n";

function ReportFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useAppTranslation();
  return (
    <div className="overview-page">
      <div className="overview-content">
        <div className="overview-card overview-state" role="alert">
          <h2 data-slot="overview-heading">{t("overview.loadFailed")}</h2>
          <div className="overview-state-actions">
            <Button variant="outline" onClick={onRetry}>
              {t("overview.retry")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Keeps a failure in the report inside the report, never a blank window. */
export class ReportBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ReportFailed onRetry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
