# Arcanum reviews

T3 Code can watch Arcanum review metadata and merge checks. Reads use Arcanum's JSON API at
`https://arcanum.yandex.net/api` and the OAuth authorization scheme.

Set `ARC_OAUTH_TOKEN` in the environment of the T3 Code server. The token is read when the server
starts; restart the server after changing it. Keep the token in your deployment's secret manager,
not in a committed `.env` file. This integration currently reads review metadata and checks; it
does not publish, edit, merge, or check out reviews.
