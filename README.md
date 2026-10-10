# سام (SAM) — نسخة تتضمن الإعلانات

## ميزات الإعلان
- تصنيفات: خدمات ومهن، إعلانات تجارية، وظائف.
- إرسال إعلان للمراجعة؛ لا يظهر للعامة قبل موافقة الإدارة.
- صفحة بحث للإعلانات المنشورة، وقائمة إعلاناتي وحالة كل إعلان.
- لوحة API للإدارة لمراجعة الإعلانات والموافقة أو الرفض أو الإيقاف، ويمكن جعل الإعلان مميزاً.

## نشر التطبيق
1. ارفع محتويات المجلد إلى مستودع GitHub.
2. أنشئ قاعدة PostgreSQL على Render.
3. نفّذ ملف `schema.sql` كاملاً مرة واحدة على قاعدة البيانات.
4. أنشئ Web Service واربطه بالمستودع، واجعل أمر البناء `npm install` وأمر التشغيل `npm start`.
5. اضبط `DATABASE_URL` على رابط قاعدة البيانات و`JWT_SECRET` على قيمة طويلة عشوائية و`DATABASE_SSL=true` إذا كانت قاعدة البيانات تتطلب SSL.
6. بعد النشر، افتح `/api/health` وتأكد أن `ok: true` و`database: connected`.

## تنبيه مهم
- هذا مشروع أولي. يلزم اختبار واجهة الإدارة عملياً وإنشاء حساب مدير يدويًا في قاعدة البيانات قبل إدارة الإعلانات.
- API الإدارة: `GET /api/admin/ads` و`PATCH /api/admin/ads/:id/moderate` مع جسم مثل `{"status":"approved","featured":true}`.
- الإعلان المميز في هذه النسخة لا يقبض أموالاً تلقائياً. تحصيل الدفع يحتاج مزود دفع وإعدادًا منفصلًا.
- التنبيهات حالياً داخل التطبيق فقط؛ إشعارات الهاتف أثناء إغلاقه تحتاج Firebase Cloud Messaging أو خدمة مماثلة.


## مدد الإعلانات
يختار المعلن مدة 7 أو 14 أو 30 أو 60 أو 90 يوماً. يبدأ العدّ من وقت إنشاء الإعلان حالياً، وقد تنتهي بعض الأيام قبل المراجعة؛ لذلك قبل الإطلاق التجاري يفضّل أن يحدد تاريخ الانتهاء عند الموافقة من لوحة الإدارة. لا يظهر الإعلان إلا بعد موافقة الإدارة، ويُخفى تلقائياً عن قائمة الإعلانات العامة عند انتهاء `ends_at`. لا توجد بوابة دفع مرتبطة بهذه النسخة.


## Version 3.3 — ad subscription safety
- Ad duration choices: 7, 14, 30, 60, or 90 days.
- The duration begins only when an admin approves the ad for publication, not when it is submitted.
- The public listing endpoint already filters ads whose `ends_at` is in the past.
- Existing databases receive a backward-compatible `duration_days` migration at startup.
- Payment is NOT implemented. Do not advertise paid subscriptions as live until Sham Cash integration and server-side payment verification are implemented and tested.
- Production requires persistent PostgreSQL and secure `JWT_SECRET`.
