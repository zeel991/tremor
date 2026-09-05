import { Shell } from "@/components/shell/Shell";
import { LinkButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export default function NotFound() {
  return (
    <Shell>
      <div className="card mx-auto mt-10 max-w-md">
        <span className="bracket bracket-muted">404</span>
        <EmptyState
          action={
            <LinkButton href="/" variant="secondary">
              Back to overview
            </LinkButton>
          }
        >
          Nothing here. The page you asked for does not exist.
        </EmptyState>
      </div>
    </Shell>
  );
}
