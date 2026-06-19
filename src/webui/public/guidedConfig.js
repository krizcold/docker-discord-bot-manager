/*
 * Guided Config Builder (frontend).
 * Renders a manifest-driven form over a config body. The raw <textarea>.cf-body
 * stays the single source of truth (the install/save collectors read it as
 * before); the guided form is a second view kept in live two-way sync through the
 * server-side serializer (/api/config/serialize + /api/config/parse), so there is
 * no duplicate serialization logic in the browser.
 *
 * A config file with no manifest is untouched and uses the plain raw editor.
 * All engine pieces here are general; only the manifest data is bot-specific.
 */
(function () {
  const REG = {};            // blockId -> state
  let seq = 0;

  function st(id) { return REG[id]; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Path grammar mirrors the backend splitPath: [N] = array index, dotted = key.
  function splitPath(p) {
    const out = []; const re = /\[(\d+)\]|([^.[\]]+)/g; let m;
    while ((m = re.exec(p))) { if (m[1] !== undefined) out.push(Number(m[1])); else if (m[2]) out.push(m[2]); }
    return out;
  }
  function getAt(obj, p) { let c = obj; for (const s of splitPath(p)) { if (c == null) return undefined; c = c[s]; } return c; }
  function setAt(obj, p, val) {
    const segs = splitPath(p); let c = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (c[s] == null || typeof c[s] !== 'object') c[s] = typeof segs[i + 1] === 'number' ? [] : {};
      c = c[s];
    }
    c[segs[segs.length - 1]] = val;
  }

  function walkFields(sections, fn) {
    for (const sec of (sections || [])) {
      for (const f of (sec.fields || [])) fn(f, sec);
      if (sec.sections) walkFields(sec.sections, fn);
    }
  }
  function findField(manifest, path) {
    let found = null;
    walkFields(manifest.sections, f => { if (f.target && f.target.path === path) found = f; });
    return found;
  }
  function findSection(manifest, id) {
    let found = null;
    const rec = secs => { for (const s of (secs || [])) { if (s.id === id) found = s; if (s.sections) rec(s.sections); } };
    rec(manifest.sections);
    return found;
  }

  // ─── registration / lifecycle ───

  window.guidedNextId = function () { return 'cfb' + (++seq); };

  window.guidedRegister = function (blockId, manifest, format, parsed) {
    let tokenPath = null;
    walkFields(manifest.sections, f => { if (!tokenPath && f.type === 'password' && f.target) tokenPath = f.target.path; });
    REG[blockId] = { manifest, format: format || 'json', parsed: parsed || {}, tokenPath, pendingOps: [], serializeTimer: null, parseTimer: null, serializing: false, dirty: false, inflight: null, listSpecs: {}, expanded: {} };
  };

  function textareaOf(id) { const b = document.getElementById(id); return b ? b.querySelector('.cf-body') : null; }

  // ─── serialize (guided -> raw body) ───

  function pushOp(s, op) { s.pendingOps.push(op); }
  function scheduleSerialize(id) {
    const s = st(id); if (!s) return;
    clearTimeout(s.serializeTimer);
    s.serializeTimer = setTimeout(() => flushSerialize(id), 250);
  }
  // Serialize pending ops into the raw .cf-body. One request in flight per block;
  // edits that arrive mid-flight are coalesced and re-run, and s.inflight resolves
  // only when the whole chain settles (so guidedFlushAll can await it).
  function flushSerialize(id) {
    const s = st(id); if (!s) return Promise.resolve();
    clearTimeout(s.serializeTimer);
    if (s.serializing) { s.dirty = true; return s.inflight || Promise.resolve(); }
    if (!s.pendingOps.length) return s.inflight || Promise.resolve();
    const ta = textareaOf(id); if (!ta) { s.pendingOps = []; return Promise.resolve(); }
    const ops = s.pendingOps; s.pendingOps = [];
    s.serializing = true;
    s.inflight = api('POST', '/config/serialize', { format: s.format, body: ta.value, ops })
      .then(r => {
        // Never overwrite a textarea the user is actively editing (raw tab).
        const t = textareaOf(id);
        if (r && r.success && typeof r.body === 'string' && t && document.activeElement !== t) t.value = r.body;
      })
      .catch(() => { })
      .then(() => { s.serializing = false; if (s.dirty || s.pendingOps.length) { s.dirty = false; return flushSerialize(id); } });
    return s.inflight;
  }
  // Await every block's pending/in-flight serialize so collectors read a current
  // raw body (the install/save buttons call this before reading .cf-body).
  window.guidedFlushAll = async function () {
    // Drop entries whose block left the DOM (bounds REG growth across a session).
    for (const id in REG) {
      if (!document.getElementById(id)) { clearTimeout(REG[id].serializeTimer); clearTimeout(REG[id].parseTimer); delete REG[id]; }
    }
    for (const id in REG) flushSerialize(id);
    // Await each block's serialize chain, but never block the button forever.
    for (const id in REG) {
      const s = REG[id]; let guard = 0;
      while ((s.serializing || s.pendingOps.length) && guard++ < 50) {
        await Promise.race([s.inflight || Promise.resolve(), new Promise(r => setTimeout(r, 200))]);
      }
    }
  };

  // ─── parse (raw body -> guided form) ───

  window.guidedRawEdit = function (id, immediate) {
    const s = st(id); const ta = textareaOf(id); if (!s || !ta) return;
    clearTimeout(s.parseTimer);
    const run = () => {
      api('POST', '/config/parse', { format: s.format, body: ta.value }).then(r => {
        const badge = document.getElementById(id + '-badge');
        if (r && r.success && r.ok) {
          s.parsed = r.data || {};
          if (badge) { badge.textContent = ''; badge.className = 'gc-badge'; }
          const form = document.getElementById(id + '-form');
          if (form && !form.classList.contains('hidden')) { form.innerHTML = buildGuidedFormHtml(id); guidedValidateAll(id); }
        } else if (badge) { badge.textContent = 'Raw has errors - form paused'; badge.className = 'gc-badge gc-badge-warn'; }
      }).catch(() => { });
    };
    if (immediate) run(); else s.parseTimer = setTimeout(run, 400);
  };

  window.guidedTab = function (id, which) {
    const block = document.getElementById(id); if (!block) return;
    const form = document.getElementById(id + '-form');
    const ta = block.querySelector('.cf-body');
    const tabs = block.querySelectorAll('.gc-tab');
    tabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-tab') === which));
    if (which === 'raw') { flushSerialize(id); form.classList.add('hidden'); ta.classList.remove('hidden'); }
    else { ta.classList.add('hidden'); form.classList.remove('hidden'); guidedRawEdit(id, true); }
  };

  function guidedRefresh(id) {
    const form = document.getElementById(id + '-form');
    if (form) { form.innerHTML = buildGuidedFormHtml(id); guidedValidateAll(id); }
  }

  // ─── value editing ───

  function coerce(type, el) {
    if (type === 'boolean') return el.checked;
    if (type === 'number') { const v = el.value.trim(); if (v === '') return null; const n = Number(v); return isNaN(n) ? null : n; }
    return el.value;
  }

  window.guidedEdit = function (id, path, type, el) {
    const s = st(id); if (!s) return;
    const val = coerce(type, el);
    if (val === null) return;   // empty/invalid number: leave body unchanged
    setAt(s.parsed, path, val);
    pushOp(s, { path, value: val });
    if (type === 'text') scheduleSerialize(id); else flushSerialize(id);
  };

  window.guidedToggle = function (id, sectionId, el) {
    const s = st(id); if (!s) return;
    const sec = findSection(s.manifest, sectionId); if (!sec || !sec.toggle) return;
    const on = el.checked;
    if (sec.toggle.target && sec.toggle.target.path) {
      setAt(s.parsed, sec.toggle.target.path, on);
      pushOp(s, { path: sec.toggle.target.path, value: on });
    }
    if (!on && sec.toggle.disabledBehavior === 'omit' && sec.toggle.omitPath) {
      pushOp(s, { path: sec.toggle.omitPath.path, remove: true });
    }
    flushSerialize(id);
    guidedRefresh(id);
  };

  // Switch an envAlt field between In file and From env. Writes the body flag
  // (so it round-trips) and, when moving to env, clears the in-file value with
  // value:'' (not remove) to keep the key + comments intact. The env VALUE is
  // entered separately in the env-vars section.
  window.guidedEnvAltMode = function (id, path, mode) {
    const s = st(id); if (!s) return;
    const f = findField(s.manifest, path); if (!f || !f.envAlt) return;
    const toEnv = mode === 'env';
    if (f.envAlt.flagPath) { setAt(s.parsed, f.envAlt.flagPath, toEnv); pushOp(s, { path: f.envAlt.flagPath, value: toEnv }); }
    if (toEnv) { setAt(s.parsed, path, ''); pushOp(s, { path, value: '' }); }
    flushSerialize(id);
    guidedRefresh(id);
  };

  // ─── lists ───

  // listPath '' means the config root itself is the array. elemPath builds the
  // targeted path of an element (or one of its keys, dotted ok), so edits/adds/
  // removes touch only that node and preserve the rest of the file's comments.
  function elemPath(listPath, index, key) {
    const base = listPath ? `${listPath}[${index}]` : `[${index}]`;
    return key ? `${base}.${key}` : base;
  }
  function listArray(s, listPath) { return listPath ? getAt(s.parsed, listPath) : s.parsed; }

  // Seed a new list element. Object elements seed only their non-conditional
  // (no showWhen) fields, so a type-discriminated element starts minimal and the
  // type-specific fields appear (and are written) once the user picks a type.
  function newListItem(f) {
    const el = (f && f.element) || {};
    if (el.objectFields) {
      const o = {};
      for (const of of el.objectFields) {
        if (of.showWhen) continue;
        let dv = of.default;
        if (dv === undefined) dv = of.type === 'list' ? [] : (of.type === 'boolean' ? false : (of.type === 'number' ? 0 : ''));
        setAt(o, of.key, dv);
      }
      return o;
    }
    if (el.field) return el.field.default !== undefined ? el.field.default : '';
    return '';
  }

  window.guidedListEdit = function (id, listPath, index, key, type, el) {
    const s = st(id); if (!s) return;
    const val = coerce(type, el); if (val === null) return;
    const fullPath = elemPath(listPath, index, key);
    setAt(s.parsed, fullPath, val);
    pushOp(s, { path: fullPath, value: val });
    if (type === 'text') scheduleSerialize(id);        // keep focus while typing
    else { flushSerialize(id); guidedRefresh(id); }    // selects/bools may gate showWhen
  };

  window.guidedListAdd = function (id, listPath) {
    const s = st(id); if (!s) return;
    let arr = listArray(s, listPath);
    if (!Array.isArray(arr)) { arr = []; if (listPath) setAt(s.parsed, listPath, arr); else s.parsed = arr; }
    const idx = arr.length;
    arr.push(newListItem(s.listSpecs[listPath]));
    s.expanded[elemPath(listPath, idx)] = true;   // open the new item for editing
    pushOp(s, { path: elemPath(listPath, idx), value: arr[idx], insert: true });
    flushSerialize(id);
    guidedRefresh(id);
  };

  window.guidedListRemove = function (id, listPath, index) {
    const s = st(id); if (!s) return;
    const arr = listArray(s, listPath); if (!Array.isArray(arr)) return;
    arr.splice(index, 1);
    pushOp(s, { path: elemPath(listPath, index), remove: true });
    flushSerialize(id);
    guidedRefresh(id);
  };

  // ─── Discord validation ───

  const KIND = { 'user-id': 'user', 'role-id': 'role', 'channel-id': 'channel', 'guild-id': 'guild', 'role-or-user-id': 'member' };
  const reqStar = '<span class="gc-req" title="Required">*</span>';

  function setChip(chip, cls, text, html) { chip.className = 'gc-chip' + (cls ? ' gc-chip-' + cls : ''); chip.innerHTML = html || (text ? esc(text) : ''); }

  function renderChip(chip, kind, r) {
    if (!r || !r.success) { setChip(chip, 'warn', 'Can\'t validate'); return; }
    const k = r.resolvedKind || kind;   // 'member' resolves to user or role
    if (r.status === 'ok') {
      if (k === 'user' || k === 'guild') {
        const img = r.avatarUrl ? '<img class="gc-av" src="' + esc(r.avatarUrl) + '">' : '';
        setChip(chip, 'ok', null, img + '<span>' + esc(r.name || '') + '</span>');
      } else if (k === 'role') {
        const dot = r.extra && r.extra.color ? '<span class="gc-dot" style="background:' + esc(r.extra.color) + '"></span>' : '<span class="gc-dot"></span>';
        setChip(chip, 'ok', null, dot + '<span>' + esc(r.name || '') + '</span>');
      } else { setChip(chip, 'ok', null, '<span># ' + esc(r.name || '') + '</span>'); }
      return;
    }
    if (r.status === 'invalid') { setChip(chip, 'bad', 'Invalid ' + (kind === 'member' ? 'ID' : kind)); return; }
    if (r.status === 'bot_not_in_guild') { setChip(chip, 'warn', 'Bot not in server yet'); return; }
    if (r.status === 'cannot_access') { setChip(chip, 'warn', 'Can\'t access (check perms)'); return; }
    setChip(chip, 'warn', r.reason === 'token' ? 'Set token to validate' : (r.reason === 'missing_guild' ? 'Set Server ID first' : 'Can\'t validate'));
  }

  window.guidedValidateField = function (id, el) {
    const s = st(id); if (!s) return;
    if (el.offsetParent === null) return;   // collapsed/hidden field: don't spend a lookup
    const kind = el.getAttribute('data-gc-kind');
    const chip = document.getElementById(el.getAttribute('data-gc-chip')); if (!chip) return;
    const serverPath = el.getAttribute('data-gc-server') || '';
    const literals = (el.getAttribute('data-gc-literals') || '').split('|').filter(Boolean);
    const phs = (el.getAttribute('data-gc-ph') || '').split('|').filter(Boolean);
    const val = (el.value || '').trim();
    clearTimeout(el._gcTimer);
    if (!val || phs.indexOf(val) >= 0) { setChip(chip, '', ''); return; }
    if (literals.indexOf(val) >= 0) { setChip(chip, 'lit', val); return; }
    if (!/^\d{5,25}$/.test(val)) { setChip(chip, 'bad', 'Invalid ' + kind); return; }
    setChip(chip, 'load', '...');
    el._gcTimer = setTimeout(() => {
      const token = s.tokenPath ? (getAt(s.parsed, s.tokenPath) || '') : '';
      const guildId = serverPath ? getAt(s.parsed, serverPath) : undefined;
      api('POST', '/discord/validate', { token, kind, id: val, guildId })
        .then(r => renderChip(chip, kind, r)).catch(() => setChip(chip, 'warn', 'Can\'t validate'));
    }, 450);
  };

  window.guidedValidateAll = function (id) {
    const form = document.getElementById(id + '-form'); if (!form) return;
    form.querySelectorAll('[data-gc-kind]').forEach(el => guidedValidateField(id, el));
  };

  window.guidedInitAll = function () {
    document.querySelectorAll('[data-guided="1"]').forEach(b => guidedValidateAll(b.id));
  };

  // ─── rendering ───

  function curVal(s, path, def) { const v = getAt(s.parsed, path); return v !== undefined ? v : (def !== undefined ? def : ''); }

  function idAttrs(f, chipId) {
    const kind = KIND[f.type];
    const server = (f.serverIdRef && f.serverIdRef.path) ? f.serverIdRef.path : '';
    const literals = (f.literals || []).join('|');
    const phs = (f.placeholders || []).join('|');
    return `data-gc-kind="${kind}" data-gc-chip="${chipId}" data-gc-server="${esc(server)}" data-gc-literals="${esc(literals)}" data-gc-ph="${esc(phs)}"`;
  }

  // Build the input control for a scalar field (everything except list/grid/
  // boolean). Shared by renderField and the in-file mode of an envAlt field.
  function renderScalarControl(id, f, path, val, dis) {
    if (f.type === 'select') {
      const o = (f.options || []).map(op => `<option value="${esc(op.value)}" ${String(op.value) === String(val) ? 'selected' : ''}>${esc(op.label || op.value)}</option>`).join('');
      return `<select ${dis} onchange="guidedEdit('${id}','${esc(path)}','select',this)">${o}</select>`;
    }
    if (f.type === 'number') {
      return `<input type="number" value="${esc(val)}" ${dis} oninput="guidedEdit('${id}','${esc(path)}','number',this)">`;
    }
    if (f.type === 'color') {
      const sv = String(val || '');
      const safe = (/^#[0-9a-fA-F]{3,8}$/.test(sv) || /^[a-zA-Z]{1,24}$/.test(sv)) ? sv : '#000';
      return `<div class="gc-color"><span class="gc-swatch" style="background:${safe}"></span><input type="text" value="${esc(val)}" ${dis} oninput="this.previousElementSibling.style.background=this.value; guidedEdit('${id}','${esc(path)}','text',this)"></div>`;
    }
    if (KIND[f.type]) {
      const chipId = id + '-chip-' + esc(path).replace(/[^a-z0-9]/gi, '_');
      const type = f.type === 'password' ? 'password' : 'text';
      return `<div class="gc-idrow"><span class="gc-chip" id="${chipId}"></span>
        <input type="${type}" value="${esc(val)}" ${dis} ${idAttrs(f, chipId)}
          oninput="guidedEdit('${id}','${esc(path)}','text',this); guidedValidateField('${id}',this)"></div>`;
    }
    const type = f.type === 'password' ? 'password' : 'text';
    return `<input type="${type}" value="${esc(val)}" ${dis} oninput="guidedEdit('${id}','${esc(path)}','text',this)">`;
  }

  // A field that can be sourced In file or From env (manifest envAlt). The mode
  // lives in the body flag (flagPath) so it round-trips through serialize/parse;
  // the env VALUE is entered in the Environment Variables section, so env mode
  // shows a hint rather than an input.
  function envAltMode(s, f) {
    if (f.envAlt && f.envAlt.flagPath) return getAt(s.parsed, f.envAlt.flagPath) ? 'env' : 'file';
    return 'file';
  }

  function renderEnvAltField(id, s, f, path, dis) {
    const mode = envAltMode(s, f);
    const label = `<div class="gc-label">${esc(f.label)}${(f.required && mode === 'file') ? reqStar : ''}</div>`;
    const help = f.help ? `<div class="gc-help">${esc(f.help)}</div>` : '';
    const sw = `<div class="gc-srcswitch">`
      + `<button type="button" class="${mode === 'file' ? 'active' : ''}" onclick="guidedEnvAltMode('${id}','${esc(path)}','file')">In file</button>`
      + `<button type="button" class="${mode === 'env' ? 'active' : ''}" onclick="guidedEnvAltMode('${id}','${esc(path)}','env')">From env</button>`
      + `</div>`;
    const body = (mode === 'file')
      ? renderScalarControl(id, f, path, curVal(s, path, f.default), dis)
      : `<div class="gc-help gc-envalt-hint">Set <code>${esc(f.envAlt.var)}</code> as an environment variable for this bot.</div>`;
    return `<div class="gc-field gc-envalt">${label}${sw}${body}${help}</div>`;
  }

  // Render one field bound to an absolute path (top-level fields).
  function renderField(id, f, disabled) {
    const path = f.target.path;
    if (f.type === 'list') return renderList(id, f.target.path, f);
    if (f.type === 'grid') return renderGrid(id, f);
    const s = st(id);
    const dis = disabled ? 'disabled' : '';
    if (f.type === 'boolean') {
      const val = curVal(s, path, f.default);
      const control = `<label class="gc-bool"><span class="toggle-switch"><input type="checkbox" ${val ? 'checked' : ''} ${dis} onchange="guidedEdit('${id}','${esc(path)}','boolean',this)"><span class="toggle-slider"></span></span></label>`;
      const label = `<div class="gc-label">${esc(f.label)}${f.required ? reqStar : ''}</div>`;
      return `<div class="gc-field gc-field-inline">${control}${label}</div>`;
    }
    if (f.envAlt) return renderEnvAltField(id, s, f, path, dis);
    const label = `<div class="gc-label">${esc(f.label)}${f.required ? reqStar : ''}</div>`;
    const help = f.help ? `<div class="gc-help">${esc(f.help)}</div>` : '';
    const control = renderScalarControl(id, f, path, curVal(s, path, f.default), dis);
    return `<div class="gc-field">${label}${control}${help}</div>`;
  }

  // Render one element field: a scalar list element, or one object property
  // (key may be dotted for nesting), or a nested list. Honors showWhen (the field
  // shows only when a sibling property of the same element equals a value).
  function renderElementField(id, listPath, index, ef) {
    const s = st(id);
    const elemBase = listPath ? `${listPath}[${index}]` : `[${index}]`;
    if (ef.showWhen) {
      const cur = getAt(s.parsed, `${elemBase}.${ef.showWhen.path}`);
      if (ef.showWhen.equals !== undefined && cur !== ef.showWhen.equals) return '';
      if (ef.showWhen.notEquals !== undefined && cur === ef.showWhen.notEquals) return '';
      if (ef.showWhen.in !== undefined && ef.showWhen.in.indexOf(cur) < 0) return '';
    }
    const key = ef.key || '';
    const itemPath = key ? `${elemBase}.${key}` : elemBase;
    if (ef.type === 'list') return renderList(id, itemPath, ef);
    const v = getAt(s.parsed, itemPath);
    const val = v !== undefined ? v : (ef.default !== undefined ? ef.default : '');
    const label = ef.label ? `<div class="gc-label gc-label-sm">${esc(ef.label)}${ef.required ? reqStar : ''}</div>` : '';
    const ed = `guidedListEdit('${id}','${esc(listPath)}',${index},'${esc(key)}'`;
    let control = '';
    if (ef.type === 'boolean') {
      control = `<label class="gc-bool"><span class="toggle-switch"><input type="checkbox" ${val ? 'checked' : ''} onchange="${ed},'boolean',this)"><span class="toggle-slider"></span></span></label>`;
      return `<div class="gc-elfield gc-field-inline">${control}${label}</div>`;
    }
    if (ef.type === 'select') {
      const o = (ef.options || []).map(op => `<option value="${esc(op.value)}" ${String(op.value) === String(val) ? 'selected' : ''}>${esc(op.label || op.value)}</option>`).join('');
      control = `<select onchange="${ed},'select',this)">${o}</select>`;
    } else if (ef.type === 'number') {
      control = `<input type="number" value="${esc(val)}" oninput="${ed},'number',this)">`;
    } else if (ef.type === 'color') {
      const sv = String(val || '');
      const safe = (/^#[0-9a-fA-F]{3,8}$/.test(sv) || /^[a-zA-Z]{1,24}$/.test(sv)) ? sv : '#000';
      control = `<div class="gc-color"><span class="gc-swatch" style="background:${safe}"></span><input type="text" value="${esc(val)}" oninput="this.previousElementSibling.style.background=this.value; ${ed},'text',this)"></div>`;
    } else if (KIND[ef.type]) {
      const chipId = id + '-chip-' + esc(itemPath).replace(/[^a-z0-9]/gi, '_');
      control = `<div class="gc-idrow"><span class="gc-chip" id="${chipId}"></span><input type="text" value="${esc(val)}" ${idAttrs(ef, chipId)} oninput="${ed},'text',this); guidedValidateField('${id}',this)"></div>`;
    } else {
      control = `<input type="text" value="${esc(val)}" oninput="${ed},'text',this)">`;
    }
    return `<div class="gc-elfield">${label}${control}</div>`;
  }

  // Substitute {key} (dotted ok) in an item-label template with the element's values.
  function elItemLabel(s, listPath, index, tpl) {
    const base = listPath ? `${listPath}[${index}]` : `[${index}]`;
    return tpl.replace(/\{([\w.@]+)\}/g, (_, k) => { const v = getAt(s.parsed, `${base}.${k}`); return v == null ? '' : String(v); });
  }

  function renderListItem(id, listPath, f, index) {
    const s = st(id);
    const el = f.element || {};
    const remove = `<button class="btn-remove" onclick="guidedListRemove('${id}','${esc(listPath)}',${index})" title="Remove">&times;</button>`;
    if (el.objectFields) {
      // Object items collapse to just their header (big multi-field items would
      // otherwise sprawl). Small items default open; expand state survives rebuilds.
      const elemBase = listPath ? `${listPath}[${index}]` : `[${index}]`;
      const defExp = el.objectFields.length <= 4;
      const expanded = s.expanded[elemBase] !== undefined ? s.expanded[elemBase] : defExp;
      const fields = el.objectFields.map(of => renderElementField(id, listPath, index, of)).join('');
      const label = el.itemLabel ? elItemLabel(s, listPath, index, el.itemLabel) : `Item ${index + 1}`;
      return `<div class="gc-item gc-item-obj">
        <div class="gc-item-hdr">
          <span class="gc-item-toggle" onclick="toggleItemCollapse('${id}','${esc(elemBase)}',this)"><span class="gc-item-caret">${expanded ? '&#9660;' : '&#9654;'}</span><span class="gc-item-name">${esc(label)}</span></span>
          ${remove}
        </div>
        <div class="gc-item-body${expanded ? '' : ' hidden'}">${fields}</div>
      </div>`;
    }
    const single = renderElementField(id, listPath, index, el.field || { type: 'text' });
    return `<div class="gc-item">${single}${remove}</div>`;
  }

  window.toggleItemCollapse = function (id, key, el) {
    const s = st(id); if (!s) return;
    const item = el.closest('.gc-item-obj'); if (!item) return;
    const body = item.querySelector('.gc-item-body');
    const caret = el.querySelector('.gc-item-caret');
    const willExpand = body.classList.contains('hidden');
    body.classList.toggle('hidden');
    if (caret) caret.innerHTML = willExpand ? '&#9660;' : '&#9654;';
    s.expanded[key] = willExpand;
    if (willExpand) guidedValidateAll(id);   // validate the now-visible id fields
  };

  // listPath is the explicit path to the array (''=config root) so lists nest.
  function renderList(id, listPath, f) {
    const s = st(id);
    s.listSpecs[listPath] = f;
    const arr = getAt(s.parsed, listPath);
    const items = Array.isArray(arr) ? arr : [];
    const rows = items.map((_, i) => renderListItem(id, listPath, f, i)).join('') || '<div class="gc-empty">None yet</div>';
    const help = f.help ? `<div class="gc-help">${esc(f.help)}</div>` : '';
    return `<div class="gc-field gc-listfield">
      <div class="gc-label">${esc(f.label || '')}${f.required ? reqStar : ''}</div>${help}
      <div class="gc-list">${rows}</div>
      <button class="btn btn-secondary btn-small" onclick="guidedListAdd('${id}','${esc(listPath)}')">+ Add</button>
    </div>`;
  }

  // Boolean matrix: rows x columns of checkboxes, each cell at
  // `${base}.${row.key}.${col.key}`, with a per-column toggle-all button.
  function renderGrid(id, f) {
    const s = st(id);
    const base = f.target.path;
    const rows = f.rows || [];
    const cols = f.columns || [];
    const help = f.help ? `<div class="gc-help">${esc(f.help)}</div>` : '';
    let head = '<div class="gc-grid-row gc-grid-head"><div class="gc-grid-rowlabel"></div>';
    for (const c of cols) {
      head += `<div class="gc-grid-col"><span>${esc(c.label)}</span>`
        + `<button type="button" class="gc-grid-all" title="Toggle whole column" onclick="guidedGridToggleCol('${id}','${esc(base)}','${esc(c.key)}')">all</button></div>`;
    }
    head += '</div>';
    let bodyRows = '';
    for (const r of rows) {
      bodyRows += `<div class="gc-grid-row"><div class="gc-grid-rowlabel">${esc(r.label)}</div>`;
      for (const c of cols) {
        const cellPath = `${base}.${r.key}.${c.key}`;
        const v = getAt(s.parsed, cellPath);
        bodyRows += `<div class="gc-grid-cell"><span class="toggle-switch"><input type="checkbox" ${v ? 'checked' : ''} onchange="guidedEdit('${id}','${esc(cellPath)}','boolean',this)"><span class="toggle-slider"></span></span></div>`;
      }
      bodyRows += '</div>';
    }
    return `<div class="gc-field gc-gridfield"><div class="gc-label">${esc(f.label)}</div>${help}<div class="gc-grid">${head}${bodyRows}</div></div>`;
  }

  window.guidedGridToggleCol = function (id, base, colKey) {
    const s = st(id); if (!s) return;
    const f = findField(s.manifest, base); if (!f || !f.rows) return;
    const allTrue = f.rows.every(r => !!getAt(s.parsed, `${base}.${r.key}.${colKey}`));
    const nv = !allTrue;
    for (const r of f.rows) { const p = `${base}.${r.key}.${colKey}`; setAt(s.parsed, p, nv); pushOp(s, { path: p, value: nv }); }
    flushSerialize(id);
    guidedRefresh(id);
  };

  function renderSection(id, sec) {
    const s = st(id);
    let on = true, toggleHtml = '';
    if (sec.toggle) {
      const cur = sec.toggle.target ? getAt(s.parsed, sec.toggle.target.path) : undefined;
      on = cur === undefined ? !!sec.toggle.default : !!cur;
      toggleHtml = `<span class="toggle-switch gc-sectoggle"><input type="checkbox" ${on ? 'checked' : ''} onchange="guidedToggle('${id}','${esc(sec.id)}',this)"><span class="toggle-slider"></span></span>`;
    }
    const help = sec.help ? `<div class="gc-help">${esc(sec.help)}</div>` : '';
    let bodyHtml = '';
    if (on) {   // a disabled section collapses its body; only the toggle stays
      const fields = (sec.fields || []).map(f => renderField(id, f)).join('');
      const wrapped = sec.columns ? `<div class="gc-cols gc-cols-${sec.columns}">${fields}</div>` : fields;
      const subs = (sec.sections || []).map(sub => renderSection(id, sub)).join('');
      bodyHtml = `<div class="gc-secbody">${wrapped}${subs}</div>`;
    }
    return `<fieldset class="gc-section${on ? '' : ' gc-off'}">
      <legend class="gc-legend">${esc(sec.title)}${toggleHtml}</legend>
      ${help}${bodyHtml}
    </fieldset>`;
  }

  function buildGuidedFormHtml(id) {
    const s = st(id); if (!s) return '';
    s.listSpecs = {};
    if (s.manifest.root) return renderField(id, s.manifest.root);   // array-root config
    return (s.manifest.sections || []).map(sec => renderSection(id, sec)).join('');
  }
  window.buildGuidedFormHtml = buildGuidedFormHtml;

  // ─── one-time styles ───
  (function injectStyles() {
    if (document.getElementById('gc-styles')) return;
    const css = `
    .gc-tabs{display:flex;gap:6px;align-items:center;margin-bottom:6px}
    .gc-tab{background:var(--bg-alt,#222);border:1px solid var(--border,#444);color:var(--text,#ddd);border-radius:5px;padding:3px 10px;font-size:.72rem;cursor:pointer}
    .gc-tab.active{background:var(--accent,#5865f2);color:#fff;border-color:var(--accent,#5865f2)}
    .gc-badge{font-size:.68rem;color:var(--text-muted,#999)}
    .gc-badge-warn{color:#e0a106}
    .gc-srcswitch{display:inline-flex;gap:4px;margin-bottom:4px}
    .gc-srcswitch button{background:var(--bg-alt,#222);border:1px solid var(--border,#444);color:var(--text-muted,#aaa);border-radius:5px;padding:2px 9px;font-size:.68rem;cursor:pointer}
    .gc-srcswitch button.active{background:var(--accent,#5865f2);color:#fff;border-color:var(--accent,#5865f2)}
    .gc-envalt-hint code{background:var(--bg,#1a1a1a);border:1px solid var(--border,#444);border-radius:4px;padding:1px 5px}
    /* the shared .toggle-switch only gets its box as a flex item; it is also used
       in non-flex wrappers (guided form, Enabled/Writable row), so give it an
       explicit inline-block box. Harmless for flex-item toggles. */
    .toggle-switch{display:inline-block;flex:0 0 auto;vertical-align:middle}
    .gc-bool{display:inline-flex;align-items:center}
    .gc-cols-2{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
    .gc-cols-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px 16px}
    .gc-grid{display:flex;flex-direction:column;gap:4px;margin-top:4px}
    .gc-grid-row{display:flex;align-items:center;gap:8px}
    .gc-grid-rowlabel{flex:1;font-size:.7rem;color:var(--text,#ddd)}
    .gc-grid-col,.gc-grid-cell{width:88px;display:flex;align-items:center;justify-content:center;gap:5px}
    .gc-grid-head{border-bottom:1px solid var(--border,#444);padding-bottom:4px;margin-bottom:2px;font-size:.7rem;font-weight:600}
    .gc-grid-all{font-size:.56rem;text-transform:uppercase;letter-spacing:.03em;background:var(--bg-alt,#222);border:1px solid var(--border,#444);color:var(--text-muted,#aaa);border-radius:4px;padding:1px 5px;cursor:pointer}
    .gc-grid-all:hover{color:var(--text,#ddd)}
    .gc-section{border:1px solid var(--border,#444);border-radius:6px;padding:8px 10px;margin:0 0 8px}
    .gc-legend{font-size:.8rem;font-weight:600;display:flex;align-items:center;gap:8px;padding:0 4px}
    .gc-secbody{display:flex;flex-direction:column;gap:8px;margin-top:4px}
    .gc-section.gc-off>.gc-secbody{opacity:.45}
    .gc-field{display:flex;flex-direction:column;gap:3px}
    .gc-field-inline{flex-direction:row;align-items:center;gap:8px}
    .gc-label{font-size:.72rem;color:var(--text,#ddd);font-weight:500}
    .gc-label-sm{font-size:.66rem;color:var(--text-muted,#aaa)}
    .gc-req{color:#ed4245;font-weight:700;margin-left:3px}
    .gc-help{font-size:.66rem;color:var(--text-muted,#999)}
    .gc-field input[type=text],.gc-field input[type=password],.gc-field input[type=number],.gc-field select,.gc-elfield input,.gc-elfield select{width:100%;background:var(--bg,#1a1a1a);border:1px solid var(--border,#444);color:var(--text,#ddd);border-radius:5px;padding:5px 7px;font-size:.74rem;box-sizing:border-box}
    .gc-color{display:flex;align-items:center;gap:6px}
    .gc-swatch{width:18px;height:18px;border-radius:4px;border:1px solid var(--border,#444);flex:0 0 auto}
    .gc-idrow{display:flex;align-items:center;gap:6px}
    .gc-idrow input{flex:1}
    .gc-chip{font-size:.66rem;display:inline-flex;align-items:center;gap:4px;min-width:0;white-space:nowrap;color:var(--text-muted,#999)}
    .gc-chip-ok{color:#3ba55d}.gc-chip-bad{color:#ed4245}.gc-chip-warn{color:#e0a106}.gc-chip-lit{color:#8a8fff}.gc-chip-load{color:var(--text-muted,#999)}
    .gc-av{width:18px;height:18px;border-radius:50%;vertical-align:middle}
    .gc-dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:#99aab5}
    .gc-list{display:flex;flex-direction:column;gap:6px;margin:4px 0}
    .gc-item{display:flex;align-items:flex-start;gap:6px}
    .gc-item .gc-elfield{flex:1}
    .gc-item-obj{display:block;border:1px solid var(--border,#444);border-radius:5px;padding:6px;position:relative}
    .gc-item-hdr{display:flex;align-items:flex-start;gap:6px;justify-content:space-between}
    .gc-item-toggle{flex:1;cursor:pointer;display:flex;gap:5px;align-items:flex-start;min-width:0}
    .gc-item-caret{font-size:.66rem;color:var(--text-muted,#999);flex:0 0 auto;line-height:1.35}
    .gc-item-name{white-space:pre-line;line-height:1.3;font-weight:600;font-size:.72rem;color:var(--text,#ddd)}
    .gc-item-body{display:flex;flex-direction:column;gap:6px;margin-top:6px}
    .gc-empty{font-size:.68rem;color:var(--text-muted,#999);font-style:italic}
    `;
    const style = document.createElement('style'); style.id = 'gc-styles'; style.textContent = css;
    document.head.appendChild(style);
  })();
})();
