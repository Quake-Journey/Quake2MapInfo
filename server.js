require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(), // ничего на диск
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 5000          // можно до 5000 файлов за один раз
  },
  fileFilter: (req, file, cb) => {
    if (!/\.bsp$/i.test(file.originalname)) {
      return cb(new Error('Разрешены только .bsp'));
    }
    cb(null, true);
  }
});

app.use(express.urlencoded({ extended: true }));

// ----- MongoDB -----

const MONGODB_URI = process.env.MONGODB_URI;
let dbPromise = null;

function getDb() {
  if (!MONGODB_URI) {
    throw new Error('Переменная окружения MONGODB_URI не задана');
  }
  if (!dbPromise) {
    const client = new MongoClient(MONGODB_URI);
    dbPromise = client.connect().then(c => c.db());
  }
  return dbPromise;
}

function getBaseMapName(fileName) {
  return fileName ? fileName.replace(/\.bsp$/i, '') : '';
}

async function getSavedMapsList() {
  const db = await getDb();
  const docs = await db.collection('maps')
    .find({}, { projection: { mapName: 1, mapVersion: 1, fileName: 1 } })
    .sort({ mapName: 1, mapVersion: 1, fileName: 1 })
    .toArray();
  return docs;
}

// --- поиск карты по подстроке имени файла ---

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchMapsByFileSubstring(fileQuery) {
  if (!fileQuery) return [];
  const term = fileQuery.trim();
  if (!term) return [];

  const pattern = escapeRegExp(term); // подстрока
  const db = await getDb();
  const docs = await db.collection('maps')
    .find(
      { fileName: { $regex: pattern, $options: 'i' } },
      { sort: { updatedAt: -1, createdAt: -1 } }
    )
    .toArray();
  return docs;
}

// поиск по точному имени файла (для /view?map=...)
async function findMapByExactFileName(fileName) {
  if (!fileName) return null;
  const term = fileName.trim();
  if (!term) return null;

  const pattern = '^' + escapeRegExp(term) + '$';

  const db = await getDb();
  const doc = await db.collection('maps').findOne(
    { fileName: { $regex: pattern, $options: 'i' } },
    { sort: { updatedAt: -1, createdAt: -1 } }
  );
  return doc;
}

