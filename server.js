require("dotenv").config();
const express=require("express"),crypto=require("crypto"),{Pool}=require("pg");
const app=express();app.disable("x-powered-by");app.use(express.json({limit:"1mb",verify:(req,_res,buf)=>{req.rawBody=Buffer.from(buf)}}));
app.use((req,res,next)=>{res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");res.setHeader("Cache-Control","no-store");next()});
app.use(express.static("public"));
const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==="true"?{rejectUnauthorized:true}:undefined,max:Number(process.env.DB_POOL_MAX||10),idleTimeoutMillis:30000,connectionTimeoutMillis:5000}):null;
const db=(req,res,next)=>pool?next():res.status(503).json({error:"Database is not configured"});
function admin(req,res,next){const key=process.env.ADMIN_API_KEY||"",got=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(key.length<32)return res.status(503).json({error:"Configure ADMIN_API_KEY with at least 32 characters"});const a=Buffer.from(key),b=Buffer.from(got);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"Unauthorized"});next()}
const textOk=(v,n=200)=>typeof v==="string"&&v.trim().length>0&&v.trim().length<=n;
const money=v=>Number.isSafeInteger(v)&&v>=0;
function fail(res,e){console.error(e);res.status(500).json({error:"Unexpected server error"})}
// Public, database-backed membership catalogue. Purchase activation is intentionally not exposed until customer authentication and gateway webhook reconciliation are deployed.
app.get("/api/subscription-plans",db,async(_q,s)=>{try{const r=await pool.query("SELECT code,name,duration_days,price_paise FROM subscription_plans WHERE active=true ORDER BY duration_days");s.json({currency:"INR",plans:r.rows})}catch(e){fail(s,e)}});
app.get("/api/health",async(_q,s)=>{let database="not_configured";if(pool)try{await pool.query("SELECT 1");database="connected"}catch(_){database="error"}s.json({status:"ok",brand:"ASHIZU",database})});
app.get("/api/products",db,async(q,s)=>{try{const vals=[],w=["active=true"];if(q.query.category){vals.push(String(q.query.category).slice(0,80));w.push(`category=$${vals.length}`)}if(q.query.q){vals.push(`%${String(q.query.q).slice(0,80)}%`);w.push(`(name ILIKE $${vals.length} OR description ILIKE $${vals.length})`)}const lim=Math.min(Math.max(parseInt(q.query.limit||"48",10)||48,1),100);const r=await pool.query(`SELECT id,sku,name,category,description,price_paise,stock,supplier_type FROM products WHERE ${w.join(" AND ")} ORDER BY created_at DESC LIMIT ${lim}`,vals);s.json({source:"database",products:r.rows})}catch(e){fail(s,e)}});
app.get("/api/admin/products",db,admin,async(_q,s)=>{try{const r=await pool.query("SELECT id,sku,name,category,description,price_paise,stock,supplier_type,active,created_at FROM products ORDER BY created_at DESC LIMIT 500");s.json({products:r.rows})}catch(e){fail(s,e)}});
app.post("/api/admin/products",db,admin,async(q,s)=>{const x=q.body||{};if(!textOk(x.sku,80)||!textOk(x.name,180)||!textOk(x.category,80)||!money(x.price_paise)||!Number.isInteger(x.stock??0)||(x.stock??0)<0||!['self','third_party','dropship'].includes(x.supplier_type||'self'))return s.status(400).json({error:"Invalid product fields"});try{const r=await pool.query("INSERT INTO products(sku,name,category,description,price_paise,stock,supplier_type,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[x.sku.trim(),x.name.trim(),x.category.trim(),String(x.description||'').slice(0,5000),x.price_paise,x.stock??0,x.supplier_type||'self',x.active!==false]);s.status(201).json({product:r.rows[0]})}catch(e){if(e.code==='23505')return s.status(409).json({error:"SKU already exists"});fail(s,e)}});
app.patch("/api/admin/products/:id",db,admin,async(q,s)=>{const allowed=['sku','name','category','description','price_paise','stock','supplier_type','active'],keys=Object.keys(q.body||{}).filter(k=>allowed.includes(k));if(!keys.length)return s.status(400).json({error:"No editable fields supplied"});for(const k of keys){const v=q.body[k];if(['sku','name','category'].includes(k)&&!textOk(v,k==='name'?180:80))return s.status(400).json({error:`Invalid ${k}`});if(k==='price_paise'&&!money(v))return s.status(400).json({error:"Invalid price"});if(k==='stock'&&(!Number.isInteger(v)||v<0))return s.status(400).json({error:"Invalid stock"});if(k==='supplier_type'&&!['self','third_party','dropship'].includes(v))return s.status(400).json({error:"Invalid supplier type"});if(k==='active'&&typeof v!=='boolean')return s.status(400).json({error:"Invalid active flag"})}try{const vals=keys.map(k=>q.body[k]);vals.push(q.params.id);const r=await pool.query(`UPDATE products SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1} RETURNING *`,vals);if(!r.rowCount)return s.status(404).json({error:"Product not found"});s.json({product:r.rows[0]})}catch(e){if(e.code==='23505')return s.status(409).json({error:"SKU already exists"});fail(s,e)}});
app.delete("/api/admin/products/:id",db,admin,async(q,s)=>{try{const r=await pool.query("UPDATE products SET active=false WHERE id=$1 RETURNING id",[q.params.id]);if(!r.rowCount)return s.status(404).json({error:"Product not found"});s.json({archived:true,id:r.rows[0].id})}catch(e){fail(s,e)}});
app.get("/api/admin/summary",db,admin,async(_q,s)=>{try{const [p,o,c]=await Promise.all([pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE active)::int active,COALESCE(SUM(stock),0)::bigint units FROM products"),pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='delivered')::int delivered,COALESCE(SUM(total_paise) FILTER(WHERE payment_status='paid'),0)::bigint paid_revenue_paise FROM orders"),pool.query("SELECT COUNT(*)::int total FROM customers")]);s.json({products:p.rows[0],orders:o.rows[0],customers:c.rows[0]})}catch(e){fail(s,e)}});
// Razorpay integration: credentials stay on the server; payment is marked paid only after signature verification.
function razorpayReady(){return !!(process.env.RAZORPAY_KEY_ID&&process.env.RAZORPAY_KEY_SECRET&&process.env.RAZORPAY_WEBHOOK_SECRET)}
async function razorpayRequest(path,body){const auth=Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');const r=await fetch(`https://api.razorpay.com/v1${path}`,{method:'POST',headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error?.description||'Razorpay request failed');return data}
async function razorpayGet(path){const auth=Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');const r=await fetch(`https://api.razorpay.com/v1${path}`,{headers:{Authorization:`Basic ${auth}`}});const data=await r.json();if(!r.ok)throw new Error(data.error?.description||'Razorpay verification request failed');return data}
app.post("/api/payments/razorpay/order",db,async(q,s)=>{if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)return s.status(503).json({error:'Razorpay test/live keys are not configured'});const x=q.body||{},c=x.customer,a=x.address,it=x.items;if(!c||!textOk(c.full_name,160)||!textOk(c.email,254)||!Array.isArray(it)||!it.length||it.length>30||!a||!textOk(a.address_line1,240)||!textOk(a.city,100)||!textOk(a.state,100)||!textOk(a.postal_code,12))return s.status(400).json({error:'Customer, items and complete address required'});const client=await pool.connect();try{await client.query('BEGIN');const products=[];for(const item of it){if(typeof item.product_id!=='string'||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>20)throw Object.assign(new Error('Invalid item'),{status:400});const r=await client.query('SELECT id,name,price_paise,stock FROM products WHERE id=$1 AND active=true FOR UPDATE',[item.product_id]);if(!r.rowCount)throw Object.assign(new Error('Product unavailable'),{status:409});if(r.rows[0].stock<item.quantity)throw Object.assign(new Error(`Insufficient stock: ${r.rows[0].name}`),{status:409});products.push({...r.rows[0],quantity:item.quantity})}const customer=await client.query('INSERT INTO customers(full_name,email,phone) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name,phone=COALESCE(EXCLUDED.phone,customers.phone) RETURNING id',[c.full_name.trim(),c.email.trim().toLowerCase(),c.phone||null]);const total=products.reduce((sum,p)=>sum+Number(p.price_paise)*p.quantity,0);if(!Number.isSafeInteger(total)||total<100)throw Object.assign(new Error('Order total must be at least ₹1'),{status:400});const number=`ASH-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;await client.query("INSERT INTO orders(order_number,customer_id,status,payment_status,payment_method,subtotal_paise,total_paise,shipping_address) VALUES($1,$2,'pending','pending','razorpay',$3,$3,$4::jsonb)",[number,customer.rows[0].id,total,JSON.stringify(a)]);for(const p of products){await client.query('INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price_paise) SELECT id,$2,$3,$4,$5 FROM orders WHERE order_number=$1',[number,p.id,p.name,p.quantity,p.price_paise]);await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[p.quantity,p.id])}await client.query('COMMIT');let gateway;try{gateway=await razorpayRequest('/orders',{amount:total,currency:'INR',receipt:number,notes:{ashizu_order_number:number}})}catch(e){await pool.query("UPDATE orders SET status='payment_failed',stock_released_at=NOW() WHERE order_number=$1",[number]);await pool.query('UPDATE products pr SET stock=pr.stock+oi.quantity FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_number=$1 AND oi.product_id=pr.id',[number]);throw e}await pool.query('INSERT INTO payments(order_id,gateway,gateway_order_id,method,status,amount_paise) SELECT id,\'razorpay\',$2,\'online\',\'created\',$3 FROM orders WHERE order_number=$1',[number,gateway.id,total]);s.status(201).json({order_number:number,razorpay_order_id:gateway.id,amount:total,currency:'INR',key_id:process.env.RAZORPAY_KEY_ID})}catch(e){if(client){try{await client.query('ROLLBACK')}catch(_){}}s.status(e.status||502).json({error:e.status?e.message:'Could not create online payment order'})}finally{client.release()}});
app.post('/api/payments/razorpay/verify',db,async(q,s)=>{const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=q.body||{};if(!razorpay_order_id||!razorpay_payment_id||!razorpay_signature||!process.env.RAZORPAY_KEY_SECRET)return s.status(400).json({error:'Missing payment verification data or gateway configuration'});const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');const a=Buffer.from(expected),b=Buffer.from(String(razorpay_signature));if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return s.status(400).json({error:'Payment signature verification failed'});let gatewayPayment;try{gatewayPayment=await razorpayGet(`/payments/${encodeURIComponent(razorpay_payment_id)}`)}catch(_){return s.status(502).json({error:'Could not confirm payment status with Razorpay'})}if(gatewayPayment.order_id!==razorpay_order_id||gatewayPayment.status!=='captured')return s.status(409).json({error:'Razorpay has not confirmed a captured payment'});const client=await pool.connect();try{await client.query('BEGIN');const p=await client.query("SELECT p.id,p.order_id,p.amount_paise,p.gateway_payment_id,o.order_number FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.gateway_order_id=$1 FOR UPDATE",[razorpay_order_id]);if(!p.rowCount){await client.query('ROLLBACK');return s.status(404).json({error:'Payment order not found'})}if(Number(gatewayPayment.amount)!==Number(p.rows[0].amount_paise)||gatewayPayment.currency!=='INR')throw Object.assign(new Error('Payment amount or currency mismatch'),{status:409});if(p.rows[0].gateway_payment_id&&p.rows[0].gateway_payment_id!==razorpay_payment_id)throw Object.assign(new Error('Payment ID mismatch'),{status:409});if(p.rows[0].gateway_payment_id===razorpay_payment_id){await client.query('COMMIT');return s.json({verified:true,order_number:p.rows[0].order_number})}await client.query("UPDATE payments SET gateway_payment_id=$2,status='captured',verified_at=NOW(),updated_at=NOW() WHERE id=$1",[p.rows[0].id,razorpay_payment_id]);await client.query("UPDATE orders SET payment_status='paid',status='confirmed' WHERE id=$1",[p.rows[0].order_id]);await client.query("INSERT INTO order_events(order_id,status,note) VALUES($1,'confirmed','Razorpay payment signature verified')",[p.rows[0].order_id]);await client.query('COMMIT');s.json({verified:true,order_number:p.rows[0].order_number})}catch(e){await client.query('ROLLBACK');fail(s,e)}finally{client.release()}});
app.post('/api/payments/razorpay/webhook',db,async(q,s)=>{if(!process.env.RAZORPAY_WEBHOOK_SECRET)return s.status(503).json({error:'Webhook secret is not configured'});const sig=q.headers['x-razorpay-signature']||'';const expected=crypto.createHmac('sha256',process.env.RAZORPAY_WEBHOOK_SECRET).update(q.rawBody||Buffer.alloc(0)).digest('hex');const a=Buffer.from(expected),b=Buffer.from(sig);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return s.status(400).json({error:'Invalid webhook signature'});const event=q.body?.event,pay=q.body?.payload?.payment?.entity;if(event==='payment.captured'&&pay?.order_id){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const payment=await client.query("UPDATE payments SET gateway_payment_id=$2,status='captured',verified_at=COALESCE(verified_at,NOW()),updated_at=NOW() WHERE gateway_order_id=$1 AND amount_paise=$3 AND currency_code=$4 AND (gateway_payment_id IS NULL OR gateway_payment_id=$2) RETURNING id,order_id,amount_paise",[pay.order_id,pay.id,pay.amount,pay.currency]);
    if(payment.rowCount&&Number(pay.amount)===Number(payment.rows[0].amount_paise)&&pay.currency==='INR'){
      if(payment.rows[0].order_id){
        await client.query("UPDATE orders SET payment_status='paid',status='confirmed' WHERE id=$1",[payment.rows[0].order_id]);
        await client.query("INSERT INTO order_events(order_id,status,note) VALUES($1,'confirmed','Razorpay captured webhook verified')",[payment.rows[0].order_id]);
      } else {
        const intent=await client.query("UPDATE subscription_payment_intents SET completed_at=COALESCE(completed_at,NOW()) WHERE gateway_order_id=$1 AND completed_at IS NULL RETURNING customer_id,plan_code,payment_id",[pay.order_id]);
        if(intent.rowCount){
          const plan=await client.query("SELECT duration_days FROM subscription_plans WHERE code=$1",[intent.rows[0].plan_code]);
          const active=await client.query("SELECT ends_at FROM customer_subscriptions WHERE customer_id=$1 AND status='active' AND ends_at>NOW() ORDER BY ends_at DESC LIMIT 1 FOR UPDATE",[intent.rows[0].customer_id]);
          const start=active.rowCount?new Date(active.rows[0].ends_at):new Date();
          const end=new Date(start.getTime()+Number(plan.rows[0].duration_days)*86400000);
          await client.query("INSERT INTO customer_subscriptions(customer_id,plan_code,status,starts_at,ends_at,payment_id) VALUES($1,$2,'active',$3,$4,$5)",[intent.rows[0].customer_id,intent.rows[0].plan_code,start,end,intent.rows[0].payment_id]);
        }
      }
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");return fail(s,e)}finally{client.release()}
}else if(event==='payment.failed'&&pay?.order_id){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("UPDATE payments SET status='failed',failure_code=$2,failure_message=$3,updated_at=NOW() WHERE gateway_order_id=$1 AND status<>'captured'",[pay.order_id,pay.error_code||null,pay.error_description||null]);
    const o=await client.query("SELECT o.id,o.order_number,o.stock_released_at FROM orders o JOIN payments p ON p.order_id=o.id WHERE p.gateway_order_id=$1 FOR UPDATE",[pay.order_id]);
    if(o.rowCount&&!o.rows[0].stock_released_at){
      await client.query("UPDATE products pr SET stock=pr.stock+oi.quantity FROM order_items oi WHERE oi.order_id=$1 AND oi.product_id=pr.id",[o.rows[0].id]);
      await client.query("UPDATE orders SET status='payment_failed',stock_released_at=NOW() WHERE id=$1",[o.rows[0].id]);
    }
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");return fail(s,e)}finally{client.release()}
}s.json({received:true})});

// Customer OTP authentication. Production delivery requires SMTP credentials; OTPs are never returned in production responses.
const otpAttempts = new Map();
function issueToken(customerId){
  const payload=Buffer.from(JSON.stringify({sub:customerId,exp:Date.now()+7*24*60*60*1000})).toString("base64url");
  const sig=crypto.createHmac("sha256",process.env.CUSTOMER_TOKEN_SECRET||process.env.ADMIN_API_KEY||"").update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function customerAuth(req,res,next){
  const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,""),parts=token.split(".");
  if(parts.length!==2)return res.status(401).json({error:"Customer login required"});
  const secret=process.env.CUSTOMER_TOKEN_SECRET||process.env.ADMIN_API_KEY||"";
  const expected=crypto.createHmac("sha256",secret).update(parts[0]).digest("base64url");
  const a=Buffer.from(expected),b=Buffer.from(parts[1]);
  if(!secret||a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:"Invalid customer session"});
  try{const p=JSON.parse(Buffer.from(parts[0],"base64url").toString());if(p.exp<Date.now())return res.status(401).json({error:"Customer session expired"});req.customerId=p.sub;next()}catch(_){res.status(401).json({error:"Invalid customer session"})}
}
app.post("/api/auth/request-otp",db,async(req,res)=>{
  const email=String(req.body?.email||"").trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({error:"Enter a valid email"});
  const now=Date.now(),last=otpAttempts.get(email)||{count:0,at:0};
  if(now-last.at<60000||last.count>=5&&now-last.at<3600000)return res.status(429).json({error:"Please wait before requesting another code"});
  const code=String(crypto.randomInt(100000,1000000)),salt=crypto.randomBytes(16).toString("hex");
  const hash=crypto.createHash("sha256").update(`${salt}:${code}:${process.env.OTP_PEPPER||process.env.CUSTOMER_TOKEN_SECRET||""}`).digest("hex");
  try{
    await pool.query("INSERT INTO customer_otps(email,code_hash,salt,expires_at) VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes') ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,salt=EXCLUDED.salt,expires_at=EXCLUDED.expires_at,attempts=0",[email,hash,salt]);
    if(process.env.NODE_ENV==="production"){
      const nodemailer=require("nodemailer");
      if(!process.env.SMTP_HOST||!process.env.SMTP_USER||!process.env.SMTP_PASS||!process.env.MAIL_FROM) return res.status(503).json({error:"Email OTP delivery is not configured"});
      const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==="true",auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
      await transport.sendMail({from:process.env.MAIL_FROM,to:email,subject:"Your ASHIZU verification code",text:`Your ASHIZU verification code is ${code}. It expires in 10 minutes. Do not share it.`});
    }
    otpAttempts.set(email,{count:last.count+1,at:now});
    res.json({sent:true,expires_in_seconds:600,...(process.env.NODE_ENV!=="production"?{development_otp:code}:{})});
  }catch(e){fail(res,e)}
});
app.post("/api/auth/verify-otp",db,async(req,res)=>{
  const email=String(req.body?.email||"").trim().toLowerCase(),code=String(req.body?.code||"");
  if(!email||!/^\d{6}$/.test(code))return res.status(400).json({error:"Email and six-digit code are required"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const r=await client.query("SELECT * FROM customer_otps WHERE email=$1 FOR UPDATE",[email]);
    if(!r.rowCount||new Date(r.rows[0].expires_at)<new Date()||r.rows[0].attempts>=5){await client.query("ROLLBACK");return res.status(400).json({error:"Code expired or invalid"})}
    const row=r.rows[0],hash=crypto.createHash("sha256").update(`${row.salt}:${code}:${process.env.OTP_PEPPER||process.env.CUSTOMER_TOKEN_SECRET||""}`).digest("hex");
    const a=Buffer.from(hash),b=Buffer.from(row.code_hash);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b)){await client.query("UPDATE customer_otps SET attempts=attempts+1 WHERE email=$1",[email]);await client.query("COMMIT");return res.status(400).json({error:"Incorrect verification code"})}
    const name=String(req.body?.full_name||email.split("@")[0]).slice(0,160);
    const c=await client.query("INSERT INTO customers(full_name,email,verified_at) VALUES($1,$2,NOW()) ON CONFLICT(email) DO UPDATE SET verified_at=NOW() RETURNING id,full_name,email",[name,email]);
    await client.query("DELETE FROM customer_otps WHERE email=$1",[email]);
    await client.query("INSERT INTO customer_preferences(customer_id) VALUES($1) ON CONFLICT(customer_id) DO NOTHING",[c.rows[0].id]);
    await client.query("COMMIT");
    res.json({customer:c.rows[0],token:issueToken(c.rows[0].id),expires_in_seconds:604800});
  }catch(e){await client.query("ROLLBACK");fail(res,e)}finally{client.release()}
});
app.get("/api/customer/me",db,customerAuth,async(req,res)=>{try{const r=await pool.query("SELECT id,full_name,email,phone,created_at FROM customers WHERE id=$1",[req.customerId]);if(!r.rowCount)return res.status(404).json({error:"Customer not found"});res.json({customer:r.rows[0]})}catch(e){fail(res,e)}});
app.get("/api/customer/rewards",db,customerAuth,async(req,res)=>{try{const r=await pool.query("SELECT l.event_key,l.points,l.coupon_paise,l.description,l.created_at,c.code AS coupon_code,c.status AS coupon_status,c.expires_at FROM loyalty_ledger l LEFT JOIN customer_coupons c ON c.ledger_id=l.id WHERE l.customer_id=$1 ORDER BY l.created_at DESC",[req.customerId]);res.json({rewards:r.rows})}catch(e){fail(res,e)}});
app.get("/api/customer/subscription",db,customerAuth,async(req,res)=>{try{const r=await pool.query("SELECT s.id,s.plan_code,p.name,s.status,s.starts_at,s.ends_at FROM customer_subscriptions s JOIN subscription_plans p ON p.code=s.plan_code WHERE s.customer_id=$1 ORDER BY s.created_at DESC LIMIT 1",[req.customerId]);res.json({subscription:r.rows[0]||null})}catch(e){fail(res,e)}});
// Subscription purchase uses server-owned plan prices; only a verified captured payment activates the membership.
app.post("/api/subscriptions/razorpay/order",db,customerAuth,async(req,res)=>{
  if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)return res.status(503).json({error:"Razorpay is not configured"});
  const code=String(req.body?.plan_code||"");
  try{
    const p=await pool.query("SELECT code,price_paise FROM subscription_plans WHERE code=$1 AND active=true",[code]);
    if(!p.rowCount)return res.status(400).json({error:"Unknown subscription plan"});
    const amount=Number(p.rows[0].price_paise),receipt=`ASHSUB-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const g=await razorpayRequest("/orders",{amount,currency:"INR",receipt,notes:{type:"subscription",customer_id:req.customerId,plan_code:code}});
    const payment=await pool.query("INSERT INTO payments(order_id,gateway,gateway_order_id,method,status,amount_paise) VALUES(NULL,'razorpay',$1,'subscription','created',$2) RETURNING id",[g.id,amount]);
    await pool.query("INSERT INTO subscription_payment_intents(gateway_order_id,customer_id,plan_code,payment_id,amount_paise) VALUES($1,$2,$3,$4,$5)",[g.id,req.customerId,code,payment.rows[0].id,amount]);
    res.status(201).json({razorpay_order_id:g.id,amount,currency:"INR",key_id:process.env.RAZORPAY_KEY_ID});
  }catch(e){fail(res,e)}
});
app.post("/api/subscriptions/razorpay/verify",db,customerAuth,async(req,res)=>{
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature}=req.body||{};
  if(!razorpay_order_id||!razorpay_payment_id||!razorpay_signature||!process.env.RAZORPAY_KEY_SECRET)return res.status(400).json({error:"Payment verification details missing"});
  const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");
  const a=Buffer.from(expected),b=Buffer.from(String(razorpay_signature));
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(400).json({error:"Invalid payment signature"});
  try{
    const gateway=await razorpayGet(`/payments/${encodeURIComponent(razorpay_payment_id)}`);
    if(gateway.order_id!==razorpay_order_id||gateway.status!=="captured")return res.status(409).json({error:"Payment is not captured"});
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const i=await client.query("SELECT * FROM subscription_payment_intents WHERE gateway_order_id=$1 AND customer_id=$2 FOR UPDATE",[razorpay_order_id,req.customerId]);
      if(!i.rowCount)throw Object.assign(new Error("Subscription intent not found"),{status:404});
      if(Number(gateway.amount)!==Number(i.rows[0].amount_paise)||gateway.currency!=="INR")throw Object.assign(new Error("Amount mismatch"),{status:409});
      if(i.rows[0].completed_at){
        const existing=await client.query("SELECT id,plan_code,status,starts_at,ends_at FROM customer_subscriptions WHERE payment_id=$1 ORDER BY created_at DESC LIMIT 1",[i.rows[0].payment_id]);
        await client.query("COMMIT");return res.json({activated:!!existing.rowCount,subscription:existing.rows[0]||null});
      }
      const p=await client.query("UPDATE payments SET gateway_payment_id=$2,status='captured',verified_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING id",[i.rows[0].payment_id,razorpay_payment_id]);
      const active=await client.query("SELECT ends_at FROM customer_subscriptions WHERE customer_id=$1 AND status='active' AND ends_at>NOW() ORDER BY ends_at DESC LIMIT 1 FOR UPDATE",[req.customerId]);
      const start=active.rowCount?new Date(active.rows[0].ends_at):new Date();
      const plan=await client.query("SELECT duration_days FROM subscription_plans WHERE code=$1",[i.rows[0].plan_code]);
      const end=new Date(start.getTime()+Number(plan.rows[0].duration_days)*86400000);
      const sub=await client.query("INSERT INTO customer_subscriptions(customer_id,plan_code,status,starts_at,ends_at,payment_id) VALUES($1,$2,'active',$3,$4,$5) RETURNING id,plan_code,status,starts_at,ends_at",[req.customerId,i.rows[0].plan_code,start,end,p.rows[0].id]);
      await client.query("UPDATE subscription_payment_intents SET completed_at=NOW() WHERE gateway_order_id=$1",[razorpay_order_id]);
      await client.query("COMMIT");res.json({activated:true,subscription:sub.rows[0]});
    }catch(e){await client.query("ROLLBACK");res.status(e.status||500).json({error:e.status?e.message:"Could not activate subscription"})}finally{client.release()}
  }catch(e){fail(res,e)}
});
app.patch("/api/admin/orders/:number",db,admin,async(req,res)=>{
  const allowed=["confirmed","processing","packed","shipped","out_for_delivery","delivered","cancelled","returned"];
  const status=req.body?.status;
  if(!allowed.includes(status))return res.status(400).json({error:"Invalid order status"});
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const o=await client.query("SELECT id,customer_id,status FROM orders WHERE order_number=$1 FOR UPDATE",[req.params.number]);
    if(!o.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Order not found"})}
    await client.query("UPDATE orders SET status=$2 WHERE id=$1",[o.rows[0].id,status]);
    await client.query("INSERT INTO order_events(order_id,status,note) VALUES($1,$2,$3)",[o.rows[0].id,status,String(req.body?.note||"Updated by admin").slice(0,500)]);
    if(status==="delivered"){
      const completed=await client.query("SELECT COUNT(*)::int n FROM orders WHERE customer_id=$1 AND status='delivered'",[o.rows[0].customer_id]);
      const n=Number(completed.rows[0].n);
      // Milestones repeat every 5 completed orders: ₹199 at 5, ₹499 at 10, then ₹199 for each additional 5.
      if(n>=5&&n%5===0){
        const coupon=n===10?49900:19900;
        const reward=await client.query("INSERT INTO loyalty_ledger(customer_id,order_id,event_key,points,coupon_paise,description) VALUES($1,$2,$3,0,$4,$5) ON CONFLICT(event_key) DO NOTHING RETURNING id",[o.rows[0].customer_id,o.rows[0].id,`milestone:${o.rows[0].customer_id}:${n}`,coupon,`${n} completed orders reward`]);
      if(reward.rowCount){
        const code=`ASH${n}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        await client.query("INSERT INTO customer_coupons(customer_id,ledger_id,code,discount_paise) VALUES($1,$2,$3,$4)",[o.rows[0].customer_id,reward.rows[0].id,code,coupon]);
      }
      }
    }
    await client.query("COMMIT");res.json({updated:true,order_number:req.params.number,status});
  }catch(e){await client.query("ROLLBACK");fail(res,e)}finally{client.release()}
});
app.get("/api/admin/orders",db,admin,async(_q,res)=>{try{const r=await pool.query("SELECT o.order_number,o.status,o.payment_status,o.payment_method,o.total_paise,o.created_at,c.full_name,c.email FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC LIMIT 500");res.json({orders:r.rows})}catch(e){fail(res,e)}});

app.post("/api/orders",db,async(q,s)=>{const x=q.body||{},c=x.customer,a=x.address,it=x.items;if(!c||!textOk(c.full_name,160)||!textOk(c.email,254)||!Array.isArray(it)||!it.length||it.length>30||!a||!textOk(a.address_line1,240)||!textOk(a.city,100)||!textOk(a.state,100)||!textOk(a.postal_code,12))return s.status(400).json({error:"Customer, items and complete address required"});if((x.payment_method||'cod')!=='cod')return s.status(400).json({error:"Online payments are not enabled. COD only."});const client=await pool.connect();try{await client.query('BEGIN');const products=[];for(const item of it){if(typeof item.product_id!=='string'||!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>20)throw Object.assign(new Error('Invalid item'),{status:400});const r=await client.query("SELECT id,name,price_paise,stock FROM products WHERE id=$1 AND active=true FOR UPDATE",[item.product_id]);if(!r.rowCount)throw Object.assign(new Error('Product unavailable'),{status:409});if(r.rows[0].stock<item.quantity)throw Object.assign(new Error(`Insufficient stock: ${r.rows[0].name}`),{status:409});products.push({...r.rows[0],quantity:item.quantity})}const customer=await client.query("INSERT INTO customers(full_name,email,phone) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET full_name=EXCLUDED.full_name,phone=COALESCE(EXCLUDED.phone,customers.phone) RETURNING id",[c.full_name.trim(),c.email.trim().toLowerCase(),c.phone||null]);const total=products.reduce((sum,p)=>sum+Number(p.price_paise)*p.quantity,0);if(!Number.isSafeInteger(total))throw Object.assign(new Error('Total out of range'),{status:400});const number=`ASH-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;const order=await client.query("INSERT INTO orders(order_number,customer_id,status,payment_status,payment_method,subtotal_paise,total_paise,shipping_address) VALUES($1,$2,'pending','pending','cod',$3,$3,$4::jsonb) RETURNING order_number,status,total_paise,created_at",[number,customer.rows[0].id,total,JSON.stringify(a)]);for(const p of products){await client.query("INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price_paise) SELECT id,$2,$3,$4,$5 FROM orders WHERE order_number=$1",[number,p.id,p.name,p.quantity,p.price_paise]);await client.query("UPDATE products SET stock=stock-$1 WHERE id=$2",[p.quantity,p.id])}await client.query("INSERT INTO order_events(order_id,status,note) SELECT id,'pending','COD order placed' FROM orders WHERE order_number=$1",[number]);await client.query('COMMIT');s.status(201).json({order:order.rows[0],message:'COD order created; collect payment on delivery'})}catch(e){await client.query('ROLLBACK');s.status(e.status||500).json({error:e.status?e.message:'Could not create order'})}finally{client.release()}});
app.get("/api/orders/:number",db,async(q,s)=>{try{const r=await pool.query("SELECT order_number,status,payment_status,payment_method,created_at,total_paise FROM orders WHERE order_number=$1",[q.params.number]);if(!r.rowCount)return s.status(404).json({error:"Order not found"});s.json(r.rows[0])}catch(e){fail(s,e)}});
app.use((e,_q,s,_n)=>{console.error(e);s.status(400).json({error:"Invalid request"})});
const port=Number(process.env.PORT||3000);app.listen(port,()=>console.log(`ASHIZU server listening on ${port}`));process.on('SIGTERM',async()=>{if(pool)await pool.end();process.exit(0)});
