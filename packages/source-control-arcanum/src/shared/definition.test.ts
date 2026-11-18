import { expect, it } from "vite-plus/test";
import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { definition } from "./definition.ts";

it("parses only positive numeric Arcanum review URLs", () => {
  expect(
    definition.parseChangeRequestUrl(new URL("https://a.yandex-team.ru/review/17236921")),
  ).toMatchObject({ host: "a.yandex-team.ru", repository: "arc_vcs", number: 17236921 });
  for (const url of [
    "https://a.yandex-team.ru/review/0",
    "https://a.yandex-team.ru.example/review/2",
    "https://a.yandex-team.ru/reviews/2",
    "ftp://a.yandex-team.ru/review/2",
  ])
    expect(definition.parseChangeRequestUrl(new URL(url))).toBeNull();
});

it("recognizes Arcanum remotes", () => {
  expect(recognizeRemoteWith(definition, "ssh://a.yandex-team.ru/arc_vcs/team/repo")).toEqual({
    kind: "arcanum",
    name: "Arcanum",
    baseUrl: "https://a.yandex-team.ru",
  });
});
