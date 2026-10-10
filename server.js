import express from "express";
import helmet from "helmet";
import cors from "cors";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT) || 10000;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
}) : null;

// Backward-compatible migration for existing databases. The application keeps the schema current.
async function ensureSchemaCompatibility() {
  if (!pool) return;
  await pool.query("ALTER TABLE advertisements ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 30 CHECK (duration_days IN (7,14,30,60,90))");
}
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(ROOT, "public")));

const clean = (value, max = 250) => String(value ?? "").trim().slice(0, max);
const fail = (res, status, error) => res.status(status).json({ error });
function configured(res) {
  if (!pool) { fail(res, 503, "قاعدة البيانات غير مربوطة. أضف DATABASE_URL في إعدادات الخدمة."); return false; }
  if (!JWT_SECRET) { fail(res, 503, "إعداد JWT_SECRET غير موجود."); return false; }
  return true;
}
function auth(req, res, next) {
  if (!configured(res)) return;
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) throw new Error("missing token");
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { return fail(res, 401, "سجّل الدخول أولاً."); }
}
const allowRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : fail(res, 403, "ليست لديك صلاحية لهذا الإجراء.");

async function notify(client, userId, bookingId, title, body) {
  await client.query(
    "INSERT INTO notifications(user_id,booking_id,title,body) VALUES($1,$2,$3,$4)",
    [userId, bookingId, title, body]
  );
}
app.get("/api/health", async (_req, res) => {
  try {
    if (!pool) return res.status(503).json({ ok: false, app: "SAM", database: "not_configured" });
    await pool.query("SELECT 1");
    return res.json({ ok: true, app: "SAM", database: "connected" });
  } catch { return res.status(503).json({ ok: false, app: "SAM", database: "error" }); }
});

app.post("/api/register", async (req, res) => {
  if (!configured(res)) return;
  const name = clean(req.body?.name, 100);
  const phone = clean(req.body?.phone, 40);
  const password = String(req.body?.password ?? "");
  const role = ["customer", "provider"].includes(req.body?.role) ? req.body.role : "customer";
  if (name.length < 2 || phone.length < 5 || password.length < 8)
    return fail(res, 400, "أدخل الاسم ورقم الهاتف وكلمة مرور من 8 أحرف على الأقل.");
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      "INSERT INTO users(name,phone,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,name,phone,role",
      [name, phone, hash, role]
    );
    const user = r.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
    return res.status(201).json({ user, token });
  } catch (e) {
    if (e.code === "23505") return fail(res, 409, "رقم الهاتف مسجل مسبقاً.");
    console.error(e); return fail(res, 500, "تعذر إنشاء الحساب.");
  }
});

app.post("/api/login", async (req, res) => {
  if (!configured(res)) return;
  try {
    const r = await pool.query("SELECT * FROM users WHERE phone=$1", [clean(req.body?.phone, 40)]);
    const password = String(req.body?.password ?? "");
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash)))
      return fail(res, 401, "رقم الهاتف أو كلمة المرور غير صحيحة.");
    const u = r.rows[0];
    const user = { id: u.id, name: u.name, phone: u.phone, role: u.role };
    const token = jwt.sign({ id: u.id, name: u.name, role: u.role }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ user, token });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تسجيل الدخول."); }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT id,name,phone,role,created_at FROM users WHERE id=$1", [req.user.id]);
    if (!r.rowCount) return fail(res, 404, "الحساب غير موجود.");
    return res.json({ user: r.rows[0] });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل الحساب."); }
});

