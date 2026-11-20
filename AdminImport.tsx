import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, CheckCircle2, CloudUpload, FileText, LockKeyhole, LoaderCircle, ShieldCheck, XCircle } from 'lucide-react';
import { subjects } from './subjects';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-expect-error Vite resolves this PDF.js worker asset at build time.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function extractPdfInBrowser(file: File) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages: string[] = [];
  let totalChars = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => ('str' in item ? item.str : '')).filter(Boolean).join(' ').trim();
    if (pageText) {
      const chunk = `[Page ${pageNumber}]\n${pageText}`;
      pages.push(chunk);
      totalChars += chunk.length;
      if (totalChars > 120_000) break;
    }
  }
  await pdf.destroy();
  const text = pages.join('\n\n').slice(0, 120_000);
  if (!text.trim()) throw new Error('ما لكيت نص قابل للتحديد داخل PDF. إذا الملزمة مصوّرة، تحتاج OCR قبل الاستيراد.');
  return { text, pageCount: pdf.numPages };
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;

function mimeFor(file: File) {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'md') return 'text/markdown';
  return 'text/plain';
}

export function AdminImport() {
  const [token, setToken] = useState('');
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? 'gasdyn');
  const [chapter, setChapter] = useState('');
  const [materialType, setMaterialType] = useState('lecture');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [cloudState, setCloudState] = useState<'checking' | 'ready' | 'disconnected'>('checking');
  const [cloudMessage, setCloudMessage] = useState('جارٍ فحص اتصال قاعدة المعرفة السحابية...');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [result, setResult] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedSubject = subjects.find((subject) => subject.id === subjectId) ?? subjects[0];
  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  useEffect(() => {
    let active = true;
    fetch('/api/health', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!active) return;
        if (data?.cloudKnowledge?.connected) {
          setCloudState('ready');
          setCloudMessage('قاعدة المعرفة السحابية متصلة وجاهزة لاستقبال المواد.');
        } else {
          setCloudState('disconnected');
          const error = data?.cloudKnowledge?.error;
          setCloudMessage(error === 'database_authentication_failed'
            ? 'قاعدة البيانات موجودة، لكن مفتاح الاتصال مرفوض. لن نبدأ الرفع حتى يُصلح الاتصال.'
            : error === 'course_documents_table_missing'
              ? 'جدول المواد الدراسية غير موجود في Neon. شغّل ملف neon/course_documents.sql أولاً.'
              : 'قاعدة المعرفة السحابية غير متصلة حالياً. تحقق من DATABASE_URL وإعدادات Neon في الخادم.');
        }
      })
      .catch(() => {
        if (!active) return;
        setCloudState('disconnected');
        setCloudMessage('تعذر فحص اتصال قاعدة المعرفة. تحقق من اتصال الإنترنت ثم أعد تحميل الصفحة.');
      });
    return () => { active = false; };
  }, []);



  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    const next = Array.from(incoming);
    const supported = next.filter((file) => /\.(pdf|docx|txt|md)$/i.test(file.name));
    const oversized = supported.filter((file) => file.size > MAX_FILE_BYTES);
    const acceptable = supported.filter((file) => file.size > 0 && file.size <= MAX_FILE_BYTES);
    setFiles((previous) => [...previous, ...acceptable]);
    setResult(oversized.length
      ? { kind: 'error', text: `تجاوزت بعض الملفات حد 15 ميغابايت: ${oversized.map((file) => file.name).join('، ')}` }
      : next.length !== supported.length
        ? { kind: 'error', text: 'بعض الملفات غير مدعومة. الصيغ المقبولة: PDF نصي وDOCX وTXT وMD.' }
        : null);
  }

  async function upload() {
    if (!token.trim() || !files.length || busy) return;
    setBusy(true);
    setResult(null);
    setProgress({ done: 0, total: files.length });
    let imported = 0;
    try {
      // Send the original binary file; base64 JSON expands PDFs by about 33% and can hit Vercel's request limit.
      for (const file of files) {
        const params = new URLSearchParams({
          subjectId,
          subjectLabel: selectedSubject.ar,
          name: file.name,
          chapter: chapter.trim(),
          materialType,
        });
        let response: Response;
        if (/\.pdf$/i.test(file.name)) {
          // Parse large PDFs on the iPhone itself so the 9.3 MB file never hits Vercel's request-body limit.
          const extracted = await extractPdfInBrowser(file);
          response = await fetch('/api/admin/course-materials-text', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token.trim()}`,
            },
            body: JSON.stringify({
              ...Object.fromEntries(params.entries()),
              text: extracted.text,
              pageCount: extracted.pageCount,
            }),
          });
        } else {
          response = await fetch(`/api/admin/course-materials?${params.toString()}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              Authorization: `Bearer ${token.trim()}`,
            },
            body: file,
          });
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const reason = data.message || (response.status === 401 ? 'رمز الاستيراد غير صحيح.' : 'فشل رفع الملف.');
          throw new Error(`توقف الرفع عند «${file.name}»: ${reason}`);
        }
        imported += Number(data.imported || 1);
        setProgress({ done: imported, total: files.length });
      }
      setResult({ kind: 'success', text: `تم استيراد ${imported} ملفاً إلى مادة «${selectedSubject.ar}» بنجاح.` });
      setFiles([]);
      setChapter('');
      if (inputRef.current) inputRef.current.value = '';
    } catch (error) {
      setResult({ kind: 'error', text: error instanceof Error ? error.message : 'حدث خطأ أثناء الاستيراد.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main dir="rtl" style={{ minHeight: '100vh', background: '#071321', color: '#e8f0fa', padding: '28px 16px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <a href="/" style={{ color: '#91a9c5', display: 'inline-flex', gap: 8, alignItems: 'center', textDecoration: 'none', marginBottom: 24 }}><ArrowLeft size={16}/> العودة إلى UNI GENIUS</a>
        <header style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#70d9df' }}><BookOpen size={25}/><span style={{ letterSpacing: 2, fontWeight: 800 }}>UNI GENIUS · ADMIN</span></div>
          <h1 style={{ fontSize: 'clamp(26px, 5vw, 38px)', margin: '14px 0 8px' }}>استيراد المواد الدراسية إلى السحابة</h1>
          <p style={{ color: '#a7b8cc', lineHeight: 1.8, margin: 0 }}>ارفع ملازمك ومحاضراتك مرة واحدة. ستُربط كل مادة بمكتبتها السحابية ليستخدمها المساعد تلقائياً عند الإجابة.</p>
        </header>

        <div role="status" style={{ marginBottom: 16, borderRadius: 12, padding: 14, border: `1px solid ${cloudState === 'ready' ? '#286b56' : cloudState === 'checking' ? '#42617c' : '#8a4b51'}`, background: cloudState === 'ready' ? '#12382f' : cloudState === 'checking' ? '#101f30' : '#3b252b', color: cloudState === 'ready' ? '#9de7c7' : cloudState === 'checking' ? '#b9c9da' : '#ffc1c1', lineHeight: 1.7 }}>
          <b>{cloudState === 'ready' ? '✓ اتصال السحابة جاهز' : cloudState === 'checking' ? '◌ فحص الاتصال' : '⚠ مشكلة في اتصال السحابة'}</b>
          <div>{cloudMessage}</div>
        </div>

        <section style={{ background: '#101f30', border: '1px solid #263a50', borderRadius: 18, padding: 20, display: 'grid', gap: 18 }}>
          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 700 }}><LockKeyhole size={17}/> رمز الاستيراد الخاص</span>
            <input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="أدخل COURSE_IMPORT_TOKEN" style={inputStyle}/>
            <small style={{ color: '#91a9c5' }}>لا تشارك هذا الرمز مع الطلاب، ولا تحفظه في GitHub.</small>
          </label>

          <label style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontWeight: 700 }}>المادة الدراسية</span>
            <select value={subjectId} onChange={(event) => setSubjectId(event.target.value)} style={inputStyle}>
              {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.ar} — {subject.en}</option>)}
            </select>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            <label style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontWeight: 700 }}>الفصل / الموضوع (اختياري)</span>
              <input value={chapter} onChange={(event) => setChapter(event.target.value)} placeholder="مثلاً: الفصل الأول" style={inputStyle}/>
            </label>
            <label style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontWeight: 700 }}>نوع المادة</span>
              <select value={materialType} onChange={(event) => setMaterialType(event.target.value)} style={inputStyle}>
                <option value="lecture">محاضرة</option><option value="notes">ملزمة / ملاحظات</option><option value="exam">أسئلة امتحانات</option><option value="solution">حلول نموذجية</option><option value="other">أخرى</option>
              </select>
            </label>
          </div>

          <div style={{ border: '1px dashed #42617c', borderRadius: 14, padding: 22, textAlign: 'center', background: '#0b1928' }}>
            <CloudUpload size={34} color="#70d9df"/>
            <h2 style={{ fontSize: 18, margin: '10px 0 6px' }}>اختر ملفات المحاضرات</h2>
            <p style={{ color: '#91a9c5', margin: '0 0 16px', lineHeight: 1.7 }}>تقدر تختار عدة ملفات من الآيفون دفعة واحدة. الحد الأقصى 15MB للملف.</p>
            <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} style={buttonStyle}>اختيار الملفات</button>
            <input ref={inputRef} type="file" multiple accept=".pdf,.docx,.txt,.md" hidden onChange={(event) => { addFiles(event.target.files); event.currentTarget.value = ''; }}/>
            <div style={{ color: '#91a9c5', fontSize: 12, marginTop: 12 }}>PDF نصي · DOCX · TXT · MD — ملفات PDF المصورة تحتاج OCR مسبقاً</div>
          </div>

          {files.length > 0 && <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#b9c9da' }}><b>الملفات المحددة: {files.length}</b><span>{(totalSize / 1048576).toFixed(1)} MB</span></div>
            {files.map((file, index) => <div key={`${file.name}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#172a3d', padding: 10, borderRadius: 10 }}>
              <FileText size={17} color="#70d9df"/><span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{file.name}</span><small style={{ color: '#91a9c5' }}>{(file.size / 1048576).toFixed(1)} MB</small>
              <button type="button" aria-label="حذف الملف" disabled={busy} onClick={() => setFiles((previous) => previous.filter((_, i) => i !== index))} style={{ background: 'transparent', border: 0, color: '#f49a9a' }}><XCircle size={18}/></button>
            </div>)}
          </div>}

          {busy && <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#b9c9da' }}><span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><LoaderCircle size={16}/> جارٍ الاستيراد...</span><b>{progress.done}/{progress.total}</b></div>
            <div style={{ height: 7, background: '#263a50', borderRadius: 20, overflow: 'hidden' }}><div style={{ width: `${progress.total ? progress.done / progress.total * 100 : 0}%`, height: '100%', background: '#70d9df', transition: 'width .2s' }}/></div>
          </div>}

          {result && <div role="status" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, borderRadius: 10, background: result.kind === 'success' ? '#12382f' : '#3b252b', color: result.kind === 'success' ? '#9de7c7' : '#ffc1c1', lineHeight: 1.7 }}>
            {result.kind === 'success' ? <CheckCircle2 size={19}/> : <XCircle size={19}/>}<span>{result.text}</span>
          </div>}

          <button type="button" onClick={() => void upload()} disabled={!token.trim() || !files.length || busy || cloudState !== 'ready'} style={{ ...buttonStyle, width: '100%', opacity: !token.trim() || !files.length || busy || cloudState !== 'ready' ? .45 : 1, cursor: !token.trim() || !files.length || busy || cloudState !== 'ready' ? 'not-allowed' : 'pointer' }}>
            {busy ? 'جارٍ الرفع...' : `استيراد ${files.length || ''} ملف إلى قاعدة المعرفة`}
          </button>
        </section>

        <p style={{ color: '#91a9c5', fontSize: 13, lineHeight: 1.8, marginTop: 16 }}><ShieldCheck size={14} style={{ verticalAlign: 'middle', marginLeft: 6 }}/>المواد تُخزّن كنص مستخرج في قاعدة بيانات خاصة، ولا تُرفع إلى GitHub. الاستيراد لا يعني تدريب النموذج؛ بل يتيح للمساعد استرجاع المقاطع المناسبة من محاضراتك.</p>
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '13px 14px', borderRadius: 10, border: '1px solid #344d65', background: '#0b1928', color: '#e8f0fa', fontSize: 15, outline: 'none' };
const buttonStyle: React.CSSProperties = { border: 0, borderRadius: 10, padding: '13px 18px', background: '#70d9df', color: '#071321', fontWeight: 800, fontSize: 15, cursor: 'pointer' };
