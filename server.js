const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(), // ничего на диск
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (!/\.bsp$/i.test(file.originalname)) {
      return cb(new Error('Разрешены только .bsp'));
    }
    cb(null, true);
  }
});

app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.type('html').send(`
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>Quake 2 BSP Resource Inspector</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;margin:2rem;max-width:1000px}
  pre{background:#f6f8fa;padding:1rem;overflow:auto}
  .file{border:1px solid #ddd;padding:1rem;margin:1rem 0}
  .warn{color:#ad5c00}
  .err{color:#b00020}
  ul{margin:0.3rem 0 1rem 1.2rem}
  code{background:#f6f8fa;padding:0 .2rem}
</style>
</head>
<body>
  <h1>Quake 2 BSP Resource Inspector</h1>
  <form action="/analyze" method="post" enctype="multipart/form-data">
    <p>
      <input type="file" name="maps" multiple accept=".bsp" />
      <button type="submit">Анализировать</button>
    </p>
  </form>
  <p>Поддерживается Quake 2 BSP (IBSP v38). Текстуры берутся из TEXINFO, а sky/sound/model — из ENTITIES.</p>
  <p>Program support: ly (@QuakeJourney)<p>
</body>
</html>
  `);
});

app.post('/analyze', upload.array('maps'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).send('Файлы не загружены');
    }

    const results = [];
    for (const f of req.files) {
      const analysis = analyzeBspBuffer(f.buffer);
      // После анализа буфер больше не используем — ничего не сохраняли на диск.
      results.push({ file: f.originalname, ...analysis });
    }

    // Если просят JSON
    if ((req.headers.accept || '').includes('application/json') || req.query.json === '1') {
      return res.json({ results });
    }

    // HTML
    res.type('html').send(renderResultsHtml(results));
  } catch (e) {
    res.status(400).send(`Ошибка: ${e.message || e}`);
  }
});