app.get("/api/services", async (req, res) => {
  if (!pool) return fail(res, 503, "قاعدة البيانات غير مربوطة.");
  try {
    const q = clean(req.query.q, 100);
    const r = await pool.query(
      `SELECT s.*,u.name AS provider_name FROM services s JOIN users u ON u.id=s.provider_id
       WHERE s.active=TRUE AND ($1='' OR s.title ILIKE $2 OR s.category ILIKE $2 OR s.city ILIKE $2)
       ORDER BY s.created_at DESC LIMIT 200`, [q, `%${q}%`]
    );
    return res.json({ services: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل الخدمات."); }
});
app.get("/api/providers", async (_req, res) => {
  if (!pool) return fail(res, 503, "قاعدة البيانات غير مربوطة.");
  try {
    const r = await pool.query(
      "SELECT s.id,s.title,s.category,s.description,s.city,s.price,u.id AS provider_id,u.name AS provider_name FROM services s JOIN users u ON u.id=s.provider_id WHERE s.active=TRUE ORDER BY s.created_at DESC LIMIT 200"
    );
    return res.json({ providers: r.rows, services: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل مقدمي الخدمات."); }
});
app.post("/api/services", auth, allowRole("provider", "admin"), async (req, res) => {
  const title = clean(req.body?.title, 120), category = clean(req.body?.category, 80);
  const description = clean(req.body?.description, 2000), city = clean(req.body?.city, 100);
  const price = clean(req.body?.price, 100);
  if (!title || !category) return fail(res, 400, "اسم الخدمة والتصنيف مطلوبان.");
  try {
    const r = await pool.query(
      "INSERT INTO services(provider_id,title,category,description,city,price) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [req.user.id, title, category, description, city, price]
    );
    return res.status(201).json({ service: r.rows[0] });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر نشر الخدمة."); }
});

app.post("/api/bookings", auth, allowRole("customer"), async (req, res) => {
  const providerId = Number(req.body?.provider_id);
  const serviceId = req.body?.service_id ? Number(req.body.service_id) : null;
  const message = clean(req.body?.message, 1500);
  if (!Number.isInteger(providerId) || providerId < 1) return fail(res, 400, "اختر صاحب المهنة.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let title = clean(req.body?.service_title || "طلب خدمة", 120);
    if (serviceId) {
      const s = await client.query("SELECT id,title,provider_id FROM services WHERE id=$1 AND active=TRUE", [serviceId]);
      if (!s.rowCount || Number(s.rows[0].provider_id) !== providerId) {
        await client.query("ROLLBACK"); return fail(res, 400, "الخدمة غير متاحة.");
      }
      title = s.rows[0].title;
    }
    const b = await client.query(
      "INSERT INTO bookings(customer_id,provider_id,service_id,service_title,message) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [req.user.id, providerId, serviceId, title, message]
    );
    await notify(client, providerId, b.rows[0].id, "طلب خدمة جديد", `لديك طلب جديد: ${title}`);
    await client.query("COMMIT");
    return res.status(201).json({ booking: b.rows[0], message: "تم إرسال الطلب." });
  } catch (e) {
    await client.query("ROLLBACK"); console.error(e); return fail(res, 500, "تعذر إرسال الطلب.");
  } finally { client.release(); }
});

app.get("/api/bookings", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.*,c.name AS customer_name,p.name AS provider_name
       FROM bookings b JOIN users c ON c.id=b.customer_id JOIN users p ON p.id=b.provider_id
       WHERE ($1='admin' OR b.customer_id=$2 OR b.provider_id=$2)
       ORDER BY b.updated_at DESC LIMIT 200`, [req.user.role, req.user.id]
    );
    return res.json({ bookings: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل المواعيد."); }
});

app.patch("/api/bookings/:id/propose", auth, async (req, res) => {
  const id = Number(req.params.id), proposed = new Date(req.body?.proposed_at);
  if (!Number.isInteger(id) || Number.isNaN(proposed.getTime()) || proposed.getTime() < Date.now())
    return fail(res, 400, "اختر موعداً صحيحاً في المستقبل.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT * FROM bookings WHERE id=$1 FOR UPDATE", [id]);
    if (!r.rowCount) { await client.query("ROLLBACK"); return fail(res, 404, "الطلب غير موجود."); }
    const b = r.rows[0], uid = String(req.user.id);
    if (![String(b.customer_id), String(b.provider_id)].includes(uid)) {
      await client.query("ROLLBACK"); return fail(res, 403, "لا تملك هذا الطلب.");
    }
    if (b.status === "cancelled") { await client.query("ROLLBACK"); return fail(res, 409, "الطلب ملغى."); }
    const customerProposed = uid === String(b.customer_id);
    const updated = await client.query(
      `UPDATE bookings SET proposed_at=$1,customer_confirmed=$2,provider_confirmed=$3,status='accepted',updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [proposed, false, false, id]
    );
    const recipient = customerProposed ? b.provider_id : b.customer_id;
    await notify(client, recipient, id, "اقتراح موعد جديد", `تم اقتراح موعد ${proposed.toLocaleString("ar")}. افتح سام لتأكيد الموعد أو اقتراح وقت آخر.`);
    await client.query("COMMIT");
    return res.json({ booking: updated.rows[0], message: "أُرسل اقتراح الموعد. يلزم تأكيد الطرف الآخر." });
  } catch (e) {
    await client.query("ROLLBACK"); console.error(e); return fail(res, 500, "تعذر اقتراح الموعد.");
  } finally { client.release(); }
});

app.post("/api/bookings/:id/confirm", auth, async (req, res) => {
  const id = Number(req.params.id), client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query("SELECT * FROM bookings WHERE id=$1 FOR UPDATE", [id]);
    if (!r.rowCount) { await client.query("ROLLBACK"); return fail(res, 404, "الطلب غير موجود."); }
    const b = r.rows[0], uid = String(req.user.id), customer = String(b.customer_id), provider = String(b.provider_id);
    if (uid !== customer && uid !== provider) { await client.query("ROLLBACK"); return fail(res, 403, "لا تملك هذا الطلب."); }
    if (!b.proposed_at) { await client.query("ROLLBACK"); return fail(res, 409, "يجب اقتراح موعد أولاً."); }
    if (b.status === "cancelled") { await client.query("ROLLBACK"); return fail(res, 409, "الطلب ملغى."); }
    const cc = Boolean(b.customer_confirmed || uid === customer);
    const pc = Boolean(b.provider_confirmed || uid === provider);
    const final = cc && pc;
    const updated = await client.query(
      "UPDATE bookings SET customer_confirmed=$1,provider_confirmed=$2,status=$3,updated_at=NOW() WHERE id=$4 RETURNING *",
      [cc, pc, final ? "confirmed" : "accepted", id]
    );
    if (final) {
      const when = new Date(b.proposed_at).toLocaleString("ar");
      await notify(client, b.customer_id, id, "تم تأكيد الموعد", `اتفق الطرفان على الموعد: ${when}`);
      await notify(client, b.provider_id, id, "تم تأكيد الموعد", `اتفق الطرفان على الموعد: ${when}`);
    } else {
      await notify(client, uid === customer ? b.provider_id : b.customer_id, id, "تأكيد مطلوب للموعد", "أكد الطرف الأول الموعد. افتح سام لتأكيده نهائياً.");
    }
    await client.query("COMMIT");
    return res.json({ booking: updated.rows[0], message: final ? "تم تأكيد الموعد من الطرفين." : "تم تسجيل تأكيدك، وننتظر الطرف الآخر." });
  } catch (e) {
    await client.query("ROLLBACK"); console.error(e); return fail(res, 500, "تعذر تأكيد الموعد.");
  } finally { client.release(); }
});

app.post("/api/bookings/:id/cancel", auth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(
      "UPDATE bookings SET status='cancelled',updated_at=NOW() WHERE id=$1 AND (customer_id=$2 OR provider_id=$2) AND status<>'cancelled' RETURNING *",
      [id, req.user.id]
    );
    if (!r.rowCount) return fail(res, 404, "لم يتم العثور على طلب قابل للإلغاء.");
    const b = r.rows[0], other = String(req.user.id) === String(b.customer_id) ? b.provider_id : b.customer_id;
    await pool.query("INSERT INTO notifications(user_id,booking_id,title,body) VALUES($1,$2,$3,$4)", [other,id,"تم إلغاء الطلب","تم إلغاء طلب الخدمة أو الموعد."]);
    return res.json({ booking: r.rows[0], message: "تم إلغاء الطلب." });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر إلغاء الطلب."); }
});

app.get("/api/notifications", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [req.user.id]);
    return res.json({ notifications: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل التنبيهات."); }
});
app.patch("/api/notifications/:id/read", auth, async (req, res) => {
  try {
    const r = await pool.query("UPDATE notifications SET read=TRUE WHERE id=$1 AND user_id=$2 RETURNING id", [Number(req.params.id), req.user.id]);
    if (!r.rowCount) return fail(res, 404, "التنبيه غير موجود.");
    return res.json({ ok: true });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحديث التنبيه."); }
});
app.post("/api/reports", auth, async (req, res) => {
  const details = clean(req.body?.details, 2000);
  const target = req.body?.target_user_id ? Number(req.body.target_user_id) : null;
  if (details.length < 5) return fail(res, 400, "اكتب تفاصيل البلاغ.");
  try {
    const r = await pool.query("INSERT INTO reports(reporter_id,target_user_id,details) VALUES($1,$2,$3) RETURNING id,status,created_at", [req.user.id, target, details]);
    return res.status(201).json({ report: r.rows[0], message: "تم إرسال البلاغ." });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر إرسال البلاغ."); }
});
app.get("/api/admin/reports", auth, allowRole("admin"), async (_req, res) => {
  try {
    const r = await pool.query("SELECT r.*,u.name AS reporter_name FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 300");
    return res.json({ reports: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل البلاغات."); }
});


// Advertisements: public listings show approved ads only; new ads require admin review.
app.get("/api/ads", async (req, res) => {
  if (!pool) return fail(res, 503, "قاعدة البيانات غير مربوطة.");
  try {
    const type = clean(req.query.type, 30);
    const q = clean(req.query.q, 100);
    const r = await pool.query(
      `SELECT a.id,a.ad_type,a.title,a.description,a.city,a.contact_phone,a.image_url,a.price_label,a.featured,a.created_at,u.name AS owner_name
       FROM advertisements a JOIN users u ON u.id=a.owner_id
       WHERE a.status='approved' AND (a.starts_at IS NULL OR a.starts_at<=NOW()) AND (a.ends_at IS NULL OR a.ends_at>NOW())
       AND ($1='' OR a.ad_type=$1) AND ($2='' OR a.title ILIKE $3 OR a.description ILIKE $3 OR a.city ILIKE $3)
       ORDER BY a.featured DESC,a.created_at DESC LIMIT 100`,
      [type,q,`%${q}%`]
    );
    return res.json({ advertisements: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل الإعلانات."); }
});

app.post("/api/ads", auth, async (req, res) => {
  const adType = ["services","commercial","jobs","featured"].includes(req.body?.ad_type) ? req.body.ad_type : "commercial";
  const title = clean(req.body?.title, 140);
  const description = clean(req.body?.description, 2500);
  const city = clean(req.body?.city, 100);
  const phone = clean(req.body?.contact_phone || "", 40);
  const imageUrl = clean(req.body?.image_url || "", 500);
  const price = clean(req.body?.price_label || "", 100);
  const durationDays = [7, 14, 30, 60, 90].includes(Number(req.body?.duration_days)) ? Number(req.body.duration_days) : 30;
  if (title.length < 3 || description.length < 10) return fail(res, 400, "اكتب عنواناً ووصفاً واضحين للإعلان.");
  if (imageUrl && !/^https:\/\/\S+$/i.test(imageUrl)) return fail(res, 400, "رابط الصورة يجب أن يبدأ بـ https://");
  try {
    const r = await pool.query(
      `INSERT INTO advertisements(owner_id,ad_type,title,description,city,contact_phone,image_url,price_label,status,featured,starts_at,ends_at,duration_days)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',FALSE,NULL,NULL,$9)
       RETURNING id,ad_type,title,status,created_at,ends_at,duration_days`,
      [req.user.id,adType,title,description,city,phone,imageUrl,price,durationDays]
    );
    return res.status(201).json({ advertisement: r.rows[0], message: "تم إرسال الإعلان للمراجعة. تبدأ مدة الإعلان بعد الموافقة والنشر؛ الدفع الإلكتروني غير مفعّل بعد." });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر إرسال الإعلان."); }
});

app.get("/api/my-ads", auth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM advertisements WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100", [req.user.id]);
    return res.json({ advertisements: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل إعلاناتك."); }
});

app.get("/api/admin/ads", auth, allowRole("admin"), async (_req, res) => {
  try {
    const r = await pool.query("SELECT a.*,u.name AS owner_name,u.phone AS owner_phone FROM advertisements a JOIN users u ON u.id=a.owner_id ORDER BY a.created_at DESC LIMIT 300");
    return res.json({ advertisements: r.rows });
  } catch (e) { console.error(e); return fail(res, 500, "تعذر تحميل قائمة الإعلانات."); }
});

app.patch("/api/admin/ads/:id/moderate", auth, allowRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const status = ["approved","rejected","paused"].includes(req.body?.status) ? req.body.status : "";
  const featured = req.body?.featured === true;
  if (!Number.isInteger(id) || !status) return fail(res, 400, "اختر حالة صحيحة للإعلان.");
  try {
    const r = await pool.query(
      `UPDATE advertisements
       SET status=$1,featured=$2,
           starts_at=CASE WHEN $1='approved' THEN COALESCE(starts_at,NOW()) ELSE starts_at END,
           ends_at=CASE WHEN $1='approved' AND starts_at IS NULL THEN NOW()+(duration_days * INTERVAL '1 day') ELSE ends_at END
       WHERE id=$3 RETURNING id,title,status,featured,owner_id,starts_at,ends_at,duration_days`,
      [status,featured && status==="approved",id]
    );
    if (!r.rowCount) return fail(res,404,"الإعلان غير موجود.");
    await pool.query("INSERT INTO notifications(user_id,title,body) VALUES($1,$2,$3)",
      [r.rows[0].owner_id, status==="approved"?"تمت الموافقة على إعلانك":status==="rejected"?"تم رفض إعلانك":"تم إيقاف إعلانك", `الإعلان: ${r.rows[0].title}`]);
    return res.json({ advertisement:r.rows[0],message:"تم تحديث حالة الإعلان." });
  } catch(e) { console.error(e); return fail(res,500,"تعذر تعديل الإعلان."); }
});


app.get("/api/admin/ads-summary", auth, allowRole("admin"), async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status='pending')::int AS pending,
        COUNT(*) FILTER (WHERE status='approved' AND (ends_at IS NULL OR ends_at>NOW()))::int AS active,
        COUNT(*) FILTER (WHERE status='approved' AND ends_at<=NOW())::int AS expired,
        COUNT(*) FILTER (WHERE status='rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status='paused')::int AS paused
       FROM advertisements`
    );
    return res.json({summary:r.rows[0]});
  } catch(e) { console.error(e); return fail(res,500,"تعذر تحميل ملخص الإعلانات."); }
});

app.use("/api", (_req, res) => fail(res, 404, "واجهة API غير موجودة."));
app.get("*", (_req, res) => res.sendFile(path.join(ROOT, "public", "index.html")));
app.use((err, _req, res, _next) => {
  console.error("SAM server error:", err);
  res.status(500).json({ error: "حدث خطأ في الخادم. حاول مجدداً." });
});
ensureSchemaCompatibility().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`SAM listening on port ${PORT}`));
}).catch((e) => {
  console.error("SAM startup/database migration failed:", e.message);
  process.exit(1);
});
