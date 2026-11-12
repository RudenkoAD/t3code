import { BriefcaseBusinessIcon, HeartIcon } from "lucide-react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import {
  PROJECT_PROFILE_VIEW_KEY,
  ProjectProfileView,
  type ProjectProfileView as ProjectProfileViewType,
} from "../projectProfileView";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

export function useProjectProfileView() {
  return useLocalStorage<ProjectProfileViewType, ProjectProfileViewType>(
    PROJECT_PROFILE_VIEW_KEY,
    "all",
    ProjectProfileView,
  );
}

export function ProjectProfileSelector({
  value,
  onChange,
  className,
}: {
  readonly value: ProjectProfileViewType;
  readonly onChange: (value: ProjectProfileViewType) => void;
  readonly className?: string;
}) {
  const label = value === "all" ? "All profiles" : value === "work" ? "Work" : "Personal";
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === "all" || next === "work" || next === "personal") onChange(next);
      }}
    >
      <SelectTrigger
        size="sm"
        variant="ghost"
        className={className}
        aria-label={`Project profile: ${label}`}
      >
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start">
        <SelectItem value="all">All profiles</SelectItem>
        <SelectItem value="work">
          <BriefcaseBusinessIcon className="size-4" /> Work
        </SelectItem>
        <SelectItem value="personal">
          <HeartIcon className="size-4" /> Personal
        </SelectItem>
      </SelectPopup>
    </Select>
  );
}
