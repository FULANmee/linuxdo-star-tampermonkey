# Security Policy

## Scope

This userscript runs only on `https://linux.do/*` and only sends sync requests to `https://api.github.com`.

## Sensitive Data

GitHub Personal Access Tokens are stored in Tampermonkey script storage. Use a dedicated token with only the `gist` permission. Do not use a token with repository, organization, or account administration permissions.

Exported JSON does not include the GitHub Token.

## Reporting

If you find a security issue, please open a private report if the hosting platform supports it. Otherwise, open an issue with minimal reproduction details and avoid posting secrets, tokens, or private Gist contents.

## Hardening Notes

- Imported JSON and remote Gist data are normalized through a field allowlist.
- Dangerous object keys such as `__proto__`, `constructor`, and `prototype` are ignored.
- Sync requests are restricted to GitHub API user and Gist endpoints.
- Imported files and GitHub responses have size limits.
