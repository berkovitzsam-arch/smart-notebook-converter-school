# SMART Notebook Converter — school deployment

Private source mirror for the school's Google Drive-integrated deployment of SMART Notebook Converter.

The app runs entirely in the browser. It converts PDFs and images into `.notebook` files and can open, annotate, and save `.notebook` files through Google Drive. The deployment build requires school-owned Google OAuth, API-key, and Drive app identifiers stored as GitHub Actions secrets.

## Required repository secrets

- `SCHOOL_GOOGLE_CLIENT_ID`
- `SCHOOL_GOOGLE_API_KEY`
- `SCHOOL_GOOGLE_APP_ID`
- `SCHOOL_GOOGLE_SITE_VERIFICATION` (optional)

Pushes to `main` run the engine tests, build the isolated school configuration, and deploy `webapp/dist` to GitHub Pages.