async function saveAnalysisToDb(analysis, fileName) {
  const db = await getDb();

  const baseName = getBaseMapName(fileName);
  const mapName = analysis.mapName || baseName || null;
  const mapVersion = analysis.mapVersion || null;

  const now = new Date();

  const doc = {
    fileName: fileName || null,
    mapName,
    mapVersion,
    textures: analysis.textures,
    skies: analysis.skies,
    sounds: analysis.sounds,
    models: analysis.models,
    others: analysis.others,
    entityStats: analysis.entityStats,
    errors: analysis.errors,
    warnings: analysis.warnings,
    updatedAt: now
  };

  await db.collection('maps').updateOne(
    { mapName, mapVersion },
    {
      $set: doc,
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );

  return { mapName, mapVersion };
}

// ----- HTTP маршруты -----

// Главная: форма загрузки + список сохранённых карт + поиск по подстроке имени файла (?map=)
app.get('/', async (req, res) => {
  try {
    const mapQuery = req.query.map;
    let searchResults = [];
    let notFoundMessage = null;

    if (mapQuery) {
      try {
        const docs = await searchMapsByFileSubstring(mapQuery);
        if (docs.length === 1) {
          // ровно одна — сразу открываем
          const fileName = docs[0].fileName;
          if (fileName) {
            return res.redirect('/view?map=' + encodeURIComponent(fileName));
          }
        } else if (docs.length > 1) {
          // несколько — покажем список выбора
          searchResults = docs;
        } else {
          notFoundMessage = `Карта с именем файла, содержащим "${mapQuery}", не найдена в базе`;
        }
      } catch (err) {
        console.error('Map search error:', err);
        notFoundMessage = 'Ошибка при поиске карты';
      }
    }

    let savedMaps = [];
    try {
      savedMaps = await getSavedMapsList();
    } catch (err) {
      savedMaps = [];
    }

    res.type('html').send(
      renderHomeHtml(savedMaps, {
        searchQuery: mapQuery || '',
        notFoundMessage,
        searchResults
      })
    );
  } catch (e) {
    res.status(500).send(`Ошибка: ${e.message || e}`);
  }
});

// Просмотр карты: теперь основной путь — /view?map=<fileName>
// Старый формат /view?id=... автоматически редиректится на /view?map=<fileName>
app.get('/view', async (req, res) => {
  try {
    const mapParam = req.query.map;
    const id = req.query.id;

    const db = await getDb();
    let doc = null;

    if (mapParam) {
      doc = await findMapByExactFileName(mapParam);
      if (!doc) {
        return res.status(404).send('Карта с таким именем файла не найдена в базе');
      }
    } else if (id) {
      // legacy: /view?id=... => найдём, потом редирект на /view?map=
      doc = await db.collection('maps').findOne({ _id: new ObjectId(id) });
      if (!doc) {
        return res.status(404).send('Карта не найдена в базе');
      }
      if (doc.fileName) {
        return res.redirect('/view?map=' + encodeURIComponent(doc.fileName));
      }
    } else {
      return res.redirect('/');
    }

    if (!doc) {
      return res.status(404).send('Карта не найдена');
    }

    const savedMaps = await getSavedMapsList();

    const result = {
      file: doc.fileName || (doc.mapName || 'map') + '.bsp',
      mapName: doc.mapName || null,
      mapVersion: doc.mapVersion || null,
      textures: doc.textures || [],
      skies: doc.skies || [],
      sounds: doc.sounds || [],
      models: doc.models || [],
      others: doc.others || [],
      entityStats: doc.entityStats || createEmptyEntityStats(),
      errors: doc.errors || [],
      warnings: doc.warnings || []
    };

    res.type('html').send(
      renderResultsHtml([result], savedMaps, { currentFileName: doc.fileName || null })
    );
  } catch (e) {
    res.status(500).send(`Ошибка: ${e.message || e}`);
  }
});

// Анализ загруженных файлов
app.post('/analyze', upload.array('maps'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).send('Файлы не загружены');
    }

    const results = [];
    for (const f of req.files) {
      const analysis = analyzeBspBuffer(f.buffer);

      // Сохраняем в MongoDB (upsert по mapName + mapVersion)
      try {
        const { mapName, mapVersion } = await saveAnalysisToDb(analysis, f.originalname);
        analysis.mapName = mapName;
        analysis.mapVersion = mapVersion;
      } catch (err) {
        analysis.warnings = analysis.warnings || [];
        analysis.warnings.push(`Не удалось сохранить в MongoDB: ${err.message}`);
      }

      results.push({ file: f.originalname, ...analysis });
    }

    const savedMaps = await getSavedMapsList();

    // Если просят JSON
    if ((req.headers.accept || '').includes('application/json') || req.query.json === '1') {
      return res.json({ results });
    }

    // HTML
    res.type('html').send(renderResultsHtml(results, savedMaps));
  } catch (e) {
    res.status(400).send(`Ошибка: ${e.message || e}`);
  }
});

// ----- HTML рендеры -----

// Удаляем управляющие символы, лишние пробелы и т.п. только для отображения
function cleanMapTitle(name) {
  if (!name) return '';
  let s = String(name);

  // 1) буквальные последовательности "\n", "\r", "\t" -> пробел
  s = s.replace(/\\[nrt]/g, ' ');

  // 2) реальные управляющие символы ASCII (0x00-0x1F, 0x7F) -> пробел
  s = s.replace(/[\x00-\x1F\x7F]+/g, ' ');

  // 3) типичный юникод-мусор: неразрывные / нулевой ширины и т.п. -> пробел
  s = s.replace(/[\u00A0\u200B-\u200F\u2028\u2029]+/g, ' ');

  // 4) схлопываем пробелы
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}


