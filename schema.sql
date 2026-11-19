CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE customers(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),full_name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT UNIQUE,password_hash TEXT,verified_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE products(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),sku TEXT UNIQUE NOT NULL,name TEXT NOT NULL,category TEXT NOT NULL,description TEXT,price_paise BIGINT NOT NULL,stock INT DEFAULT 0,supplier_type TEXT DEFAULT 'self',active BOOLEAN DEFAULT TRUE,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE orders(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_number TEXT UNIQUE NOT NULL,customer_id UUID REFERENCES customers(id),status TEXT DEFAULT 'pending',payment_status TEXT DEFAULT 'pending',payment_method TEXT DEFAULT 'cod',subtotal_paise BIGINT NOT NULL,discount_paise BIGINT DEFAULT 0,shipping_paise BIGINT DEFAULT 0,total_paise BIGINT NOT NULL,shipping_address JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE order_items(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID REFERENCES orders(id) ON DELETE CASCADE,product_id UUID REFERENCES products(id),product_name TEXT NOT NULL,quantity INT NOT NULL,unit_price_paise BIGINT NOT NULL);
CREATE TABLE order_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID REFERENCES orders(id) ON DELETE CASCADE,status TEXT NOT NULL,note TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE loyalty_rules(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),completed_orders INT NOT NULL,discount_percent NUMERIC(5,2) NOT NULL,active BOOLEAN DEFAULT TRUE);
CREATE INDEX products_category_idx ON products(category);
CREATE INDEX orders_created_idx ON orders(created_at DESC);


-- Customer address book and consent-aware profile preferences
CREATE TABLE customer_addresses(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,label TEXT,recipient_name TEXT NOT NULL,phone TEXT NOT NULL,address_line1 TEXT NOT NULL,address_line2 TEXT,city TEXT NOT NULL,state TEXT NOT NULL,postal_code TEXT NOT NULL,country TEXT NOT NULL DEFAULT 'India',is_default BOOLEAN DEFAULT FALSE,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE customer_preferences(customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,language_code TEXT NOT NULL DEFAULT 'en',currency_code TEXT NOT NULL DEFAULT 'INR',marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,order_updates BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ DEFAULT NOW());

-- Store gateway references and statuses only; never store card numbers, CVV, UPI PINs or secrets.
CREATE TABLE payments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,gateway TEXT NOT NULL DEFAULT 'razorpay',gateway_order_id TEXT,gateway_payment_id TEXT,transaction_reference TEXT UNIQUE,method TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',amount_paise BIGINT NOT NULL,currency_code TEXT NOT NULL DEFAULT 'INR',failure_code TEXT,failure_message TEXT,verified_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE refunds(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),payment_id UUID NOT NULL REFERENCES payments(id),gateway_refund_id TEXT,amount_paise BIGINT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',reason TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE shipments(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,carrier TEXT,tracking_number TEXT,tracking_url TEXT,status TEXT NOT NULL DEFAULT 'pending',shipped_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE shipment_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),shipment_id UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,status TEXT NOT NULL,description TEXT,event_time TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE customer_activity_logs(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,actor_type TEXT NOT NULL,actor_id UUID,action TEXT NOT NULL,entity_type TEXT,entity_id UUID,metadata JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE order_address_change_requests(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,requested_by TEXT NOT NULL,old_address JSONB NOT NULL,new_address JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reviewed_by UUID,created_at TIMESTAMPTZ DEFAULT NOW(),reviewed_at TIMESTAMPTZ);
CREATE INDEX payments_order_idx ON payments(order_id,created_at DESC);
CREATE INDEX shipment_order_idx ON shipments(order_id);
CREATE INDEX customer_activity_idx ON customer_activity_logs(customer_id,created_at DESC);

-- Subscription and auditable loyalty ledger (new additive migration section)
CREATE TABLE IF NOT EXISTS subscription_plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_days INT NOT NULL CHECK (duration_days > 0),
  price_paise BIGINT NOT NULL CHECK (price_paise >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO subscription_plans(code,name,duration_days,price_paise,active) VALUES
 ('monthly','Monthly',30,3900,TRUE),
 ('quarterly','3 Months',90,9900,TRUE),
 ('yearly','Yearly',365,39900,TRUE)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,duration_days=EXCLUDED.duration_days,price_paise=EXCLUDED.price_paise;
CREATE TABLE IF NOT EXISTS customer_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  plan_code TEXT NOT NULL REFERENCES subscription_plans(code),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','expired','cancelled','payment_failed')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  payment_id UUID REFERENCES payments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_subscriptions_customer_idx ON customer_subscriptions(customer_id,created_at DESC);
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  order_id UUID REFERENCES orders(id),
  event_key TEXT NOT NULL UNIQUE,
  points INT NOT NULL DEFAULT 0,
  coupon_paise BIGINT NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS loyalty_ledger_customer_idx ON loyalty_ledger(customer_id,created_at DESC);


-- Authentication and subscription checkout additions
CREATE TABLE IF NOT EXISTS customer_otps(
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE payments ALTER COLUMN order_id DROP NOT NULL;
CREATE TABLE IF NOT EXISTS subscription_payment_intents(
  gateway_order_id TEXT PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id),
  plan_code TEXT NOT NULL REFERENCES subscription_plans(code),
  payment_id UUID NOT NULL REFERENCES payments(id),
  amount_paise BIGINT NOT NULL CHECK(amount_paise>0),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS stock_released_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS orders_customer_status_idx ON orders(customer_id,status);
CREATE INDEX IF NOT EXISTS customer_otps_expiry_idx ON customer_otps(expires_at);
CREATE INDEX IF NOT EXISTS subscription_intents_customer_idx ON subscription_payment_intents(customer_id,created_at DESC);


CREATE TABLE IF NOT EXISTS customer_coupons(
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  ledger_id UUID NOT NULL UNIQUE REFERENCES loyalty_ledger(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  discount_paise BIGINT NOT NULL CHECK(discount_paise>0),
  status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','redeemed','expired')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '90 days',
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_coupons_customer_idx ON customer_coupons(customer_id,status,expires_at);
