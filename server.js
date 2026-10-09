import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const dbPath = path.join(__dirname, 'data', 'db.json');

function load() {
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(
      dbPath,
      JSON.stringify({
        users: [],
        providers: [],
        reports: [],
        requests: [],
        listings: [],
        campaigns: []
      }, null, 2)
    );
  }

  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  for (const key of [
    'users', 'providers', 'reports',
    'requests', 'listings', 'campaigns'
  ]) {
    if (!Array.isArray(db[key])) db[key] = [];
  }

  return db;
}

function save(db) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

const id = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'خِدمتك', version: '1.0.0' });
});

app.post('/api/register', (req, res) => {
  const { name, phone, role = 'user' } = req.body || {};

  if (!name || !phone) {
    return res.status(400).json({ error: 'الاسم ورقم الهاتف مطلوبان' });
  }

  const db = load();

  if (db.users.some(x => x.phone === phone)) {
    return res.status(409).json({ error: 'الحساب موجود' });
  }

  const user = {
    id: id(),
    name,
    phone,
    role,
    createdAt: new Date().toISOString()
  };

  db.users.push(user);
  save(db);
  res.json(user);
});

app.post('/api/reports', (req, res) => {
  const { category, description, city, area, phone } = req.body || {};

  if (!category || !city) {
    return res.status(400).json({
      error: 'نوع البلاغ والمدينة مطلوبان'
    });
  }

  const db = load();
  const report = {
    id: id(),
    category,
    description: description || '',
    city,
    area: area || '',
    phone: phone || '',
    status: 'جديد',
    createdAt: new Date().toISOString()
  };

  db.reports.unshift(report);
  save(db);
  res.status(201).json(report);
});

app.get('/api/reports', (req, res) => {
  const db = load();
  let reports = db.reports;

  if (req.query.city) {
    reports = reports.filter(x => x.city === req.query.city);
  }

  res.json(reports);
});

app.get('/api/providers', (req, res) => {
  const db = load();
  let providers = db.providers;

  if (req.query.city) {
    providers = providers.filter(
      x => !x.city || x.city === req.query.city
    );
  }

  if (req.query.available === 'true') {
    providers = providers.filter(x => x.status === 'متاح الآن');
  }

  res.json(providers);
});

app.post('/api/providers', (req, res) => {
  const { name, profession, phone, city, service, hours } = req.body || {};

  if (!name || !profession || !phone) {
    return res.status(400).json({
      error: 'الاسم والمهنة والهاتف مطلوبة'
    });
  }

  const db = load();
  const provider = {
    id: id(),
    name,
    profession,
    phone,
    city: city || '',
    service: service || profession,
    hours: hours || '',
    status: 'غير متاح',
    verified: false,
    createdAt: new Date().toISOString()
  };

  db.providers.push(provider);
  save(db);
  res.status(201).json(provider);
});

app.patch('/api/providers/:id', (req, res) => {
  const db = load();
  const provider = db.providers.find(x => x.id === req.params.id);

  if (!provider) return res.sendStatus(404);

  if (['متاح الآن', 'مشغول', 'غير متاح'].includes(req.body.status)) {
    provider.status = req.body.status;
  }

  save(db);
  res.json(provider);
});

app.post('/api/requests', (req, res) => {
  const {
    userName, phone, service, city, area, providerId
  } = req.body || {};

  if (!service || !city) {
    return res.status(400).json({
      error: 'الخدمة والمدينة مطلوبة'
    });
  }

  const db = load();
  const request = {
    id: id(),
    userName: userName || '',
    phone: phone || '',
    service,
    city,
    area: area || '',
    providerId: providerId || null,
    status: 'جديد',
    createdAt: new Date().toISOString()
  };

  db.requests.unshift(request);
  save(db);
  res.status(201).json(request);
});

app.post('/api/listings', (req, res) => {
  const { title, price, city, phone, description } = req.body || {};

  if (!title || !city) {
    return res.status(400).json({
      error: 'العنوان والمدينة مطلوبان'
    });
  }

  const db = load();
  const listing = {
    id: id(),
    title,
    price: price || '',
    city,
    phone: phone || '',
    description: description || '',
    createdAt: new Date().toISOString()
  };

  db.listings.unshift(listing);
  save(db);
  res.status(201).json(listing);
});

app.get('/api/listings', (req, res) => {
  const db = load();
  let listings = db.listings;

  if (req.query.city) {
    listings = listings.filter(x => x.city === req.query.city);
  }

  res.json(listings);
});

app.get('/api/summary', (req, res) => {
  const db = load();

  res.json({
    users: db.users.length,
    reports: db.reports.length,
    providers: db.providers.length,
    requests: db.requests.length,
    listings: db.listings.length
  });
});

// عرض ملفات الموقع من المجلد الرئيسي
app.use(express.static(__dirname));

// الصفحة الرئيسية موجودة في المجلد الرئيسي
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Khedmtak running on ${port}`);
});
