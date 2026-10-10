import { useMemo, useRef, useState } from "react";
import {
  readCustomImportFiles, analyzeFiles, draftFormatFromAnalysis, previewRows,
  headerSignature, slugify, DEFAULT_EXCLUDE_KEYWORDS, CUSTOM_FORMAT_VERSION,
} from "./importers/customImporter";

const STRINGS = {
  en: {
    title: 'Learn format',
    help: 'Teach homefin any bank or card export: upload one sample CSV/XLSX, check the detected columns and preview, then save. Files with the same columns are recognised automatically on import. An automatic Time Machine backup is created before saving.',
    pick: 'Upload sample file',
    saved: 'Saved formats',
    none: 'No learned formats yet.',
    edit: 'Edit', del: 'Delete', cancel: 'Cancel', save: 'Save format', saveImport: 'Save & import this file',
    deleteConfirm: 'Delete this format? Already imported transactions are kept.',
    name: 'Name', sheet: 'Sheet', headerRow: 'Header row',
    columns: 'Columns', date: 'Date', valueDate: 'Value date (fallback)', description: 'Description', extraDescription: 'Extra description (optional)',
    amountMode: 'Amounts are in', single: 'One signed column', split: 'Separate money-out / money-in columns', indicator: 'Amount + debit/credit column',
    amount: 'Amount', debit: 'Money out', credit: 'Money in', indicatorCol: 'Debit/credit column', debitValues: 'Values meaning "money out"',
    currency: 'Currency', holder: 'Holder / cardholder', category: 'Bank category', status: 'Status', country: 'Country', reference: 'Transaction ID',
    none_: '— none —',
    interpretation: 'How to read values', dateOrder: 'Date order', dmy: 'Day / month / year', mdy: 'Month / day / year',
    decimal: 'Decimal separator', comma: 'Comma (1.234,56)', dot: 'Dot (1,234.56)',
    sign: 'Money out is shown as', negOut: 'Negative numbers (bank accounts)', posOut: 'Positive numbers (credit cards)',
    incoming: 'Money coming in counts as', income: 'Income', refund: 'Refund (reduces spending)', ignore: 'Ignored',
    ownership: 'Account owner', useColumn: 'Read from holder column', shared: 'Shared',
    exclusions: 'Exclude rows whose description contains (one per line)', ownTransfers: 'Exclude transfers to accounts of household members',
    skipStatus: 'Skip rows whose status contains (one per line)',
    preview: 'Preview', previewHelp: 'First rows as they will be imported. Positive = spend, negative = money in.',
    okRows: 'rows ready', skippedRows: 'skipped',
    expense: 'Expense', incomeTag: 'Income', refundTag: 'Refund', excludedTag: 'Excluded',
    reasons: { invalid_date: 'unreadable date', missing_description: 'no description', invalid_amount: 'unreadable amount', zero_amount: 'zero amount', status: 'status filtered' },
    required: 'Name, date, description and amount columns are required.',
    savedMsg: 'Format saved.', noSample: 'Editing without a sample file: preview unavailable. Upload a new sample to re-detect columns.',
    readError: 'Could not read the file', noTable: 'No transaction table found in this file.',
  },
  it: {
    title: 'Impara formato',
    help: 'Insegna a homefin qualsiasi export di banca o carta: carica un file campione CSV/XLSX, verifica colonne e anteprima, poi salva. I file con le stesse colonne vengono riconosciuti in automatico all’import. Prima del salvataggio viene creato un backup Time Machine.',
    pick: 'Carica file campione',
    saved: 'Formati salvati',
    none: 'Nessun formato appreso.',
    edit: 'Modifica', del: 'Elimina', cancel: 'Annulla', save: 'Salva formato', saveImport: 'Salva e importa questo file',
    deleteConfirm: 'Eliminare questo formato? Le transazioni già importate restano.',
    name: 'Nome', sheet: 'Foglio', headerRow: 'Riga intestazioni',
    columns: 'Colonne', date: 'Data', valueDate: 'Data valuta (riserva)', description: 'Descrizione', extraDescription: 'Descrizione aggiuntiva (opzionale)',
    amountMode: 'Gli importi sono in', single: 'Una colonna con segno', split: 'Colonne separate uscite / entrate', indicator: 'Importo + colonna dare/avere',
    amount: 'Importo', debit: 'Uscite', credit: 'Entrate', indicatorCol: 'Colonna dare/avere', debitValues: 'Valori che indicano "uscita"',
    currency: 'Valuta', holder: 'Titolare', category: 'Categoria banca', status: 'Stato', country: 'Paese', reference: 'ID transazione',
    none_: '— nessuna —',
    interpretation: 'Come leggere i valori', dateOrder: 'Ordine data', dmy: 'Giorno / mese / anno', mdy: 'Mese / giorno / anno',
    decimal: 'Separatore decimale', comma: 'Virgola (1.234,56)', dot: 'Punto (1,234.56)',
    sign: 'Le uscite sono', negOut: 'Numeri negativi (conti)', posOut: 'Numeri positivi (carte di credito)',
    incoming: 'Il denaro in entrata conta come', income: 'Entrata', refund: 'Rimborso (riduce la spesa)', ignore: 'Ignorato',
    ownership: 'Intestatario del conto', useColumn: 'Leggi dalla colonna titolare', shared: 'Condiviso',
    exclusions: 'Escludi righe la cui descrizione contiene (una per riga)', ownTransfers: 'Escludi bonifici verso conti dei membri del nucleo',
    skipStatus: 'Salta righe il cui stato contiene (una per riga)',
    preview: 'Anteprima', previewHelp: 'Prime righe come verranno importate. Positivo = spesa, negativo = entrata.',
    okRows: 'righe pronte', skippedRows: 'saltate',
    expense: 'Spesa', incomeTag: 'Entrata', refundTag: 'Rimborso', excludedTag: 'Escluso',
    reasons: { invalid_date: 'data illeggibile', missing_description: 'senza descrizione', invalid_amount: 'importo illeggibile', zero_amount: 'importo zero', status: 'filtrata per stato' },
    required: 'Servono nome, data, descrizione e importo.',
    savedMsg: 'Formato salvato.', noSample: 'Modifica senza file campione: anteprima non disponibile. Carica un nuovo campione per rilevare di nuovo le colonne.',
    readError: 'Impossibile leggere il file', noTable: 'Nessuna tabella di transazioni trovata nel file.',
  },
};

