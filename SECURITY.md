# Security Policy — Optical Marketplace Backend

## 1) Reporting a Vulnerability
If you discover a security issue, do NOT open a public issue.

Instead, report it privately to the maintainers:
- Provide a clear description
- Steps to reproduce
- Impact assessment
- Any relevant logs/screenshots (redacted)

## 2) Secrets & Credentials
- Never commit secrets (tokens, passwords, keys).
- Only commit `.env.example` with placeholder values.
- Store real secrets in CI secrets and password manager (e.g., Bitwarden).

If a secret leak is suspected:
1) Rotate/revoke immediately
2) Remove from repository history if needed
3) Audit access logs
4) Document incident in an internal note / issue

## 3) Dependency Security
- Keep dependencies updated
- Avoid unmaintained packages
- Review any high-risk dependency changes carefully

## 4) Logging & PII
- Do not log sensitive personal data
- Do not log credentials or payment tokens
- Log only what is needed for traceability (request id, order id, error code)
