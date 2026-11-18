import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  projectChangeRequestHost,
} from "@t3tools/source-control-core/shared/definition";

const HOST = "a.yandex-team.ru";
const KIND = SourceControlProviderKind.make("arcanum");

function parseChangeRequestUrl(url: URL) {
  const match = /^\/review\/([1-9][0-9]*)(?:\/|$)/u.exec(url.pathname);
  const number = Number(match?.[1]);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.hostname.toLowerCase() !== HOST ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    return null;
  return {
    host: HOST,
    ...(url.port ? { authority: url.host.toLowerCase() } : {}),
    repository: "arc_vcs",
    number,
    repositoryUrl: `https://${HOST}/arc_vcs`,
  };
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "Arcanum",
  pickerLabel: "Arcanum",
  icon: null,
  changeRequest: {
    shortLabel: "review",
    shortLabelWithArticle: "a review",
    singular: "review",
    plural: "reviews",
  },
  repositoryPathHint: "arc_vcs",
  publicHost: HOST,
  publishDescription: "Arcanum",
  publishHost: () => HOST,
  newRepositoryOwner: () => null,
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ number }) => `https://${HOST}/review/${number}`,
  parseChangeRequestUrl,
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(),
  checkoutCommand: () => null,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: () => null,
  isChangeRequestReference: (value) => {
    try {
      return parseChangeRequestUrl(new URL(value)) !== null;
    } catch {
      return false;
    }
  },
  checkoutChangeRequestHost: () => null,
  recognizeRemote: ({ hostname }) =>
    hostname === HOST ? { kind: KIND, name: "Arcanum", baseUrl: `https://${HOST}` } : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
});
