# Private cloud course knowledge (Supabase)

UNI GENIUS can keep centrally imported course material in a private Supabase Postgres table. Students do not upload the same lectures in each chat: the API retrieves the selected subject's indexed text and passes only relevant passages to Gemini. Existing chat attachments and the on-device library remain available.

## One-time setup

1. Create a Supabase project.
2. Open SQL Editor and run `supabase/course_documents.sql`.
3. In the Vercel project settings, add these **server-only** environment variables for Production (and Preview if desired):
   - `SUPABASE_URL`: Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY`: service_role key. Never use the anon key here and never put this value in Vite/client variables.
   - `COURSE_IMPORT_TOKEN`: a long random secret used to protect the import endpoint.
4. Redeploy the app.

## Import endpoint

POST `/api/admin/course-materials` with header `Authorization: Bearer <COURSE_IMPORT_TOKEN>` and JSON:
```json
{
  "documents": [{
    "subjectId": "ice",
    "subjectLabel": "Internal Combustion Engines",
    "name": "Lecture 1.pdf",
    "chapter": "Introduction",
    "materialType": "lecture",
    "attachment": {
      "name": "Lecture 1.pdf",
      "mimeType": "application/pdf",
      "dataBase64": "<base64 file bytes>"
    }
  }]
}
```
Send up to 50 files per batch; each file must be 15 MB or smaller and supported by the existing extractor (text PDF, DOCX, TXT, MD). The importer stores extracted text and page markers, not the original binary file. Repeat batches for larger collections. Scanned PDFs need OCR before import.

## Important

- GitHub stores application code only; do not commit private lectures or exams.
- The service-role key and import token belong only in Vercel server environment variables.
- This first version uses subject-scoped retrieval over imported text and the existing passage ranker, not model training or fine-tuning.
- Current API retrieval is capped at 200 stored documents per subject and sends only the best passages to Gemini.
- Review Supabase/Vercel free-tier limits before importing large archives.
