# ASHIZU Commerce — expanded development build

This is an expanded development build based on the supplied ASHIZU starter. It is **not deployed and is not yet production-ready**.

## Included in this build

### Storefront
- Responsive ASHIZU storefront with database-backed product catalog.
- Product search/category filtering and local shopping cart.
- Checkout sends COD orders to the server; online checkout opens Razorpay Checkout when server credentials are configured.
- Order tracking by real server-side order number.
- Membership plans are loaded from PostgreSQL and shown in the storefront.
- Email OTP customer sign-in flow; development mode returns the OTP in the API response for local testing only.
- Customer reward history display.

### Server and database
- PostgreSQL product catalog and protected admin product CRUD/archive APIs.
- Transactional COD order creation with row-level product stock locks and stock decrement.
- Razorpay order creation, payment signature verification, amount/currency check, and signed webhook verification.
- Webhook failure handling releases reserved stock once.
- Customer email OTP records are hashed with a salt and expire after 10 minutes; production email delivery uses SMTP.
- Seven-day signed customer sessions.
- Subscription checkout at the configured ₹39 / ₹99 / ₹399 plans. Server-owned plan prices; activation only after a captured, verified payment. Payment webhook can also activate subscriptions.
- Completed-order rewards: ₹199 at 5 orders, ₹499 at 10 orders, then ₹199 at later 5-order milestones. Coupons are uniquely generated and stored in the customer coupon table.
- Admin order list and order-status updates; marking an order delivered issues its milestone coupon idempotently.
- Security headers, JSON body size cap, parameterized SQL and environment-based secrets.

## Run locally

Requirements: Node.js 20+, PostgreSQL 14+.

1. `npm install`
2. Copy `.env.example` to `.env`.
3. Set `DATABASE_URL`, `ADMIN_API_KEY` (random, 32+ chars), `CUSTOMER_TOKEN_SECRET` (separate random secret) and `OTP_PEPPER`.
4. Create a PostgreSQL database and apply the complete schema once:
   `psql "$DATABASE_URL" -f schema.sql`
5. For development OTP, set `NODE_ENV=development`. The API response includes `development_otp`; do not run this mode publicly.
6. For production OTP email, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, and `NODE_ENV=production`.
7. Add Razorpay TEST credentials to `.env`, configure the webhook URL `/api/payments/razorpay/webhook` and the matching webhook secret. Start with test mode only.
8. `npm start`; storefront `http://localhost:3000/`, admin `http://localhost:3000/admin.html`.

## Test checklist

- `node --check server.js`
- Extract inline scripts from `public/index.html` and `public/admin.html`, then run `node --check` on each.
- Check ZIP integrity with `unzip -t`.
- After PostgreSQL is available, apply `schema.sql` and call `/api/health`.
- Create a test product in Admin, place a COD test order, verify stock decrement and order tracking.
- Use Razorpay TEST keys and test cards/UPI from Razorpay's current test documentation; verify captured payment, failed payment, webhook replay and subscription activation.
- Test OTP with development mode locally, then SMTP delivery in a private staging environment.

## Still requires real provider accounts / infrastructure

- No PostgreSQL server or credentials are bundled. Database runtime/migration could not be executed in this build environment.
- No Razorpay test/live credentials were supplied; gateway API requests and real test payments have not been performed. Keep live payments disabled until test-mode checkout and webhook replay pass.
- No SMTP account was supplied; production OTP delivery has not been exercised.
- No courier provider credentials or contract/API supplied. Shipment label purchase, carrier tracking webhooks, reverse pickup and live shipping rates remain unconnected.
- Refund creation/reconciliation, coupon redemption at checkout, GST/tax invoice generation, address-change approval workflow, product image storage/variants, complete multilingual translation, supplier marketplace integrations, WhatsApp/Meta catalog and analytics remain to be implemented.
- Admin access currently uses a bootstrap bearer key, not staff accounts, MFA, RBAC or secure browser sessions. Replace before launch.
- OTP rate limiting is in-process and must move to Redis/distributed rate limiting for multi-instance production.
- No domain, hosting, CDN/WAF, Redis, queue, managed database, object storage, monitoring, backups or disaster recovery has been configured.
- The 500,000 concurrent shopper target is not tested or guaranteed. It requires a separate cloud deployment architecture and load/soak testing with realistic traffic.

Never store card numbers, CVV, UPI PINs or gateway secrets in browser code. Never use Razorpay live keys until all staging checks and merchant onboarding are complete.
