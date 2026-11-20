# UNI GENIUS — Neon database setup

The app uses Neon PostgreSQL for private cloud course materials. The database connection is made only on the server through `DATABASE_URL`.

## Setup

1. Create a Neon account and a project using the Free plan. Do not select a paid plan, paid add-on, or enable any spend/billing option.
2. Create or select the database, then copy its pooled connection string from the Neon dashboard.
3. Open the Neon SQL Editor and run `neon/course_documents.sql`.
4. In Vercel → Project → Settings → Environment Variables, add:
   - Name: `DATABASE_URL`
   - Value: the Neon connection string
   - Environments: Production and Preview
5. Redeploy the Vercel project, then open `/api/health`. The expected cloud knowledge state is `connected: true` and `tableAvailable: true`.
6. Only after the health check passes, import course documents at `/admin/import`.

## Important

- Never put `DATABASE_URL` in client-side or `VITE_*` variables.
- Do not paste the connection string into chat or GitHub.
- Do not delete the old Supabase project or its credentials until Neon is verified and the course materials have been re-imported or migrated.
- This change does not migrate existing Supabase rows automatically. Export/re-import the course materials before retiring Supabase.
- Keep the Neon project on its free tier and do not enable paid usage. Free quotas and terms can change; check the current Neon billing page in your account.
