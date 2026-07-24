# Odinn Maintainer GitHub Action

This is a small, GitHub-native ClawSweeper-style review lane for Odinn. It
reacts to pull requests and issues, collects a bounded snapshot, asks the
configured Codex model for a conservative structured review, and upserts one
sticky review comment. It does not execute pull-request code, merge, close, or
modify the Odinn web app.

## OAuth setup

Create a repository Actions secret named `ODINN_OPENAI_OAUTH_JSON`. Its value
should be the contents of the local Odinn OAuth record from
`.odinn/oauth/openai.json`, for example an object containing `refreshToken` (or
`refresh_token`) and optionally `accessToken`/`expiresAt`. Do not commit that
file or paste its contents into an issue or pull request.

The action refreshes the OAuth access token when needed and calls the same
ChatGPT Codex Responses transport Odinn uses. It does not use
`OPENAI_API_KEY`, `api.openai.com`, or a generic chat-completions endpoint.

The GitHub token is separate: `GITHUB_TOKEN` is only used to read the bounded
PR/issue context and publish the sticky review comment.