const fmtAmount = (n) => (Number(n) < 0 ? '−' : '') + '€' + Math.abs(Number(n) || 0).toFixed(2);
const lines = (text) => String(text || '').split(/\n/).map((s) => s.trim()).filter(Boolean);

export default function LearnFormatPanel({ store, theme, input, lang = 'en', members = [], sharedLabel = 'Shared', onSaveFormat, onDeleteFormat, onSaveAndImport }) {
  const S = STRINGS[lang] || STRINGS.en;
  const fileRef = useRef();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState(null); // { format, files, fileTables, best, sheetIndex, headerIndex }
  const formats = store?.customImportFormats && typeof store.customImportFormats === 'object' ? store.customImportFormats : {};

  const analysisFor = (fileTables, sheetIndex, headerIndex) => analyzeFiles(fileTables, { sheetIndex, headerIndex });

  const onPick = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setBusy(true); setMsg('');
    try {
      const fileTables = await readCustomImportFiles(files.slice(0, 1));
      const best = analysisFor(fileTables);
      if (!best || !best.analysis.headers.length) throw new Error(S.noTable);
      const format = draftFormatFromAnalysis(best, { fileName: files[0].name, members });
      setDraft({ format: { ...format, headers: best.analysis.headers }, files: files.slice(0, 1), fileTables, best, sheetIndex: best.sheetIdx, headerIndex: best.analysis.headerIndex });
    } catch (err) {
      setMsg(`❌ ${S.readError}: ${err?.message || err}`);
    }
    setBusy(false);
  };

  // Changing sheet or header row re-runs detection, keeping the user's non-column settings.
  const reanalyze = (sheetIndex, headerIndex) => setDraft((d) => {
    const best = analysisFor(d.fileTables, sheetIndex, headerIndex);
    if (!best) return d;
    const fresh = draftFormatFromAnalysis(best, { fileName: d.format.sampleFileName, members });
    return { ...d, best, sheetIndex, headerIndex: best.analysis.headerIndex, format: { ...d.format, ...fresh, label: d.format.label, owner: d.format.owner, excludeKeywords: d.format.excludeKeywords, skipStatus: d.format.skipStatus, headers: best.analysis.headers } };
  });
  const setFormat = (patch) => setDraft((d) => ({ ...d, format: { ...d.format, ...patch } }));
  const setMapping = (patch) => setDraft((d) => ({ ...d, format: { ...d.format, mapping: { ...d.format.mapping, ...patch } } }));

  const ctx = { members, sharedLabel };
  const preview = useMemo(() => (draft?.best ? previewRows(draft.best.analysis, draft.format, ctx, 12) : null), [draft, members]);

  const finalFormat = () => {
    const f = draft.format;
    const id = f.id || `custom_${slugify(f.label)}`;
    const now = new Date().toISOString();
    return { ...f, id, version: CUSTOM_FORMAT_VERSION, headerSignature: headerSignature(f.headers || []), createdAt: f.createdAt || now, updatedAt: now };
  };
  const validate = () => {
    const f = draft?.format;
    const m = f?.mapping || {};
    const hasAmount = m.amountMode === 'split' ? (m.debit && m.credit) : !!m.amount;
    return !!(f?.label?.trim() && m.date && m.description?.length && hasAmount);
  };
  const save = async (andImport) => {
    if (!validate()) { setMsg(S.required); return; }
    setBusy(true); setMsg('');
    try {
      const format = finalFormat();
      if (andImport) await onSaveAndImport?.(format, draft.files);
      else await onSaveFormat?.(format);
      setDraft(null);
      setMsg(S.savedMsg);
    } catch (err) {
      setMsg(`❌ ${err?.message || err}`);
    }
    setBusy(false);
  };
  const editExisting = (format) => setDraft({ format: { ...format }, files: [], fileTables: null, best: null });
  const removeFormat = async (format) => {
    if (!window.confirm(S.deleteConfirm)) return;
    await onDeleteFormat?.(format.id);
  };

  const sel = (value, onChange, options, allowNone = true) => (
    <select style={input} value={value || ''} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">{S.none_}</option>}
      {options.map((o) => typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  const field = (label, control) => <label><div className="profile-field-label">{label}</div>{control}</label>;
  const pill = (active) => ({ background: active ? theme.accentSoft : theme.input, border: '1px solid ' + (active ? theme.accent : theme.border), color: active ? theme.accent : theme.text, borderRadius: 999, padding: '7px 11px', fontWeight: 800, cursor: 'pointer', fontSize: 12 });
  const tag = (tx) => tx.cashflowType === 'income' ? S.incomeTag : tx.cashflowType === 'excluded' ? S.excludedTag : tx.isRefund ? S.refundTag : S.expense;

  const f = draft?.format;
  const m = f?.mapping || {};
  const headers = f?.headers || [];
  const sheets = draft?.fileTables?.[0]?.sheets || [];
  const descCols = Array.isArray(m.description) ? m.description : [m.description].filter(Boolean);

  return <>
    <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,.xlsx,.xls,text/csv" onChange={onPick} style={{ display: 'none' }} />
    <div className="profile-action-row">
      <button className="profile-primary-btn" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? '…' : S.title}</button>
      <div className="profile-action-copy"><b>{S.title}</b><br />{S.help}{msg ? <span className="profile-inline-status"> {msg}</span> : null}</div>
    </div>

    {!draft && Object.keys(formats).length > 0 && <div className="profile-learn-card">
      <div className="profile-section-title">{S.saved}</div>
      <div style={{ display: 'grid', gap: 8 }}>
        {Object.values(formats).map((format) => <div key={format.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid ' + theme.border, borderRadius: 10, padding: '8px 10px' }}>
          <div style={{ minWidth: 0 }}>
            <b>{format.label}</b>
            <div style={{ fontSize: 12, color: theme.subtext }}>{(format.headers || []).slice(0, 6).join(' · ')}{(format.headers || []).length > 6 ? ' …' : ''}</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="profile-secondary-btn" onClick={() => editExisting(format)}>{S.edit}</button>
            <button className="hf-icon-danger-btn" onClick={() => removeFormat(format)}>{S.del}</button>
          </div>
        </div>)}
      </div>
    </div>}

    {draft && <div className="profile-learn-card" style={{ display: 'grid', gap: 14 }}>
      <div className="profile-field-grid">
        {field(S.name, <input style={input} value={f.label || ''} onChange={(e) => setFormat({ label: e.target.value })} />)}
        {draft.best && sheets.length > 1 && field(S.sheet, sel(String(draft.sheetIndex), (v) => reanalyze(Number(v), undefined), sheets.map((s, i) => ({ value: String(i), label: s.name })), false))}
        {draft.best && field(S.headerRow, sel(String(draft.headerIndex), (v) => reanalyze(draft.sheetIndex, Number(v)),
          (sheets[draft.sheetIndex]?.rows || []).slice(0, 40).map((row, i) => ({ value: String(i), label: `${i + 1}: ${row.filter((c) => c !== '').slice(0, 4).map(String).join(' | ').slice(0, 70)}` })), false))}
      </div>
      {!draft.best && <div className="profile-empty-state">{S.noSample}</div>}

      <div>
        <div className="profile-section-title">{S.columns}</div>
        <div className="profile-mapping-grid">
          {field(S.date + ' *', sel(m.date, (v) => setMapping({ date: v }), headers))}
          {field(S.valueDate, sel(m.valueDate, (v) => setMapping({ valueDate: v }), headers))}
          {field(S.description + ' *', sel(descCols[0], (v) => setMapping({ description: [v, ...descCols.slice(1)].filter(Boolean) }), headers))}
          {field(S.extraDescription, sel(descCols[1], (v) => setMapping({ description: [descCols[0], v].filter(Boolean) }), headers))}
          {field(S.currency, sel(m.currency, (v) => setMapping({ currency: v }), headers))}
          {field(S.holder, sel(m.holder, (v) => setMapping({ holder: v }), headers))}
          {field(S.category, sel(m.category, (v) => setMapping({ category: v }), headers))}
          {field(S.status, sel(m.status, (v) => setMapping({ status: v }), headers))}
          {field(S.country, sel(m.country, (v) => setMapping({ country: v }), headers))}
          {field(S.reference, sel(m.reference, (v) => setMapping({ reference: v }), headers))}
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="profile-field-label">{S.amountMode} *</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {['single', 'split', 'indicator'].map((mode) => <button type="button" key={mode} style={pill(m.amountMode === mode)} onClick={() => setMapping({ amountMode: mode })}>{S[mode]}</button>)}
          </div>
          <div className="profile-mapping-grid" style={{ marginTop: 0 }}>
            {m.amountMode !== 'split' && field(S.amount, sel(m.amount, (v) => setMapping({ amount: v }), headers))}
            {m.amountMode === 'split' && field(S.debit, sel(m.debit, (v) => setMapping({ debit: v }), headers))}
            {m.amountMode === 'split' && field(S.credit, sel(m.credit, (v) => setMapping({ credit: v }), headers))}
            {m.amountMode === 'indicator' && field(S.indicatorCol, sel(m.indicator, (v) => setMapping({ indicator: v }), headers))}
            {m.amountMode === 'indicator' && field(S.debitValues, <input style={input} value={(m.debitValues || []).join(', ')} onChange={(e) => setMapping({ debitValues: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="D, DR, Debit" />)}
          </div>
        </div>
      </div>

      <div>
        <div className="profile-section-title">{S.interpretation}</div>
        <div className="profile-mapping-grid">
          {field(S.dateOrder, sel(f.dateOrder, (v) => setFormat({ dateOrder: v }), [{ value: 'DMY', label: S.dmy }, { value: 'MDY', label: S.mdy }], false))}
          {field(S.decimal, sel(f.decimal, (v) => setFormat({ decimal: v }), [{ value: ',', label: S.comma }, { value: '.', label: S.dot }], false))}
          {m.amountMode === 'single' && field(S.sign, sel(f.signMode, (v) => setFormat({ signMode: v }), [{ value: 'negative_is_expense', label: S.negOut }, { value: 'positive_is_expense', label: S.posOut }], false))}
          {field(S.incoming, sel(f.incomingAs, (v) => setFormat({ incomingAs: v }), [{ value: 'income', label: S.income }, { value: 'refund', label: S.refund }, { value: 'excluded', label: S.ignore }], false))}
          {field(S.ownership, sel(f.owner, (v) => setFormat({ owner: v }), [
            ...members.map((x) => ({ value: x.id, label: x.name })),
            ...(members.length > 1 ? [{ value: 'shared', label: S.shared }] : []),
            ...(m.holder ? [{ value: 'column', label: S.useColumn }] : []),
          ], false))}
        </div>
      </div>

      <div className="profile-field-grid">
        {field(S.exclusions, <textarea style={{ ...input, minHeight: 110, fontFamily: 'inherit' }} value={(f.excludeKeywords || []).join('\n')} onChange={(e) => setFormat({ excludeKeywords: lines(e.target.value) })} placeholder={DEFAULT_EXCLUDE_KEYWORDS.slice(0, 3).join('\n')} />)}
        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={!!f.excludeOwnTransfers} onChange={(e) => setFormat({ excludeOwnTransfers: e.target.checked })} />{S.ownTransfers}</label>
          {m.status && field(S.skipStatus, <textarea style={{ ...input, minHeight: 70, fontFamily: 'inherit' }} value={(f.skipStatus || []).join('\n')} onChange={(e) => setFormat({ skipStatus: lines(e.target.value) })} />)}
        </div>
      </div>

      {preview && <div>
        <div className="profile-section-title">{S.preview} · {preview.ok} {S.okRows}{Object.keys(preview.skipped).length ? ` · ${Object.entries(preview.skipped).map(([k, v]) => `${v} ${S.skippedRows} (${S.reasons[k] || k})`).join(', ')}` : ''}</div>
        <div style={{ fontSize: 12, color: theme.subtext }}>{S.previewHelp}</div>
        <div className="profile-preview-table">
          {preview.rows.map((r) => r.tx
            ? <div key={r.rowNumber} className="profile-preview-row" style={{ gridTemplateColumns: '92px minmax(0,1fr) 110px 90px 90px' }}>
                <span>{r.tx.date}</span><span title={r.tx.desc}>{r.tx.desc}</span><span>{r.tx.holder || '—'}</span><span style={{ color: r.tx.cashflowType === 'excluded' ? theme.subtext : r.tx.cashflowType === 'income' ? theme.totalGreen : theme.text }}>{tag(r.tx)}</span><b>{fmtAmount(r.tx.amount)}</b>
              </div>
            : <div key={r.rowNumber} className="profile-preview-row" style={{ gridTemplateColumns: '92px minmax(0,1fr) 180px', opacity: 0.6 }}>
                <span>#{r.rowNumber}</span><span>{r.raw.map(String).join(' | ')}</span><span>{S.reasons[r.skip] || r.skip}</span>
              </div>)}
        </div>
      </div>}

      <div className="profile-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="profile-secondary-btn" onClick={() => setDraft(null)} disabled={busy}>{S.cancel}</button>
        <button className="profile-primary-btn" onClick={() => save(false)} disabled={busy}>{S.save}</button>
        {draft.files?.length > 0 && <button className="profile-primary-btn" onClick={() => save(true)} disabled={busy}>{S.saveImport}</button>}
      </div>
    </div>}
  </>;
}
