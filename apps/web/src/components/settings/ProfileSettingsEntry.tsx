import type { ProjectProfile } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function ProfileSettingsEntry({
  onSelect,
}: {
  readonly onSelect: (profile: ProjectProfile) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-3">
      <p className="max-w-xl text-sm text-muted-foreground">
        Configure tool permissions and isolated native provider setup for Work or Personal projects.
      </p>
      <div className="flex shrink-0 gap-1">
        <Button size="xs" variant="outline" onClick={() => onSelect("work")}>
          Work tools
        </Button>
        <Button size="xs" variant="outline" onClick={() => onSelect("personal")}>
          Personal tools
        </Button>
      </div>
    </div>
  );
}
