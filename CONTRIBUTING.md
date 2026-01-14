# Contributing Guide — Optical Marketplace Backend

Thank you for contributing to this repository. This project follows a strict governance model to protect production stability and ensure milestone traceability.

---

## 1) Golden Rules
- **No direct commits to `main`** (protected branch).
- **All changes must go through a Pull Request (PR)**.
- Each PR must be linked to **exactly one Issue** (1:1 mapping).
- PRs must be scoped to a **single milestone** (no cross-milestone bundling).
- **CI must pass** before merge.
- **No secrets** may be committed (tokens, passwords, private keys).

---

## 2) Branch Naming
Use the following naming convention:

- `feature/<issue-id>-short-description`
- `fix/<issue-id>-short-description`
- `docs/<issue-id>-short-description`
- `chore/<issue-id>-short-description`

Examples:
- `feature/18-shipping-cost-api`
- `fix/21-order-flow-validation`
- `docs/12-add-governance-docs`

---

## 3) Commit Message Convention
We recommend Conventional Commits:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`
- `refactor: ...`
- `test: ...`

Examples:
- `docs: add contributing guidelines`
- `feat: implement shipping cost calculation API`

---

## 4) Pull Request Requirements
Every PR must include:

### 4.1 Description (Minimum Content)
- **What changed**
- **Why**
- **Scope** (what is included)
- **Out of scope**
- **How to test**
- **Risks / rollout notes** (if applicable)

### 4.2 Link to Issue
Include: `Closes #<issue-id>` when the PR fully resolves the issue.

---

## 5) Local Setup (Developer)
### 5.1 Requirements
- Node.js >= 18
- npm (or yarn/pnpm)
- PostgreSQL (Supabase)

### 5.2 Install
```bash
npm install