function renderHomeHtml(
  savedMaps,
  { searchQuery = '', notFoundMessage = null, searchResults = [] } = {}
) {
  const esc = htmlEscape;

  const options = savedMaps.map(m => {
    const fileName = m.fileName || '';
    const rawNamePart = m.mapName || getBaseMapName(fileName) || 'Без имени';
    const namePart = cleanMapTitle(rawNamePart) || 'Без имени';
    const filePart = fileName ? ` (${fileName})` : '';
    const label = namePart + filePart;
    const value = fileName || namePart; // value для select — имя файла, если есть
    return `<option value="${esc(value)}">${esc(label)}</option>`;
  }).join('');

  const haveMaps = savedMaps.length > 0;

  const searchResultsHtml = searchResults.length > 1
    ? `
      <div class="panel">
        <div><strong>Найдено карт: ${searchResults.length}</strong></div>
        <ul>
          ${searchResults.map(m => {
            const fileName = m.fileName || '';
            const rawNamePart = m.mapName || getBaseMapName(fileName) || 'Без имени';
            const namePart = cleanMapTitle(rawNamePart) || 'Без имени';
            const filePart = fileName ? ` (${fileName})` : '';
            const label = namePart + filePart;
            const href = '/view?map=' + encodeURIComponent(fileName || namePart);
            return `<li><a href="${href}">${esc(label)}</a></li>`;
          }).join('')}
        </ul>
      </div>
    `
    : '';

  return `
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>Quake 2 BSP Resource Inspector</title>
<style>
  body{font-family:system-ui,Arial,sans-serif;margin:2rem;max-width:1100px}
  pre{background:#f6f8fa;padding:1rem;overflow:auto}
  .panel{border:1px solid #ddd;padding:1rem;margin:1rem 0;border-radius:4px}
  .top-bar{display:flex;flex-wrap:wrap;gap:1rem;align-items:center;margin-bottom:1rem}
  .top-bar form{margin:0}
  label{font-size:0.95rem}
  select,input[type="text"]{padding:0.2rem 0.4rem}
  button{padding:0.3rem 0.8rem;cursor:pointer}
  .search-msg{margin-top:0.3rem;font-size:0.85rem;color:#b00020}
  .stats{margin-top:0.5rem;font-size:0.9rem;color:#555}
</style>
</head>
<body>
  <h1>Quake 2 BSP Resource Inspector</h1>

  <p class="stats">
    Всего загруженных карт в базе: <strong>${savedMaps.length}</strong>
  </p>

  <div class="top-bar">
    <form action="/analyze" method="post" enctype="multipart/form-data">
      <label>
        Загрузить BSP:
        <input type="file" name="maps" multiple accept=".bsp" />
      </label>
      <button type="submit">Анализировать</button>
    </form>

    ${haveMaps ? `
      <form action="/view" method="get" id="savedMapForm">
        <label>
          Сохранённые карты:
          <select name="map" onchange="if(this.value) document.getElementById('savedMapForm').submit();">
            <option value="">— выбрать карту —</option>
            ${options}
          </select>
        </label>
        <noscript><button type="submit">Открыть</button></noscript>
      </form>
    ` : ''}
  </div>

  <div class="panel">
    <form action="/" method="get">
      <label>
        Поиск по имени файла карты (по подстроке, без учёта регистра):
        <input type="text" name="map" value="${esc(searchQuery || '')}" placeholder="например, dm1 или q2dm1" />
      </label>
      <button type="submit">Найти</button>
    </form>
    ${notFoundMessage ? `<div class="search-msg">${esc(notFoundMessage)}</div>` : ''}
  </div>

  ${searchResultsHtml}

  <p>Поддерживается Quake 2 BSP (IBSP v38). Текстуры берутся из TEXINFO, а sky/sound/model и игровые объекты (оружие, броня, спавны, полезные предметы) — из ENTITIES.</p>
  <p>Program support: ly (@QuakeJourney)<p>
</body>
</html>
  `;
}


