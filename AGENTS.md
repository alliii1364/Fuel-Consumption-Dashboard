# Repository Guidelines

## Project Structure & Module Organization
This repository has two TypeScript applications:

- `fuel-backend/`: NestJS API. Main code lives in `src/` with feature modules such as `auth/`, `fuel/`, `dashboard/`, `reports/`, and `vehicles/`. End-to-end tests live in `test/`.
- `fuel-dashboard/`: Next.js 16 frontend. App Router pages are under `src/app/`, shared UI in `src/components/`, auth state in `src/contexts/`, reusable logic in `src/hooks/`, and API/helpers in `src/lib/`.

Keep backend logic inside its owning module and place frontend page-specific components near the route when they are not reused elsewhere.

## Build, Test, and Development Commands
Run commands from the relevant package directory.

- `cd fuel-backend && npm run start:dev`: start the API with hot reload on port `3000`.
- `cd fuel-backend && npm run build`: compile the backend to `dist/`.
- `cd fuel-backend && npm run test`, `npm run test:cov`, `npm run test:e2e`: run unit, coverage, and e2e suites.
- `cd fuel-backend && npm run lint`: run ESLint with autofix.
- `cd fuel-dashboard && npm run dev`: start the frontend on port `3001`.
- `cd fuel-dashboard && npm run build && npm run start`: build and serve the production frontend.
- `cd fuel-dashboard && npm run lint`: run Next.js ESLint checks.

## Coding Style & Naming Conventions
Both packages use TypeScript. Backend Prettier settings enforce `singleQuote: true` and trailing commas; follow that style across the repo. Use 2-space indentation, `PascalCase` for React components and Nest classes, and `camelCase` for functions, hooks, and helpers. Keep DTOs in `dto/` folders and prefer descriptive file names such as `reports.service.ts` or `FuelStatsPanel.tsx`.

## Testing Guidelines
Backend tests use Jest and Supertest. Keep unit tests next to the module when added, and name e2e tests `*.e2e-spec.ts`. Run `npm run test:cov` before merging backend logic changes. The frontend currently has no committed test runner, so contributors should at minimum run `npm run lint` and document any manual verification performed.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects such as `Enhance fuel consumption service...` or `Implement trip reporting feature...`. Follow that pattern and keep commits focused. PRs should include a clear summary, affected areas (`fuel-backend`, `fuel-dashboard`, or both), linked issues if available, and screenshots for UI changes. Call out any required `.env` updates, especially `DB_*`, `JWT_SECRET`, `PORT`, and `NEXT_PUBLIC_API_URL`.
