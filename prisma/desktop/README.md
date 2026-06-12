# Desktop SQLite Prisma Schema

This schema is intended for packaged desktop builds.

- Runtime database file: user data directory, not the installation directory.
- JSON-heavy application records are stored as stringified JSON to keep SQLite portable.
- Packaged builds copy this directory as an application resource so migrations/schema can ship with the installer.

Operational notes:

- Check readiness with `GET /api/storage/status`.
- Initialize the SQLite schema with `POST /api/storage/sqlite/initialize` or `npm run prisma:desktop:push`.
- Runtime reads and writes use SQLite directly, including test cases, runs, settings, schedules, and browser-chat sessions.
- Packaged desktop builds run `prisma:desktop:generate` before `next build` so the generated client matches this schema.