function renderResultsHtml(results) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const block = r => `
  <div class="file">
    <h2>${esc(r.file)}</h2>
    ${r.warnings.length ? `<p class="warn">Предупреждения:<br>• ${r.warnings.map(esc).join('<br>• ')}</p>` : ''}
    ${r.errors.length ? `<p class="err">Ошибки:<br>• ${r.errors.map(esc).join('<br>• ')}</p>` : ''}

    <h3>Текстуры (из TEXINFO)</h3>
    ${r.textures.length ? `<ul>${r.textures.map(t => `<li><code>${esc(t)}</code></li>`).join('')}</ul>` : '<p>—</p>'}

    <h3>Небо (sky) из ENTITIES</h3>
    ${r.skies.length ? `<ul>${r.skies.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ul>` : '<p>—</p>'}

    <h3>Звуки из ENTITIES</h3>
    ${r.sounds.length ? `<ul>${r.sounds.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ul>` : '<p>—</p>'}

    <h3>Модели из ENTITIES</h3>
    ${r.models.length ? `<ul>${r.models.map(m => `<li><code>${esc(m)}</code></li>`).join('')}</ul>` : '<p>—</p>'}

    ${r.others.length ? `<h3>Другие ссылки</h3><ul>${r.others.map(o => `<li><code>${esc(o)}</code></li>`).join('')}</ul>` : ''}
  </div>`;
  return `
<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Результаты анализа</title>
<style>body{font-family:system-ui,Arial,sans-serif;margin:2rem;max-width:1000px} .file{border:1px solid #ddd;padding:1rem;margin:1rem 0} code{background:#f6f8fa;padding:0 .2rem}</style>
</head>
<body>
  <h1>Результаты анализа</h1>
  ${results.map(block).join('\n')}
  <p><a href="/">← Назад</a></p>
</body>
</html>`;
}

// ---- BSP parsing (Quake 2 IBSP v38) ----

const Q2_MAGIC = 'IBSP';
const Q2_VERSION = 38;
const LUMP = {
  ENTITIES: 0,
  TEXINFO: 5
};
// dtexinfo_t size in bytes for Quake 2: 32 (vecs) + 4 (flags) + 4 (value) + 32 (texture) + 4 (nexttexinfo) = 76
const DTEXINFO_SIZE = 76;

function analyzeBspBuffer(buf) {
  const errors = [];
  const warnings = [];

  if (buf.length < 8) {
    throw new Error('Файл слишком мал для BSP заголовка');
  }

  const magic = buf.toString('ascii', 0, 4);
  const version = buf.readInt32LE(4);
  if (magic !== Q2_MAGIC) {
    errors.push(`Неверная сигнатура: ожидается "${Q2_MAGIC}", получено "${magic}"`);
  }
  if (version !== Q2_VERSION) {
    warnings.push(`Версия BSP ${version}. Ожидалась ${Q2_VERSION} (Quake 2). Попытаюсь разобрать дальше.`);
  }

  // Лампы (offset/length) начинаются с 8 байта, каждая запись: int32 offset + int32 length
  const lumps = [];
  let off = 8;
  for (let i = 0; i < 19; i++) {
    if (off + 8 > buf.length) {
      errors.push('Неожиданный конец файла в таблице лумпов');
      break;
    }
    const lo = buf.readInt32LE(off);
    const ll = buf.readInt32LE(off + 4);
    lumps.push({ offset: lo, length: ll });
    off += 8;
  }

  const textures = new Set();
  const skies = new Set();
  const sounds = new Set();
  const models = new Set();
  const others = new Set();

  // ENTITIES
  const ent = lumps[LUMP.ENTITIES];
  if (ent && ent.length > 0 && ent.offset + ent.length <= buf.length) {
    const entsTxt = buf.toString('ascii', ent.offset, ent.offset + ent.length);
    extractFromEntities(entsTxt, { skies, sounds, models, others });
  } else {
    warnings.push('ENTITIES лумп отсутствует или поврежден');
  }

  // TEXINFO -> texture names (char[32]) => textures/<name>.wal
  const tix = lumps[LUMP.TEXINFO];
  if (tix && tix.length > 0 && tix.offset + tix.length <= buf.length) {
    const count = Math.floor(tix.length / DTEXINFO_SIZE);
    for (let i = 0; i < count; i++) {
      const base = tix.offset + i * DTEXINFO_SIZE;
      const name = readCString(buf, base + 32 + 4 + 4, 32); // vecs(32) + flags(4) + value(4) = 40 -> name at +40
      if (name) {
        // В Quake 2 движок ищет textures/<name>.wal
        const normalized = name.replace(/^textures[\\/]+/i, '').replace(/\\/g, '/');
        textures.add(`textures/${normalized}.wal`);
      }
    }
  } else {
    warnings.push('TEXINFO лумп отсутствует или поврежден — текстуры могут быть не найдены');
  }

  return {
    errors,
    warnings,
    textures: Array.from(textures).sort(),
    skies: Array.from(skies).sort(),
    sounds: Array.from(sounds).sort(),
    models: Array.from(models).sort(),
    others: Array.from(others).sort()
  };
}

function readCString(buf, start, maxLen) {
  const end = Math.min(start + maxLen, buf.length);
  let i = start;
  for (; i < end; i++) {
    if (buf[i] === 0) break;
  }
  return buf.toString('ascii', start, i).replace(/\0/g, '').trim();
}

// Очень упрощенный парсер key/value из ENTITIES
function extractFromEntities(txt, out) {
  // Пары вида "key" "value"
  const re = /"([^"]+)"\s*"([^"]*)"/g;
  const pairs = [];
  let m;
  while ((m = re.exec(txt)) !== null) {
    const k = m[1].toLowerCase();
    const v = m[2];
    pairs.push([k, v]);
  }

  for (const [k, v] of pairs) {
    if (!v) continue;
    const vv = v.replace(/\\/g, '/');

    if (k === 'sky') {
      // Q2: движок грузит env/<name>*.pcx (или .tga в портах)
      out.skies.add(`env/${vv}*`);
    } else if (k === 'sound' || k === 'noise' || k === 'snd' || /^sound/.test(k)) {
      if (/^sound\//i.test(vv) || /\.(wav|ogg|mp3)$/i.test(vv)) out.sounds.add(vv);
      else out.others.add(`${k}=${vv}`);
    } else if (k === 'model') {
      if (/^models\//i.test(vv) || /\.(md2|sp2|iqm|md3)$/i.test(vv)) out.models.add(vv);
      else out.others.add(`${k}=${vv}`);
    } else if (k === 'music' || k === 'cdtrack' || k === 'wav') {
      out.sounds.add(vv);
    } else if (k === 'wad') {
      // Обычно не для Q2, но вдруг: просто покажем
      out.others.add(`wad=${vv}`);
    } else if (/^path|file|script|shader$/i.test(k)) {
      out.others.add(`${k}=${vv}`);
    }
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Q2 BSP Resource Inspector: http://localhost:${PORT}`);
});