function renderResultsHtml(results, savedMaps = [], { currentFileName = null } = {}) {
  const esc = htmlEscape;

  const renderCountsList = map => {
    const entries = Object.entries(map || {});
    if (!entries.length) return '<p>—</p>';
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return `<ul>${entries.map(([name, count]) =>
      `<li><code>${esc(name)}</code>: <strong>${count}</strong></li>`).join('')}</ul>`;
  };

  const renderSpawnPoints = sp => {
    if (!sp) return '<p>—</p>';
    const items = [];
    if (sp.deathmatch) items.push(
      `<li>Deathmatch (<code>info_player_deathmatch</code>): <strong>${sp.deathmatch}</strong></li>`
    );
    if (sp.start) items.push(
      `<li>Start / single (<code>info_player_start</code>): <strong>${sp.start}</strong></li>`
    );
    if (sp.coop) items.push(
      `<li>Coop (<code>info_player_coop</code>): <strong>${sp.coop}</strong></li>`
    );
    if (sp.intermission) items.push(
      `<li>Intermission (<code>info_player_intermission</code>): <strong>${sp.intermission}</strong></li>`
    );
    if (!items.length) return '<p>—</p>';
    return `<ul>${items.join('')}</ul>`;
  };

  // Навигационное меню по секциям (якорям)
  const navItems = [];
  const sections = [
    { key: 'textures', label: 'Текстуры' },
    { key: 'skies', label: 'Небо' },
    { key: 'sounds', label: 'Звуки' },
    { key: 'models', label: 'Модели' },
    { key: 'weapons', label: 'Оружие' },
    { key: 'armors', label: 'Броня' },
    { key: 'spawns', label: 'Спавны' },
    { key: 'items', label: 'Предметы' }
  ];

  results.forEach((r, idx) => {
    const rawTitle = r.mapName || getBaseMapName(r.file || '') || r.file || `Map ${idx + 1}`;
    const title = cleanMapTitle(rawTitle) || rawTitle;
    const prefix = `map${idx}`;
    sections.forEach(sec => {
      const id = `${prefix}-${sec.key}`;
      navItems.push({
        href: `#${id}`,
        label: `${title}: ${sec.label}`
      });
    });
  });

  const savedOptions = savedMaps.map(m => {
    const fileName = m.fileName || '';
    const rawNamePart = m.mapName || getBaseMapName(fileName) || 'Без имени';
    const namePart = cleanMapTitle(rawNamePart) || 'Без имени';
    const filePart = fileName ? ` (${fileName})` : '';
    const label = namePart + filePart;
    const value = fileName || namePart;
    const selected = currentFileName && fileName &&
      String(fileName).toLowerCase() === String(currentFileName).toLowerCase()
      ? ' selected'
      : '';
    return `<option value="${esc(value)}"${selected}>${esc(label)}</option>`;
  }).join('');

  const haveMaps = savedMaps.length > 0;

  const fileBlocks = results.map((r, idx) => {
    const prefix = `map${idx}`;
    const rawTitle = r.mapName || getBaseMapName(r.file || '') || r.file || `Map ${idx + 1}`;
    const title = cleanMapTitle(rawTitle) || rawTitle;
    const displayMapName = cleanMapTitle(r.mapName) || r.mapName || '—';

    return `
    <div class="file">
      <h2>${esc(title)}</h2>
      <p class="file-subtitle">
        <span class="muted">Файл:</span> <code>${esc(r.file || '—')}</code><br>
        <span class="muted">Название карты:</span> ${esc(displayMapName)}<br>
        <span class="muted">Версия:</span> ${esc(r.mapVersion || '—')}
      </p>

      ${r.warnings && r.warnings.length ? `<div class="warn-block">
        <strong>Предупреждения:</strong>
        <ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      </div>` : ''}

      ${r.errors && r.errors.length ? `<div class="err-block">
        <strong>Ошибки:</strong>
        <ul>${r.errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
      </div>` : ''}

      <a id="${prefix}-textures"></a>
      <details open>
        <summary>Текстуры (из TEXINFO)</summary>
        ${r.textures && r.textures.length
          ? `<ul>${r.textures.map(t => `<li><code>${esc(t)}</code></li>`).join('')}</ul>`
          : '<p>—</p>'}
      </details>

      <a id="${prefix}-skies"></a>
      <details>
        <summary>Небо (sky) из ENTITIES</summary>
        ${r.skies && r.skies.length
          ? `<ul>${r.skies.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ul>`
          : '<p>—</p>'}
      </details>

      <a id="${prefix}-sounds"></a>
      <details>
        <summary>Звуки из ENTITIES</summary>
        ${r.sounds && r.sounds.length
          ? `<ul>${r.sounds.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ul>`
          : '<p>—</p>'}
      </details>

      <a id="${prefix}-models"></a>
      <details>
        <summary>Модели из ENTITIES</summary>
        ${r.models && r.models.length
          ? `<ul>${r.models.map(m => `<li><code>${esc(m)}</code></li>`).join('')}</ul>`
          : '<p>—</p>'}
      </details>

      ${r.others && r.others.length ? `
        <details>
          <summary>Другие ссылки</summary>
          <ul>${r.others.map(o => `<li><code>${esc(o)}</code></li>`).join('')}</ul>
        </details>
      ` : ''}

      ${r.entityStats ? `
        <a id="${prefix}-weapons"></a>
        <details>
          <summary>Оружие на карте (по classname)</summary>
          ${renderCountsList(r.entityStats.weapons)}
        </details>

        <a id="${prefix}-armors"></a>
        <details>
          <summary>Броня на карте (по classname)</summary>
          ${renderCountsList(r.entityStats.armors)}
        </details>

        <a id="${prefix}-spawns"></a>
        <details>
          <summary>Точки появления игроков</summary>
          ${renderSpawnPoints(r.entityStats.spawnPoints)}
        </details>

        <a id="${prefix}-items"></a>
        <details>
          <summary>Полезные предметы</summary>
          ${renderCountsList(r.entityStats.items)}
        </details>
      ` : ''}
    </div>`;
  }).join('\n');

  const navHtml = navItems.length ? `
    <nav class="top-nav">
      <strong>Разделы:</strong>
      <div class="top-nav-links">
        ${navItems.map(n => `<a href="${n.href}">${esc(n.label)}</a>`).join('')}
      </div>
    </nav>
  ` : '';

  return `
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Результаты анализа карт</title>
  <style>
    body{
      font-family:system-ui,Arial,sans-serif;
      margin:2rem;
      max-width:1100px;
    }
    .top-bar{
      display:flex;
      flex-wrap:wrap;
      gap:1rem;
      align-items:center;
      margin-bottom:1rem;
    }
    .top-bar form{margin:0}
    .home-link{
      font-size:0.9rem;
      text-decoration:none;
      color:#0056b3;
      margin-right:0.5rem;
    }
    .home-link:hover{text-decoration:underline;}
    label{font-size:0.95rem}
    input[type="file"]{max-width:280px}
    select{padding:0.2rem 0.4rem}
    button{padding:0.3rem 0.8rem;cursor:pointer}
    .file{
      border:1px solid #ddd;
      padding:1rem 1.2rem;
      margin:1.2rem 0;
      border-radius:6px;
      background:#fafafa;
    }
    .file-subtitle{
      font-size:0.9rem;
      color:#555;
    }
    .muted{color:#777}
    code{
      background:#f6f8fa;
      padding:0 .2rem;
      border-radius:3px;
    }
    details{
      margin:0.4rem 0 0.6rem 0;
      padding:0.4rem 0.6rem;
      background:#fff;
      border-radius:4px;
      border:1px solid #e2e2e2;
    }
    summary{
      cursor:pointer;
      font-weight:600;
      outline:none;
    }
    summary::-webkit-details-marker{margin-right:4px}
    .warn-block{
      border-left:4px solid #f0a500;
      background:#fffaf0;
      padding:0.4rem 0.6rem;
      margin-bottom:0.6rem;
    }
    .err-block{
      border-left:4px solid #cc0000;
      background:#fff5f5;
      padding:0.4rem 0.6rem;
      margin-bottom:0.6rem;
    }
    .top-nav{
      position:sticky;
      top:0;
      z-index:10;
      background:#ffffffee;
      backdrop-filter:blur(4px);
      padding:0.4rem 0.6rem;
      border:1px solid #ddd;
      border-radius:6px;
      margin-bottom:1rem;
      display:flex;
      align-items:center;
      gap:0.5rem;
      flex-wrap:wrap;
    }
    .top-nav-links{
      display:flex;
      flex-wrap:wrap;
      gap:0.4rem;
    }
    .top-nav a{
      font-size:0.85rem;
      text-decoration:none;
      color:#0056b3;
      padding:0.1rem 0.4rem;
      border-radius:4px;
    }
    .top-nav a:hover{
      background:#eaf3ff;
    }
    ul{margin:0.3rem 0 0.8rem 1.2rem}
  </style>
</head>
<body>
  <div class="top-bar">
    <a href="/" class="home-link">← К выбору/поиску карт</a>

    <form action="/analyze" method="post" enctype="multipart/form-data">
      <label>
        Загрузить BSP:
        <input type="file" name="maps" multiple accept=".bsp" />
      </label>
      <button type="submit">Анализировать</button>
    </form>

    ${haveMaps ? `
      <form action="/view" method="get" id="savedMapFormTop">
        <label>
          Сохранённые карты:
          <select name="map" onchange="if(this.value) document.getElementById('savedMapFormTop').submit();">
            <option value="">— выбрать карту —</option>
            ${savedOptions}
          </select>
        </label>
        <noscript><button type="submit">Открыть</button></noscript>
      </form>
    ` : ''}
  </div>

  <h1>Результаты анализа карт</h1>

  ${navHtml}

  ${fileBlocks}

  <p><a href="/">← На главную (выбор/поиск карт)</a></p>

  <script>
    (function() {
      function openDetailsForHash() {
        var hash = window.location.hash;
        if (!hash || hash.length < 2) return;
        var id = hash.slice(1);
        var anchor = document.getElementById(id);
        if (!anchor) return;

        var details = anchor.nextElementSibling;
        if (details && details.tagName && details.tagName.toLowerCase() === 'details') {
          details.open = true;
        }
      }

      window.addEventListener('hashchange', openDetailsForHash);

      window.addEventListener('DOMContentLoaded', function() {
        openDetailsForHash();

        var navLinks = document.querySelectorAll('.top-nav a[href^="#"]');
        navLinks.forEach(function(a) {
          a.addEventListener('click', function() {
            setTimeout(openDetailsForHash, 0);
          });
        });
      });
    })();
  </script>
</body>
</html>`;
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
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

function createEmptyEntityStats() {
  return {
    weapons: {},        // weapon_* -> count
    armors: {},         // item_armor_* -> count
    spawnPoints: {      // info_player_* counters
      deathmatch: 0,
      coop: 0,
      start: 0,
      intermission: 0
    },
    items: {}           // полезные item_*
  };
}

function inc(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function classifyClassname(cls, entityStats) {
  // Оружие
  if (cls.startsWith('weapon_')) {
    inc(entityStats.weapons, cls);
    return;
  }

  // Броня
  if (cls.startsWith('item_armor_')) {
    inc(entityStats.armors, cls);
    return;
  }

  // Спавны игроков
  if (cls.startsWith('info_player_')) {
    if (cls === 'info_player_deathmatch') {
      entityStats.spawnPoints.deathmatch++;
    } else if (cls === 'info_player_start') {
      entityStats.spawnPoints.start++;
    } else if (cls === 'info_player_coop') {
      entityStats.spawnPoints.coop++;
    } else if (cls === 'info_player_intermission') {
      entityStats.spawnPoints.intermission++;
    }
    return;
  }

  // Полезные предметы (минимально интересный набор)
  const interestingItems = new Set([
    'item_health',
    'item_health_large',
    'item_health_mega',
    'item_quad',
    'item_invulnerability',
    'item_adrenaline',
    'item_bandolier',
    'item_pack',
    'item_power_screen',
    'item_power_shield'
  ]);
  if (interestingItems.has(cls)) {
    inc(entityStats.items, cls);
  }
}

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

  // Лумпы (offset/length) начинаются с 8 байта, каждая запись: int32 offset + int32 length
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
  const entityStats = createEmptyEntityStats();
  const worldInfo = { name: null, version: null };

  // ENTITIES
  const ent = lumps[LUMP.ENTITIES];
  if (ent && ent.length > 0 && ent.offset + ent.length <= buf.length) {
    const entsTxt = buf.toString('ascii', ent.offset, ent.offset + ent.length);
    extractFromEntities(entsTxt, { skies, sounds, models, others, entityStats, worldInfo });
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
        const normalized = name.replace(/^textures[\\/]+/i, '').replace(/\\/g, '/');
        textures.add(`textures/${normalized}.wal`);
      }
    }
  } else {
    warnings.push('TEXINFO лумп отсутствует или поврежден — текстуры могут быть не найдены');
  }

  const mapName = worldInfo.name || null;
  const mapVersion = worldInfo.version || null;

  return {
    errors,
    warnings,
    mapName,
    mapVersion,
    textures: Array.from(textures).sort(),
    skies: Array.from(skies).sort(),
    sounds: Array.from(sounds).sort(),
    models: Array.from(models).sort(),
    others: Array.from(others).sort(),
    entityStats
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
  const re = /"([^"]+)"\s*"([^"]*)"/g;
  const pairs = [];
  let m;
  while ((m = re.exec(txt)) !== null) {
    const k = m[1].toLowerCase();
    const v = m[2];
    pairs.push([k, v]);
  }

  if (!out.worldInfo) {
    out.worldInfo = { name: null, version: null };
  }

  for (const [k, v] of pairs) {
    if (!v) continue;
    const vv = v.replace(/\\/g, '/');

    // Название карты / версия (worldspawn)
    if ((k === 'message' || k === 'map' || k === 'mapname') && !out.worldInfo.name) {
      out.worldInfo.name = v;
    }
    if ((k === 'mapversion' || k === 'version') && !out.worldInfo.version) {
      out.worldInfo.version = v;
    }

    // Классы сущностей — считаем оружие/броню/спавны/предметы
    if (k === 'classname' && out.entityStats) {
      const cls = v.toLowerCase();
      classifyClassname(cls, out.entityStats);
    }

    if (k === 'sky') {
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
